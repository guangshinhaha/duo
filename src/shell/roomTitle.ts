import { duoOwnerLabel, isDuoUserId, localpartOf } from "../workspace/identity.js";
import type { RoomSummary } from "../workspace/matrix.js";

/**
 * The title a room reads under: its name when it has one, its members when
 * it doesn't (a direct conversation IS its members), its id as the last
 * resort. Pure presentation over the projection — the chat list, the room
 * and the thread all read from here, so they can never title one room two
 * ways.
 */
export function roomTitle(room: RoomSummary): string {
  if (room.name !== null) {
    return room.name;
  }
  const names = room.members.map((member) => member.name ?? localpartOf(member.userId));
  return names.length > 0 ? names.join(", ") : room.roomId;
}

/**
 * "{owner}'s duo" for every duo riding in a room — read from the member id
 * grammar, never from a name the duo chose (vocabulary.md: a duo is
 * attributed structurally).
 */
export function roomDuoLabels(room: RoomSummary): string[] {
  return room.members
    .filter((member) => isDuoUserId(member.userId))
    .map((member) => `${duoOwnerLabel(member.userId) ?? localpartOf(member.userId)}'s duo`);
}

/** A room that is one colleague's duo and nobody else — it reads as that duo, by the id grammar's label. */
export function soleDuoLabel(room: RoomSummary): string | null {
  if (room.name !== null || room.members.length === 0 || !room.members.every((member) => isDuoUserId(member.userId))) {
    return null;
  }
  return roomDuoLabels(room).join(", ");
}
