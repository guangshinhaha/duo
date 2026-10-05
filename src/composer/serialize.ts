import { $isListItemNode, $isListNode, type ListNode } from "@lexical/list";
import {
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from "lexical";
import type { MessageMention } from "../workspace/mentions.js";
import { $isMentionNode } from "./MentionNode.js";

/**
 * #248: what the composer hands the send path — the message's markdown
 * source (the same string #216's textarea used to hold: what `matrix.ts`
 * sends as `body` and renders through `markdown.ts` into `formatted_body`)
 * and the mentions it carries, in document order.
 *
 * Why a hand-written walk rather than `@lexical/markdown`'s own
 * `$convertToMarkdownString`: that exporter backslash-escapes every literal
 * `*`, `_`, `` ` `` and `~` the member typed (`snake\_case`, `2 \* 3`). The
 * markdown source here is ALSO the plain `body` every non-formatting client
 * reads (#216 AC2), so it has to be exactly what the member typed — a
 * literal asterisk stays an asterisk, same as it did in the textarea. Only
 * what the editor actually formatted (bold/italic/strikethrough/inline code
 * the live shortcuts produced, lists) is written back as markdown syntax.
 */
export interface ComposedMessage {
  /** The markdown source — `body` on the wire, and the input to `markdownToHtml`. Untrimmed: the caller trims. */
  readonly body: string;
  /** Every mention node still in the editor, in the order they appear. */
  readonly mentions: readonly MessageMention[];
}

/** The inline formats a member can produce here, in the order their markers nest (outermost first). */
const MARKERS = [
  { format: "strikethrough", marker: "~~" },
  { format: "bold", marker: "**" },
  { format: "italic", marker: "*" },
] as const;
type Marker = (typeof MARKERS)[number]["marker"];

/** One inline run of a paragraph: the words, and the markers it wants open around them. */
interface Segment {
  /** Whitespace before the words — kept OUTSIDE any marker (CommonMark's flanking rule: `** x**` isn't bold). */
  readonly lead: string;
  readonly core: string;
  readonly trail: string;
  readonly markers: readonly Marker[];
}

function markersOf(node: TextNode): readonly Marker[] {
  return MARKERS.filter((entry) => node.hasFormat(entry.format)).map((entry) => entry.marker);
}

/** An inline code span with a fence longer than any backtick run inside it (CommonMark's own rule for literal backticks). */
function codeSpan(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

function segmentOf(node: TextNode): Segment {
  const text = node.getTextContent();
  if (node.hasFormat("code")) {
    // A code span is atomic: its whitespace stays inside the fence.
    return { lead: "", core: codeSpan(text), trail: "", markers: markersOf(node) };
  }
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return { lead: match[1]!, core: match[2]!, trail: match[3]!, markers: markersOf(node) };
}

/**
 * One line's inline runs as markdown. Markers stay open across neighbouring
 * runs that share them (`**bold *and italic***`, not `**bold *****and
 * italic***` — adjacent delimiter runs would merge and mis-parse), close
 * before trailing whitespace and open after leading whitespace.
 */
function emitLine(segments: readonly Segment[]): string {
  let out = "";
  let open: Marker[] = [];
  let pendingSpace = "";
  for (const segment of segments) {
    if (segment.core.length === 0) {
      // Whitespace alone never opens or closes anything.
      pendingSpace += segment.lead + segment.trail;
      continue;
    }
    let shared = 0;
    while (shared < open.length && shared < segment.markers.length && open[shared] === segment.markers[shared]) {
      shared++;
    }
    out += open.slice(shared).reverse().join("") + pendingSpace + segment.lead + segment.markers.slice(shared).join("") + segment.core;
    open = [...segment.markers];
    pendingSpace = segment.trail;
  }
  return out + open.reverse().join("") + pendingSpace;
}

/** A paragraph's (or list item's) inline children, line breaks closing every open marker. */
function inlineOf(element: ElementNode, mentions: MessageMention[]): string {
  const lines: Segment[][] = [[]];
  const visit = (node: LexicalNode): void => {
    if ($isLineBreakNode(node)) {
      lines.push([]);
    } else if ($isMentionNode(node)) {
      mentions.push({ userId: node.getUserId(), label: node.getLabel() });
      // The addressed words, exactly — never inside a code span (the seam's
      // anchor would land inside backticks and render as literal HTML).
      lines.at(-1)!.push({ lead: "", core: node.getTextContent(), trail: "", markers: markersOf(node) });
    } else if ($isTextNode(node)) {
      lines.at(-1)!.push(segmentOf(node));
    } else if ($isElementNode(node) && !$isListNode(node)) {
      node.getChildren().forEach(visit);
    }
  };
  element.getChildren().forEach(visit);
  return lines.map(emitLine).join("\n");
}

/** A list as markdown lines — nested lists indented to their parent item's content column. */
function listLines(list: ListNode, indent: string, mentions: MessageMention[]): string[] {
  const lines: string[] = [];
  let number = list.getStart();
  for (const item of list.getChildren()) {
    if (!$isListItemNode(item)) {
      continue;
    }
    const nested = item.getChildren().filter($isListNode);
    const marker = list.getListType() === "number" ? `${number}. ` : "- ";
    const words = inlineOf(item, mentions);
    // An item that only holds a nested list (Lexical's shape for an
    // indented sub-list) adds no line of its own.
    if (nested.length === 0 || words.length > 0) {
      lines.push(`${indent}${marker}${words.replace(/\n/g, `\n${indent}${" ".repeat(marker.length)}`)}`);
      number++;
    }
    for (const child of nested) {
      lines.push(...listLines(child, indent + " ".repeat(marker.length), mentions));
    }
  }
  return lines;
}

/**
 * The whole editor as a `ComposedMessage` — call inside a read or update.
 * Blocks join with a single newline: each Shift+Enter is one line, the same
 * line the textarea used to hold (and `markdown.ts`'s `breaks: true` keeps it
 * a line on the formatted half too); an empty paragraph is a blank line.
 */
export function $composedMessage(): ComposedMessage {
  const mentions: MessageMention[] = [];
  const blocks: string[] = [];
  for (const block of $getRoot().getChildren()) {
    if ($isListNode(block)) {
      blocks.push(listLines(block, "", mentions).join("\n"));
    } else if ($isElementNode(block)) {
      blocks.push(inlineOf(block, mentions));
    } else {
      blocks.push(block.getTextContent());
    }
  }
  return { body: blocks.join("\n"), mentions };
}
