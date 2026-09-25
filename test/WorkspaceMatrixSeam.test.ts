// @ts-expect-error no node types by design
import { readdirSync, readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { join, dirname } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #62: the seam test. `src/workspace/matrix.ts` is the ONE module that may
 * import matrix-js-sdk — the Tauri-seam pattern again, so daemon-only flows
 * never load the SDK transitively. Here the SDK itself is mocked and the
 * seam's side of the contract is pinned: the client is built with NOTHING
 * persistent (no IndexedDB store, no web-storage session — a workspace
 * session lives in this app's own credential store or nowhere, so signing
 * out can never leave a warm session behind, #62 AC4), sign-in follows the
 * platform record's rules (https only — the token rides the URL), and the
 * projection from Matrix events to room messages is the honest minimal one.
 */
vi.mock("matrix-js-sdk", () => ({
  createClient: vi.fn(),
  ClientEvent: { Sync: "sync" },
  RoomEvent: { Timeline: "timeline" },
  SyncState: { Prepared: "PREPARED" },
  MsgType: { Text: "m.text" },
  ReceiptType: { Read: "m.read", FullyRead: "m.fully_read", ReadPrivate: "m.read.private" },
  NotificationCountType: { Highlight: "highlight", Total: "total" },
  PushRuleKind: { Override: "override", ContentSpecific: "content", RoomSpecific: "room", SenderSpecific: "sender", Underride: "underride" },
  EventType: { RoomMessage: "m.room.message", Reaction: "m.reaction", RoomRedaction: "m.room.redaction" },
  RelationType: { Annotation: "m.annotation", Replace: "m.replace", Thread: "m.thread", Reference: "m.reference" },
  MatrixError: class MatrixError extends Error {
    errcode?: string;
  },
}));

import { ClientEvent, createClient, MsgType, ReceiptType, RoomEvent } from "matrix-js-sdk";
import { connect, signIn } from "../src/workspace/matrix.js";
import type { MatrixClient, MatrixEvent, Room, RoomMember } from "matrix-js-sdk";

const SESSION = {
  homeserverUrl: "https://workspace.example",
  userId: "@ana:workspace.example",
  accessToken: "syt_workspace_token",
  deviceId: "YGBNAUIOMK",
};

/** Every key the SDK would accept for a store, a session store, or web-storage persistence. */
const PERSISTENCE_KEYS = /store|storage|indexeddb|idb|localstorage|websql/i;

function fakeEvent(
  shape: {
    type: string;
    sender: string;
    msgtype?: string;
    body?: string;
    ts: number;
    /** The event's relation — a replacement, an annotation, or a thread reply. */
    relatesTo?: { rel_type: string; event_id: string; key?: string; is_falling_back?: boolean };
    /** A replacement's new body, under m.new_content. */
    newContent?: { msgtype: string; body: string };
    /** True once the homeserver (or a member) struck the event. */
    redacted?: boolean;
  },
): MatrixEvent {
  return {
    getId: () => `$${shape.ts}`,
    getType: () => shape.type,
    getSender: () => shape.sender,
    getContent: () => ({
      msgtype: shape.msgtype,
      body: shape.body,
      "m.new_content": shape.newContent,
      "m.relates_to": shape.relatesTo,
    }),
    getTs: () => shape.ts,
    isRedacted: () => shape.redacted ?? false,
  } as unknown as MatrixEvent;
}

function fakeRoom(): Room {
  const member = (userId: string): RoomMember | null =>
    userId === "@bose:workspace.example" ? ({ name: "Bose" } as RoomMember) : null;
  return {
    roomId: "!project-x:workspace.example",
    name: "project-x",
    getLiveTimeline: () => ({
      getEvents: () => [
        fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "what's our refund policy?", ts: 1_700_000_000_000 }),
        fakeEvent({ type: "m.room.topic", sender: "@bose:workspace.example", body: "refunds", ts: 1_700_000_000_001 }),
        fakeEvent({ type: "m.room.message", sender: "@duo-carol:workspace.example", msgtype: "m.text", body: "Refunds within 30 days, full amount.", ts: 1_700_000_000_002 }),
        fakeEvent({ type: "m.room.message", sender: "@nobody:workspace.example", msgtype: "m.file", body: "refund-policy.pdf", ts: 1_700_000_000_003 }),
      ],
    }),
    getMember: member,
  } as unknown as Room;
}

