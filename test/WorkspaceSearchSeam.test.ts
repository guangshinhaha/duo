import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #70: the seam's half of message search. Search is the homeserver's own
 * (client-server API §Server-side search, `POST /search`): the seam asks it,
 * with the member's words, and projects what comes back. The homeserver
 * scopes the search to the rooms the member is in; the seam adds no scoping
 * of its own to the request (a client-chosen room list would be a second
 * opinion about membership) but refuses to project a result from a room
 * this account is not joined to — a defence at the last inch, so a server
 * slip can never put another conversation's words on this member's screen.
 * Landing at a hit is the homeserver's `/context` (via the SDK's
 * getEventTimeline): the window around the event, not the live timeline.
 */
vi.mock("matrix-js-sdk", () => ({
  createClient: vi.fn(),
  ClientEvent: { Sync: "sync", Event: "event", AccountData: "accountData" },
  // #287: `connect()` calls this at least once on every connect.
  SetPresence: { Offline: "offline", Online: "online", Unavailable: "unavailable" },
  // #211: backward-pagination token checks (`loadOlder`) read this.
  Direction: { Backward: "b", Forward: "f" },
  RoomEvent: { Timeline: "timeline", LocalEchoUpdated: "Room.localEchoUpdated" },
  SyncState: { Prepared: "PREPARED" },
  MsgType: { Text: "m.text" },
  ReceiptType: { Read: "m.read", FullyRead: "m.fully_read", ReadPrivate: "m.read.private" },
  NotificationCountType: { Highlight: "highlight", Total: "total" },
  PushRuleKind: { Override: "override", ContentSpecific: "content", RoomSpecific: "room", SenderSpecific: "sender", Underride: "underride" },
  EventType: { RoomMessage: "m.room.message", Reaction: "m.reaction", RoomRedaction: "m.room.redaction" },
  RelationType: { Annotation: "m.annotation", Replace: "m.replace", Thread: "m.thread", Reference: "m.reference" },
  // #209: Detached pending-event ordering (startClient) and the local-echo
  // statuses the projection maps to pending/failed.
  PendingEventOrdering: { Chronological: "chronological", Detached: "detached" },
  EventStatus: {
    NOT_SENT: "not_sent",
    ENCRYPTING: "encrypting",
    SENDING: "sending",
    QUEUED: "queued",
    SENT: "sent",
    CANCELLED: "cancelled",
  },
  MatrixError: class MatrixError extends Error {
    errcode?: string;
  },
}));

import { ClientEvent, createClient } from "matrix-js-sdk";
import { connect } from "../src/workspace/matrix.js";
import type { MatrixClient, MatrixEvent, Room, RoomMember } from "matrix-js-sdk";

const SESSION = {
  homeserverUrl: "https://workspace.example",
  userId: "@ana:workspace.example",
  accessToken: "syt_workspace_token",
  deviceId: "YGBNAUIOMK",
};

const PROJECT = "!project-x:workspace.example";
const SECRET = "!leadership:workspace.example";
const LEFT = "!old-team:workspace.example";

/** A raw event as the homeserver's `/search` and `/context` hand it back — snake_case, straight off the wire. */
function wireEvent(shape: {
  id: string;
  room?: string;
  sender: string;
  ts: number;
  body?: string;
  msgtype?: string;
  relatesTo?: { rel_type: string; event_id: string };
  type?: string;
}) {
  return {
    event_id: shape.id,
    room_id: shape.room ?? PROJECT,
    sender: shape.sender,
    origin_server_ts: shape.ts,
    type: shape.type ?? "m.room.message",
    content: { msgtype: shape.msgtype ?? "m.text", body: shape.body ?? "", "m.relates_to": shape.relatesTo },
  };
}

function searchResponse(results: Array<{ rank?: number; result: ReturnType<typeof wireEvent>; before?: ReturnType<typeof wireEvent>[]; after?: ReturnType<typeof wireEvent>[]; profiles?: Record<string, { displayname?: string }> }>, nextBatch?: string) {
  return {
    search_categories: {
      room_events: {
        count: results.length,
        results: results.map((entry, index) => ({
          rank: entry.rank ?? index,
          result: entry.result,
          context: {
            events_before: entry.before ?? [],
            events_after: entry.after ?? [],
            profile_info: entry.profiles ?? {},
          },
        })),
        next_batch: nextBatch,
      },
    },
  };
}

