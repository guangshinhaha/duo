import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveArrival, RoomSummary, WorkspaceConnection } from "../src/workspace/matrix.js";
import { roomHref } from "../src/workspace/links.js";

/*
 * #221: `dispatchArrival` (App.tsx) is the one place that decides whether a
 * live arrival interrupts — the same decision a Tauri notification has
 * always obeyed and the one a browser notification now rides on top of
 * (notifications.ts's `postNotification` is the only thing downstream of
 * it that differs by shell). These tests exercise that gate directly, with
 * `postNotification` mocked out, rather than re-deriving the per-room mode
 * rules a second time against a browser-only stand-in.
 */
vi.mock("../src/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notifications.js")>();
  return { ...actual, postNotification: vi.fn() };
});

import { postNotification } from "../src/notifications.js";
import { dispatchArrival } from "../src/App.js";

const postNotificationMock = vi.mocked(postNotification);

const ME = "@me:workspace.example";
const ROOM_ID = "!project-x:workspace.example";

function room(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    roomId: ROOM_ID,
    kind: "group",
    name: "project-x",
    members: [],
    latest: null,
    unread: { notifications: 0, mentions: 0 },
    muted: false,
    notifications: "all",
    ...overrides,
  };
}

function arrival(overrides: Partial<LiveArrival> = {}): LiveArrival {
  return { senderId: "@bob:workspace.example", senderName: "Bob", body: "ship it", mentionsMe: false, ...overrides };
}

function connectionWith(rooms: readonly RoomSummary[]): WorkspaceConnection {
  return { userId: ME, rooms: async () => rooms } as unknown as WorkspaceConnection;
}

describe("dispatchArrival — the per-room notification level a browser notification now obeys too (#221)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "";
    postNotificationMock.mockClear();
  });
  afterEach(() => {
    localStorage.clear();
    window.location.hash = "";
  });

  it("notifies for a message in an 'all' room", async () => {
    const connection = connectionWith([room({ notifications: "all" })]);
    await dispatchArrival(connection, ROOM_ID, arrival());
    expect(postNotificationMock).toHaveBeenCalledTimes(1);
    const [body, hash] = postNotificationMock.mock.calls[0]!;
    expect(body).toBe("Bob in project-x: ship it");
    expect(hash).toBe(roomHref(ROOM_ID));
  });

  it("never notifies for a muted ('nothing') room", async () => {
    const connection = connectionWith([room({ notifications: "nothing", muted: true })]);
    await dispatchArrival(connection, ROOM_ID, arrival());
    expect(postNotificationMock).not.toHaveBeenCalled();
  });

  it("in a 'mentions' room, does not notify when the message doesn't mention me", async () => {
    const connection = connectionWith([room({ notifications: "mentions" })]);
    await dispatchArrival(connection, ROOM_ID, arrival({ mentionsMe: false }));
    expect(postNotificationMock).not.toHaveBeenCalled();
  });

  it("in a 'mentions' room, notifies when the message does mention me", async () => {
    const connection = connectionWith([room({ notifications: "mentions" })]);
    await dispatchArrival(connection, ROOM_ID, arrival({ mentionsMe: true }));
    expect(postNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("never notifies about the member's own message, from any device", async () => {
    const connection = connectionWith([room({ notifications: "all" })]);
    await dispatchArrival(connection, ROOM_ID, arrival({ senderId: ME }));
    expect(postNotificationMock).not.toHaveBeenCalled();
  });

  it("does not notify about the conversation already open on screen", async () => {
    window.location.hash = roomHref(ROOM_ID);
    const connection = connectionWith([room({ notifications: "all" })]);
    await dispatchArrival(connection, ROOM_ID, arrival());
    expect(postNotificationMock).not.toHaveBeenCalled();
  });

  it("does nothing for room news with no arrival (an edit or a reaction)", async () => {
    const connection = connectionWith([room({ notifications: "all" })]);
    await dispatchArrival(connection, ROOM_ID, undefined);
    expect(postNotificationMock).not.toHaveBeenCalled();
  });
});