/** The mock surface the seam drives, kept as a type so the fakes carry their .mock through every helper. */
type FakeClient = MatrixClient & {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  startClient: ReturnType<typeof vi.fn>;
  stopClient: ReturnType<typeof vi.fn>;
  getRooms: ReturnType<typeof vi.fn>;
  getRoom: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  getAccountData: ReturnType<typeof vi.fn>;
  getPushRules: ReturnType<typeof vi.fn>;
  createRoom: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  addPushRule: ReturnType<typeof vi.fn>;
  deletePushRule: ReturnType<typeof vi.fn>;
  searchUserDirectory: ReturnType<typeof vi.fn>;
  sendReadReceipt: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  redactEvent: ReturnType<typeof vi.fn>;
};

/**
 * A client whose first sync is fired by the test, the way a homeserver's
 * PREPARED state would. The #63 overridables carry the list projection's
 * inputs: which rooms exist, which of them the m.direct account data marks
 * direct, and which the server's push rules hold muted.
 */
function fakeClient(
  over: { rooms?: Room[]; directRoomIds?: string[]; mutedRoomIds?: string[] } = {},
): FakeClient {
  const client = {
    on: vi.fn(),
    off: vi.fn(),
    startClient: vi.fn(),
    stopClient: vi.fn(() => Promise.resolve()),
    getRooms: vi.fn(() => over.rooms ?? [fakeRoom()]),
    getRoom: vi.fn(() => over.rooms?.[0] ?? fakeRoom()),
    sendMessage: vi.fn(() => Promise.resolve()),
    login: vi.fn(() => Promise.resolve({ access_token: "syt_workspace_token", user_id: "@ana:workspace.example", device_id: "YGBNAUIOMK" })),
    getAccountData: vi.fn((eventType: string) =>
      eventType === "m.direct"
        ? { getContent: () => ({ "@bose:workspace.example": over.directRoomIds ?? [] }) }
        : undefined,
    ),
    getPushRules: vi.fn(async () => ({
      global: { room: (over.mutedRoomIds ?? []).map((roomId) => ({ rule_id: roomId, enabled: true, actions: [] })) },
    })),
    createRoom: vi.fn(async () => ({ room_id: "!fresh:workspace.example" })),
    leave: vi.fn(async () => ({})),
    addPushRule: vi.fn(async () => ({})),
    deletePushRule: vi.fn(async () => ({})),
    searchUserDirectory: vi.fn(async () => ({
      results: [
        { user_id: "@carol:workspace.example", display_name: "Carol" },
        { user_id: "@duo-carol:workspace.example", display_name: undefined },
      ],
    })),
    sendReadReceipt: vi.fn(async () => ({})),
    sendEvent: vi.fn(async () => ({})),
    redactEvent: vi.fn(async () => ({})),
  };
  return client as unknown as FakeClient;
}

/**
 * A room shaped for the conversation list's projection (#63): membership,
 * unread accounting, join rule, and the timeline the latest word and the
 * read position come from.
 */
function summaryRoom(shape: {
  roomId: string;
  name: string | null;
  joinRule: string;
  members: Array<{ userId: string; name: string | null }>;
  notificationCount: number;
  highlightCount: number;
  events: MatrixEvent[];
}): Room {
  return {
    roomId: shape.roomId,
    name: shape.name,
    getJoinRule: () => shape.joinRule,
    getMembers: () => shape.members.map((member) => ({ userId: member.userId, name: member.name, membership: "join" })),
    getUnreadNotificationCount: (type?: string) => (type === "highlight" ? shape.highlightCount : shape.notificationCount),
    getLiveTimeline: () => ({ getEvents: () => shape.events }),
    getMember: () => null,
  } as unknown as Room;
}

/** connect() resolves only once the SDK reports PREPARED — fire the captured sync handler like the SDK would. */
async function connectPrepared(client: FakeClient) {
  const pending = connect(SESSION);
  const syncHandler = client.on.mock.calls.find(([event]) => event === ClientEvent.Sync)?.[1] as (state: string) => void;
  syncHandler?.("PREPARED");
  return pending;
}

beforeEach(() => {
  vi.mocked(createClient).mockReset();
});

