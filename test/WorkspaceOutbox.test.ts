import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setPlatformForTesting } from "../src/platform/index.js";
import { fakePlatform } from "./platformFakes.js";
import {
  clearPendingMessages,
  dequeuePendingMessage,
  enqueuePendingMessage,
  outboxKeyOf,
  pendingMessagesInOrder,
  rekeyPendingMessage,
  sweepPendingMessages,
  type OutboxAccount,
} from "../src/workspace/outbox.js";

/*
 * #289: the device-local record of what `matrix.ts`'s `send()` has handed
 * to the homeserver but not yet had confirmed — the thing that survives a
 * reload when matrix-js-sdk's own in-memory pending-event queue (#209)
 * cannot. This module knows nothing about matrix-js-sdk (see its own
 * header): these are pure read/write tests against #320's platform
 * storage (a fake here, the same pattern #288's own cache tests use for
 * IndexedDB), never the SDK's own `mx_pending_events_*` keys.
 *
 * Every queue is one account's own — named exactly like #288's cache
 * (`workspaceCacheName`) — so these tests exercise that namespacing
 * directly: two different accounts never read or clear each other's
 * queue, and only a wipe addressed to the right account empties it.
 */
describe("the workspace outbox (#289)", () => {
  const ANA: OutboxAccount = { homeserverUrl: "https://workspace.example", userId: "@ana:workspace.example", deviceId: "ANADEVICE" };
  const BOSE: OutboxAccount = { homeserverUrl: "https://workspace.example", userId: "@bose:workspace.example", deviceId: "BOSEDEVICE" };

  let platform: ReturnType<typeof fakePlatform>;

  beforeEach(() => {
    platform = fakePlatform();
    setPlatformForTesting(platform.platform);
  });

  afterEach(() => {
    setPlatformForTesting(null);
  });

  it("starts empty", async () => {
    expect(await pendingMessagesInOrder(ANA)).toEqual([]);
  });

  it("queues a message and answers it back, mentions and reply target intact", async () => {
    await enqueuePendingMessage(ANA, {
      localId: "outbox:txn1",
      roomId: "!project-x:workspace.example",
      body: "thanks all",
      mentions: [{ userId: "@carol:workspace.example", label: "Carol" }],
      replyToEventId: "$1000",
    });

    expect(await pendingMessagesInOrder(ANA)).toEqual([
      expect.objectContaining({
        localId: "outbox:txn1",
        roomId: "!project-x:workspace.example",
        body: "thanks all",
        mentions: [{ userId: "@carol:workspace.example", label: "Carol" }],
        replyToEventId: "$1000",
      }),
    ]);
  });

  it("orders by when each message was composed, not by when it was written to storage", async () => {
    await enqueuePendingMessage(ANA, { localId: "outbox:a", roomId: "!r:workspace.example", body: "first typed", mentions: [], replyToEventId: null });
    await enqueuePendingMessage(ANA, { localId: "outbox:b", roomId: "!r:workspace.example", body: "second typed", mentions: [], replyToEventId: null });

    expect((await pendingMessagesInOrder(ANA)).map((m) => m.body)).toEqual(["first typed", "second typed"]);
  });

  it("dequeues by its own key — a confirmed send leaves nothing behind to resend", async () => {
    await enqueuePendingMessage(ANA, { localId: "outbox:txn1", roomId: "!r:workspace.example", body: "hi", mentions: [], replyToEventId: null });
    await enqueuePendingMessage(ANA, { localId: "outbox:txn2", roomId: "!r:workspace.example", body: "there", mentions: [], replyToEventId: null });

    await dequeuePendingMessage(ANA, "outbox:txn1");

    expect((await pendingMessagesInOrder(ANA)).map((m) => m.localId)).toEqual(["outbox:txn2"]);
  });

  it("dequeuing a key that was never queued (or already gone) is a no-op", async () => {
    await enqueuePendingMessage(ANA, { localId: "outbox:txn1", roomId: "!r:workspace.example", body: "hi", mentions: [], replyToEventId: null });

    await expect(dequeuePendingMessage(ANA, "outbox:nowhere")).resolves.not.toThrow();
    expect(await pendingMessagesInOrder(ANA)).toHaveLength(1);
  });

  it("re-keys a queued entry in place, keeping its original composed order", async () => {
    await enqueuePendingMessage(ANA, { localId: "outbox:old", roomId: "!r:workspace.example", body: "resend me", mentions: [], replyToEventId: null });
    const [before] = await pendingMessagesInOrder(ANA);

    await rekeyPendingMessage(ANA, "outbox:old", "outbox:new");

    const [after] = await pendingMessagesInOrder(ANA);
    expect(after).toEqual({ ...before, localId: "outbox:new" });
    // The old key no longer resolves to anything — a stray retry/cancel
    // addressed to it finds nothing, same as any other already-gone id.
    expect((await pendingMessagesInOrder(ANA)).some((m) => m.localId === "outbox:old")).toBe(false);
  });

  it("outboxKeyOf is a pure, deterministic function of the txnId — the same txnId always reaches the same record", () => {
    expect(outboxKeyOf("abc")).toBe(outboxKeyOf("abc"));
    expect(outboxKeyOf("abc")).not.toBe(outboxKeyOf("def"));
  });

  it("clearPendingMessages empties the queue — a sign-out leaves nothing behind for the next account", async () => {
    await enqueuePendingMessage(ANA, { localId: "outbox:a", roomId: "!r:workspace.example", body: "hi", mentions: [], replyToEventId: null });
    await enqueuePendingMessage(ANA, { localId: "outbox:b", roomId: "!r:workspace.example", body: "there", mentions: [], replyToEventId: null });

    await clearPendingMessages(ANA);

    expect(await pendingMessagesInOrder(ANA)).toEqual([]);
    expect([...platform.items.keys()].some((key) => key.includes("@ana:workspace.example"))).toBe(false);
  });

  it("a corrupt or foreign value under the storage key is read as empty, never thrown", async () => {
    await platform.platform.storage.set("duo.workspace-outbox|duo-workspace|https://workspace.example|@ana:workspace.example|ANADEVICE", "{not json");
    expect(await pendingMessagesInOrder(ANA)).toEqual([]);

    await platform.platform.storage.set(
      "duo.workspace-outbox|duo-workspace|https://workspace.example|@ana:workspace.example|ANADEVICE",
      JSON.stringify({ not: "an array" }),
    );
    expect(await pendingMessagesInOrder(ANA)).toEqual([]);
  });

  it("drops malformed entries from a mixed array rather than failing the whole read", async () => {
    await platform.platform.storage.set(
      "duo.workspace-outbox|duo-workspace|https://workspace.example|@ana:workspace.example|ANADEVICE",
      JSON.stringify([
        { localId: "outbox:good", roomId: "!r:workspace.example", body: "fine", mentions: [], replyToEventId: null, composedAt: 1 },
        { localId: "outbox:bad", body: "missing fields" },
        "not even an object",
      ]),
    );

    expect((await pendingMessagesInOrder(ANA)).map((m) => m.localId)).toEqual(["outbox:good"]);
  });

  /*
   * #289 (post-#288/#320 review): the whole point of naming this queue
   * exactly like #288 names its cache — no two accounts on one device
   * ever read, dequeue or clear the same storage key, and nothing here
   * resurrects matrix-js-sdk's own un-namespaced `mx_pending_events_*`
   * keys, which #288's cache deliberately left disabled for this exact
   * reason.
   */
  describe("account namespacing — the #288/#320 review's own concern", () => {
    it("two different accounts on the same device never see each other's queue", async () => {
      await enqueuePendingMessage(ANA, { localId: "outbox:ana-1", roomId: "!r:workspace.example", body: "ana's draft", mentions: [], replyToEventId: null });
      await enqueuePendingMessage(BOSE, { localId: "outbox:bose-1", roomId: "!r:workspace.example", body: "bose's draft", mentions: [], replyToEventId: null });

      expect((await pendingMessagesInOrder(ANA)).map((m) => m.body)).toEqual(["ana's draft"]);
      expect((await pendingMessagesInOrder(BOSE)).map((m) => m.body)).toEqual(["bose's draft"]);
    });

    it("clearing one account's queue leaves every other account's queue untouched", async () => {
      await enqueuePendingMessage(ANA, { localId: "outbox:ana-1", roomId: "!r:workspace.example", body: "ana's draft", mentions: [], replyToEventId: null });
      await enqueuePendingMessage(BOSE, { localId: "outbox:bose-1", roomId: "!r:workspace.example", body: "bose's draft", mentions: [], replyToEventId: null });

      await clearPendingMessages(ANA);

      expect(await pendingMessagesInOrder(ANA)).toEqual([]);
      expect((await pendingMessagesInOrder(BOSE)).map((m) => m.body)).toEqual(["bose's draft"]);
    });

    it("never writes under the SDK's own generic key shape — no mx_pending_events_, no un-namespaced duo.workspace-outbox", async () => {
      await enqueuePendingMessage(ANA, { localId: "outbox:a", roomId: "!r:workspace.example", body: "hi", mentions: [], replyToEventId: null });

      const keys = [...platform.items.keys()];
      expect(keys.some((key) => key.startsWith("mx_pending_events_"))).toBe(false);
      expect(keys).not.toContain("duo.workspace-outbox");
      expect(keys.every((key) => key.startsWith("duo.workspace-outbox|"))).toBe(true);
    });

    it("sweepPendingMessages deletes every other account's leftover queue, keeping only the one to keep", async () => {
      await enqueuePendingMessage(ANA, { localId: "outbox:ana-1", roomId: "!r:workspace.example", body: "ana's draft", mentions: [], replyToEventId: null });
      await enqueuePendingMessage(BOSE, { localId: "outbox:bose-1", roomId: "!r:workspace.example", body: "bose's draft", mentions: [], replyToEventId: null });

      await sweepPendingMessages(ANA);

      expect((await pendingMessagesInOrder(ANA)).map((m) => m.body)).toEqual(["ana's draft"]);
      expect(await pendingMessagesInOrder(BOSE)).toEqual([]);
    });

    it("sweepPendingMessages with no account to keep clears every queue on the device", async () => {
      await enqueuePendingMessage(ANA, { localId: "outbox:ana-1", roomId: "!r:workspace.example", body: "ana's draft", mentions: [], replyToEventId: null });
      await enqueuePendingMessage(BOSE, { localId: "outbox:bose-1", roomId: "!r:workspace.example", body: "bose's draft", mentions: [], replyToEventId: null });

      await sweepPendingMessages(null);

      expect(await pendingMessagesInOrder(ANA)).toEqual([]);
      expect(await pendingMessagesInOrder(BOSE)).toEqual([]);
    });
  });
});
