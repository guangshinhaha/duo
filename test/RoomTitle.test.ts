import { describe, expect, it } from "vitest";
import { groupRoomMembers, latestMessageDuoLabel, roomDuoLabels, roomTitle, soleDuoLabel } from "../src/shell/roomTitle.js";
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

  it("a room with no name and no joined members, but someone still sitting on an invite, reads under THAT person — #245", () => {
    expect(
      roomTitle(
        room({
          name: null,
          members: [],
          invitedMembers: [{ userId: "@carol:workspace.example", name: "Carol Chen" }],
        }),
      ),
    ).toBe("Carol Chen");
  });

  it("an invited member with no name on record reads under its localpart too — #245", () => {
    expect(
      roomTitle(room({ name: null, members: [], invitedMembers: [{ userId: "@eeyore:workspace.example", name: null }] })),
    ).toBe("eeyore");
  });

  it("a room with no name, no joined members and no invited ones falls to matrix-js-sdk's own generated name — #245", () => {
    expect(
      roomTitle(room({ name: null, members: [], invitedMembers: [], generatedName: "Empty room (was Guang Shin MOE)" })),
    ).toBe("Empty room (was Guang Shin MOE)");
  });

  it("a room with truly no information — no name, no members ever, no generated name — reads as 'Conversation', NEVER its raw id — #245", () => {
    expect(
      roomTitle(room({ roomId: "!empty:workspace.example", name: null, members: [], invitedMembers: [], generatedName: null })),
    ).toBe("Conversation");
    expect(roomTitle(room({ roomId: "!PWCpfCxbgCgYzydXHH:duo", name: null, members: [] }))).not.toContain("!");
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

describe("latestMessageDuoLabel — #247: a duo speaks only when it actually sent the latest word", () => {
  it("is null when the latest message has no senderId at all (a fixture that predates the field — never crashes, never guesses)", () => {
    expect(latestMessageDuoLabel(room({ latest: { at: 1, body: "hi" } }))).toBeNull();
  });

  it("is null when the latest sender is a person, even with a duo riding in the room", () => {
    expect(
      latestMessageDuoLabel(
        room({
          members: [
            { userId: "@bose:workspace.example", name: "Bose" },
            { userId: "@duo-carol:workspace.example", name: "duo-carol" },
          ],
          latest: { at: 1, body: "lunch?", senderId: "@bose:workspace.example" },
        }),
      ),
    ).toBeNull();
  });

  it("attributes the latest word to the duo's owner, by real name when known, the id grammar's label when not", () => {
    expect(
      latestMessageDuoLabel(
        room({
          members: [{ userId: "@duo-carol:workspace.example", name: "duo-carol", ownerName: "Carol Chen" }],
          latest: { at: 1, body: "ship it", senderId: "@duo-carol:workspace.example" },
        }),
      ),
    ).toBe("Carol Chen's duo");
    expect(
      latestMessageDuoLabel(
        room({
          members: [{ userId: "@duo-carol:workspace.example", name: "duo-carol" }],
          latest: { at: 1, body: "ship it", senderId: "@duo-carol:workspace.example" },
        }),
      ),
    ).toBe("carol's duo");
  });
});

describe("groupRoomMembers — #247: one row per person, a duo attached or grouped separately", () => {
  it("attaches a duo to its owner's row when the owner is in the room — never a second row", () => {
    const { people, duos } = groupRoomMembers(
      room({
        members: [
          { userId: "@carol:workspace.example", name: "Carol" },
          { userId: "@duo-carol:workspace.example", name: "duo-carol", ownerName: "Carol" },
        ],
      }),
      "@ana:workspace.example",
    );
    expect(people).toEqual([{ member: { userId: "@carol:workspace.example", name: "Carol" }, duoHere: true }]);
    expect(duos).toEqual([]);
  });

  it("groups a duo whose owner isn't in the room under its own quiet group, labelled by the owner", () => {
    const { people, duos } = groupRoomMembers(
      room({
        members: [
          { userId: "@bose:workspace.example", name: "Bose" },
          { userId: "@duo-carol:workspace.example", name: "duo-carol", ownerName: "Carol Chen" },
        ],
      }),
      "@ana:workspace.example",
    );
    expect(people).toEqual([{ member: { userId: "@bose:workspace.example", name: "Bose" }, duoHere: false }]);
    expect(duos).toEqual([{ member: { userId: "@duo-carol:workspace.example", name: "duo-carol", ownerName: "Carol Chen" }, label: "Carol Chen's duo" }]);
  });

  it("reads the viewer's own duo as 'Your duo' when it rides alongside them, never by a name nobody set for this purpose", () => {
    const { duos } = groupRoomMembers(
      room({ members: [{ userId: "@duo-ana:workspace.example", name: "duo-ana" }] }),
      "@ana:workspace.example",
    );
    expect(duos).toEqual([{ member: { userId: "@duo-ana:workspace.example", name: "duo-ana" }, label: "Your duo" }]);
  });
});