describe("the seam's persistence contract (#62 AC4)", () => {
  it("builds its clients with nothing persistent — no store, no session store, no web storage", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);

    await connectPrepared(client);

    const options = vi.mocked(createClient).mock.calls[0]![0]!;
    expect(options.baseUrl).toBe("https://workspace.example");
    expect(options.accessToken).toBe("syt_workspace_token");
    expect(options.userId).toBe("@ana:workspace.example");
    expect(Object.keys(options).filter((key) => PERSISTENCE_KEYS.test(key))).toEqual([]);
  });

  it("sign-in's throwaway client is built the same way and stopped, not parked", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);

    await signIn("https://workspace.example", "ana", "correct horse");

    const options = vi.mocked(createClient).mock.calls[0]![0]!;
    expect(options.baseUrl).toBe("https://workspace.example");
    expect(Object.keys(options).filter((key) => PERSISTENCE_KEYS.test(key))).toEqual([]);
    expect(client.login).toHaveBeenCalledWith("m.login.password", {
      user: "ana",
      password: "correct horse",
      initial_device_display_name: "Duo",
    });
    // The login-only client holds a live sync-less connection; the seam stops
    // it rather than leaving it around for the app's lifetime.
    expect(client.stopClient).toHaveBeenCalled();
  });

  it("stop() stops the client — sign-out's half of 'leaves nothing behind'", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.stop();

    expect(client.stopClient).toHaveBeenCalled();
  });
});

describe("sign-in's wire rules", () => {
  it("refuses a non-https homeserver without dialing it — the token must never ride a plaintext URL", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);

    await expect(signIn("http://workspace.example", "ana", "correct horse")).rejects.toThrow(/https/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("trims a trailing slash off the homeserver address", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);

    await signIn("https://workspace.example/", "ana", "correct horse");

    expect(vi.mocked(createClient).mock.calls[0]![0]!.baseUrl).toBe("https://workspace.example");
  });
});

describe("the projection from Matrix events to room messages", () => {
  it("keeps text messages only, resolves names from membership, and falls back to the localpart", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const messages = await connection.timeline("!project-x:workspace.example");

    expect(messages).toEqual([
      {
        eventId: expect.any(String),
        roomId: "!project-x:workspace.example",
        senderId: "@bose:workspace.example",
        senderName: "Bose",
        body: "what's our refund policy?",
        originServerTs: 1_700_000_000_000,
      },
      {
        eventId: expect.any(String),
        roomId: "!project-x:workspace.example",
        senderId: "@duo-carol:workspace.example",
        senderName: "duo-carol", // no membership record: the localpart, never a blank
        body: "Refunds within 30 days, full amount.",
        originServerTs: 1_700_000_000_002,
      },
    ]);
    // The topic event and the file message are not conversation text.
    expect(messages.map((message) => message.body).join()).not.toContain("refund-policy.pdf");
  });

  it("sends text, and only text, and reports live timeline arrivals for their room", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.send("!project-x:workspace.example", "thanks all");

    expect(client.sendMessage).toHaveBeenCalledWith("!project-x:workspace.example", { msgtype: MsgType.Text, body: "thanks all" });

    const arrivals: string[] = [];
    connection.subscribe((roomId) => arrivals.push(roomId));
    const timelineHandler = client.on.mock.calls.find(([event]) => event === RoomEvent.Timeline)?.[1] as (
      event: MatrixEvent,
      room: Room,
    ) => void;
    timelineHandler?.(fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "np", ts: 1 }), client.getRoom("!x")!);

    expect(arrivals).toEqual(["!project-x:workspace.example"]);
  });
});