/** A joined room the client knows, its membership names, and (when asked) the timeline the context window resolves to. */
function fakeRoom(roomId: string, over: { membership?: string; names?: Record<string, string>; windowEvents?: MatrixEvent[] } = {}): Room {
  const timelineSet = { tag: `set-of-${roomId}` };
  return {
    roomId,
    name: roomId,
    getMyMembership: () => over.membership ?? "join",
    getMember: (userId: string) => (over.names?.[userId] ? ({ name: over.names[userId] } as RoomMember) : null),
    getUnfilteredTimelineSet: () => timelineSet,
    getLiveTimeline: () => ({ getEvents: () => [] }),
  } as unknown as Room;
}

function fakeMatrixEvent(shape: { id: string; sender: string; ts: number; body: string; relatesTo?: { rel_type: string; event_id: string } }): MatrixEvent {
  return {
    getId: () => shape.id,
    getType: () => "m.room.message",
    getSender: () => shape.sender,
    getContent: () => ({ msgtype: "m.text", body: shape.body, "m.relates_to": shape.relatesTo }),
    getTs: () => shape.ts,
    isRedacted: () => false,
  } as unknown as MatrixEvent;
}

type FakeClient = MatrixClient & {
  on: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  getEventTimeline: ReturnType<typeof vi.fn>;
};

function fakeClient(over: { rooms?: Room[]; searchAnswer?: unknown; searchError?: Error; timelineEvents?: MatrixEvent[] } = {}): FakeClient {
  const rooms = over.rooms ?? [fakeRoom(PROJECT, { names: { "@bose:workspace.example": "Bose" } })];
  const client = {
    userId: SESSION.userId,
    getUserId: () => SESSION.userId,
    on: vi.fn(),
    off: vi.fn(),
    startClient: vi.fn(),
    stopClient: vi.fn(() => Promise.resolve()),
    getRooms: vi.fn(() => rooms),
    getRoom: vi.fn((roomId: string) => rooms.find((room) => room.roomId === roomId) ?? null),
    search: vi.fn(async () => {
      if (over.searchError) {
        throw over.searchError;
      }
      return over.searchAnswer ?? searchResponse([]);
    }),
    getEventTimeline: vi.fn(async () => ({ getEvents: () => over.timelineEvents ?? [] })),
    // #287: `connect()` touches presence on every connect, whether or not
    // this test exercises it — a bare-bones fixture still needs the door.
    getAccountData: vi.fn(() => undefined),
    setAccountData: vi.fn(async () => undefined),
    getUser: vi.fn(() => null),
    setPresence: vi.fn(async () => undefined),
    setSyncPresence: vi.fn(async () => undefined),
  };
  return client as unknown as FakeClient;
}

async function connectPrepared(client: FakeClient) {
  const pending = connect(SESSION);
  const syncHandler = client.on.mock.calls.find(([event]) => event === ClientEvent.Sync)?.[1] as (state: string) => void;
  syncHandler?.("PREPARED");
  return pending;
}

beforeEach(() => {
  vi.mocked(createClient).mockReset();
});

