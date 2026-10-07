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
import { writeNotificationCategoryPrefs } from "../src/notificationCategoryPrefs.js";
import { resetNotificationBatches } from "../src/notificationDispatch.js";

const postNotificationMock = vi.mocked(postNotification);

const ALL_IMMEDIATE = { draftsReady: "immediate", passedOn: "immediate", mentions: "immediate", directMessages: "immediate" } as const;

const ME = "@me:workspace.example";
const ROOM_ID = "!project-x:workspace.example";

function room(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    roomId: ROOM_ID,
    kind: "group",
    name: "project-x",
    topic: null,
    avatarUrl: null,
    members: [],
    latest: null,
    unread: { notifications: 0, mentions: 0 },
    muted: false,
    notifications: "all",
    canEdit: { name: false, topic: false, avatar: false, pins: false },
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

/*
 * #309: on top of the per-room mode above, a mention or a direct message
 * is also one of the four categories Settings exposes. Default
 * (immediate) changes nothing — covered by every case above, which all
 * run with no category preference written.
 */
describe("dispatchArrival — the mentions and direct-messages categories (#309)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "";
    postNotificationMock.mockClear();
  });
  afterEach(() => {
    resetNotificationBatches();
    localStorage.clear();
    window.location.hash = "";
  });

  it("a mention is never sent when the mentions category is off, even in an 'all' room", async () => {
    writeNotificationCategoryPrefs({ ...ALL_IMMEDIATE, mentions: "off" });
    const connection = connectionWith([room({ notifications: "all" })]);
    await dispatchArrival(connection, ROOM_ID, arrival({ mentionsMe: true }));
    expect(postNotificationMock).not.toHaveBeenCalled();
  });

  it("a non-mention message in an 'all' room still notifies when the mentions category is off — it isn't a mention", async () => {
    writeNotificationCategoryPrefs({ ...ALL_IMMEDIATE, mentions: "off" });
    const connection = connectionWith([room({ notifications: "all" })]);
    await dispatchArrival(connection, ROOM_ID, arrival({ mentionsMe: false }));
    expect(postNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("a direct message is never sent when the direct-messages category is off", async () => {
    writeNotificationCategoryPrefs({ ...ALL_IMMEDIATE, directMessages: "off" });
    const connection = connectionWith([room({ kind: "direct", notifications: "all" })]);
    await dispatchArrival(connection, ROOM_ID, arrival({ mentionsMe: false }));
    expect(postNotificationMock).not.toHaveBeenCalled();
  });

  it("a mention inside a direct conversation obeys the mentions setting, not the direct-messages one", async () => {
    writeNotificationCategoryPrefs({ ...ALL_IMMEDIATE, directMessages: "off", mentions: "immediate" });
    const connection = connectionWith([room({ kind: "direct", notifications: "all" })]);
    await dispatchArrival(connection, ROOM_ID, arrival({ mentionsMe: true }));
    expect(postNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("the duo answering on the owner's behalf is neither category, and is unaffected by either setting", async () => {
    writeNotificationCategoryPrefs({ ...ALL_IMMEDIATE, mentions: "off", directMessages: "off" });
    const connection = connectionWith([room({ kind: "direct", notifications: "all" })]);
    await dispatchArrival(connection, ROOM_ID, arrival({ senderId: "@duo-me:workspace.example" }));
    expect(postNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("batched queues a direct message instead of posting it immediately", async () => {
    writeNotificationCategoryPrefs({ ...ALL_IMMEDIATE, directMessages: "batched" });
    const connection = connectionWith([room({ kind: "direct", notifications: "all" })]);
    await dispatchArrival(connection, ROOM_ID, arrival());
    expect(postNotificationMock).not.toHaveBeenCalled();
  });
});