describe("the rooms projection the conversation list reads (#63)", () => {
  it("carries members, the latest word, unread and mentions, kind, and mute — ordered by latest activity", async () => {
    const client = fakeClient({
      // Written out of recency order on purpose: ordering is the seam's
      // projection, and the shuffled input proves it.
      rooms: [
        summaryRoom({
          roomId: "!project-x:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [
            { userId: "@ana:workspace.example", name: "ana" },
            { userId: "@bose:workspace.example", name: "Bose" },
            { userId: "@duo-carol:workspace.example", name: "duo-carol" },
          ],
          notificationCount: 3,
          highlightCount: 0,
          events: [
            // Matrix timelines read oldest first — the last event is the latest word.
            fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "earlier", ts: 1_000 }),
            fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "ship it", ts: 2_000 }),
          ],
        }),
        summaryRoom({
          roomId: "!direct:workspace.example",
          name: null,
          joinRule: "invite",
          members: [
            { userId: "@ana:workspace.example", name: "ana" },
            { userId: "@bose:workspace.example", name: "Bose" },
          ],
          notificationCount: 0,
          highlightCount: 0,
          events: [fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "lunch?", ts: 3_000 })],
        }),
        summaryRoom({
          roomId: "!announce:workspace.example",
          name: "announce",
          joinRule: "public",
          members: [
            { userId: "@dee:workspace.example", name: "Dee" },
            { userId: "@eeyore:workspace.example", name: null },
          ],
          notificationCount: 9,
          highlightCount: 9,
          events: [fakeEvent({ type: "m.room.message", sender: "@dee:workspace.example", msgtype: "m.text", body: "all-hands friday", ts: 1_500 })],
        }),
      ],
      directRoomIds: ["!direct:workspace.example"],
      mutedRoomIds: ["!announce:workspace.example"],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(await connection.rooms()).toEqual([
      {
        roomId: "!direct:workspace.example",
        kind: "direct", // the m.direct account data says so, not the member count
        name: null,
        members: [{ userId: "@bose:workspace.example", name: "Bose" }], // this member's own id never lists
        latest: { at: 3_000, body: "lunch?" },
        unread: { notifications: 0, mentions: 0 },
        muted: false,
      },
      {
        roomId: "!project-x:workspace.example",
        kind: "group", // named, joined by invitation
        name: "project-x",
        members: [
          { userId: "@bose:workspace.example", name: "Bose" },
          { userId: "@duo-carol:workspace.example", name: "duo-carol" },
        ],
        latest: { at: 2_000, body: "ship it" },
        unread: { notifications: 3, mentions: 0 },
        muted: false,
      },
      {
        roomId: "!announce:workspace.example",
        kind: "channel", // named, public join rule
        name: "announce",
        members: [
          { userId: "@dee:workspace.example", name: "Dee" },
          { userId: "@eeyore:workspace.example", name: "eeyore" }, // no name on record: the localpart, never a blank
        ],
        latest: { at: 1_500, body: "all-hands friday" },
        unread: { notifications: 9, mentions: 9 },
        muted: true, // the server's own push rule — true on every device
      },
    ]);
  });

  it("markRead receipts the room's latest event — the durable read position", async () => {
    const events = [
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "one", ts: 1 }),
      fakeEvent({ type: "m.room.topic", sender: "@bose:workspace.example", body: "topic", ts: 2 }),
    ];
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!r:workspace.example",
          name: "r",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 1,
          highlightCount: 0,
          events,
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.markRead("!r:workspace.example");

    // The receipt points at the last event the room has — even a non-text
    // one: the read position is where the eye stopped, not what was said.
    expect(client.sendReadReceipt).toHaveBeenCalledWith(events[1], ReceiptType.Read, true);
  });

  it("start, leave, mute, and people-search map to the homeserver's verbs", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await expect(connection.startDirect("@carol:workspace.example")).resolves.toBe("!fresh:workspace.example");
    expect(client.createRoom).toHaveBeenCalledWith({ is_direct: true, invite: ["@carol:workspace.example"] });

    await connection.leave("!r:workspace.example");
    expect(client.leave).toHaveBeenCalledWith("!r:workspace.example");

    // Muting is the account's push rule, server-side — the state every
    // device of this member reads the same way.
    await connection.setMuted("!r:workspace.example", true);
    expect(client.addPushRule).toHaveBeenCalledWith("global", "room", "!r:workspace.example", { actions: [], conditions: [] });
    await connection.setMuted("!r:workspace.example", false);
    expect(client.deletePushRule).toHaveBeenCalledWith("global", "room", "!r:workspace.example");

    const people = await connection.searchPeople("carol");
    expect(client.searchUserDirectory).toHaveBeenCalledWith({ term: "carol", limit: expect.any(Number) });
    expect(people).toEqual([
      { userId: "@carol:workspace.example", name: "Carol" },
      { userId: "@duo-carol:workspace.example", name: "duo-carol" }, // display name absent: the localpart, never a blank
    ]);
  });
});

