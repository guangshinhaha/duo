/**
 * The workspace surfaces' addresses (#64, #70): a conversation and a thread
 * are each their own hash route, and a search hit is an address INTO them —
 * the conversation (or thread) plus the event to land at. Every segment is
 * encoded whole, so the first `/` after a prefix is the grammar's own
 * separator; shell/routes.ts's `routeFromHash` reads the same shape back.
 *
 *   #chat/<room>                 the conversation, at its latest
 *   #chat/<room>/<event>         the conversation, in context around an event
 *   #chat/<room>/thread/<root>   a thread
 *   #chat/<room>/thread/<root>/<event>  a thread, with one reply marked
 *
 * (The pre-chat-first `#room/…` and `#thread/…` forms still resolve — see
 * shell/routes.ts — but nothing here writes them any more.)
 */

/** A conversation's own address — optionally landing at one of its events, in context (#70). */
export function roomHref(roomId: string, at?: string): string {
  return `#chat/${encodeURIComponent(roomId)}${at === undefined ? "" : `/${encodeURIComponent(at)}`}`;
}

/** A thread's own address: both halves encoded whole, the grammar is the route's (#64) — optionally marking one reply (#70). */
export function threadHref(roomId: string, rootEventId: string, at?: string): string {
  return `#chat/${encodeURIComponent(roomId)}/thread/${encodeURIComponent(rootEventId)}${at === undefined ? "" : `/${encodeURIComponent(at)}`}`;
}
