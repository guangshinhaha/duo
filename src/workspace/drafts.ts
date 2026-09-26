import { useQuery } from "@tanstack/react-query";
import type { DraftProvenance } from "../api/types.js";
import type { WorkspaceConnection } from "./matrix.js";

/**
 * #68: a message that arrived in a conversation here can have a draft
 * waiting for its owner, and the draft has to be findable from that
 * conversation. The daemon writes the draft with the conversation and the
 * message as its channel provenance (digital-duo #169) — the message's own
 * permalink is the address it records. This module reads that address; it
 * never decides what kind of draft it is looking at. The channel kind is
 * the daemon's string and is not consulted (#43: nothing here is keyed on
 * it): a draft "belongs to a conversation" exactly when its permalink
 * names one, whatever the daemon calls the channel.
 */

/** Where in the workspace a draft's provenance points: the conversation, and the message when the address names one. */
export interface DraftConversation {
  readonly roomId: string;
  readonly eventId: string | null;
}

/**
 * The conversation (and message) a draft's provenance addresses — read
 * from a `matrix.to` permalink, the spec's own address for a room and an
 * event, so the grammar is the platform's, not ours. Anything that is not
 * such an address — an owner-asked draft, a row that predates provenance,
 * no permalink, a room alias (only a room id names a conversation
 * unambiguously), another site, a malformed escape — reads as no
 * conversation at all, and the draft stays exactly where it always was:
 * Review.
 */
export function conversationOf(provenance: DraftProvenance | undefined): DraftConversation | null {
  // `undefined` is the persisted cache being older than the field, the
  // same belt every provenance reader wears.
  if (provenance?.origin !== "channel" || provenance.permalink === null) {
    return null;
  }
  try {
    const url = new URL(provenance.permalink);
    if (url.hostname !== "matrix.to") {
      return null;
    }
    // "#/!room:server/$event?via=server" — the fragment is the address.
    const address = url.hash.replace(/^#\//, "").split("?")[0] ?? "";
    const [room, event] = address.split("/");
    const roomId = decodeURIComponent(room ?? "");
    if (!roomId.startsWith("!")) {
      return null;
    }
    const eventId = event === undefined ? "" : decodeURIComponent(event);
    return { roomId, eventId: eventId.startsWith("$") ? eventId : null };
  } catch {
    return null;
  }
}

/** A conversation's own address — the route Conversations' entries link to. */
export function roomHref(roomId: string): string {
  return `#room/${encodeURIComponent(roomId)}`;
}

/**
 * Where a draft's conversation opens, for the surfaces that show a draft
 * away from it (Review, a draft's own page). The link exists only when
 * this member actually holds the conversation — the same rooms read every
 * workspace surface shares (one cache entry) — so it never leads to a room
 * the workspace would refuse. No connection, or a room that is not among
 * the member's, is no link; the provenance line still says where it came
 * from.
 */
export function useConversationLink(
  connection: WorkspaceConnection | null,
): (provenance: DraftProvenance | undefined) => string | undefined {
  const rooms = useQuery({
    queryKey: ["workspace", "rooms"],
    queryFn: () => connection!.rooms(),
    enabled: connection !== null,
    meta: { target: "workspace" },
  });
  return (provenance) => {
    const conversation = conversationOf(provenance);
    if (conversation === null || !rooms.data?.some((room) => room.roomId === conversation.roomId)) {
      return undefined;
    }
    return roomHref(conversation.roomId);
  };
}
