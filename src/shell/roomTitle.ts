import { duoOwnerLabel, duoOwnerUserIdOf, isDuoUserId, localpartOf } from "../workspace/identity.js";
import type { RoomMemberRef, RoomSummary } from "../workspace/matrix.js";

/**
 * The title a room reads under (#245): its name when it has one, its joined
 * members when it doesn't (a direct conversation IS its members), the
 * members it's still waiting on an invite to answer when there are no
 * joined ones, matrix-js-sdk's own generated name (heroes, including
 * members who've since left) when none of those found anything, and a
 * plain "Conversation" as the true last resort — NEVER the raw room id,
 * which reads as nothing a person recognizes. Pure presentation over the
 * projection — the chat list, the room and the thread all read from here,
 * so they can never title one room two ways.
 */
export function roomTitle(room: RoomSummary): string {
  if (room.name !== null) {
    return room.name;
  }
  const joinedNames = room.members.map((member) => member.name ?? localpartOf(member.userId));
  if (joinedNames.length > 0) {
    return joinedNames.join(", ");
  }
  const invitedNames = (room.invitedMembers ?? []).map((member) => member.name ?? localpartOf(member.userId));
  if (invitedNames.length > 0) {
    return invitedNames.join(", ");
  }
  return room.generatedName ?? "Conversation";
}

/**
 * "{owner}'s duo" for every duo riding in a room — attributed to the owner
 * the member id grammar names (vocabulary.md: a duo is attributed
 * structurally, never by a name it chose), shown under the owner's OWN
 * display name when the projection found one (#208) and the grammar's own
 * label (the owner's localpart) when it didn't — never a raw id either way.
 */
export function roomDuoLabels(room: RoomSummary): string[] {
  return room.members
    .filter((member) => isDuoUserId(member.userId))
    .map((member) => `${member.ownerName ?? duoOwnerLabel(member.userId) ?? localpartOf(member.userId)}'s duo`);
}

/** A room that is one colleague's duo and nobody else — it reads as that duo, by the id grammar's label. */
export function soleDuoLabel(room: RoomSummary): string | null {
  if (room.name !== null || room.members.length === 0 || !room.members.every((member) => isDuoUserId(member.userId))) {
    return null;
  }
  return roomDuoLabels(room).join(", ");
}

/**
 * #247: a duo must never be listed as a second speaker beside the person it
 * belongs to — a sidebar preview attributes its latest word to the OWNER,
 * with a marker, only when the duo actually sent it. Null whenever the
 * latest message wasn't from a duo (including when `latest` carries no
 * `senderId` at all — a hand-built fixture, never the live projection), so
 * a caller never has to re-derive "was this a duo" itself.
 */
export function latestMessageDuoLabel(room: RoomSummary): string | null {
  const senderId = room.latest?.senderId;
  if (senderId === undefined || !isDuoUserId(senderId)) {
    return null;
  }
  const sender = room.members.find((member) => member.userId === senderId);
  return `${sender?.ownerName ?? duoOwnerLabel(senderId) ?? localpartOf(senderId)}'s duo`;
}

/** One row of a room's member list, grouped the way #247 reads them (below). */
export interface AttachedMember {
  readonly member: RoomMemberRef;
  /** This member's own duo is also riding in the room — show the badge and the "Ask their duo" action on their row. */
  readonly duoHere: boolean;
}

/** A duo riding in a room whose owner ISN'T a member of it — the quiet "Duos" group at the bottom. */
export interface UnattachedDuo {
  readonly member: RoomMemberRef;
  /** "{owner}'s duo", or "Your duo" when this member themself owns it (they never appear in `room.members`, which lists everyone BUT the viewer). */
  readonly label: string;
}

/**
 * #247: a room's member list read as one row per PERSON, a duo attached to
 * its owner's row when the owner is also here, and grouped separately,
 * quietly, when it isn't — "a colleague's duo belongs to that colleague,
 * not a second person in the list." `selfId` is the viewing member's own id
 * (never itself a member of `room.members` — #63's own rule), so their own
 * duo riding alongside them in a group still reads as "Your duo" rather
 * than by a display name nobody set for this purpose.
 */
export function groupRoomMembers(room: RoomSummary, selfId: string | null): { people: readonly AttachedMember[]; duos: readonly UnattachedDuo[] } {
  const duoMembers = room.members.filter((member) => isDuoUserId(member.userId));
  const ownersWithDuoHere = new Set(duoMembers.map((duo) => duoOwnerUserIdOf(duo.userId)).filter((owner): owner is string => owner !== null));
  const people = room.members
    .filter((member) => !isDuoUserId(member.userId))
    .map((member): AttachedMember => ({ member, duoHere: ownersWithDuoHere.has(member.userId) }));
  const peopleIds = new Set(people.map((entry) => entry.member.userId));
  const duos = duoMembers
    .filter((duo) => {
      const ownerId = duoOwnerUserIdOf(duo.userId);
      return ownerId === null || !peopleIds.has(ownerId);
    })
    .map((member): UnattachedDuo => {
      const ownerId = duoOwnerUserIdOf(member.userId);
      const label = ownerId !== null && ownerId === selfId ? "Your duo" : `${member.ownerName ?? duoOwnerLabel(member.userId) ?? localpartOf(member.userId)}'s duo`;
      return { member, label };
    });
  return { people, duos };
}
