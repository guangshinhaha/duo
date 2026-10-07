import { describe, expect, it } from "vitest";
import type { ChatSection, RoomSummary } from "../src/workspace/matrix.js";
import {
  createSection,
  deleteSection,
  loadSections,
  moveRoomToSection,
  moveSection,
  normalizedSectionName,
  renameSection,
  roomIdsInSections,
  saveSections,
  sectionIdForRoom,
  sectionUnreadCount,
  setSectionCollapsed,
  watchSections,
} from "../src/shell/sections.js";

/*
 * #296: the owner's own sidebar folders — the pure CRUD half
 * (`src/shell/sections.ts`), tested with no connection at all. The
 * persistence binding (`loadSections`/`saveSections`/`watchSections`,
 * against a real `WorkspaceConnection`) is covered here only for its
 * "degrade, don't throw" contract with an unsupporting connection;
 * `test/ChatList.test.tsx` exercises the real round trip through a fake
 * connection that does implement the door.
 */

const section = (overrides: Partial<ChatSection> = {}): ChatSection => ({
  id: "s1",
  name: "Project X",
  collapsed: false,
  roomIds: [],
  ...overrides,
});

describe("normalizedSectionName", () => {
  it("trims, and a blank name (before or after trimming) is nothing to save", () => {
    expect(normalizedSectionName("  Ops  ")).toBe("Ops");
    expect(normalizedSectionName("")).toBeNull();
    expect(normalizedSectionName("   ")).toBeNull();
  });
});

describe("createSection", () => {
  it("appends a new, empty, expanded folder at the end", () => {
    const next = createSection([section({ id: "s1", name: "Ops" })], "  Project X  ");
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ name: "Project X", collapsed: false, roomIds: [] });
    expect(next[1]!.id).not.toBe("s1");
  });

  it("a blank name makes no change at all — never an empty-named folder", () => {
    const sections = [section()];
    expect(createSection(sections, "   ")).toBe(sections);
  });
});

describe("renameSection", () => {
  it("renames in place, order and membership untouched", () => {
    const sections = [section({ id: "a", roomIds: ["!r:w"] }), section({ id: "b", name: "Other" })];
    const next = renameSection(sections, "a", "  Renamed  ");
    expect(next[0]).toMatchObject({ id: "a", name: "Renamed", roomIds: ["!r:w"] });
    expect(next[1]).toEqual(sections[1]);
  });

  it("a blank name makes no change", () => {
    const sections = [section()];
    expect(renameSection(sections, "s1", "  ")).toEqual(sections);
  });
});

describe("deleteSection", () => {
  it("removes the folder — its conversations aren't deleted, they're just unfoldered", () => {
    const sections = [section({ id: "a" }), section({ id: "b" })];
    expect(deleteSection(sections, "a")).toEqual([section({ id: "b" })]);
  });
});

describe("setSectionCollapsed", () => {
  it("flips one folder's own flag, leaving the rest untouched", () => {
    const sections = [section({ id: "a", collapsed: false }), section({ id: "b", collapsed: false })];
    const next = setSectionCollapsed(sections, "a", true);
    expect(next[0]!.collapsed).toBe(true);
    expect(next[1]!.collapsed).toBe(false);
  });
});

