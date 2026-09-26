/**
 * The workspace surfaces' addresses (#64, #70): a conversation and a thread
 * are each their own hash route, and a search hit is an address INTO them —
 * the conversation (or thread) plus the event to land at. Every segment is
 * encoded whole, so the first `/` after a prefix is the grammar's own
 * separator; App.tsx's `routeFromHash` reads the same shape back.
 *
 *   #room/<room>                 the conversation, at its latest
 *   #room/<room>/<event>         the conversation, in context around an event
 *   #thread/<room>/<root>        a thread
 *   #thread/<room>/<root>/<event>  a thread, with one reply marked
 */

/** A conversation's own address — optionally landing at one of its events, in context (#70). */
export function roomHref(roomId: string, at?: string): string {
  return `#room/${encodeURIComponent(roomId)}${at === undefined ? "" : `/${encodeURIComponent(at)}`}`;
}

/** A thread's own address: both halves encoded whole, the grammar is the route's (#64) — optionally marking one reply (#70). */
export function threadHref(roomId: string, rootEventId: string, at?: string): string {
  return `#thread/${encodeURIComponent(roomId)}/${encodeURIComponent(rootEventId)}${at === undefined ? "" : `/${encodeURIComponent(at)}`}`;
}