describe("the timeline projection the message surface reads (#64)", () => {
  it("folds same-sender replacements, ignores foreign ones, aggregates reactions, separates threads, and strikes redactions", async () => {
    const events = [
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "what's our refund policy?", ts: 1_000 }),
      fakeEvent({ type: "m.room.message", sender: "@ana:workspace.example", msgtype: "m.text", body: "the policy doc says 30 days", ts: 2_000 }),
      // Bose amends their own message: a replacement folds into its base.
      fakeEvent({
        type: "m.room.message",
        sender: "@bose:workspace.example",
        msgtype: "m.text",
        body: "* what IS our refund policy?",
        ts: 3_000,
        relatesTo: { rel_type: "m.replace", event_id: "$1000" },
        newContent: { msgtype: "m.text", body: "what IS our refund policy?" },
      }),
      // Carol "amends" Bose's message: a foreign replacement is not an edit,
      // it's a claim — the projection leaves the base words standing.
      fakeEvent({
        type: "m.room.message",
        sender: "@carol:workspace.example",
        msgtype: "m.text",
        body: "* hacked",
        ts: 3_100,
        relatesTo: { rel_type: "m.replace", event_id: "$2000" },
        newContent: { msgtype: "m.text", body: "hacked" },
      }),
      // Two 👍 on the question — one of them this member's own.
      fakeEvent({ type: "m.reaction", sender: "@ana:workspace.example", ts: 3_200, relatesTo: { rel_type: "m.annotation", event_id: "$1000", key: "👍" } }),
      fakeEvent({ type: "m.reaction", sender: "@bose:workspace.example", ts: 3_300, relatesTo: { rel_type: "m.annotation", event_id: "$1000", key: "👍" } }),
      // A redacted reaction counts as no reaction at all.
      fakeEvent({ type: "m.reaction", sender: "@ana:workspace.example", ts: 3_400, relatesTo: { rel_type: "m.annotation", event_id: "$2000", key: "🎉" }, redacted: true }),
      // A colleague's duo answers in the question's thread.
      fakeEvent({
        type: "m.room.message",
        sender: "@duo-carol:workspace.example",
        msgtype: "m.text",
        body: "np, 30 days",
        ts: 3_500,
        relatesTo: { rel_type: "m.thread", event_id: "$1000" },
      }),
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "ship it", ts: 3_600 }),
      // A struck message keeps its place and loses its words.
      fakeEvent({ type: "m.room.message", sender: "@carol:workspace.example", msgtype: "m.text", body: "gone soon", ts: 3_700, redacted: true }),
    ];
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!project-x:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events,
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(await connection.timeline("!project-x:workspace.example")).toEqual([
      {
        eventId: "$1000",
        roomId: "!project-x:workspace.example",
        senderId: "@bose:workspace.example",
        senderName: "Bose",
        body: "what IS our refund policy?", // the replacement's words
        originServerTs: 1_000,               // the base's place — an edit amends, it doesn't move
        edited: true,
        redacted: false,
        reactions: [{ key: "👍", count: 2, mine: true }],
        thread: { replyCount: 1, latestReply: { senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "np, 30 days" } },
        threadRootEventId: null,
      },
      {
        eventId: "$2000",
        roomId: "!project-x:workspace.example",
        senderId: "@ana:workspace.example",
        senderName: "ana", // no membership record: the localpart, never a blank
        body: "the policy doc says 30 days", // the foreign replacement changed nothing
        originServerTs: 2_000,
        edited: false,
        redacted: false,
        reactions: [], // the only 🎉 was redacted before it ever counted
        thread: null,
        threadRootEventId: null,
      },
      {
        eventId: "$3500",
        roomId: "!project-x:workspace.example",
        senderId: "@duo-carol:workspace.example",
        senderName: "duo-carol",
        body: "np, 30 days",
        originServerTs: 3_500,
        edited: false,
        redacted: false,
        reactions: [],
        thread: null,
        threadRootEventId: "$1000", // a thread reply: carried, not a row of the main flow
      },
      {
        eventId: "$3600",
        roomId: "!project-x:workspace.example",
        senderId: "@bose:workspace.example",
        senderName: "Bose",
        body: "ship it",
        originServerTs: 3_600,
        edited: false,
        redacted: false,
        reactions: [],
        thread: null,
        threadRootEventId: null,
      },
      {
        eventId: "$3700",
        roomId: "!project-x:workspace.example",
        senderId: "@carol:workspace.example",
        senderName: "carol",
        body: "", // struck: the words are gone, the row is not
        originServerTs: 3_700,
        edited: false,
        redacted: true,
        reactions: [],
        thread: null,
        threadRootEventId: null,
      },
    ]);
  });

  it("edit, delete, react, unreact, and reply-in-thread map to the homeserver's verbs", async () => {
    const mine = fakeEvent({ type: "m.reaction", sender: "@ana:workspace.example", ts: 500, relatesTo: { rel_type: "m.annotation", event_id: "$1", key: "👍" } });
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!project-x:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [mine],
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    // An edit is a replacement: the new words ride m.new_content, the
    // relation points back at the event being amended.
    await connection.edit("!project-x:workspace.example", "$1", "new words");
    expect(client.sendMessage).toHaveBeenCalledWith("!project-x:workspace.example", {
      msgtype: MsgType.Text,
      body: "* new words",
      "m.new_content": { msgtype: MsgType.Text, body: "new words" },
      "m.relates_to": { rel_type: "m.replace", event_id: "$1" },
    });

    await connection.delete("!project-x:workspace.example", "$1");
    expect(client.redactEvent).toHaveBeenCalledWith("!project-x:workspace.example", "$1");

    await connection.react("!project-x:workspace.example", "$1", "👍");
    expect(client.sendEvent).toHaveBeenCalledWith("!project-x:workspace.example", "m.reaction", {
      "m.relates_to": { rel_type: "m.annotation", event_id: "$1", key: "👍" },
    });

    // Un-reacting is redacting MY reaction event — the one this account
    // sent for this message and key, never anyone else's.
    await connection.unreact("!project-x:workspace.example", "$1", "👍");
    expect(client.redactEvent).toHaveBeenLastCalledWith("!project-x:workspace.example", "$500");

    await connection.replyInThread("!project-x:workspace.example", "$1", "in the thread");
    expect(client.sendMessage).toHaveBeenLastCalledWith("!project-x:workspace.example", {
      msgtype: MsgType.Text,
      body: "in the thread",
      "m.relates_to": { rel_type: "m.thread", event_id: "$1", is_falling_back: true, "m.in_reply_to": { event_id: "$1" } },
    });

    // The connection knows whose it is — the surface needs it to tell own
    // messages (editable, deletable) from everyone else's.
    expect(connection.userId).toBe("@ana:workspace.example");
  });

  it("live arrivals report reactions and redactions too, not just messages", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const arrivals: string[] = [];
    connection.subscribe((roomId) => arrivals.push(roomId));
    const timelineHandler = client.on.mock.calls.find(([event]) => event === RoomEvent.Timeline)?.[1] as (
      event: MatrixEvent,
      room: Room,
    ) => void;
    const room = client.getRoom("!x")!;
    const at = (event: MatrixEvent): void => timelineHandler?.(event, room);

    at(fakeEvent({ type: "m.reaction", sender: "@bose:workspace.example", ts: 1, relatesTo: { rel_type: "m.annotation", event_id: "$1", key: "👍" } }));
    at(fakeEvent({ type: "m.room.redaction", sender: "@bose:workspace.example", ts: 2 }));
    at(fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "np", ts: 3 }));
    // A topic change is not a message fact — the surface doesn't re-read for it.
    at(fakeEvent({ type: "m.room.topic", sender: "@bose:workspace.example", body: "refunds", ts: 4 }));

    expect(arrivals).toEqual(["!project-x:workspace.example", "!project-x:workspace.example", "!project-x:workspace.example"]);
  });
});

describe("the seam stays the SDK's only door", () => {
  it("no file outside src/workspace/matrix.ts references matrix-js-sdk", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !path.endsWith(join("src", "workspace", "matrix.ts"))) {
          const text = readFileSync(path, "utf8");
          // Importers only — a comment SAYING "matrix-js-sdk" is documentation;
          // a module importing it is the leak the tripwire exists for.
          if (/from\s+["']matrix-js-sdk["']|import\(\s*["']matrix-js-sdk["']/.test(text)) {
            offenders.push(path);
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
