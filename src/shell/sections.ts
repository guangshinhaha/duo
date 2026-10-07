import type { ChatSection, RoomSummary, WorkspaceConnection } from "../workspace/matrix.js";

/**
 * #296: the owner's own sidebar folders — a project, a team, whatever
 * grouping matches how they work, on top of the sidebar's own Channels /
 * Direct messages / Duos shelves (`ChatList.tsx`'s `sectionsOf`, #208 — a
 * different, unrelated "section" that this module never touches). This is
 * the CRUD half: pure functions over a `ChatSection[]`, so every edit
 * (made, renamed, reordered, deleted, a conversation moved in or out) is
 * one easily-tested transform with no I/O of its own.
 *
 * Persistence is `matrix.ts`'s `sections()`/`setSections()` — this
 * account's own data (`duo.sidebar.sections`), read and written over the
 * one seam that may speak matrix-js-sdk (`WorkspaceMatrixSeam.test.ts`'s
 * scan). That is deliberate, not an oversight: the issue asks for folders
 * that "sync across devices", and this account already has a door for
 * exactly that shape of fact (`m.direct`, `duo.notifications`,
 * `m.marked_unread`) — a second, device-local store next to it would be a
 * folder that disagrees with itself the moment the owner opens a second
 * device. `loadSections`/`saveSections`/`watchSections` below are the thin
 * binding onto that door, tolerant of a connection built before #296
 * (`sections`/`setSections`/`subscribeSections` are optional on
 * `WorkspaceConnection`, same reasoning as `sendTyping` — see matrix.ts).
 */

/** This device's own transient id for a folder — the stable identity `moveRoomToSection` and friends address, never shown. */
let localSeq = 0;
function newSectionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  localSeq += 1;
  return `section-${Date.now()}-${localSeq}`;
}

/** A name worth keeping — trimmed, and never empty (an empty folder name is not a folder, it's a mistake). Null when there's nothing to save. */
export function normalizedSectionName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
}

/** Appends a new, empty folder at the end of the owner's own order. Null `name` (after trimming) makes no change. */
export function createSection(sections: readonly ChatSection[], name: string): readonly ChatSection[] {
  const normalized = normalizedSectionName(name);
  if (normalized === null) {
    return sections;
  }
  return [...sections, { id: newSectionId(), name: normalized, collapsed: false, roomIds: [] }];
}

/** Renames a folder in place — its order and membership untouched. A blank name (after trimming) makes no change, same as `createSection`. */
export function renameSection(sections: readonly ChatSection[], id: string, name: string): readonly ChatSection[] {
  const normalized = normalizedSectionName(name);
  if (normalized === null) {
    return sections;
  }
  return sections.map((section) => (section.id === id ? { ...section, name: normalized } : section));
}

/** Deletes a folder. Its conversations are never deleted — they simply have no folder again, back on the sidebar's ordinary shelves. */
export function deleteSection(sections: readonly ChatSection[], id: string): readonly ChatSection[] {
  return sections.filter((section) => section.id !== id);
}

/** Shows or hides a folder's own rows — synced like the rest of the record, so collapsing one on a Mac collapses it on the phone too. */
export function setSectionCollapsed(sections: readonly ChatSection[], id: string, collapsed: boolean): readonly ChatSection[] {
  return sections.map((section) => (section.id === id ? { ...section, collapsed } : section));
}

/** Moves a folder one place earlier or later in the owner's own order. Past either end, nothing moves. */
export function moveSection(sections: readonly ChatSection[], id: string, direction: "up" | "down"): readonly ChatSection[] {
  const at = sections.findIndex((section) => section.id === id);
  const to = at + (direction === "up" ? -1 : 1);
  if (at === -1 || to < 0 || to >= sections.length) {
    return sections;
  }
  const next = [...sections];
  [next[at], next[to]] = [next[to]!, next[at]!];
  return next;
}

/**
 * Puts a conversation in exactly one folder, or none. A room belongs to at
 * most one folder — the single-placement rule Slack's own sections keep —
 * so moving it into `targetSectionId` takes it out of every other folder
 * first; moving it to `null` ungroups it back to the sidebar's ordinary
 * shelves. Lands at the end of the target folder's own order. A target id
 * that names no folder leaves the set unchanged — never a silent no-op
 * disguised as a move.
 */
export function moveRoomToSection(sections: readonly ChatSection[], roomId: string, targetSectionId: string | null): readonly ChatSection[] {
  if (targetSectionId !== null && !sections.some((section) => section.id === targetSectionId)) {
    return sections;
  }
  const withoutRoom = sections.map((section) => ({ ...section, roomIds: section.roomIds.filter((id) => id !== roomId) }));
  if (targetSectionId === null) {
    return withoutRoom;
  }
  return withoutRoom.map((section) => (section.id === targetSectionId ? { ...section, roomIds: [...section.roomIds, roomId] } : section));
}

/** The folder a conversation currently lives in, or null when it's on the sidebar's ordinary shelves. */
export function sectionIdForRoom(sections: readonly ChatSection[], roomId: string): string | null {
  return sections.find((section) => section.roomIds.includes(roomId))?.id ?? null;
}

/** Every room id any folder claims — what the sidebar removes from its ordinary Channels/Direct messages/Duos shelves before grouping the rest (`ChatList.tsx`). */
export function roomIdsInSections(sections: readonly ChatSection[]): ReadonlySet<string> {
  return new Set(sections.flatMap((section) => section.roomIds));
}

/**
 * A folder's own unread count (AC3): the sum of its member conversations'
 * own unread counts, the same number each row already shows next to its
 * own name (`RoomSummary.unread.notifications`) — a folder's badge is never
 * a second opinion about what's unread, only a total of what the rows
 * beneath it already say. A room the folder still names but this account
 * has left (or never loaded) simply isn't counted — `roomsById` is the
 * truth of what currently exists.
 */
export function sectionUnreadCount(section: ChatSection, roomsById: ReadonlyMap<string, RoomSummary>): number {
  let total = 0;
  for (const roomId of section.roomIds) {
    total += roomsById.get(roomId)?.unread.notifications ?? 0;
  }
  return total;
}

/**
 * This account's folders, as the workspace currently has them. `null` (no
 * connection yet) and a connection built before #296 (no `sections` door)
 * both answer the same way as an account that has simply never made one:
 * an empty list, never a throw the sidebar would need to guard against.
 */
export async function loadSections(connection: WorkspaceConnection | null): Promise<readonly ChatSection[]> {
  if (!connection?.sections) {
    return [];
  }
  return connection.sections();
}

/** Writes the whole set back. A connection with no `setSections` door silently keeps the edit in memory only — same "degrade, don't throw" stance as `loadSections`. */
export async function saveSections(connection: WorkspaceConnection | null, sections: readonly ChatSection[]): Promise<void> {
  if (!connection?.setSections) {
    return;
  }
  await connection.setSections(sections);
}

/** Hears this account's folders change on another device. Returns a no-op unsubscribe where the connection (or an older one) has no such door. */
export function watchSections(connection: WorkspaceConnection | null, handler: (sections: readonly ChatSection[]) => void): () => void {
  if (!connection?.subscribeSections) {
    return () => {};
  }
  return connection.subscribeSections(handler);
}
