import { describe, expect, it } from "vitest";
import type { LaterItem, WorkspaceConnection } from "../src/workspace/matrix.js";
import {
  activeLaterItems,
  addLaterItem,
  dueLaterItems,
  laterPreview,
  loadLater,
  markLaterDone,
  markLaterFired,
  removeLaterItem,
  saveLater,
  snoozeLaterItem,
  watchLater,
} from "../src/shell/later.js";

/*
 * duo#299: "Later" — save a message or your own unsent words, with an
 * optional reminder. The pure CRUD half (`src/shell/later.ts`), tested with
 * no connection at all, the same shape `test/ChatSections.test.ts` already
 * takes for #296's own folders. The persistence binding
 * (`loadLater`/`saveLater`/`watchLater`, against a real `WorkspaceConnection`)
 * is covered here only for its "degrade, don't throw" contract with a
 * connection built before #299; the real round trip is exercised through
 * `matrix.ts`'s own account-data seam test (`test/WorkspaceMatrixSeam.test.ts`).
 */

const item = (overrides: Partial<LaterItem> = {}): LaterItem => ({
  id: "l1",
  kind: "message",
  roomId: "!project-x:workspace.example",
  eventId: "$1",
  senderId: "@bose:workspace.example",
  senderName: "Bose",
  preview: "Ship it by Friday",
  createdAt: "2026-10-01T00:00:00.000Z",
  remindAt: null,
  done: false,
  firedAt: null,
  ...overrides,
});

