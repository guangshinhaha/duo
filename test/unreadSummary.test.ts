import { describe, expect, it } from "vitest";
import { oneLineUnreadSummary } from "../src/unreadSummary.js";
import { SIDEBAR_SUMMARY_UNREAD_THRESHOLD } from "../src/catchUpThresholds.js";
import type { RoomSummary } from "../src/workspace/matrix.js";

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
    canEdit: { name: false, topic: false, avatar: false, pins: false },
    ...over,
  } as RoomSummary;
}

describe("duo#281 — oneLineUnreadSummary", () => {
  it("is null below the unread threshold", () => {
    const below = room({
      unread: { notifications: SIDEBAR_SUMMARY_UNREAD_THRESHOLD - 1, mentions: 0 },
      latest: { at: 1, body: "let's ship Friday", senderId: "@alice:workspace.example" },
    });
    expect(oneLineUnreadSummary(below)).toBeNull();
  });

  it("is null with no latest message even past the threshold", () => {
    const noLatest = room({ unread: { notifications: SIDEBAR_SUMMARY_UNREAD_THRESHOLD, mentions: 0 }, latest: null });
    expect(oneLineUnreadSummary(noLatest)).toBeNull();
  });

  it("names the unread count and the latest sender, past the threshold", () => {
    const busy = room({
      unread: { notifications: SIDEBAR_SUMMARY_UNREAD_THRESHOLD, mentions: 0 },
      members: [{ userId: "@alice:workspace.example", name: "Alice" }],
      latest: { at: 1, body: "let's ship Friday", senderId: "@alice:workspace.example" },
    });
    const summary = oneLineUnreadSummary(busy);
    expect(summary).toContain(`${SIDEBAR_SUMMARY_UNREAD_THRESHOLD} unread`);
    expect(summary).toContain("Alice");
    expect(summary).toContain("let's ship Friday");
  });

  it("falls back to the sender's localpart when the room has no name for them", () => {
    const busy = room({
      unread: { notifications: SIDEBAR_SUMMARY_UNREAD_THRESHOLD, mentions: 0 },
      members: [],
      latest: { at: 1, body: "hi", senderId: "@bob:workspace.example" },
    });
    expect(oneLineUnreadSummary(busy)).toContain("bob");
  });

  it("truncates a long latest message", () => {
    const longBody = "a".repeat(200);
    const busy = room({
      unread: { notifications: SIDEBAR_SUMMARY_UNREAD_THRESHOLD, mentions: 0 },
      latest: { at: 1, body: longBody, senderId: "@alice:workspace.example" },
    });
    const summary = oneLineUnreadSummary(busy);
    expect(summary!.length).toBeLessThan(longBody.length);
    expect(summary).toContain("…");
  });
});
