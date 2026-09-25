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

function fakeEvent(shape: { type: string; sender: string; msgtype?: string; body?: string; ts: number }): MatrixEvent {
  return {
    getId: () => `$${shape.ts}`,
    getType: () => shape.type,
    getSender: () => shape.sender,
    getContent: () => ({ msgtype: shape.msgtype, body: shape.body }),
    getTs: () => shape.ts,
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
    getRoom: vi.fn(() => fakeRoom()),
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
            fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "ship it", ts: 2_000 }),
            fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "earlier", ts: 1_000 }),
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