describe("laterPreview", () => {
  it("trims and passes short text through unchanged", () => {
    expect(laterPreview("  Ship it  ")).toBe("Ship it");
  });

  it("caps a long save at 500 characters with an ellipsis, never a whole essay someone pasted in", () => {
    const long = "x".repeat(600);
    const preview = laterPreview(long);
    expect(preview).toHaveLength(501);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("addLaterItem", () => {
  it("appends a new item, not done, never fired, with the preview trimmed", () => {
    const next = addLaterItem([], {
      kind: "message",
      roomId: "!r:w",
      eventId: "$1",
      senderId: "@bose:w",
      senderName: "Bose",
      preview: "  hello  ",
      remindAt: "2026-10-02T09:00:00.000Z",
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      kind: "message",
      roomId: "!r:w",
      eventId: "$1",
      senderId: "@bose:w",
      senderName: "Bose",
      preview: "hello",
      remindAt: "2026-10-02T09:00:00.000Z",
      done: false,
      firedAt: null,
    });
    expect(typeof next[0]!.id).toBe("string");
    expect(next[0]!.id.length).toBeGreaterThan(0);
  });

  it("a note (the owner's own unsent words) carries no event or sender", () => {
    const [saved] = addLaterItem([], { kind: "note", roomId: "!r:w", eventId: null, senderId: null, senderName: null, preview: "draft reply", remindAt: null });
    expect(saved).toMatchObject({ kind: "note", eventId: null, senderId: null, senderName: null, remindAt: null });
  });
});

describe("markLaterDone / removeLaterItem", () => {
  it("marks one item done, leaving the rest and the record untouched", () => {
    const items = [item({ id: "a" }), item({ id: "b" })];
    const next = markLaterDone(items, "a");
    expect(next.find((i) => i.id === "a")!.done).toBe(true);
    expect(next.find((i) => i.id === "b")!.done).toBe(false);
    expect(next).toHaveLength(2); // still in the record
  });

  it("can also un-mark done", () => {
    const next = markLaterDone([item({ id: "a", done: true })], "a", false);
    expect(next[0]!.done).toBe(false);
  });

  it("removeLaterItem actually drops it", () => {
    expect(removeLaterItem([item({ id: "a" }), item({ id: "b" })], "a")).toEqual([item({ id: "b" })]);
  });
});

describe("snoozeLaterItem", () => {
  it("changes the reminder time and clears any earlier fire", () => {
    const items = [item({ id: "a", remindAt: "2026-10-01T09:00:00.000Z", firedAt: "2026-10-01T09:00:05.000Z" })];
    const next = snoozeLaterItem(items, "a", "2026-10-02T09:00:00.000Z");
    expect(next[0]).toMatchObject({ remindAt: "2026-10-02T09:00:00.000Z", firedAt: null });
  });

  it("can clear the reminder outright with null", () => {
    const next = snoozeLaterItem([item({ id: "a", remindAt: "2026-10-01T09:00:00.000Z" })], "a", null);
    expect(next[0]!.remindAt).toBeNull();
  });
});

describe("markLaterFired", () => {
  it("records when a reminder was shown, so a second device never re-shows it", () => {
    const next = markLaterFired([item({ id: "a" })], "a", "2026-10-01T09:00:01.000Z");
    expect(next[0]!.firedAt).toBe("2026-10-01T09:00:01.000Z");
  });
});

describe("activeLaterItems", () => {
  it("drops done items, and sorts the rest: due/dated first by remind time, then undated by save order", () => {
    const items = [
      item({ id: "undated-1", remindAt: null, createdAt: "2026-10-01T00:00:00.000Z" }),
      item({ id: "done", done: true }),
      item({ id: "dated-late", remindAt: "2026-10-05T00:00:00.000Z" }),
      item({ id: "undated-2", remindAt: null, createdAt: "2026-10-02T00:00:00.000Z" }),
      item({ id: "dated-early", remindAt: "2026-10-03T00:00:00.000Z" }),
    ];
    expect(activeLaterItems(items).map((i) => i.id)).toEqual(["dated-early", "dated-late", "undated-1", "undated-2"]);
  });
});

describe("dueLaterItems", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");

  it("a reminder in the past that hasn't fired is due", () => {
    const due = dueLaterItems([item({ remindAt: "2026-10-10T11:00:00.000Z", firedAt: null })], now);
    expect(due).toHaveLength(1);
  });

  it("a reminder already fired is not due again", () => {
    expect(dueLaterItems([item({ remindAt: "2026-10-10T11:00:00.000Z", firedAt: "2026-10-10T11:00:01.000Z" })], now)).toEqual([]);
  });

  it("a reminder still in the future is not due", () => {
    expect(dueLaterItems([item({ remindAt: "2026-10-10T13:00:00.000Z" })], now)).toEqual([]);
  });

  it("a done item is never due, even past its reminder", () => {
    expect(dueLaterItems([item({ remindAt: "2026-10-10T11:00:00.000Z", done: true })], now)).toEqual([]);
  });

  it("no reminder at all is never due", () => {
    expect(dueLaterItems([item({ remindAt: null })], now)).toEqual([]);
  });
});

describe("loadLater / saveLater / watchLater — degrade, don't throw", () => {
  it("a null connection, or one with no `later` door, reads as an empty list", async () => {
    expect(await loadLater(null)).toEqual([]);
    expect(await loadLater({} as WorkspaceConnection)).toEqual([]);
  });

  it("a connection with no `setLater` door silently keeps the write in memory only", async () => {
    await expect(saveLater({} as WorkspaceConnection, [item()])).resolves.toBeUndefined();
  });

  it("a connection with no `subscribeLater` door returns a safe no-op unsubscribe", () => {
    const unsubscribe = watchLater({} as WorkspaceConnection, () => {});
    expect(() => unsubscribe()).not.toThrow();
  });

  it("a real connection's doors are called through", async () => {
    const items = [item()];
    const later = async () => items;
    const setLater = async () => undefined;
    const subscribeLater = () => () => undefined;
    const connection = { later, setLater, subscribeLater } as unknown as WorkspaceConnection;
    expect(await loadLater(connection)).toBe(items);
    await expect(saveLater(connection, items)).resolves.toBeUndefined();
    expect(watchLater(connection, () => {})).toBeInstanceOf(Function);
  });
});
