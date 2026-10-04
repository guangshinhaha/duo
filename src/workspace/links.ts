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
 *
 * `messagePermalink` is a different kind of address: not this app's own
 * route, but the platform's own `matrix.to` grammar (#225) — what a member
 * hands to a colleague, in Element or Cinny or here, to point at one
 * message. `shell/routes.ts`'s `routeFromHash` reads that grammar back too
 * (`#/!room:server/$event`), the way it already reads every other retired
 * or foreign shape, so a copied link opened against this app lands at the
 * same place a `#chat/<room>/<event>` address would.
 */

/** A conversation's own address — optionally landing at one of its events, in context (#70). */
export function roomHref(roomId: string, at?: string): string {
  return `#chat/${encodeURIComponent(roomId)}${at === undefined ? "" : `/${encodeURIComponent(at)}`}`;
}

/** A thread's own address: both halves encoded whole, the grammar is the route's (#64) — optionally marking one reply (#70). */
export function threadHref(roomId: string, rootEventId: string, at?: string): string {
  return `#chat/${encodeURIComponent(roomId)}/thread/${encodeURIComponent(rootEventId)}${at === undefined ? "" : `/${encodeURIComponent(at)}`}`;
}

/**
 * One message's shareable address (#225): the spec's own `matrix.to`
 * permalink for a room id and an event id — never a room alias, the same
 * "only a room id names a conversation unambiguously" rule
 * `workspace/drafts.ts`'s `conversationOf` already holds for reading one
 * back. `via` names a server that can route to the room, the current
 * revision's own routing hint (without it, a server with no other path to
 * the room can't resolve the link) — the room id's own domain is used,
 * since every room id already carries the server that minted it. Matrix
 * ids are left unencoded in the fragment, matching this codebase's other
 * matrix.to anchors (`mentions.ts`'s user-mention pills): neither a room id
 * nor an event id carries a character that grammar would need escaped.
 */
export function messagePermalink(roomId: string, eventId: string): string {
  const server = roomId.includes(":") ? roomId.slice(roomId.indexOf(":") + 1) : null;
  return `https://matrix.to/#/${roomId}/${eventId}${server ? `?via=${server}` : ""}`;
}
