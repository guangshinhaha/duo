import type { RoomSummary } from "./workspace/matrix.js";
import { localpartOf } from "./workspace/identity.js";
import { plainPreview } from "./workspace/duoAnswer.js";
import { SIDEBAR_SUMMARY_UNREAD_THRESHOLD } from "./catchUpThresholds.js";

/**
 * duo#281: the sidebar's one-line gist. Deliberately client-side and free
 * of any daemon call — the chat list only ever holds one message per room
 * (`RoomSummary.latest`, #247's own field), never the unread backlog
 * #280's catch-up card gets by reading an opened room's loaded timeline,
 * so there is nothing here to send an inference provider that would be
 * more than that one message already says. Asking the daemon to
 * summarize "the latest message" for every room over the unread threshold,
 * on every list render, would also be exactly the fan-out cost #280's own
 * card avoids by living inside one opened room at a time. A real
 * multi-message LLM gist for the list would need the daemon to hold (or
 * the client to fetch) each room's unread backlog up front — a materially
 * bigger change than this issue's own threshold-gated one-liner asks for.
 *
 * What this derives instead: how many are unread, and a clean preview of
 * the newest one, attributed to whoever sent it — the same facts the
 * ordinary preview line already shows, read together as a gist rather
 * than shown as a quote. Labelled "✦ Summary:" so it is never mistaken
 * for the message itself (#281 AC "Clearly labelled as a summary, not a
 * message").
 */

function senderLabel(room: RoomSummary, senderId: string | undefined): string | null {
  if (senderId === undefined) {
    return null;
  }
  const member = room.members.find((candidate) => candidate.userId === senderId);
  return member?.name ?? localpartOf(senderId);
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Null below the threshold, or with nothing to summarize — the caller falls back to the ordinary preview line exactly as it always has. */
export function oneLineUnreadSummary(room: RoomSummary): string | null {
  if (room.unread.notifications < SIDEBAR_SUMMARY_UNREAD_THRESHOLD || room.latest === null) {
    return null;
  }
  const from = senderLabel(room, room.latest.senderId);
  const snippet = truncate(plainPreview(room.latest.body), 72);
  const count = `${room.unread.notifications} unread`;
  return from ? `${count} — latest from ${from}: “${snippet}”` : `${count} — “${snippet}”`;
}
