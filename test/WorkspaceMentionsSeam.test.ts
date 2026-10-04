import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #222: the seam's half of "every mention across conversations". The
 * homeserver's own highlight-tier notifications (client-server API
 * `GET /_matrix/client/v3/notifications`) are the ask; the seam asks for
 * `only=highlight`, re-checks that each one actually carries a highlight
 * tweak (a homeserver may answer the filter loosely), and projects what's
 * left the same way the timeline projection does — same-id attribution,
 * edits and redactions are not rows, a thread mention carries its root.
 * This installed matrix-js-sdk (v34) exposes no `client.getNotifications()`
 * convenience method — only the raw endpoint, through `client.http`, which
 * is why the seam calls it directly rather than a method the SDK doesn't have.
 */
vi.mock("matrix-js-sdk", () => ({
  createClient: vi.fn(),
  ClientEvent: { Sync: "sync" },
  // #211: backward-pagination token checks (`loadOlder`) read this.
  Direction: { Backward: "b", Forward: "f" },
  // #209: LocalEchoUpdated alongside Timeline — the seam's `subscribe`
  // listens for both (room news with no arrival vs. a message's arrival).
  RoomEvent: { Timeline: "timeline", LocalEchoUpdated: "Room.localEchoUpdated" },
  SyncState: { Prepared: "PREPARED" },
  Method: { Get: "GET" },
  TweakName: { Highlight: "highlight" },
  MsgType: { Text: "m.text", File: "m.file", Image: "m.image" },
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
const DIRECT = "!direct:workspace.example";

/** A raw event as the homeserver's `/notifications` hands it back — snake_case, straight off the wire. */
function wireEvent(shape: {
  id: string;
  room?: string;
  sender: string;
  ts: number;
  body?: string;
  msgtype?: string;
  type?: string;
  relatesTo?: { rel_type: string; event_id: string };
  redacted?: boolean;
}) {
  return {
    event_id: shape.id,
    room_id: shape.room ?? PROJECT,
    sender: shape.sender,
    origin_server_ts: shape.ts,
    type: shape.type ?? "m.room.message",
    content: { msgtype: shape.msgtype ?? "m.text", body: shape.body ?? "", "m.relates_to": shape.relatesTo },
    unsigned: shape.redacted ? { redacted_because: {} } : undefined,
  };
}

type WireEvent = ReturnType<typeof wireEvent>;

/** One notification as `/notifications` returns it: the event, which room it's in, whether it's a highlight, and whether a receipt has passed it. */
function notification(shape: { event: WireEvent; highlight?: boolean; read?: boolean }) {
  return {
    actions: shape.highlight === false ? ["notify"] : [{ set_tweak: "highlight", value: true }],
    event: shape.event,
    profile_tag: undefined,
    read: shape.read ?? false,
    room_id: shape.event.room_id,
    ts: shape.event.origin_server_ts,
  };
}

function notificationsResponse(notifications: ReturnType<typeof notification>[], nextToken?: string) {
  return { notifications, next_token: nextToken };
}

/** A joined room the client knows, and the member names it holds. */
function fakeRoom(roomId: string, over: { names?: Record<string, string> } = {}): Room {
  return {
    roomId,
    name: roomId,
    getMember: (userId: string) => (over.names?.[userId] ? ({ name: over.names[userId] } as RoomMember) : null),
  } as unknown as Room;
}

/** The SDK's own event mapper: turns a raw wire event into a `MatrixEvent`-shaped object with a mutable `.event`, the same thing `client.getEventMapper()` returns for real. */
function fakeEventMapper() {
  return (raw: WireEvent): MatrixEvent => {
    const event = { ...raw } as WireEvent & { unsigned?: { redacted_because?: unknown } };
    return {
      event,
      getId: () => event.event_id,
      getType: () => event.type,
      getSender: () => event.sender,
      getContent: () => event.content,
      getTs: () => event.origin_server_ts,
      isRedacted: () => Boolean(event.unsigned?.redacted_because),
    } as unknown as MatrixEvent;
  };
}

type FakeClient = MatrixClient & {
  on: ReturnType<typeof vi.fn>;
  http: { authedRequest: ReturnType<typeof vi.fn> };
  getEventMapper: ReturnType<typeof vi.fn>;
};

function fakeClient(over: { rooms?: Room[]; answer?: unknown; error?: Error } = {}): FakeClient {
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
    getEventMapper: vi.fn(() => fakeEventMapper()),
    http: {
      authedRequest: vi.fn(async () => {
        if (over.error) {
          throw over.error;
        }
        return over.answer ?? notificationsResponse([]);
      }),
    },
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

describe("#222 — the wire: highlight notifications, asked of the homeserver", () => {
  it("asks GET /notifications for highlight-tier only, with a page size", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.mentions();

    expect(client.http.authedRequest).toHaveBeenCalledTimes(1);
    const [method, path, params] = client.http.authedRequest.mock.calls[0]!;
    expect(method).toBe("GET");
    expect(path).toBe("/notifications");
    expect(params).toMatchObject({ only: "highlight" });
    expect(Number(params.limit)).toBeGreaterThan(0);
  });

  it("a homeserver that answers the filter loosely still only yields actually-highlighted notifications", async () => {
    const client = fakeClient({
      answer: notificationsResponse([
        notification({ event: wireEvent({ id: "$h", sender: "@bose:workspace.example", ts: 10, body: "@ana check this" }), highlight: true }),
        notification({ event: wireEvent({ id: "$n", sender: "@bose:workspace.example", ts: 20, body: "just fyi, no mention" }), highlight: false }),
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const hits = await connection.mentions();

    expect(hits.map((hit) => hit.eventId)).toEqual(["$h"]);
  });

  it("a request the homeserver refuses is a rejection", async () => {
    const client = fakeClient({ error: new Error("M_UNKNOWN") });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await expect(connection.mentions()).rejects.toThrow("M_UNKNOWN");
  });
});

describe("#222 AC1 — the projection: a mention is a message with its conversation, author, and time", () => {
  it("projects the event's ids, author id (with the room's own name), words, server time, and the homeserver's read flag", async () => {
    const client = fakeClient({
      rooms: [fakeRoom(PROJECT, { names: { "@bose:workspace.example": "Bose" } })],
      answer: notificationsResponse([
        notification({
          event: wireEvent({ id: "$q", room: PROJECT, sender: "@bose:workspace.example", ts: 1_700_000_000_000, body: "@ana, can you take a look?" }),
          read: false,
        }),
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [hit] = await connection.mentions();

    expect(hit).toMatchObject({
      eventId: "$q",
      roomId: PROJECT,
      senderId: "@bose:workspace.example",
      senderName: "Bose",
      body: "@ana, can you take a look?",
      originServerTs: 1_700_000_000_000,
      read: false,
      threadRootEventId: null,
    });
  });

  it("a sender the room holds no name for reads under their localpart", async () => {
    const client = fakeClient({
      rooms: [fakeRoom(PROJECT)],
      answer: notificationsResponse([
        notification({ event: wireEvent({ id: "$q", sender: "@dee:workspace.example", ts: 5, body: "@ana?" }) }),
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [hit] = await connection.mentions();
    expect(hit!.senderName).toBe("dee");
  });

  it("a mention inside a thread carries its root, the way a search hit does (#70)", async () => {
    const client = fakeClient({
      answer: notificationsResponse([
        notification({
          event: wireEvent({
            id: "$r1",
            sender: "@bose:workspace.example",
            ts: 30,
            body: "@ana replying here",
            relatesTo: { rel_type: "m.thread", event_id: "$root" },
          }),
        }),
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [hit] = await connection.mentions();
    expect(hit!.threadRootEventId).toBe("$root");
  });

  it("newest first — re-sorted here, not trusted off the wire", async () => {
    const client = fakeClient({
      answer: notificationsResponse([
        notification({ event: wireEvent({ id: "$old", sender: "@bose:workspace.example", ts: 1_000, body: "@ana first" }) }),
        notification({ event: wireEvent({ id: "$new", sender: "@bose:workspace.example", ts: 3_000, body: "@ana third" }) }),
        notification({ event: wireEvent({ id: "$mid", sender: "@bose:workspace.example", ts: 2_000, body: "@ana second" }) }),
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const hits = await connection.mentions();
    expect(hits.map((hit) => hit.eventId)).toEqual(["$new", "$mid", "$old"]);
  });

  it("mentions from several conversations all come back, each with its own room id", async () => {
    const client = fakeClient({
      rooms: [fakeRoom(PROJECT), fakeRoom(DIRECT)],
      answer: notificationsResponse([
        notification({ event: wireEvent({ id: "$p", room: PROJECT, sender: "@bose:workspace.example", ts: 10, body: "@ana in project" }) }),
        notification({ event: wireEvent({ id: "$d", room: DIRECT, sender: "@bose:workspace.example", ts: 20, body: "@ana in dm" }) }),
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const hits = await connection.mentions();
    expect(hits.map((hit) => hit.roomId).sort()).toEqual([DIRECT, PROJECT].sort());
  });
});

describe("#222 AC2 — only messages are mentions", () => {
  it("a struck (redacted) notification is not a row — it has no words left to read", async () => {
    const client = fakeClient({
      answer: notificationsResponse([
        notification({ event: wireEvent({ id: "$gone", sender: "@bose:workspace.example", ts: 10, body: "@ana", redacted: true }) }),
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(await connection.mentions()).toEqual([]);
  });

  it("an edit's replacement event is not a row of its own — the same rule the timeline and search projections hold", async () => {
    const client = fakeClient({
      answer: notificationsResponse([
        notification({
          event: wireEvent({
            id: "$edit",
            sender: "@bose:workspace.example",
            ts: 10,
            body: "* @ana edited",
            relatesTo: { rel_type: "m.replace", event_id: "$original" },
          }),
        }),
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(await connection.mentions()).toEqual([]);
  });

  it("a share (file/image) carries no mentioning words and is not a row", async () => {
    const client = fakeClient({
      answer: notificationsResponse([
        notification({ event: wireEvent({ id: "$f", sender: "@bose:workspace.example", ts: 10, body: "report.pdf", msgtype: "m.file" }) }),
      ]),
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(await connection.mentions()).toEqual([]);
  });
});