describe("#70 — the wire: one search, asked of the homeserver, in the member's words", () => {
  it("asks /search over the message bodies with the words as given, a page size, and the context window", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.searchMessages("  refund policy  ");

    expect(client.search).toHaveBeenCalledTimes(1);
    const request = client.search.mock.calls[0]![0] as { body: { search_categories: { room_events: Record<string, unknown> } }; next_batch?: string };
    expect(request.next_batch).toBeUndefined();
    expect(request.body).toEqual({
      search_categories: {
        room_events: {
          search_term: "refund policy",
          keys: ["content.body"],
          filter: { limit: 20 },
          event_context: { before_limit: 2, after_limit: 2, include_profile: true },
        },
      },
    });
  });

  it("chooses no rooms — scoping to the member's conversations is the homeserver's own rule, not a second opinion held here", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.searchMessages("refund");

    const roomEvents = (client.search.mock.calls[0]![0] as { body: { search_categories: { room_events: { filter?: Record<string, unknown> } } } }).body
      .search_categories.room_events;
    expect(Object.keys(roomEvents.filter ?? {})).not.toContain("rooms");
    expect(Object.keys(roomEvents.filter ?? {})).not.toContain("not_rooms");
  });

  it("carries the page token forward as the next batch, and answers the token it was given", async () => {
    const client = fakeClient({ searchAnswer: searchResponse([{ result: wireEvent({ id: "$1", sender: "@bose:workspace.example", ts: 5, body: "refund" }) }], "tok-2") });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const page = await connection.searchMessages("refund", "tok-1");

    expect((client.search.mock.calls[0]![0] as { next_batch?: string }).next_batch).toBe("tok-1");
    expect(page.next).toBe("tok-2");
  });

  it("the last page has no next token", async () => {
    const client = fakeClient({ searchAnswer: searchResponse([{ result: wireEvent({ id: "$1", sender: "@bose:workspace.example", ts: 5, body: "refund" }) }]) });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect((await connection.searchMessages("refund")).next).toBeNull();
  });

  it("an empty query asks nothing of the homeserver", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(await connection.searchMessages("   ")).toEqual({ hits: [], next: null });
    expect(client.search).not.toHaveBeenCalled();
  });

  it("a search the homeserver refuses is a rejection — never an empty answer that reads as 'nothing found'", async () => {
    const client = fakeClient({ searchError: new Error("M_LIMIT_EXCEEDED") });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await expect(connection.searchMessages("refund")).rejects.toThrow("M_LIMIT_EXCEEDED");
  });
});

