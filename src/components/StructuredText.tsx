import type { ReactNode } from "react";

/**
 * #26: draft text rendered as the structure it carries — paragraphs, `-`
 * lists, fenced code blocks, `code` spans, and [label](https://…) links —
 * so a draft reads like the message it will become.
 *
 * Safety is by construction, not by filtering: everything renders as React
 * text nodes, which escape whatever the daemon sent, and no HTML in the
 * text is ever parsed. The one string that reaches an attribute is a link
 * URL, and it becomes an anchor only when it is http(s) — a `javascript:`
 * or data: URL renders as the literal text it arrived as, because the
 * receiver's trust ends at schemes the app can vouch for.
 */

type Block = { kind: "paragraph"; lines: string[] } | { kind: "list"; items: string[] } | { kind: "code"; text: string };

const LIST_ITEM = /^\s*[-*]\s+/;

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // past the closing fence when there is one; end-of-text is fine too
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i])) {
        items.push(lines[i].replace(LIST_ITEM, ""));
        i += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !LIST_ITEM.test(lines[i]) &&
      !lines[i].trim().startsWith("```")
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

/** Inline spans: `code` and [label](url). Match order puts code first so a link label containing backticks still splits cleanly. */
const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

function isVouchableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      nodes.push(text.slice(cursor, index));
    }
    const [whole, code, linkLabel, linkUrl] = match;
    if (code !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-code-${index}`} data-testid="structured-code" className="rounded-[var(--r-sm)] bg-[var(--surface)] px-1 py-0.5 text-[0.9em]">
          {code}
        </code>,
      );
    } else if (linkUrl !== undefined && isVouchableUrl(linkUrl)) {
      nodes.push(
        <a key={`${keyPrefix}-link-${index}`} data-testid="structured-link" href={linkUrl} className="underline">
          {linkLabel}
        </a>,
      );
    } else {
      // Not a link this app will vouch for — the text keeps its brackets
      // and the reader keeps their trust.
      nodes.push(whole);
    }
    cursor = index + whole.length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

export function StructuredText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2" data-testid="structured-text">
      {parseBlocks(text).map((block, index) => {
        if (block.kind === "paragraph") {
          return <p key={index}>{renderInline(block.lines.join(" "), String(index))}</p>;
        }
        if (block.kind === "list") {
          return (
            <ul key={index} data-testid="structured-list" className="list-disc pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item, `${index}-${itemIndex}`)}</li>
              ))}
            </ul>
          );
        }
        return (
          <pre
            key={index}
            data-testid="structured-codeblock"
            className="overflow-x-auto rounded-[var(--r-sm)] bg-[var(--surface)] p-2 text-xs"
          >
            <code>{block.text}</code>
          </pre>
        );
      })}
    </div>
  );
}
