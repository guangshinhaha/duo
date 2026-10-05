import {
  $applyNodeReplacement,
  $getState,
  $isTextNode,
  $setState,
  createState,
  TextNode,
  type EditorConfig,
  type LexicalNode,
} from "lexical";
import { addressed, mentionPillClassName } from "../workspace/mentions.js";

/**
 * #248: one mention inside the composer — the rebuilt half of #65's offer.
 * A pick from the typeahead lands as this node: a token (deleted whole,
 * never half-edited into words that no longer name anyone) whose text is
 * exactly the addressed words `mentions.ts` decides ("@carol's duo",
 * "@Carol"), and whose state carries the pick's user id and bare label.
 *
 * The node is what replaces #65's `picks` list and its "is the label still
 * in the text?" check: what the editor still holds at send time IS the set
 * of mentions, in document order, so a mention the member deleted simply
 * isn't there to ride `m.mentions`. Its text serializes as the plain
 * addressed words (`serialize.ts`), and the seam (`matrix.ts`'s `send`) goes
 * on anchoring those words exactly as it always has — the editor never
 * writes a matrix.to anchor itself.
 */

const MENTION_TYPE = "duo-mention";
const parseString = (value: unknown): string => (typeof value === "string" ? value : "");
const userIdState = createState("mentionUserId", { parse: parseString });
const labelState = createState("mentionLabel", { parse: parseString });

export class MentionNode extends TextNode {
  $config() {
    return this.config(MENTION_TYPE, {
      extends: TextNode,
      stateConfigs: [
        { stateConfig: userIdState, flat: true },
        { stateConfig: labelState, flat: true },
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

  /** The pill a sent mention renders as (#65/#213) — the same classes, from the same one home, so the composer shows what the timeline will. */
  private decorate(element: HTMLElement): void {
    const userId = $getState(this, userIdState);
    element.classList.add(...mentionPillClassName(userId).split(/\s+/).filter(Boolean));
    element.setAttribute("data-mentioned-user", userId);
    element.setAttribute("data-testid", "composer-mention");
    element.setAttribute("spellcheck", "false");
  }

  getUserId(): string {
    return $getState(this, userIdState);
  }

  getLabel(): string {
    return $getState(this, labelState);
  }

  isTextEntity(): true {
    return true;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }
}

/** A mention of `userId` under `label` — the label is advisory for a duo; `addressed` re-derives a duo's words from its id. */
export function $createMentionNode(userId: string, label: string): MentionNode {
  const node = $applyNodeReplacement(new MentionNode(addressed(userId, label)));
  $setState(node, userIdState, userId);
  $setState(node, labelState, label);
  // Token: the whole pill goes on one Backspace, and typing beside it never
  // grows it — the words stay exactly the ones `addressed` produced.
  node.setMode("token");
  return node;
}

/**
 * By registered type rather than `instanceof`: the type is the editor's own
 * name for the node, so the answer holds even where this module has been
 * loaded twice (a test that resets its module registry under a live editor).
 */
export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return $isTextNode(node) && node.getType() === MENTION_TYPE;
}
