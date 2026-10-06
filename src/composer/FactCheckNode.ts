import {
  $applyNodeReplacement,
  $getState,
  $getRoot,
  $isTextNode,
  $setState,
  createState,
  TextNode,
  type EditorConfig,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

/**
 * #264: one flagged span inside the composer — a possible contradiction
 * between a claim the owner just typed and something the corpus already
 * knows. Structured the same way #248's `MentionNode` is (a `TextNode`
 * subclass carrying its own state, decorated with classes/attributes in
 * `createDOM`/`updateDOM`) because the shape of the problem is the same:
 * a run of plain text that needs to render differently and carry data a
 * plugin can read back off the DOM, without becoming a decorator node of
 * its own.
 *
 * Unlike a mention, this is never a token the owner picked — it's
 * daemon-asserted and provisional, so typing beside or inside it is never
 * blocked (`isTextEntity()` stays false, the TextNode default): the
 * moment the owner edits anything, `FactCheckPlugin`'s debounce fires
 * again and `$clearFactCheckMarks` below removes every mark before the
 * next check's result (if any) lands. A flag that outlived the edit that
 * invalidated it would be the "confidently wrong" failure mode the
 * feature exists to avoid.
 */

const FACT_CHECK_TYPE = "duo-fact-check";
const parseString = (value: unknown): string => (typeof value === "string" ? value : "");
const concernState = createState("factCheckConcern", { parse: parseString });
const sourceLabelState = createState("factCheckSourceLabel", { parse: parseString });

export class FactCheckNode extends TextNode {
  $config() {
    return this.config(FACT_CHECK_TYPE, {
      extends: TextNode,
      stateConfigs: [
        { stateConfig: concernState, flat: true },
        { stateConfig: sourceLabelState, flat: true },
      ],
    });
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    this.decorate(element);
    return element;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const replaced = super.updateDOM(prevNode, dom, config);
    this.decorate(dom);
    return replaced;
  }

  /** The subtle underline + hover/tap target — `FactCheckAssist.tsx` reads these same attributes back off the hovered/focused element, rather than needing a live Lexical read to show the card. */
  private decorate(element: HTMLElement): void {
    element.classList.add("underline", "decoration-wavy", "decoration-[var(--refused)]", "cursor-help");
    element.setAttribute("data-testid", "fact-check-flag");
    element.setAttribute("data-fact-check-concern", $getState(this, concernState));
    element.setAttribute("data-fact-check-source", $getState(this, sourceLabelState));
    element.setAttribute("tabindex", "0");
  }

  getConcern(): string {
    return $getState(this, concernState);
  }

  getSourceLabel(): string {
    return $getState(this, sourceLabelState);
  }
}

export function $createFactCheckNode(text: string, concern: string, sourceLabel: string): FactCheckNode {
  const node = $applyNodeReplacement(new FactCheckNode(text));
  $setState(node, concernState, concern);
  $setState(node, sourceLabelState, sourceLabel);
  return node;
}

/** By registered type, same reasoning as `$isMentionNode` — holds even where this module loaded twice. */
export function $isFactCheckNode(node: LexicalNode | null | undefined): node is FactCheckNode {
  return $isTextNode(node) && node.getType() === FACT_CHECK_TYPE;
}

/**
 * Un-marks every fact-check span back to plain text, preserving its exact
 * text content and position — called before every fresh check (a stale
 * mark must never outlive the edit that invalidated it) and when the
 * feature is turned off.
 */
export function $clearFactCheckMarks(editor: LexicalEditor): void {
  const visit = (node: LexicalNode): void => {
    if ($isFactCheckNode(node)) {
      const plain = $applyNodeReplacement(new TextNode(node.getTextContent()));
      node.replace(plain);
      return;
    }
    if ("getChildren" in node) {
      (node as ElementNode).getChildren().forEach(visit);
    }
  };
  // Discrete, like `ChatEditor.tsx`'s own `clear()`: this fires from a
  // debounced timer, outside any keystroke's own update batch, and the
  // mark/unmark must be visible the instant this call returns rather than
  // riding whatever microtask the editor would otherwise coalesce it into.
  editor.update(
    () => {
      $getRoot().getChildren().forEach(visit);
    },
    { discrete: true },
  );
}

/**
 * Finds the FIRST plain `TextNode` anywhere in the document whose own
 * text contains `claim` (case-insensitive) and splits out the matching
 * slice as a `FactCheckNode`, leaving any text before/after it as
 * ordinary siblings. Deliberately does not attempt to mark a claim that
 * spans more than one existing node (e.g. crossing a **bold** boundary,
 * or a paragraph break) — a flag this module can't safely and precisely
 * underline is better left unmarked than mis-rendered over the wrong
 * text, which is the same "skip rather than guess" discipline the
 * daemon's own fact-check.ts applies to the contradiction call itself.
 * Returns whether a mark was placed.
 */
export function $applyFactCheckMark(editor: LexicalEditor, claim: string, concern: string, sourceLabel: string): boolean {
  const lowerClaim = claim.trim().toLowerCase();
  if (lowerClaim.length === 0) {
    return false;
  }
  let placed = false;
  const visit = (node: LexicalNode): void => {
    // Only the base TextNode type is a safe rewrite target — a mention
    // (a token, never to be split) and an existing fact-check mark (never
    // nested inside another) are both TextNode subclasses too, so this
    // checks the registered type exactly rather than `$isTextNode`.
    if (placed || node.getType() !== "text") {
      if (!placed && "getChildren" in node) {
        (node as ElementNode).getChildren().forEach(visit);
      }
      return;
    }
    const textNode = node as TextNode;
    const text = textNode.getTextContent();
    const index = text.toLowerCase().indexOf(lowerClaim);
    if (index === -1) {
      return;
    }
    const matchEnd = index + lowerClaim.length;
    // splitText at the match boundaries — Lexical's own primitive for
    // "carve a middle run out of a text node", the same one the markdown
    // shortcut transforms use.
    const parts = textNode.splitText(index, matchEnd);
    const middle = index === 0 ? parts[0] : parts[1];
    if (!middle) {
      return;
    }
    const marked = $createFactCheckNode(middle.getTextContent(), concern, sourceLabel);
    middle.replace(marked);
    placed = true;
  };
  editor.update(
    () => {
      $getRoot().getChildren().forEach(visit);
    },
    { discrete: true },
  );
  return placed;
}
