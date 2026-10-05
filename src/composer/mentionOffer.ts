import { isDuoUserId, localpartOf } from "../workspace/identity.js";
import { mentionLabelOf } from "../workspace/mentions.js";

/** One member the composer can offer as a mention — a person by their name, a duo by whose it is (#65). */
export interface MentionCandidate {
  readonly userId: string;
  readonly label: string;
  readonly kind: "person" | "duo";
}

/**
 * Who a mention can address (#65): the room's own members, the member
 * themself excepted. The label is structural the way every attribution is —
 * a duo offers as "{owner}'s duo" from the @duo- grammar, never from a
 * display name a sender chose, and the kind marker says what each offer IS
 * before the picker commits to it.
 */
export function mentionCandidatesOf(
  members: readonly { readonly userId: string; readonly name?: string | null }[],
  selfId: string,
): readonly MentionCandidate[] {
  return members
    .filter((member) => member.userId !== selfId)
    .map((member) => ({
      userId: member.userId,
      // The label comes from the one home of the rule — a duo offers as
      // "{owner}'s duo" from the @duo- grammar, never from a display name.
      label: mentionLabelOf(member.userId, member.name ?? localpartOf(member.userId)),
      kind: isDuoUserId(member.userId) ? "duo" : "person",
    }));
}

/**
 * #65's matching rule, unchanged by #248: what follows the "@" is a prefix
 * of the offer's label or of its user id's localpart, case-insensitively.
 */
export function mentionOffer(candidates: readonly MentionCandidate[], fragment: string): readonly MentionCandidate[] {
  const lower = fragment.toLowerCase();
  return candidates.filter(
    (candidate) => candidate.label.toLowerCase().startsWith(lower) || localpartOf(candidate.userId).toLowerCase().startsWith(lower),
  );
}

/**
 * The mention being typed, read from the text before the caret: a run with
 * no whitespace and no second "@", starting with "@" right after whitespace
 * or the start of the text — the same token #65's textarea read off the
 * text's end ("the run after the last whitespace, when it starts with @"),
 * now read at the caret, wherever the member is typing.
 */
export function mentionTokenBeforeCaret(text: string): { leadOffset: number; fragment: string; token: string } | null {
  const match = /(^|\s)(@[^@\s]*)$/.exec(text);
  if (!match) {
    return null;
  }
  return { leadOffset: match.index + match[1]!.length, fragment: match[2]!.slice(1), token: match[2]! };
}
