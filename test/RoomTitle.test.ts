import { describe, expect, it } from "vitest";
import { roomDuoLabels, roomTitle, soleDuoLabel } from "../src/shell/roomTitle.js";
import type { RoomSummary } from "../src/workspace/matrix.js";

/*
 * #208: the sidebar's presentation layer over the projection. These pin the
 * two facts the issue's root causes named directly:
 *   1. A duo's chip is the owner's real name when the projection found one,
 *      the id grammar's own label when it didn't — never a raw id either way.
 *   2. An unnamed room's title falls back to its members, which is what
 *      lets `projectRoom`'s honestly-null `name` (#208's other fix) still
 *      read as something sensible rather than as a bare `null`.
 */

function room(over: Partial<RoomSummary> = {}): RoomSummary {
  return {
    roomId: "!r:workspace.example",
    kind: "group",
    name: null,
    topic: null,
    avatarUrl: null,
    members: [],
    latest: null,
    unread: { notifications: 0, mentions: 0 },
    muted: false,
    notifications: "all",
    canEdit: { name: false, topic: false, avatar: false },
    ...over,
  };
}

describe("roomTitle — the one place every surface reads a room's title from", () => {
  it("a named room reads under its own name", () => {
    expect(roomTitle(room({ name: "project-x" }))).toBe("project-x");
  });

  it("an unnamed room — real name null, not just absent — reads under its members, joined", () => {
    expect(
      roomTitle(
        room({
          name: null,
          members: [
            { userId: "@ana:workspace.example", name: "Ana" },
            { userId: "@bose:workspace.example", name: "Bose" },
          ],
        }),
      ),
    ).toBe("Ana, Bose");
  });

  it("a member with no name on record reads under its localpart, never a raw id with the server appended", () => {
    expect(roomTitle(room({ name: null, members: [{ userId: "@eeyore:workspace.example", name: null }] }))).toBe("eeyore");
  });

  it("a room with no name and no other members reads under its own id — the last resort, never a blank", () => {
    expect(roomTitle(room({ roomId: "!empty:workspace.example", name: null, members: [] }))).toBe("!empty:workspace.example");
  });
});

describe("roomDuoLabels — a duo's chip, attributed to its owner (#208)", () => {
  it("shows the owner's real display name when the projection found one", () => {
    const labels = roomDuoLabels(
      room({ members: [{ userId: "@duo-carol:workspace.example", name: "duo-carol", ownerName: "Carol Chen" }] }),
    );
    expect(labels).toEqual(["Carol Chen's duo"]);
  });

  it("falls back to the id grammar's own label when no owner name was found — never the duo's own display name, and never a raw id", () => {
    const labels = roomDuoLabels(
      room({ members: [{ userId: "@duo-carol:workspace.example", name: "Totally A Person" }] }),
    );
    expect(labels).toEqual(["carol's duo"]);
    expect(labels.join()).not.toContain("Totally A Person");
  });

  it("a person riding beside a duo in the same room never gets a chip", () => {
    const labels = roomDuoLabels(
      room({
        members: [
          { userId: "@bose:workspace.example", name: "Bose" },
          { userId: "@duo-carol:workspace.example", name: "duo-carol", ownerName: "Carol Chen" },
        ],
      }),
    );
    expect(labels).toEqual(["Carol Chen's duo"]);
  });
});

describe("soleDuoLabel — a room that IS one colleague's duo and nobody else", () => {
  it("reads as that duo's owner name when every member is duo-shaped and the owner's name is known", () => {
    expect(
      soleDuoLabel(room({ members: [{ userId: "@duo-carol:workspace.example", name: "duo-carol", ownerName: "Carol Chen" }] })),
    ).toBe("Carol Chen's duo");
  });

  it("is null once the room has its own name, or has anyone who isn't duo-shaped", () => {
    expect(soleDuoLabel(room({ name: "project-x", members: [{ userId: "@duo-carol:workspace.example", name: "duo-carol" }] }))).toBeNull();
    expect(
      soleDuoLabel(
        room({
          members: [
            { userId: "@bose:workspace.example", name: "Bose" },
            { userId: "@duo-carol:workspace.example", name: "duo-carol" },
          ],
        }),
      ),
    ).toBeNull();
  });
});