describe("moveSection", () => {
  it("swaps with its neighbour in the chosen direction", () => {
    const sections = [section({ id: "a" }), section({ id: "b" }), section({ id: "c" })];
    expect(moveSection(sections, "b", "up").map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(moveSection(sections, "b", "down").map((s) => s.id)).toEqual(["a", "c", "b"]);
  });

  it("does nothing past either end", () => {
    const sections = [section({ id: "a" }), section({ id: "b" })];
    expect(moveSection(sections, "a", "up")).toBe(sections);
    expect(moveSection(sections, "b", "down")).toBe(sections);
  });
});

describe("moveRoomToSection — single placement", () => {
  it("adds a room to a folder it wasn't in", () => {
    const sections = [section({ id: "a", roomIds: [] })];
    expect(moveRoomToSection(sections, "!r:w", "a")[0]!.roomIds).toEqual(["!r:w"]);
  });

  it("moving into a second folder takes it out of the first — one placement, never two", () => {
    const sections = [section({ id: "a", roomIds: ["!r:w"] }), section({ id: "b", roomIds: [] })];
    const next = moveRoomToSection(sections, "!r:w", "b");
    expect(next.find((s) => s.id === "a")!.roomIds).toEqual([]);
    expect(next.find((s) => s.id === "b")!.roomIds).toEqual(["!r:w"]);
  });

  it("moving to null ungroups it back to the ordinary shelves", () => {
    const sections = [section({ id: "a", roomIds: ["!r:w"] })];
    expect(moveRoomToSection(sections, "!r:w", null)[0]!.roomIds).toEqual([]);
  });

  it("a target naming no real folder changes nothing", () => {
    const sections = [section({ id: "a", roomIds: ["!r:w"] })];
    expect(moveRoomToSection(sections, "!r:w", "ghost")).toBe(sections);
  });
});

describe("sectionIdForRoom / roomIdsInSections", () => {
  it("finds which folder (if any) a room is in", () => {
    const sections = [section({ id: "a", roomIds: ["!r:w"] }), section({ id: "b", roomIds: [] })];
    expect(sectionIdForRoom(sections, "!r:w")).toBe("a");
    expect(sectionIdForRoom(sections, "!other:w")).toBeNull();
  });

  it("collects every claimed room id across every folder", () => {
    const sections = [section({ id: "a", roomIds: ["!r1:w", "!r2:w"] }), section({ id: "b", roomIds: ["!r3:w"] })];
    expect(roomIdsInSections(sections)).toEqual(new Set(["!r1:w", "!r2:w", "!r3:w"]));
  });
});

describe("sectionUnreadCount (AC3)", () => {
  const roomSummary = (roomId: string, notifications: number): RoomSummary =>
    ({
      roomId,
      kind: "direct",
      name: null,
      topic: null,
      avatarUrl: null,
      members: [],
      latest: null,
      unread: { notifications, mentions: 0 },
      muted: false,
      notifications: "all",
      canEdit: { name: false, topic: false, avatar: false, pins: false },
    }) as RoomSummary;

  it("sums its own rooms' unread counts, never a second opinion", () => {
    const roomsById = new Map([
      ["!r1:w", roomSummary("!r1:w", 3)],
      ["!r2:w", roomSummary("!r2:w", 1)],
    ]);
    expect(sectionUnreadCount(section({ roomIds: ["!r1:w", "!r2:w"] }), roomsById)).toBe(4);
  });

  it("skips a room id the folder still names but no longer exists", () => {
    const roomsById = new Map([["!r1:w", roomSummary("!r1:w", 2)]]);
    expect(sectionUnreadCount(section({ roomIds: ["!r1:w", "!gone:w"] }), roomsById)).toBe(2);
  });
});

describe("loadSections / saveSections / watchSections — degrade, don't throw", () => {
  it("answer the no-connection and pre-#296-connection cases the same way an account that never made a folder would", async () => {
    expect(await loadSections(null)).toEqual([]);
    expect(await loadSections({} as never)).toEqual([]);
    await expect(saveSections(null, [section()])).resolves.toBeUndefined();
    await expect(saveSections({} as never, [section()])).resolves.toBeUndefined();
    expect(watchSections(null, () => {})()).toBeUndefined();
    expect(watchSections({} as never, () => {})()).toBeUndefined();
  });

  it("a real door is read, written and watched exactly as given", async () => {
    let stored: readonly ChatSection[] = [section()];
    const handlers = new Set<(sections: readonly ChatSection[]) => void>();
    const connection = {
      sections: async () => stored,
      setSections: async (next: readonly ChatSection[]) => {
        stored = next;
      },
      subscribeSections: (handler: (sections: readonly ChatSection[]) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    } as never;

    expect(await loadSections(connection)).toEqual([section()]);
    await saveSections(connection, [section({ name: "Renamed" })]);
    expect(stored).toEqual([section({ name: "Renamed" })]);

    const seen: (readonly ChatSection[])[] = [];
    const unwatch = watchSections(connection, (next) => seen.push(next));
    for (const handler of handlers) {
      handler([section({ id: "fresh" })]);
    }
    expect(seen).toEqual([[section({ id: "fresh" })]]);
    unwatch();
    expect(handlers.size).toBe(0);
  });
});