describe("#70 AC1 — the projection: a hit is a message with its conversation, author, and surroundings", () => {
  it("projects the hit's ids, author id, words, and server time, with the room's own record of the author's name", async () => {
    const client = fakeClient({
      searchAnswer: searchResponse([
        { result: wireEvent({ id: "$q", sender: "@bose:workspace.example", ts: 1_700_000_000_000, body: "what's our refund policy?" }) },
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const { hits } = await connection.searchMessages("refund");

    expect(hits).toEqual([
      {
        eventId: "$q",
        roomId: PROJECT,
        senderId: "@bose:workspace.example",
        senderName: "Bose",
        body: "what's our refund policy?",
        originServerTs: 1_700_000_000_000,
        threadRootEventId: null,
        context: { before: [], after: [] },
      },
    ]);
  });

  it("names an author the room doesn't know from the search's own profile, else the localpart — a name is a claim, the id rides beside it", async () => {
    const client = fakeClient({
      searchAnswer: searchResponse([
        {
          result: wireEvent({ id: "$1", sender: "@dee:workspace.example", ts: 1, body: "refund?" }),
          profiles: { "@dee:workspace.example": { displayname: "Dee D." } },
        },
        { result: wireEvent({ id: "$2", sender: "@duo-carol:workspace.example", ts: 2, body: "refund: 30 days" }) },
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const { hits } = await connection.searchMessages("refund");

    expect(hits[0]).toMatchObject({ senderId: "@dee:workspace.example", senderName: "Dee D." });
    expect(hits[1]).toMatchObject({ senderId: "@duo-carol:workspace.example", senderName: "duo-carol" });
  });

  it("gives the context in the order it was said, whichever order the server listed it in, dropping what isn't conversation", async () => {
    const client = fakeClient({
      searchAnswer: searchResponse([
        {
          result: wireEvent({ id: "$q", sender: "@bose:workspace.example", ts: 100, body: "refund?" }),
          // The spec doesn't fix the listing order of events_before; the seam reads it by server time.
          before: [
            wireEvent({ id: "$b2", sender: "@bose:workspace.example", ts: 90, body: "second before" }),
            wireEvent({ id: "$b1", sender: "@bose:workspace.example", ts: 80, body: "first before" }),
            wireEvent({ id: "$file", sender: "@bose:workspace.example", ts: 85, body: "policy.pdf", msgtype: "m.file" }),
          ],
          after: [
            wireEvent({ id: "$a1", sender: "@duo-carol:workspace.example", ts: 110, body: "30 days" }),
            wireEvent({ id: "$topic", sender: "@bose:workspace.example", ts: 111, type: "m.room.topic" }),
          ],
        },
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const { hits } = await connection.searchMessages("refund");

    expect(hits[0]!.context.before.map((line) => line.body)).toEqual(["first before", "second before"]);
    expect(hits[0]!.context.after).toEqual([{ senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "30 days" }]);
  });

  it("a thread reply's hit carries its thread's root, so opening it lands in the thread", async () => {
    const client = fakeClient({
      searchAnswer: searchResponse([
        {
          result: wireEvent({
            id: "$r1", sender: "@duo-carol:workspace.example", ts: 5, body: "np, 30 days for refunds",
            relatesTo: { rel_type: "m.thread", event_id: "$q" },
          }),
        },
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const { hits } = await connection.searchMessages("refunds");

    expect(hits[0]).toMatchObject({ eventId: "$r1", threadRootEventId: "$q" });
  });

  it("keeps only the conversation's words: an edit's replacement event, a file, and a notice are not hits", async () => {
    const client = fakeClient({
      searchAnswer: searchResponse([
        { result: wireEvent({ id: "$e", sender: "@bose:workspace.example", ts: 4, body: "* refunds: 45 days", relatesTo: { rel_type: "m.replace", event_id: "$q" } }) },
        { result: wireEvent({ id: "$f", sender: "@bose:workspace.example", ts: 5, body: "refund-policy.pdf", msgtype: "m.file" }) },
        { result: wireEvent({ id: "$n", sender: "@bose:workspace.example", ts: 6, body: "refund bot online", msgtype: "m.notice" }) },
        { result: wireEvent({ id: "$t", sender: "@bose:workspace.example", ts: 7, body: "refund policy" }) },
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const { hits } = await connection.searchMessages("refund");

    expect(hits.map((hit) => hit.eventId)).toEqual(["$t"]);
  });
});

describe("#70 AC2 — results respect membership", () => {
  it("never projects a result from a conversation this account is not joined to, even if the server sent it", async () => {
    const client = fakeClient({
      rooms: [fakeRoom(PROJECT)],
      searchAnswer: searchResponse([
        { result: wireEvent({ id: "$ok", room: PROJECT, sender: "@bose:workspace.example", ts: 1, body: "refund ok" }) },
        {
          result: wireEvent({ id: "$leak", room: SECRET, sender: "@dee:workspace.example", ts: 2, body: "refund budget is secret" }),
          before: [wireEvent({ id: "$leak-ctx", room: SECRET, sender: "@dee:workspace.example", ts: 1, body: "leadership only" })],
        },
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const { hits } = await connection.searchMessages("refund");

    expect(hits.map((hit) => hit.eventId)).toEqual(["$ok"]);
    expect(JSON.stringify(hits)).not.toContain("secret");
    expect(JSON.stringify(hits)).not.toContain("leadership");
  });

  it("nor from one the account has left — a membership the homeserver dropped is not one this client remembers for it", async () => {
    const client = fakeClient({
      rooms: [fakeRoom(PROJECT), fakeRoom(LEFT, { membership: "leave" })],
      searchAnswer: searchResponse([
        { result: wireEvent({ id: "$old", room: LEFT, sender: "@bose:workspace.example", ts: 1, body: "refund from before I left" }) },
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect((await connection.searchMessages("refund")).hits).toEqual([]);
  });
});

describe("#70 AC1 — landing at a hit, in context", () => {
  it("reads the window around the event from the homeserver and projects it like any timeline — the hit among its neighbours", async () => {
    const client = fakeClient({
      timelineEvents: [
        fakeMatrixEvent({ id: "$before", sender: "@bose:workspace.example", ts: 10, body: "quick one before standup" }),
        fakeMatrixEvent({ id: "$q", sender: "@bose:workspace.example", ts: 20, body: "what's our refund policy?" }),
        fakeMatrixEvent({ id: "$a", sender: "@duo-carol:workspace.example", ts: 30, body: "Refunds within 30 days" }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const messages = await connection.timelineAt(PROJECT, "$q");

    expect(client.getEventTimeline).toHaveBeenCalledTimes(1);
    expect(client.getEventTimeline.mock.calls[0]![1]).toBe("$q");
    expect(messages.map((message) => message.eventId)).toEqual(["$before", "$q", "$a"]);
    // Attribution keeps riding the id: the duo's message is a duo-shaped sender, whatever the window's names say.
    expect(messages[2]).toMatchObject({ senderId: "@duo-carol:workspace.example", roomId: PROJECT });
  });

  it("a conversation this account isn't in has no window to read", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(await connection.timelineAt(SECRET, "$x")).toEqual([]);
    expect(client.getEventTimeline).not.toHaveBeenCalled();
  });
});
