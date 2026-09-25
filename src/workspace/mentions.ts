import { duoOwnerLabel, isDuoUserId, localpartOf } from "./identity.js";

/**
 * #65: the rich half of mentioning, on top of the offer and the ids-only
 * wire #112 shipped. The spec's pill convention (client-server API §User
 * and room mentions, verified against v1.15): the plain `body` carries
 * each pill's text where the link sits — "@carol's duo" in this client's
 * idiom, the "@" the composer's pick leaves in the words — the
 * `formatted_body` carries the same words with each mention as a matrix.to
 * permalink anchor, and `m.mentions.user_ids` carries the ids — the list
 * the server's `.m.rule.is_user_mention` push rule reads to raise the
 * mentioned member's highlight count, which is what the conversation
 * list's mention badge shows. Every send carries `m.mentions`, empty when
 * nothing is mentioned: the spec recommends it on each event so the
 * legacy display-name push rules can't fire on a message that merely
 * contains a name.
 *
 * This module is pure on purpose: the seam (matrix.ts) uses it to build
 * and read the wire shape, the Room route uses it to render pills, and
 * neither needs the other to do so. It imports nothing from the SDK — the
 * importer-walk contract keeps holding.
 */

/**
 * One mention the composer is sending: the mentioned user's id, and the
 * bare label the offer picked ("carol's duo", "Carol" — no "@"). For a duo
 * the label is ALWAYS derived from the id's grammar at the seam — the
 * claim the caller passes is advisory only.
 */
export interface MessageMention {
  readonly userId: string;
  readonly label: string;
}

/**
 * One piece of a message body as it renders (#65): words, or a mention
 * pill. `RoomMessage.parts` carries these when the message was sent with
 * mention anchors, and is null when the body is plain words — the render
 * degrades to the plain body rather than guessing pills.
 */
export type MessagePart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "mention"; readonly userId: string; readonly label: string };

/** One matrix.to user-permalink anchor found in a formatted body, in order. */
export interface MentionAnchor {
  readonly userId: string;
  /** The anchor's text as sent — the words the body was supposed to carry at that position. */
  readonly text: string;
}

/**
 * The bare label a mention renders under. A duo's label is the id's
 * grammar (`@duo-carol` → "carol's duo") — never a display name or a
 * sender's claim, the same structural rule message attribution has always
 * followed (#60). A person's label is whatever the caller resolved (room
 * membership, else the anchor's text), falling back to the localpart only
 * when nothing claimed anything.
 */
export function mentionLabelOf(userId: string, claimedLabel: string): string {
  if (isDuoUserId(userId)) {
    return `${duoOwnerLabel(userId) ?? claimedLabel}'s duo`;
  }
  return claimedLabel || localpartOf(userId);
}

/** The three escapable characters an HTML text node cares about — nothing more is produced here. */
const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const unescapeHtml = (text: string): string =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * The words a pill occupies in the body: the label, addressed — this
 * client's picks land in the text as "@carol's duo", so the anchor's text
 * is the addressed form and the spec's rule ("the anchor's text is the
 * body's text there") holds on both halves. The "@" rule lives here and
 * nowhere else — the composer's picks, the wire's anchors, and the
 * rendered pill all splice it through this one helper.
 */
export const addressed = (userId: string, label: string): string => `@${mentionLabelOf(userId, label)}`;

function anchorOf(userId: string, text: string): string {
  return `<a href="https://matrix.to/#/${userId}">${escapeHtml(text)}</a>`;
}

/**
 * The wire shape of a mentioning message's HTML half, or null when no
 * mention's words occur in the body (nothing to anchor — the mention ids
 * still ride `m.mentions`). Each mention's next in-order occurrence is
 * wrapped in its matrix.to anchor; the walk is left-to-right so two
 * mentions can't claim the same words. A duo's anchor text is derived
 * from its id here — the caller's label is advisory only.
 */
export function formattedBodyWithMentions(body: string, mentions: readonly MessageMention[]): string | null {
  const pieces: string[] = [];
  let at = 0;
  let anchored = false;
  for (const mention of mentions) {
    const words = addressed(mention.userId, mention.label);
    const found = body.indexOf(words, at);
    if (found < 0) {
      continue; // the words aren't in the body — the id still rides m.mentions
    }
    pieces.push(escapeHtml(body.slice(at, found)), anchorOf(mention.userId, words));
    at = found + words.length;
    anchored = true;
  }
  if (!anchored) {
    return null;
  }
  pieces.push(escapeHtml(body.slice(at)));
  return pieces.join("");
}

/**
 * The user-permalink anchors of a formatted body, in order — the pills the
 * message was sent with. Both quote styles are accepted (the spec's own
 * example uses single quotes); percent-encoded ids decode; anchors to
 * anything but a user (`#room`/`!room` permalinks) are links, not
 * mentions, and don't collect.
 */
export function mentionAnchorsFrom(formattedBody: string | undefined): readonly MentionAnchor[] {
  if (!formattedBody) {
    return [];
  }
  const anchors: MentionAnchor[] = [];
  for (const match of formattedBody.matchAll(/<a href=["']https:\/\/matrix\.to\/#\/([^"']+)["']>([^<]*)<\/a>/g)) {
    let userId = match[1]!;
    try {
      userId = decodeURIComponent(userId);
    } catch {
      // A malformed escape sequence stays as-is — it won't match a member id and the projection drops it.
    }
    if (!userId.startsWith("@")) {
      continue;
    }
    anchors.push({ userId, text: unescapeHtml(match[2]!) });
  }
  return anchors;
}

/**
 * The body in parts, split at each anchor's text (the spec's rule: the
 * anchor's text component is what sits in `body`), each mention part
 * carrying its bare label from `labelOf`. All-or-nothing by design: if
 * any anchor's text doesn't occur in the body from the walk's position,
 * the message renders as plain words — never a wrong set of pills.
 */
export function partsFromBody(
  body: string,
  anchors: readonly MentionAnchor[],
  labelOf: (anchor: MentionAnchor) => string,
): readonly MessagePart[] | null {
  if (anchors.length === 0) {
    return null;
  }
  const parts: MessagePart[] = [];
  let at = 0;
  for (const anchor of anchors) {
    const found = body.indexOf(anchor.text, at);
    if (found < 0) {
      return null;
    }
    if (found > at) {
      parts.push({ kind: "text", text: body.slice(at, found) });
    }
    parts.push({ kind: "mention", userId: anchor.userId, label: labelOf(anchor) });
    at = found + anchor.text.length;
  }
  if (at < body.length) {
    parts.push({ kind: "text", text: body.slice(at) });
  }
  return parts;
}
