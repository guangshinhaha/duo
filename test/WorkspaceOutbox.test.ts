import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingMessages,
  dequeuePendingMessage,
  enqueuePendingMessage,
  outboxKeyOf,
  pendingMessagesInOrder,
  rekeyPendingMessage,
} from "../src/workspace/outbox.js";

/*
 * #289: the device-local record of what `matrix.ts`'s `send()` has handed
 * to the homeserver but not yet had confirmed — the thing that survives a
 * reload when matrix-js-sdk's own in-memory pending-event queue (#209)
 * cannot. This module knows nothing about matrix-js-sdk (see its own
 * header): these are pure `localStorage` read/write tests, the same
 * footing as `WorkspaceIdentity.test.ts`'s pure-logic tests.
 */
describe("the workspace outbox (#289)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty", () => {
    expect(pendingMessagesInOrder()).toEqual([]);
  });

  it("queues a message and answers it back, mentions and reply target intact", () => {
    enqueuePendingMessage({
      localId: "outbox:txn1",
      roomId: "!project-x:workspace.example",
      body: "thanks all",
      mentions: [{ userId: "@carol:workspace.example", label: "Carol" }],
      replyToEventId: "$1000",
    });

    expect(pendingMessagesInOrder()).toEqual([
      expect.objectContaining({
        localId: "outbox:txn1",
        roomId: "!project-x:workspace.example",
        body: "thanks all",
        mentions: [{ userId: "@carol:workspace.example", label: "Carol" }],
        replyToEventId: "$1000",
      }),
    ]);
  });

  it("orders by when each message was composed, not by when it was written to storage", () => {
    enqueuePendingMessage({ localId: "outbox:a", roomId: "!r:workspace.example", body: "first typed", mentions: [], replyToEventId: null });
    enqueuePendingMessage({ localId: "outbox:b", roomId: "!r:workspace.example", body: "second typed", mentions: [], replyToEventId: null });

    expect(pendingMessagesInOrder().map((m) => m.body)).toEqual(["first typed", "second typed"]);
  });

  it("dequeues by its own key — a confirmed send leaves nothing behind to resend", () => {
    enqueuePendingMessage({ localId: "outbox:txn1", roomId: "!r:workspace.example", body: "hi", mentions: [], replyToEventId: null });
    enqueuePendingMessage({ localId: "outbox:txn2", roomId: "!r:workspace.example", body: "there", mentions: [], replyToEventId: null });

    dequeuePendingMessage("outbox:txn1");

    expect(pendingMessagesInOrder().map((m) => m.localId)).toEqual(["outbox:txn2"]);
  });

  it("dequeuing a key that was never queued (or already gone) is a no-op", () => {
    enqueuePendingMessage({ localId: "outbox:txn1", roomId: "!r:workspace.example", body: "hi", mentions: [], replyToEventId: null });

    expect(() => dequeuePendingMessage("outbox:nowhere")).not.toThrow();
    expect(pendingMessagesInOrder()).toHaveLength(1);
  });

  it("re-keys a queued entry in place, keeping its original composed order", () => {
    enqueuePendingMessage({ localId: "outbox:old", roomId: "!r:workspace.example", body: "resend me", mentions: [], replyToEventId: null });
    const [before] = pendingMessagesInOrder();

    rekeyPendingMessage("outbox:old", "outbox:new");

    const [after] = pendingMessagesInOrder();
    expect(after).toEqual({ ...before, localId: "outbox:new" });
    // The old key no longer resolves to anything — a stray retry/cancel
    // addressed to it finds nothing, same as any other already-gone id.
    expect(pendingMessagesInOrder().some((m) => m.localId === "outbox:old")).toBe(false);
  });

  it("outboxKeyOf is a pure, deterministic function of the txnId — the same txnId always reaches the same record", () => {
    expect(outboxKeyOf("abc")).toBe(outboxKeyOf("abc"));
    expect(outboxKeyOf("abc")).not.toBe(outboxKeyOf("def"));
  });

  it("clearPendingMessages empties the queue — a sign-out leaves nothing behind for the next account", () => {
    enqueuePendingMessage({ localId: "outbox:a", roomId: "!r:workspace.example", body: "hi", mentions: [], replyToEventId: null });
    enqueuePendingMessage({ localId: "outbox:b", roomId: "!r:workspace.example", body: "there", mentions: [], replyToEventId: null });

    clearPendingMessages();

    expect(pendingMessagesInOrder()).toEqual([]);
    expect(localStorage.getItem("duo.workspace-outbox")).toBeNull();
  });

  it("a corrupt or foreign value under the storage key is read as empty, never thrown", () => {
    localStorage.setItem("duo.workspace-outbox", "{not json");
    expect(pendingMessagesInOrder()).toEqual([]);

    localStorage.setItem("duo.workspace-outbox", JSON.stringify({ not: "an array" }));
    expect(pendingMessagesInOrder()).toEqual([]);
  });

  it("drops malformed entries from a mixed array rather than failing the whole read", () => {
    localStorage.setItem(
      "duo.workspace-outbox",
      JSON.stringify([
        { localId: "outbox:good", roomId: "!r:workspace.example", body: "fine", mentions: [], replyToEventId: null, composedAt: 1 },
        { localId: "outbox:bad", body: "missing fields" },
        "not even an object",
      ]),
    );

    expect(pendingMessagesInOrder().map((m) => m.localId)).toEqual(["outbox:good"]);
  });
});
