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
  // #211: backward-pagination token checks (`loadOlder`) read this.
  Direction: { Backward: "b", Forward: "f" },
  // #209: LocalEchoUpdated alongside Timeline — the seam's `subscribe`
  // listens for both (room news with no arrival vs. a message's arrival).
  RoomEvent: { Timeline: "timeline", LocalEchoUpdated: "Room.localEchoUpdated" },
  SyncState: { Prepared: "PREPARED", Error: "ERROR" },
  MsgType: { Text: "m.text", File: "m.file", Image: "m.image" },
  ReceiptType: { Read: "m.read", FullyRead: "m.fully_read", ReadPrivate: "m.read.private" },
  NotificationCountType: { Highlight: "highlight", Total: "total" },
  Preset: { PrivateChat: "private_chat", TrustedPrivateChat: "trusted_private_chat", PublicChat: "public_chat" },
  PushRuleKind: { Override: "override", ContentSpecific: "content", RoomSpecific: "room", SenderSpecific: "sender", Underride: "underride" },
  EventType: {
    RoomMessage: "m.room.message",
    Reaction: "m.reaction",
    RoomRedaction: "m.room.redaction",
    RoomName: "m.room.name",
    RoomTopic: "m.room.topic",
    RoomAvatar: "m.room.avatar",
    RoomPowerLevels: "m.room.power_levels",
  },
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

import { ClientEvent, createClient, EventStatus, MatrixError, MsgType, PendingEventOrdering, ReceiptType, RoomEvent } from "matrix-js-sdk";
import { connect, normalizeHomeserverUrl, signIn } from "../src/workspace/matrix.js";
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
    /** #65: the HTML body a mentioning message carries its matrix.to pill anchors in. */
    format?: string;
    formattedBody?: string;
    /** #65: the m.mentions user ids as sent — the intentional-mention list. */
    mentions?: string[];
    /** The event's relation — a replacement, an annotation, or a thread reply. */
    relatesTo?: { rel_type: string; event_id: string; key?: string; is_falling_back?: boolean };
    /** #215: a plain reply's target — the spec's shape with no `rel_type` at all, distinct from `relatesTo` above (which always carries one). Mutually exclusive with it in practice; never both at once. */
    replyToEventId?: string;
    /** A replacement's new body, under m.new_content. */
    newContent?: { msgtype: string; body: string };
    /** A file message's share: the upload's stable reference and the declared facts. */
    url?: string;
    filename?: string;
    info?: { mimetype?: string; size?: number };
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
      format: shape.format,
      formatted_body: shape.formattedBody,
      "m.mentions": shape.mentions === undefined ? undefined : { user_ids: shape.mentions },
      filename: shape.filename,
      url: shape.url,
      info: shape.info,
      "m.new_content": shape.newContent,
      "m.relates_to":
        shape.relatesTo ?? (shape.replyToEventId === undefined ? undefined : { "m.in_reply_to": { event_id: shape.replyToEventId } }),
    }),
    getTs: () => shape.ts,
    isRedacted: () => shape.redacted ?? false,
  } as unknown as MatrixEvent;
}

function fakeRoom(pendingEvents: MatrixEvent[] = []): Room {
  const member = (userId: string): RoomMember | null =>
    userId === "@bose:workspace.example" ? ({ name: "Bose" } as RoomMember) : null;
  return {
    roomId: "!project-x:workspace.example",
    name: "project-x",
    // #209: this device's own sends still in flight — empty unless a test
    // asks otherwise (the local-echo projection tests below).
    getPendingEvents: () => pendingEvents,
    getLiveTimeline: () => ({
      getEvents: () => [
        fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "what's our refund policy?", ts: 1_700_000_000_000 }),
        fakeEvent({ type: "m.room.topic", sender: "@bose:workspace.example", body: "refunds", ts: 1_700_000_000_001 }),
        fakeEvent({ type: "m.room.message", sender: "@duo-carol:workspace.example", msgtype: "m.text", body: "Refunds within 30 days, full amount.", ts: 1_700_000_000_002 }),
        fakeEvent({
          type: "m.room.message",
          sender: "@nobody:workspace.example",
          msgtype: "m.file",
          body: "refund-policy.pdf",
          ts: 1_700_000_000_003,
          url: "mxc://workspace.example/policy1",
          filename: "refund-policy.pdf",
          info: { mimetype: "application/pdf", size: 48_000 },
        }),
      ],
    }),
    getMember: member,
    loadMembersIfNeeded: vi.fn(async () => true),
    getMembers: () => [{ userId: "@bose:workspace.example", name: "Bose", membership: "join" }],
    // #207: startDirect's existing-DM check walks every visible room —
    // "join" and no DM partner here, so the default fixture never looks
    // like one already open with anybody.
    getMyMembership: () => "join",
    guessDMUserId: () => "@nobody:workspace.example",
    normalizedName: "project-x",
  } as unknown as Room;
}

/** The mock surface the seam drives, kept as a type so the fakes carry their .mock through every helper. */
type FakeClient = MatrixClient & {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  startClient: ReturnType<typeof vi.fn>;
  setAccessToken: ReturnType<typeof vi.fn>;
  stopClient: ReturnType<typeof vi.fn>;
  getRooms: ReturnType<typeof vi.fn>;
  getVisibleRooms: ReturnType<typeof vi.fn>;
  getRoom: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  getAccountData: ReturnType<typeof vi.fn>;
  setAccountData: ReturnType<typeof vi.fn>;
  getProfileInfo: ReturnType<typeof vi.fn>;
  getPushRules: ReturnType<typeof vi.fn>;
  createRoom: ReturnType<typeof vi.fn>;
  invite: ReturnType<typeof vi.fn>;
  joinRoom: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  addPushRule: ReturnType<typeof vi.fn>;
  deletePushRule: ReturnType<typeof vi.fn>;
  setRoomAccountData: ReturnType<typeof vi.fn>;
  searchUserDirectory: ReturnType<typeof vi.fn>;
  sendReadReceipt: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  redactEvent: ReturnType<typeof vi.fn>;
  uploadContent: ReturnType<typeof vi.fn>;
  mxcUrlToHttp: ReturnType<typeof vi.fn>;
  getUrlPreview: ReturnType<typeof vi.fn>;
  setRoomName: ReturnType<typeof vi.fn>;
  setRoomTopic: ReturnType<typeof vi.fn>;
  sendStateEvent: ReturnType<typeof vi.fn>;
  resendEvent: ReturnType<typeof vi.fn>;
  cancelPendingEvent: ReturnType<typeof vi.fn>;
  getEventTimeline: ReturnType<typeof vi.fn>;
  scrollback: ReturnType<typeof vi.fn>;
  setRoomReadMarkers: ReturnType<typeof vi.fn>;
  setDisplayName: ReturnType<typeof vi.fn>;
  setAvatarUrl: ReturnType<typeof vi.fn>;
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
    userId: SESSION.userId,
    getUserId: () => SESSION.userId,
    on: vi.fn(),
    off: vi.fn(),
    startClient: vi.fn(),
    setAccessToken: vi.fn(),
    stopClient: vi.fn(() => Promise.resolve()),
    getRooms: vi.fn(() => over.rooms ?? [fakeRoom()]),
    getVisibleRooms: vi.fn(() => over.rooms ?? [fakeRoom()]),
    getRoom: vi.fn(() => over.rooms?.[0] ?? fakeRoom()),
    sendMessage: vi.fn(() => Promise.resolve()),
    login: vi.fn(() => Promise.resolve({ access_token: "syt_workspace_token", user_id: "@ana:workspace.example", device_id: "YGBNAUIOMK" })),
    getAccountData: vi.fn((eventType: string) =>
      eventType === "m.direct"
        ? { getContent: () => ({ "@bose:workspace.example": over.directRoomIds ?? [] }) }
        : undefined,
    ),
    setAccountData: vi.fn(async () => ({})),
    getProfileInfo: vi.fn(async () => {
      throw new Error("no profile in this fake — override per test");
    }),
    getPushRules: vi.fn(async () => ({
      global: { room: (over.mutedRoomIds ?? []).map((roomId) => ({ rule_id: roomId, enabled: true, actions: [] })) },
    })),
    createRoom: vi.fn(async () => ({ room_id: "!fresh:workspace.example" })),
    invite: vi.fn(async () => ({})),
    joinRoom: vi.fn(async () => ({})),
    leave: vi.fn(async () => ({})),
    addPushRule: vi.fn(async () => ({})),
    deletePushRule: vi.fn(async () => ({})),
    setRoomAccountData: vi.fn(async () => ({})),
    searchUserDirectory: vi.fn(async () => ({
      results: [
        { user_id: "@carol:workspace.example", display_name: "Carol" },
        { user_id: "@duo-carol:workspace.example", display_name: undefined },
      ],
    })),
    sendReadReceipt: vi.fn(async () => ({})),
    sendEvent: vi.fn(async () => ({})),
    redactEvent: vi.fn(async () => ({})),
    uploadContent: vi.fn(async () => ({ content_uri: "mxc://workspace.example/abc123" })),
    mxcUrlToHttp: vi.fn(() => "https://workspace.example/_matrix/media/v3/download/workspace.example/abc123"),
    getUrlPreview: vi.fn(async () => ({
      "og:title": "Example",
      "og:type": "website",
      "og:url": "https://example.com",
      "og:description": "An example page.",
      "og:image": "mxc://workspace.example/preview1",
    })),
    setRoomName: vi.fn(async () => ({})),
    setRoomTopic: vi.fn(async () => ({})),
    sendStateEvent: vi.fn(async () => ({})),
    resendEvent: vi.fn(async () => ({})),
    cancelPendingEvent: vi.fn(() => {}),
    getEventTimeline: vi.fn(async () => undefined),
    scrollback: vi.fn(async (room: Room) => room),
    setRoomReadMarkers: vi.fn(async () => ({})),
    setDisplayName: vi.fn(async () => ({})),
    setAvatarUrl: vi.fn(async () => ({})),
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
  members: Array<{ userId: string; name: string | null; powerLevel?: number }>;
  notificationCount: number;
  highlightCount: number;
  events: MatrixEvent[];
  /** #69: the room's account-data notification mode, as another device wrote it. */
  accountDataMode?: "mentions";
  /** #220: the room's `m.marked_unread` account data, as this or another device wrote it. */
  markedUnread?: boolean;
  /** #208: set when this room should read as an invite the SDK knows was flagged `is_direct` — `getDMInviter()`'s own answer. */
  dmInviter?: string;
  /** #214: `rooms()` reads only joined rooms now; #208: also the common case this account's own membership defaults to — "join" unless a test says otherwise. */
  membership?: "join" | "invite";
  /** #223: the room's own topic and picture, as `m.room.topic`/`m.room.avatar` state would carry them — absent when the room has none. */
  topic?: string;
  avatarUrl?: string;
  /** #223: `m.room.power_levels`' content — absent models a room with no such state at all (the spec's own defaults apply). */
  powerLevels?: { events?: Record<string, number>; state_default?: number };
  /** #209: this device's own sends still in flight — empty unless a test asks otherwise. */
  pendingEvents?: MatrixEvent[];
}): Room {
  const lastEventTs = shape.events.length > 0 ? shape.events[shape.events.length - 1]!.getTs() : 0;
  return {
    roomId: shape.roomId,
    name: shape.name,
    normalizedName: shape.name ?? "",
    getJoinRule: () => shape.joinRule,
    getMyMembership: () => shape.membership ?? "join",
    getMembers: () => shape.members.map((member) => ({ userId: member.userId, name: member.name, rawDisplayName: member.name, membership: "join" })),
    getUnreadNotificationCount: (type?: string) => (type === "highlight" ? shape.highlightCount : shape.notificationCount),
    getLiveTimeline: () => ({ getEvents: () => shape.events }),
    getPendingEvents: () => shape.pendingEvents ?? [],
    getUnfilteredTimelineSet: () => ({}),
    // Membership lookup and the member list agree, the way the SDK's do —
    // the timeline projection resolves sender names through this door.
    getMember: (userId: string) => {
      const member = shape.members.find((candidate) => candidate.userId === userId);
      return member
        ? ({ name: member.name ?? null, rawDisplayName: member.name ?? null, powerLevel: member.powerLevel ?? 0 } as RoomMember)
        : null;
    },
    getAccountData: (type: string) => {
      if (type === "duo.notifications" && shape.accountDataMode) {
        return { getContent: () => ({ mode: shape.accountDataMode }) } as MatrixEvent;
      }
      if (type === "m.marked_unread" && shape.markedUnread) {
        return { getContent: () => ({ unread: true }) } as MatrixEvent;
      }
      return undefined;
    },
    // #223: the three state events a group's name, topic and picture ride
    // on, read the way the SDK's RoomState does — a stateKey of "" and
    // null when the room has never carried that event. #208: `m.room.name`
    // is the real name only — never the SDK's auto-generated fill-in, which
    // `.name` above stands in for in every OTHER test here. `projectRoom`
    // reads this door, not `.name`.
    currentState: {
      getStateEvents: (type: string) => {
        if (type === "m.room.name") {
          return shape.name !== null ? ({ getContent: () => ({ name: shape.name }) } as MatrixEvent) : null;
        }
        if (type === "m.room.topic") {
          return shape.topic === undefined ? null : ({ getContent: () => ({ topic: shape.topic }) } as MatrixEvent);
        }
        if (type === "m.room.avatar") {
          return shape.avatarUrl === undefined ? null : ({ getContent: () => ({ url: shape.avatarUrl }) } as MatrixEvent);
        }
        if (type === "m.room.power_levels") {
          return shape.powerLevels === undefined ? null : ({ getContent: () => shape.powerLevels } as MatrixEvent);
        }
        return null;
      },
    },
    getLastActiveTimestamp: () => lastEventTs,
    loadMembersIfNeeded: vi.fn(async () => true),
    getDMInviter: () => shape.dmInviter,
    // #207's findRooms: for a direct room, guessed from its one other
    // member, the way the real SDK's `guessDMUserId` reads a two-person room.
    guessDMUserId: () => shape.members[0]?.userId ?? "",
  } as unknown as Room;
}

/**
 * A room as an INVITED (not yet joined) client sees it (#214): Synapse's
 * stripped `invite_room_state`, never a full member list or a timeline. A
 * DM invite carries `getDMInviter()` (the SDK's own `is_direct` read); any
 * other invite's inviter comes from the one membership event this account
 * does have — its own invite.
 */
function inviteRoom(shape: { roomId: string; name: string | null; joinRule?: string; inviterId: string | null; inviterName?: string | null; direct?: boolean }): Room {
  // The viewer's OWN membership record (keyed by their own id) carries the
  // invite's m.room.member event — whose sender is who invited them. A
  // lookup for anyone else (the inviter's own profile, if it's known) is
  // served separately, the way the real room's membership table would.
  const selfMember = { name: null, events: { member: { getSender: () => shape.inviterId ?? undefined } } } as unknown as RoomMember;
  const inviterProfile = shape.inviterId ? ({ name: shape.inviterName ?? null } as RoomMember) : null;
  return {
    roomId: shape.roomId,
    name: shape.name,
    getJoinRule: () => shape.joinRule ?? "invite",
    getMyMembership: () => "invite",
    getDMInviter: () => (shape.direct ? (shape.inviterId ?? undefined) : undefined),
    getMember: (userId: string) => (userId === SESSION.userId ? selfMember : userId === shape.inviterId ? inviterProfile : null),
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

  it("starts the client with Detached pending-event ordering (#209) — the projection folds the local echo back in itself", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);

    await connectPrepared(client);

    expect(client.startClient).toHaveBeenCalledWith(
      expect.objectContaining({ lazyLoadMembers: true, pendingEventOrdering: PendingEventOrdering.Detached }),
    );
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

/*
 * #127: a hosted session's credential is minted by the operator, so it has no
 * device. The client is built without one and never starts encryption (the
 * only thing that needs a device), and the seam reports the workspace refusing
 * the credential — the hosted hook answers that with a fresh session.
 */
describe("a hosted session — no device, and a credential that can end (#127)", () => {
  const HOSTED_SESSION = { homeserverUrl: "https://workspace.example", userId: "@acme.ada:workspace.example", accessToken: "syt_minted", deviceId: null };

  /** Fires the sync handlers the seam registered, the way the SDK reports a sync state. */
  function emitSync(client: FakeClient, state: string, data?: unknown): void {
    for (const [event, handler] of client.on.mock.calls) {
      if (event === ClientEvent.Sync) {
        (handler as (s: string, prev: string | null, d?: unknown) => void)(state, null, data);
      }
    }
  }

  it("builds the client with no device id and no crypto, and syncs on the access token alone", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const pending = connect(HOSTED_SESSION);
    emitSync(client, "PREPARED");
    await pending;

    const options = vi.mocked(createClient).mock.calls[0]![0]!;
    expect(options.accessToken).toBe("syt_minted");
    expect(options.deviceId).toBeUndefined();
    expect(Object.keys(options).filter((key) => /crypto|device/i.test(key))).toEqual([]);
    expect(client.startClient).toHaveBeenCalledTimes(1);
    // A fake with no crypto entry points would have thrown had the seam tried to start any.
    expect((client as unknown as Record<string, unknown>).initRustCrypto).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).initCrypto).toBeUndefined();
  });

  it("tells its caller once when the workspace stops accepting the credential after the connection is up", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const onSessionRejected = vi.fn();
    const pending = connect(HOSTED_SESSION, { onSessionRejected });
    emitSync(client, "PREPARED");
    await pending;

    emitSync(client, "SYNCING");
    expect(onSessionRejected).not.toHaveBeenCalled();
    emitSync(client, "ERROR", { error: { errcode: "M_UNKNOWN_TOKEN" } });
    expect(onSessionRejected).toHaveBeenCalledTimes(1);
    expect(client.off).toHaveBeenCalled();
  });

  it("a network error is not a refusal", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const onSessionRejected = vi.fn();
    const pending = connect(HOSTED_SESSION, { onSessionRejected });
    emitSync(client, "PREPARED");
    await pending;

    emitSync(client, "ERROR", { error: { errcode: "M_LIMIT_EXCEEDED" } });
    emitSync(client, "ERROR", { error: new Error("offline") });
    expect(onSessionRejected).not.toHaveBeenCalled();
  });

  it("a credential already refused at the first sync rejects the connect by its errcode, and leaves no client polling", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const pending = connect(HOSTED_SESSION);
    emitSync(client, "ERROR", { error: { errcode: "M_UNKNOWN_TOKEN" } });

    await expect(pending).rejects.toMatchObject({ errcode: "M_UNKNOWN_TOKEN" });
    expect(client.stopClient).toHaveBeenCalled();
  });

  it("renewToken swaps the credential under the open client", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const pending = connect(HOSTED_SESSION);
    emitSync(client, "PREPARED");
    const connection = await pending;

    connection.renewToken?.("syt_renewed");

    expect(client.setAccessToken).toHaveBeenCalledWith("syt_renewed");
    expect(client.stopClient).not.toHaveBeenCalled();
  });
});

describe("sign-in's wire rules", () => {
  it("normalizeHomeserverUrl is the one rule for every door: https only, and the origin is what is used (#127)", () => {
    expect(normalizeHomeserverUrl(" https://workspace.example/some/prefix/ ")).toBe("https://workspace.example");
    expect(() => normalizeHomeserverUrl("http://workspace.example")).toThrow(/https/);
    expect(() => normalizeHomeserverUrl("workspace.example")).toThrow();
  });

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
  it("projects conversation turns — text and shares — resolving names from membership, falling back to the localpart", async () => {
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
        // #64 widened the projection: the verbs' folded outcomes ride every
        // row now, at their neutral defaults where nothing happened. #65
        // added `parts` the same way: null where the body is plain words.
        edited: false,
        redacted: false,
        reactions: [],
        thread: null,
        threadRootEventId: null,
        replyToEventId: null,
        parts: null,
      },
      {
        eventId: expect.any(String),
        roomId: "!project-x:workspace.example",
        senderId: "@duo-carol:workspace.example",
        senderName: "duo-carol", // no membership record: the localpart, never a blank
        body: "Refunds within 30 days, full amount.",
        originServerTs: 1_700_000_000_002,
        edited: false,
        redacted: false,
        reactions: [],
        thread: null,
        threadRootEventId: null,
        replyToEventId: null,
        parts: null,
      },
      {
        // #66: a shared file is a conversation turn — its facts are the
        // sender's declarations beside the homeserver's own reference.
        eventId: expect.any(String),
        roomId: "!project-x:workspace.example",
        senderId: "@nobody:workspace.example",
        senderName: "nobody",
        body: "refund-policy.pdf",
        parts: null, // a share's label carries no pills
        file: { name: "refund-policy.pdf", mimeType: "application/pdf", size: 48_000, url: "mxc://workspace.example/policy1", image: false },
        originServerTs: 1_700_000_000_003,
        edited: false,
        redacted: false,
        reactions: [],
        thread: null,
        threadRootEventId: null,
        replyToEventId: null,
      },
    ]);
    // The topic event is still not a conversation turn.
    expect(messages.map((message) => message.body)).not.toContain("refunds");
  });

  it("sends text, and only text, and reports live timeline arrivals for their room", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.send("!project-x:workspace.example", "thanks all");

    // #65: even a mention-less send carries m.mentions — the spec
    // recommends it on every event, because the legacy display-name push
    // rules otherwise fire on any message that happens to contain a name.
    // #216: every text send now also carries a markdown-derived
    // formatted_body, mentions or not — a plain sentence is still its own
    // (trivial) formatting.
    expect(client.sendMessage).toHaveBeenCalledWith("!project-x:workspace.example", {
      msgtype: MsgType.Text,
      body: "thanks all",
      format: "org.matrix.custom.html",
      formatted_body: "<p>thanks all</p>\n",
      "m.mentions": { user_ids: [] },
    });

    const arrivals: string[] = [];
    connection.subscribe((roomId) => arrivals.push(roomId));
    const timelineHandler = client.on.mock.calls.find(([event]) => event === RoomEvent.Timeline)?.[1] as (
      event: MatrixEvent,
      room: Room,
    ) => void;
    timelineHandler?.(fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "np", ts: 1 }), client.getRoom("!x")!);

    expect(arrivals).toEqual(["!project-x:workspace.example"]);
  });

  it("a live text arrival carries what a notification needs — sender, words, and whether it mentions the member (#69)", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const arrivals: Array<{ roomId: string; arrival: unknown }> = [];
    connection.subscribe((roomId, arrival) => arrivals.push({ roomId, arrival }));
    const timelineHandler = client.on.mock.calls.find(([event]) => event === RoomEvent.Timeline)?.[1] as (
      event: MatrixEvent,
      room: Room,
    ) => void;
    const room = client.getRoom("!x")!;

    // A mention of the member: the structured half the push rules read is
    // the same half the arrival reads — one grammar, everywhere.
    timelineHandler?.(
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "@ana, ship it?", ts: 1, mentions: [SESSION.userId] }),
      room,
    );
    // No mention, no marker — false is a fact here, not an absence.
    timelineHandler?.(fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "np", ts: 2 }), room);
    // A thread reply is a message — it interrupts like one.
    timelineHandler?.(
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "in thread", ts: 3, relatesTo: { rel_type: "m.thread", event_id: "$1" } }),
      room,
    );
    // An amendment of an old message is not a new one — the room hears it,
    // the notification path does not.
    timelineHandler?.(
      fakeEvent({
        type: "m.room.message",
        sender: "@bose:workspace.example",
        msgtype: "m.text",
        body: "*",
        ts: 4,
        relatesTo: { rel_type: "m.replace", event_id: "$2" },
        newContent: { msgtype: "m.text", body: "np, 30 days" },
      }),
      room,
    );
    // A reaction is not a message at all.
    timelineHandler?.(fakeEvent({ type: "m.reaction", sender: "@ana:workspace.example", body: "👍", ts: 5, relatesTo: { rel_type: "m.annotation", event_id: "$2", key: "👍" } }), room);

    expect(arrivals).toEqual([
      {
        roomId: "!project-x:workspace.example",
        arrival: { senderId: "@bose:workspace.example", senderName: "Bose", body: "@ana, ship it?", mentionsMe: true },
      },
      { roomId: "!project-x:workspace.example", arrival: { senderId: "@bose:workspace.example", senderName: "Bose", body: "np", mentionsMe: false } },
      {
        roomId: "!project-x:workspace.example",
        arrival: { senderId: "@bose:workspace.example", senderName: "Bose", body: "in thread", mentionsMe: false },
      },
      { roomId: "!project-x:workspace.example", arrival: undefined }, // the replacement
      { roomId: "!project-x:workspace.example", arrival: undefined }, // the reaction
    ]);
  });

  it("a mention rides the wire in the spec's full shape — anchors in formatted_body, ids in m.mentions (#65 AC4)", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    // The body says the mention in words people read; the pills half says
    // it as matrix.to anchors over exactly those words; the structured
    // half says it in ids — which is what drives the receiving member's
    // settings-governed notification (the server's conditional push rule
    // .m.rule.is_user_mention, and with it the list's mention badge).
    await connection.send("!project-x:workspace.example", "@carol's duo what's our refund policy?", [
      { userId: "@duo-carol:workspace.example", label: "The Refund Bot" },
    ]);

    expect(client.sendMessage).toHaveBeenCalledWith("!project-x:workspace.example", {
      msgtype: MsgType.Text,
      body: "@carol's duo what's our refund policy?",
      format: "org.matrix.custom.html",
      // A duo's anchor text is the grammar's — "@carol's duo" from
      // @duo-carol — never the caller's claim, so every reader's pill
      // names the duo, not a name the sender chose. #216: wrapped in a
      // paragraph and its apostrophe entity-encoded — markdown's own doing,
      // on top of the anchor the mention wire always built.
      formatted_body: "<p><a href=\"https://matrix.to/#/@duo-carol:workspace.example\">@carol&#39;s duo</a> what&#39;s our refund policy?</p>\n",
      "m.mentions": { user_ids: ["@duo-carol:workspace.example"] },
    });
    // The mention-less half of the wire contract is pinned by the send
    // above: m.mentions always rides, empty when nothing is addressed.
  });
});

describe("the pills half of the mention wire (#65)", () => {
  it("send anchors each mention's addressed words in order — a duo's derived, a repeat anchored once", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.send("!project-x:workspace.example", "@Carol, @carol's duo — what's our refund policy?", [
      { userId: "@carol:workspace.example", label: "Carol" },
      // The duo's label is advisory only — the seam derives it.
      { userId: "@duo-carol:workspace.example", label: "The Refund Bot" },
      // A repeated id anchors nothing new and pings once.
      { userId: "@carol:workspace.example", label: "Carol" },
    ]);

    expect(client.sendMessage).toHaveBeenCalledWith("!project-x:workspace.example", {
      msgtype: MsgType.Text,
      body: "@Carol, @carol's duo — what's our refund policy?",
      format: "org.matrix.custom.html",
      // #216: same paragraph wrap and apostrophe-encoding as above.
      formatted_body:
        '<p><a href="https://matrix.to/#/@carol:workspace.example">@Carol</a>, ' +
        "<a href=\"https://matrix.to/#/@duo-carol:workspace.example\">@carol&#39;s duo</a> — what&#39;s our refund policy?</p>\n",
      "m.mentions": { user_ids: ["@carol:workspace.example", "@duo-carol:workspace.example"] },
    });
  });

  it("projects formatted_body anchors into parts — a duo's label structural even when the sender lied, a mismatch plain", async () => {
    const events = [
      // Bose mentions Carol (a person) and a colleague's duo. The duo's
      // anchor text is a LIE — "@carol", the owner's name, as if the
      // person were the duo speaking. The projection derives the duo's
      // label from the id.
      fakeEvent({
        type: "m.room.message",
        sender: "@bose:workspace.example",
        msgtype: "m.text",
        body: "@Carol, @carol — what's our refund policy?",
        ts: 1_000,
        format: "org.matrix.custom.html",
        formattedBody:
          '<a href="https://matrix.to/#/@carol:workspace.example">@Carol</a>, ' +
          '<a href="https://matrix.to/#/@duo-carol:workspace.example">@carol</a> — what\'s our refund policy?',
        mentions: ["@carol:workspace.example", "@duo-carol:workspace.example"],
      }),
      // A plain message beside it: no anchors, no parts.
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "ship it", ts: 2_000 }),
      // An anchor whose words the body doesn't carry: no pills rather than
      // wrong ones — the row renders plain.
      fakeEvent({
        type: "m.room.message",
        sender: "@bose:workspace.example",
        msgtype: "m.text",
        body: "lunch?",
        ts: 3_000,
        format: "org.matrix.custom.html",
        formattedBody: '<a href="https://matrix.to/#/@carol:workspace.example">@Carol</a>?',
      }),
      // An edit of the mentioning message: the replacement's words ride
      // m.new_content; this client sends no anchors with an edit, and a
      // fold never carries pills — the row reads plain words, marked.
      fakeEvent({
        type: "m.room.message",
        sender: "@bose:workspace.example",
        msgtype: "m.text",
        body: "* @Carol, @carol — what IS our refund policy?",
        ts: 4_000,
        relatesTo: { rel_type: "m.replace", event_id: "$1000" },
        newContent: { msgtype: "m.text", body: "@Carol, @carol — what IS our refund policy?" },
      }),
    ];
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!project-x:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [
            { userId: "@ana:workspace.example", name: "ana" },
            { userId: "@bose:workspace.example", name: "Bose" },
          ],
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
        body: "@Carol, @carol — what IS our refund policy?",
        originServerTs: 1_000,
        edited: true,
        redacted: false,
        reactions: [],
        thread: null,
        threadRootEventId: null,
        replyToEventId: null,
        parts: null, // the fold's words stand plain — pills don't survive an edit
      },
      {
        eventId: "$2000",
        roomId: "!project-x:workspace.example",
        senderId: "@bose:workspace.example",
        senderName: "Bose",
        body: "ship it",
        originServerTs: 2_000,
        edited: false,
        redacted: false,
        reactions: [],
        thread: null,
        threadRootEventId: null,
        replyToEventId: null,
        parts: null,
      },
      {
        eventId: "$3000",
        roomId: "!project-x:workspace.example",
        senderId: "@bose:workspace.example",
        senderName: "Bose",
        body: "lunch?",
        originServerTs: 3_000,
        edited: false,
        redacted: false,
        reactions: [],
        thread: null,
        threadRootEventId: null,
        replyToEventId: null,
        // The anchor words "@Carol" aren't in the body: degrade to plain.
        parts: null,
        // #213: the formatted half still carries through (and still
        // resolves a label for its anchor) even when the plain-text pills
        // degrade — the formatted-HTML renderer reads it directly and
        // doesn't need the anchor's words to occur in `body`.
        formattedBody: '<a href="https://matrix.to/#/@carol:workspace.example">@Carol</a>?',
        mentionLabels: { "@carol:workspace.example": "Carol" },
      },
    ]);
    // The pre-edit projection, pinned apart from the fold above: the pills
    // the message carried before Bose amended it. A person's label falls
    // back to the anchor's words (no membership record); a duo's label
    // comes from the id, the lie in the anchor text notwithstanding.
    events.splice(3, 1);
    const clientBeforeEdit = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!project-x:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [
            { userId: "@ana:workspace.example", name: "ana" },
            { userId: "@bose:workspace.example", name: "Bose" },
          ],
          notificationCount: 0,
          highlightCount: 0,
          events,
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(clientBeforeEdit);
    const before = await connectPrepared(clientBeforeEdit);
    expect((await before.timeline("!project-x:workspace.example"))[0]).toEqual({
      eventId: "$1000",
      roomId: "!project-x:workspace.example",
      senderId: "@bose:workspace.example",
      senderName: "Bose",
      body: "@Carol, @carol — what's our refund policy?",
      originServerTs: 1_000,
      edited: false,
      redacted: false,
      reactions: [],
      thread: null,
      threadRootEventId: null,
      replyToEventId: null,
      parts: [
        { kind: "mention", userId: "@carol:workspace.example", label: "Carol" },
        { kind: "text", text: ", " },
        { kind: "mention", userId: "@duo-carol:workspace.example", label: "carol's duo" },
        { kind: "text", text: " — what's our refund policy?" },
      ],
      // #213: the same event's formatted half, carried alongside `parts` —
      // both are read off the one `formatted_body`.
      formattedBody:
        '<a href="https://matrix.to/#/@carol:workspace.example">@Carol</a>, ' +
        '<a href="https://matrix.to/#/@duo-carol:workspace.example">@carol</a> — what\'s our refund policy?',
      mentionLabels: { "@carol:workspace.example": "Carol", "@duo-carol:workspace.example": "carol's duo" },
    });
  });
});

describe("#215 — a reply outside a thread", () => {
  it("send with a reply target rides the spec's plain reply relation — no rel_type, composable with mentions", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.send("!project-x:workspace.example", "yes, 30 days", [], "$1000");

    expect(client.sendMessage).toHaveBeenCalledWith("!project-x:workspace.example", {
      msgtype: MsgType.Text,
      body: "yes, 30 days",
      format: "org.matrix.custom.html",
      formatted_body: "<p>yes, 30 days</p>\n",
      "m.mentions": { user_ids: [] },
      "m.relates_to": { "m.in_reply_to": { event_id: "$1000" } },
    });
  });

  it("a reply carries no relation at all when no target is given — the ordinary send stays ordinary", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.send("!project-x:workspace.example", "np", []);

    const [, content] = vi.mocked(client.sendMessage).mock.calls[0]!;
    expect(content).not.toHaveProperty("m.relates_to");
  });

  it("the projection reads a plain reply's target into replyToEventId — a thread reply's own fallback never leaks into it", async () => {
    const events = [
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "what's our refund policy?", ts: 1_000 }),
      // A plain reply outside any thread (#215): no rel_type at all.
      fakeEvent({
        type: "m.room.message",
        sender: "@ana:workspace.example",
        msgtype: "m.text",
        body: "30 days",
        ts: 2_000,
        replyToEventId: "$1000",
      }),
      // A thread reply, for contrast: rel_type m.thread — never read as a
      // #215-style reply, even though the spec's thread fallback nests the
      // very same "m.in_reply_to" key a level deeper than this fixture
      // models (the seam's own condition requires rel_type to be absent,
      // which a thread relation never is).
      fakeEvent({
        type: "m.room.message",
        sender: "@bose:workspace.example",
        msgtype: "m.text",
        body: "in thread",
        ts: 3_000,
        relatesTo: { rel_type: "m.thread", event_id: "$1000" },
      }),
    ];
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!project-x:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [
            { userId: "@ana:workspace.example", name: "ana" },
            { userId: "@bose:workspace.example", name: "Bose" },
          ],
          notificationCount: 0,
          highlightCount: 0,
          events,
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const messages = await connection.timeline("!project-x:workspace.example");
    expect(messages.find((message) => message.eventId === "$2000")?.replyToEventId).toBe("$1000");
    expect(messages.find((message) => message.eventId === "$1000")?.replyToEventId).toBeNull();
    expect(messages.find((message) => message.eventId === "$3000")?.replyToEventId).toBeNull();
  });
});

describe("#216 — writing in markdown", () => {
  it("bold, a list and a mention compose on one send — the plain body stays untouched, the mention still anchors", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.send("!project-x:workspace.example", "**urgent** @carol's duo:\n- 30 days\n- full amount", [
      { userId: "@duo-carol:workspace.example", label: "The Refund Bot" },
    ]);

    const [, content] = vi.mocked(client.sendMessage).mock.calls[0]!;
    // #216 AC2: the plain body always rides exactly as typed — markdown
    // syntax and all — for a client that can't render HTML.
    expect(content.body).toBe("**urgent** @carol's duo:\n- 30 days\n- full amount");
    expect(content.format).toBe("org.matrix.custom.html");
    // Bold rendered, the list rendered, and the mention's anchor still
    // wraps exactly "@carol's duo" — markdown mixing with the mention
    // syntax mangled neither.
    expect(content.formatted_body).toContain("<strong>urgent</strong>");
    expect(content.formatted_body).toContain("<li>30 days</li>");
    expect(content.formatted_body).toContain(
      '<a href="https://matrix.to/#/@duo-carol:workspace.example">@carol&#39;s duo</a>',
    );
    expect(content["m.mentions"]).toEqual({ user_ids: ["@duo-carol:workspace.example"] });
  });

  it("a mention survives the round trip through markdown and back into parts — the apostrophe marked's escaper adds doesn't break the match", async () => {
    const events = [
      fakeEvent({
        type: "m.room.message",
        sender: "@bose:workspace.example",
        msgtype: "m.text",
        body: "@carol's duo, what's our refund policy?",
        ts: 1_000,
        format: "org.matrix.custom.html",
        // Exactly what `markdownToHtml(withMentionAnchors(...))` produces:
        // wrapped in a paragraph, the anchor's own apostrophe entity-encoded.
        formattedBody:
          '<p><a href="https://matrix.to/#/@duo-carol:workspace.example">@carol&#39;s duo</a>, what&#39;s our refund policy?</p>\n',
      }),
    ];
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!project-x:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [{ userId: "@bose:workspace.example", name: "Bose" }],
          notificationCount: 0,
          highlightCount: 0,
          events,
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [message] = await connection.timeline("!project-x:workspace.example");
    expect(message!.parts).toEqual([
      { kind: "mention", userId: "@duo-carol:workspace.example", label: "carol's duo" },
      { kind: "text", text: ", what's our refund policy?" },
    ]);
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
        topic: null, // #223: no m.room.topic state in this fixture's events
        avatarUrl: null,
        members: [{ userId: "@bose:workspace.example", name: "Bose" }], // this member's own id never lists
        latest: { at: 3_000, body: "lunch?", senderId: "@bose:workspace.example" }, // #247: who sent it — the preview reads this to attribute a duo's own word to its owner
        lastActiveAt: 3_000,
        unread: { notifications: 0, mentions: 0 },
        muted: false,
        notifications: "all", // nothing muted, nothing scoped — the default
        canEdit: { name: false, topic: false, avatar: false }, // #223: no power_levels state — fails closed
      },
      {
        roomId: "!project-x:workspace.example",
        kind: "group", // named, joined by invitation
        name: "project-x",
        topic: null,
        avatarUrl: null,
        members: [
          { userId: "@bose:workspace.example", name: "Bose" },
          { userId: "@duo-carol:workspace.example", name: "duo-carol" },
        ],
        latest: { at: 2_000, body: "ship it", senderId: "@bose:workspace.example" },
        lastActiveAt: 2_000,
        unread: { notifications: 3, mentions: 0 },
        muted: false,
        notifications: "all",
        canEdit: { name: false, topic: false, avatar: false },
      },
      {
        roomId: "!announce:workspace.example",
        kind: "channel", // named, public join rule
        name: "announce",
        topic: null,
        avatarUrl: null,
        members: [
          { userId: "@dee:workspace.example", name: "Dee" },
          { userId: "@eeyore:workspace.example", name: "eeyore" }, // no name on record: the localpart, never a blank
        ],
        latest: { at: 1_500, body: "all-hands friday", senderId: "@dee:workspace.example" },
        lastActiveAt: 1_500,
        unread: { notifications: 9, mentions: 9 },
        muted: true, // the server's own push rule — true on every device
        notifications: "nothing", // the same rule, read as the mode it is (#69)
        canEdit: { name: false, topic: false, avatar: false },
      },
    ]);
  });

  it("a mentions-only room reads from the room's account data — another device's write, honored here (#69 AC1)", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!r:workspace.example",
          name: "r",
          joinRule: "invite",
          members: [
            { userId: "@ana:workspace.example", name: "ana" },
            { userId: "@bose:workspace.example", name: "Bose" },
          ],
          notificationCount: 2,
          highlightCount: 1,
          events: [],
          accountDataMode: "mentions",
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [room] = await connection.rooms();
    expect(room?.notifications).toBe("mentions");
    expect(room?.muted).toBe(false); // audible — for mentions alone
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

  it("#220: the rooms projection carries markedUnread from the room's own m.marked_unread account data, true only", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!r:workspace.example",
          name: "r",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
          markedUnread: true,
        }),
        summaryRoom({
          roomId: "!s:workspace.example",
          name: "s",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [flagged, plain] = await connection.rooms();
    expect(flagged?.markedUnread).toBe(true);
    // Absent, not an explicit false — the same convention this projection
    // already uses for "no" elsewhere (RoomMemberRef.ownerName).
    expect(plain).not.toHaveProperty("markedUnread");
  });

  it("#220: markUnread writes m.marked_unread account data as true", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!r:workspace.example",
          name: "r",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.markUnread("!r:workspace.example");

    expect(client.setRoomAccountData).toHaveBeenCalledWith("!r:workspace.example", "m.marked_unread", { unread: true });
  });

  it("#220: markRead clears an explicit mark-unread flag, the same reading it does for a true unread count", async () => {
    const events = [fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "one", ts: 1 })];
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
          markedUnread: true,
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.markRead("!r:workspace.example");

    expect(client.sendReadReceipt).toHaveBeenCalledWith(events[0], ReceiptType.Read, true);
    expect(client.setRoomAccountData).toHaveBeenCalledWith("!r:workspace.example", "m.marked_unread", { unread: false });
  });

  it("#220: markRead costs no account-data write when the room was never flagged unread", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!r:workspace.example",
          name: "r",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.markRead("!r:workspace.example");

    expect(client.setRoomAccountData).not.toHaveBeenCalled();
  });

  it("start, leave, mute, and people-search map to the homeserver's verbs", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await expect(connection.startDirect("@carol:workspace.example")).resolves.toBe("!fresh:workspace.example");
    expect(client.createRoom).toHaveBeenCalledWith({ is_direct: true, invite: ["@carol:workspace.example"] });
    // #208: the homeserver never infers DM-ness from `is_direct` on create —
    // only this account's own `m.direct` record does, merged with whatever
    // another device already wrote there (the fake's default: Bose's).
    expect(client.setAccountData).toHaveBeenCalledWith("m.direct", {
      "@bose:workspace.example": [],
      "@carol:workspace.example": ["!fresh:workspace.example"],
    });

    await connection.leave("!r:workspace.example");
    expect(client.leave).toHaveBeenCalledWith("!r:workspace.example");

    // The per-conversation notification setting (#69 AC1) is server-side
    // state every device of this member reads the same way: "nothing" is
    // the account's own push rule (the mute the list has shown since #63),
    // and the audible modes stand in the room's account data beside it.
    await connection.setNotificationMode("!r:workspace.example", "nothing");
    expect(client.addPushRule).toHaveBeenCalledWith("global", "room", "!r:workspace.example", { actions: [], conditions: [] });
    await connection.setNotificationMode("!r:workspace.example", "mentions");
    expect(client.deletePushRule).toHaveBeenCalledWith("global", "room", "!r:workspace.example");
    expect(client.setRoomAccountData).toHaveBeenCalledWith("!r:workspace.example", "duo.notifications", { mode: "mentions" });
    await connection.setNotificationMode("!r:workspace.example", "all");
    expect(client.setRoomAccountData).toHaveBeenCalledWith("!r:workspace.example", "duo.notifications", { mode: "all" });

    const people = await connection.searchPeople("carol");
    expect(client.searchUserDirectory).toHaveBeenCalledWith({ term: "carol", limit: expect.any(Number) });
    expect(people).toEqual([
      { userId: "@carol:workspace.example", name: "Carol" },
      { userId: "@duo-carol:workspace.example", name: "duo-carol" }, // display name absent: the localpart, never a blank
    ]);
  });

  it("a member whose display name equals their own user id falls back to the localpart, never the raw id (#208)", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!r:workspace.example",
          name: "r",
          joinRule: "invite",
          members: [
            { userId: "@ana:workspace.example", name: "ana" },
            // A member record that merely echoes the id back — the SDK's
            // own stand-in for "nobody ever set one" (#208).
            { userId: "@weird:workspace.example", name: "@weird:workspace.example" },
          ],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [room] = await connection.rooms();
    expect(room?.members).toEqual([{ userId: "@weird:workspace.example", name: "weird" }]);
  });

  it("backfills `m.direct` for a joined room the SDK can still tell was a direct invite — no second device needed (#208)", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!dm:workspace.example",
          name: null,
          joinRule: "invite",
          members: [{ userId: "@bose:workspace.example", name: "Bose" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
          dmInviter: "@bose:workspace.example",
          membership: "join",
        }),
      ],
      // Nothing on record for Bose yet — this room was never written.
      directRoomIds: [],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [room] = await connection.rooms();
    expect(room?.kind).toBe("direct"); // read as a DM on the very read that discovered it — no reload needed
    expect(client.setAccountData).toHaveBeenCalledWith("m.direct", { "@bose:workspace.example": ["!dm:workspace.example"] });
  });

  it("never backfills a room nobody ever flagged `is_direct`, or one not yet joined", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!r:workspace.example",
          name: "r",
          joinRule: "invite",
          members: [{ userId: "@bose:workspace.example", name: "Bose" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
          // No dmInviter: an ordinary group invite, never flagged direct.
        }),
        summaryRoom({
          roomId: "!pending:workspace.example",
          name: null,
          joinRule: "invite",
          members: [{ userId: "@dee:workspace.example", name: "Dee" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
          dmInviter: "@dee:workspace.example",
          membership: "invite", // still just an invite — not joined yet
        }),
      ],
      directRoomIds: [],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.rooms();
    expect(client.setAccountData).not.toHaveBeenCalled();
  });

  it("a duo's chip is attributed to the owner's own display name from THIS room, when the owner shares it — no profile fetch needed", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!together:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [
            { userId: "@carol:workspace.example", name: "Carol Chen" },
            { userId: "@duo-carol:workspace.example", name: "duo-carol" },
          ],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [room] = await connection.rooms();
    expect(room?.members).toEqual([
      { userId: "@carol:workspace.example", name: "Carol Chen" },
      { userId: "@duo-carol:workspace.example", name: "duo-carol", ownerName: "Carol Chen" },
    ]);
    expect(client.getProfileInfo).not.toHaveBeenCalled();
  });

  it("a duo's chip is attributed to the owner's own display name from the workspace's profile, when the owner never joined this room (#208)", async () => {
    const client = fakeClient({
      rooms: [
        // A 1:1 with just the duo — the owner (Carol) never joined this one.
        summaryRoom({
          roomId: "!duo-only:workspace.example",
          name: null,
          joinRule: "invite",
          members: [{ userId: "@duo-carol:workspace.example", name: "duo-carol" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
        }),
      ],
    });
    client.getProfileInfo = vi.fn(async () => ({ displayname: "Carol Chen" })) as unknown as FakeClient["getProfileInfo"];
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [room] = await connection.rooms();
    expect(room?.members).toEqual([{ userId: "@duo-carol:workspace.example", name: "duo-carol", ownerName: "Carol Chen" }]);
    expect(client.getProfileInfo).toHaveBeenCalledWith("@carol:workspace.example");
  });

  it("a duo whose owner's profile can't be found falls back to no owner name — the caller's own grammar label stands in, never a raw id", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!duo-only:workspace.example",
          name: null,
          joinRule: "invite",
          members: [{ userId: "@duo-carol:workspace.example", name: "duo-carol" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
        }),
      ],
    });
    // The default fake's getProfileInfo rejects — nothing to resolve from.
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [room] = await connection.rooms();
    expect(room?.members).toEqual([{ userId: "@duo-carol:workspace.example", name: "duo-carol" }]); // no `ownerName`
  });

  it("names, topics and pictures a conversation — #223's three verbs, each its own homeserver call", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.setRoomName("!r:workspace.example", "project-x");
    expect(client.setRoomName).toHaveBeenCalledWith("!r:workspace.example", "project-x");

    await connection.setRoomTopic("!r:workspace.example", "refunds");
    expect(client.setRoomTopic).toHaveBeenCalledWith("!r:workspace.example", "refunds");

    // The picture is a state event pointing at an upload already on the
    // homeserver — this verb never uploads itself (uploadFile, #66, already
    // does that door), it only states the result as the room's own.
    await connection.setRoomAvatar("!r:workspace.example", "mxc://workspace.example/pic1");
    expect(client.sendStateEvent).toHaveBeenCalledWith("!r:workspace.example", "m.room.avatar", { url: "mxc://workspace.example/pic1" }, "");
  });
});

describe("a group conversation's name, topic, picture and edit permissions (#223)", () => {
  it("reads the room's own topic and picture from state, honestly absent when the room has neither", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!r:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
          topic: "refunds and billing",
          avatarUrl: "mxc://workspace.example/pic1",
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [withBoth] = await connection.rooms();
    expect(withBoth?.topic).toBe("refunds and billing");
    expect(withBoth?.avatarUrl).toBe("mxc://workspace.example/pic1");

    const bareClient = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!bare:workspace.example",
          name: "bare",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(bareClient);
    const bare = await connectPrepared(bareClient);
    const [withNeither] = await bare.rooms();
    expect(withNeither?.topic).toBeNull();
    expect(withNeither?.avatarUrl).toBeNull();
  });

  it("grants edit permission exactly where this member's power level clears each field's own gate", async () => {
    const client = fakeClient({
      rooms: [
        // A moderator (level 50): clears the state default (50) that the
        // room's power levels leave for name and topic, but not the
        // avatar's own higher-than-default gate (100).
        summaryRoom({
          roomId: "!r:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana", powerLevel: 50 }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
          powerLevels: { events: { "m.room.avatar": 100 }, state_default: 50 },
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);
    const [moderator] = await connection.rooms();
    expect(moderator?.canEdit).toEqual({ name: true, topic: true, avatar: false });

    // An ordinary member (level 0, the spec's default for an unlisted
    // user) clears none of it — the same room, read from a plain member's
    // own level.
    const plainClient = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!r:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana", powerLevel: 0 }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
          powerLevels: { events: { "m.room.avatar": 100 }, state_default: 50 },
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(plainClient);
    const plain = await connectPrepared(plainClient);
    const [member] = await plain.rooms();
    expect(member?.canEdit).toEqual({ name: false, topic: false, avatar: false });
  });

  it("fails closed when this member's own level is unknown — never guessed as editable", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!r:workspace.example",
          name: "project-x",
          joinRule: "invite",
          // "ana" (the connection's own user) isn't even in the member
          // list the fake returns from getMember: room.getMember(selfId)
          // answers null, same as a membership record the projection
          // hasn't synced yet would. The spec's own 0 default for an
          // unlisted user applies — never a guessed level that would
          // read as editable.
          members: [{ userId: "@bose:workspace.example", name: "Bose" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
          // No powerLevels state either: state_default falls back to the
          // spec's own 50 — still well above the 0 a missing member reads as.
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);
    const [room] = await connection.rooms();
    expect(room?.canEdit).toEqual({ name: false, topic: false, avatar: false });
  });

  it("a name/topic/picture change arrives at every subscriber as room news — no arrival, just the roomId (AC2: shows for everyone)", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);
    const handler = vi.fn();
    connection.subscribe(handler);

    const timelineListener = client.on.mock.calls.find(([event]) => event === RoomEvent.Timeline)?.[1] as (
      event: MatrixEvent,
      room: Room,
    ) => void;
    const room = fakeRoom();
    timelineListener(
      fakeEvent({ type: "m.room.name", sender: "@bose:workspace.example", body: "", ts: 9_000 }),
      room,
    );

    expect(handler).toHaveBeenCalledWith(room.roomId);
  });
});

describe("the one search box's seam (#207)", () => {
  it("findRooms matches a room's own name, local to the client — never a network call", async () => {
    const rooms = [
      summaryRoom({ roomId: "!a:workspace.example", name: "project-x", joinRule: "invite", members: [], notificationCount: 0, highlightCount: 0, events: [] }),
      summaryRoom({ roomId: "!b:workspace.example", name: "announce", joinRule: "public", members: [], notificationCount: 0, highlightCount: 0, events: [] }),
    ];
    const client = fakeClient({ rooms });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const found = await connection.findRooms("project");

    expect(found.map((room) => room.roomId)).toEqual(["!a:workspace.example"]);
    // Local to the client's own visible rooms — never the directory (the
    // one source here that is an actual network ask).
    expect(client.searchUserDirectory).not.toHaveBeenCalled();
  });

  it("findRooms matches a direct conversation on its partner's name, not only the room's own (nameless) title", async () => {
    const dm = summaryRoom({
      roomId: "!dm:workspace.example",
      name: null,
      joinRule: "invite",
      members: [{ userId: "@bose:workspace.example", name: "Bose" }],
      notificationCount: 0,
      highlightCount: 0,
      events: [],
    });
    const client = fakeClient({ rooms: [dm], directRoomIds: ["!dm:workspace.example"] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const found = await connection.findRooms("bose");

    expect(found.map((room) => room.roomId)).toEqual(["!dm:workspace.example"]);
  });

  it("ranks matches by last activity, and an empty query answers the member's most recent conversations", async () => {
    const stale = summaryRoom({
      roomId: "!stale:workspace.example",
      name: "stale-room",
      joinRule: "invite",
      members: [],
      notificationCount: 0,
      highlightCount: 0,
      events: [fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "old", ts: 1 })],
    });
    const fresh = summaryRoom({
      roomId: "!fresh:workspace.example",
      name: "fresh-room",
      joinRule: "invite",
      members: [],
      notificationCount: 0,
      highlightCount: 0,
      events: [fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "new", ts: 999 })],
    });
    const client = fakeClient({ rooms: [stale, fresh] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect((await connection.findRooms("")).map((room) => room.roomId)).toEqual(["!fresh:workspace.example", "!stale:workspace.example"]);
  });

  it("searchPeople merges the directory with members of rooms already shared, de-duplicated by user id", async () => {
    const sharedRoom = summaryRoom({
      roomId: "!shared:workspace.example",
      name: "shared",
      joinRule: "invite",
      members: [{ userId: "@carol:workspace.example", name: "Carol From Membership" }, { userId: "@priya:workspace.example", name: "Priya" }],
      notificationCount: 0,
      highlightCount: 0,
      events: [],
    });
    const client = fakeClient({ rooms: [sharedRoom] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const people = await connection.searchPeople("ca");

    // Carol comes from BOTH sources (local membership and the directory
    // fixture) — one entry, not two, and the first source (local) names her.
    expect(people.filter((person) => person.userId === "@carol:workspace.example")).toHaveLength(1);
    expect(people).toContainEqual({ userId: "@carol:workspace.example", name: "Carol From Membership" });
  });

  it("a person the directory doesn't carry is still found by local membership, when the directory itself fails", async () => {
    const sharedRoom = summaryRoom({
      roomId: "!shared:workspace.example",
      name: "shared",
      joinRule: "invite",
      members: [{ userId: "@priya:workspace.example", name: "Priya" }],
      notificationCount: 0,
      highlightCount: 0,
      events: [],
    });
    const client = fakeClient({ rooms: [sharedRoom] });
    client.searchUserDirectory.mockRejectedValueOnce(new Error("directory down"));
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await expect(connection.searchPeople("priya")).resolves.toEqual([{ userId: "@priya:workspace.example", name: "Priya" }]);
  });

  it("a full user id finds someone no shared room and no directory entry can — the exact-id fallback", async () => {
    const client = fakeClient();
    client.searchUserDirectory.mockResolvedValueOnce({ results: [] });
    client.getProfileInfo.mockResolvedValueOnce({ displayname: "Priya (other team)" });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const people = await connection.searchPeople("@priya:workspace.example");

    expect(client.getProfileInfo).toHaveBeenCalledWith("@priya:workspace.example");
    expect(people).toEqual([{ userId: "@priya:workspace.example", name: "Priya (other team)" }]);
  });

  it("a query that merely contains an '@' and a ':' but isn't a real id asks no exact lookup of it", async () => {
    const client = fakeClient();
    client.searchUserDirectory.mockResolvedValueOnce({ results: [] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(await connection.searchPeople("meeting @ 3: refunds")).toEqual([]);
    expect(client.getProfileInfo).not.toHaveBeenCalled();
  });

  it("another org's person — no shared room, and the directory (membership-scoped, search_all_users:false) refuses them — never appears from a name search", async () => {
    const client = fakeClient();
    client.searchUserDirectory.mockResolvedValueOnce({ results: [] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    // The org wall is enforced server-side (the directory's own answer, and
    // no shared room to find them through locally); the client adds no
    // filtering, and should need none — this is what that looks like from
    // here: nothing comes back for a name.
    expect(await connection.searchPeople("someone at another company")).toEqual([]);
  });

  it("startDirect reuses a DM already open with that person instead of creating a duplicate", async () => {
    const existing = summaryRoom({
      roomId: "!already:workspace.example",
      name: null,
      joinRule: "invite",
      members: [{ userId: "@carol:workspace.example", name: "Carol" }],
      notificationCount: 0,
      highlightCount: 0,
      events: [],
    });
    const client = fakeClient({ rooms: [existing], directRoomIds: ["!already:workspace.example"] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await expect(connection.startDirect("@carol:workspace.example")).resolves.toBe("!already:workspace.example");
    expect(client.createRoom).not.toHaveBeenCalled();
  });

  it("startDirect still creates one when no DM with that person exists yet", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await expect(connection.startDirect("@carol:workspace.example")).resolves.toBe("!fresh:workspace.example");
    expect(client.createRoom).toHaveBeenCalledWith({ is_direct: true, invite: ["@carol:workspace.example"] });
  });

  it("getProfile answers the homeserver's own name and avatar for an id, and null when it won't say", async () => {
    const client = fakeClient();
    client.getProfileInfo.mockResolvedValueOnce({ displayname: "Carol", avatar_url: "mxc://workspace.example/a1" });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await expect(connection.getProfile("@carol:workspace.example")).resolves.toEqual({
      userId: "@carol:workspace.example",
      name: "Carol",
      avatarUrl: "mxc://workspace.example/a1",
    });
    await expect(connection.getProfile("@nobody:workspace.example")).resolves.toBeNull();
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
          members: [
            { userId: "@ana:workspace.example", name: "ana" },
            { userId: "@bose:workspace.example", name: "Bose" },
          ],
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
        replyToEventId: null,
        parts: null, // a fold keeps the words and drops the pills — see the #65 projection test
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
        replyToEventId: null,
        parts: null,
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
        replyToEventId: null,
        parts: null,
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
        replyToEventId: null,
        parts: null,
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
        replyToEventId: null,
        parts: null,
      },
    ]);
  });

  it("a redaction that pruned the content still keeps its row — a tombstone is a row by having been said", async () => {
    // What a synced redaction looks like: the event type survives, the
    // content is pruned whole (msgtype with it). The tombstone must render
    // from the redaction alone, not from any content the event no longer has.
    const events = [
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "kept", ts: 1 }),
      fakeEvent({ type: "m.room.message", sender: "@carol:workspace.example", ts: 2, redacted: true }),
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

    const messages = await connection.timeline("!project-x:workspace.example");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ body: "kept", redacted: false });
    expect(messages[1]).toMatchObject({ senderId: "@carol:workspace.example", body: "", redacted: true });
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

  it("a thread reply's fallback points at the latest reply known in the thread — the root only when nothing has answered yet", async () => {
    // The spec's fallback rule (client-server API §Threads): with
    // `is_falling_back`, `m.in_reply_to` names "the most recent message
    // known to the client in the thread" — a client that doesn't thread
    // renders the reply against the message it actually follows, and the
    // relation proper still targets the ROOT (the thread's address, never
    // its latest word).
    const events = [
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "what's our refund policy?", ts: 1_000 }),
      fakeEvent({ type: "m.room.message", sender: "@ana:workspace.example", msgtype: "m.text", body: "first answer", ts: 2_000, relatesTo: { rel_type: "m.thread", event_id: "$1000" } }),
      fakeEvent({ type: "m.room.message", sender: "@duo-carol:workspace.example", msgtype: "m.text", body: "np, 30 days", ts: 2_500, relatesTo: { rel_type: "m.thread", event_id: "$1000" } }),
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

    await connection.replyInThread("!project-x:workspace.example", "$1000", "third answer");
    const content = vi.mocked(client.sendMessage).mock.lastCall?.[1] as Record<string, unknown>;
    expect(content["m.relates_to"]).toMatchObject({
      rel_type: "m.thread",
      event_id: "$1000", // the relation is the root's — always
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$2500" }, // the fallback is the latest known reply's
    });
  });

  it("identical annotations from one sender count once — a duplicate 👍 is not a louder 👍", async () => {
    // The spec's counting rule (client-server API §Event annotations):
    // duplicate annotations of the same (rel_type, key) from one sender
    // count once — servers SHOULD reject the duplicate, and a client that
    // sees one anyway (a race, a federated rerun) must not let it inflate
    // the count. Distinct senders still count distinctly.
    const events = [
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "ship it", ts: 1_000 }),
      fakeEvent({ type: "m.reaction", sender: "@ana:workspace.example", ts: 2_000, relatesTo: { rel_type: "m.annotation", event_id: "$1000", key: "👍" } }),
      // The same member's 👍 again — a duplicate, not a second person.
      fakeEvent({ type: "m.reaction", sender: "@ana:workspace.example", ts: 2_100, relatesTo: { rel_type: "m.annotation", event_id: "$1000", key: "👍" } }),
      fakeEvent({ type: "m.reaction", sender: "@bose:workspace.example", ts: 2_200, relatesTo: { rel_type: "m.annotation", event_id: "$1000", key: "👍" } }),
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

    const messages = await connection.timeline("!project-x:workspace.example");
    expect(messages[0]!.reactions).toEqual([{ key: "👍", count: 2, mine: true }]);
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
    // A topic change isn't a message fact, but it IS room news (#223 AC2):
    // the roomId still arrives, so a group's name/topic/picture refreshes
    // for every subscriber the same door a new message uses.
    at(fakeEvent({ type: "m.room.topic", sender: "@bose:workspace.example", body: "refunds", ts: 4 }));

    expect(arrivals).toEqual([
      "!project-x:workspace.example",
      "!project-x:workspace.example",
      "!project-x:workspace.example",
      "!project-x:workspace.example",
    ]);
  });
});

/**
 * #209: the local-echo projection — this device's own sends, read from
 * matrix-js-sdk's own pending-event list (`getPendingEvents`) and its
 * `event.status`, folded into the live view exactly where the issue asked:
 * after the live timeline, marked pending or failed, never a second copy
 * this client invents.
 */
describe("the local-echo projection (#209)", () => {
  /** A pending event the way matrix-js-sdk's own local echo shapes one: a temporary `~room:txn` id and a live `status`. */
  function pendingEvent(shape: { id: string; sender: string; body: string; status: string; ts?: number }): MatrixEvent {
    return {
      ...fakeEvent({ type: "m.room.message", sender: shape.sender, msgtype: "m.text", body: shape.body, ts: shape.ts ?? 9_000_000 }),
      getId: () => shape.id,
      status: shape.status,
    } as unknown as MatrixEvent;
  }

  it("a send still in flight renders after the live timeline, marked pending — never a row this client wrote itself", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!project-x:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "ship it", ts: 1_000 })],
          pendingEvents: [
            pendingEvent({ id: "~!project-x:workspace.example:txn1", sender: "@ana:workspace.example", body: "on it", status: EventStatus.SENDING }),
          ],
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const messages = await connection.timeline("!project-x:workspace.example");
    expect(messages.map((message) => message.body)).toEqual(["ship it", "on it"]);
    expect(messages[1]).toMatchObject({ eventId: "~!project-x:workspace.example:txn1", body: "on it", pending: true, failed: undefined });
    expect(messages[0]!.pending).toBeUndefined();
  });

  it("a send the homeserver never got renders failed, not pending — EventStatus.NOT_SENT", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!project-x:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
          pendingEvents: [
            pendingEvent({ id: "~!project-x:workspace.example:txn2", sender: "@ana:workspace.example", body: "offline", status: EventStatus.NOT_SENT }),
          ],
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const [message] = await connection.timeline("!project-x:workspace.example");
    expect(message).toMatchObject({ body: "offline", pending: undefined, failed: true });
  });

  it("a search window never carries a pending send — nothing \"in flight\" about history (#70)", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!project-x:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
          pendingEvents: [
            pendingEvent({ id: "~!project-x:workspace.example:txn3", sender: "@ana:workspace.example", body: "on it", status: EventStatus.SENDING }),
          ],
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    client.getEventTimeline.mockResolvedValue({
      getEvents: () => [fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "history", ts: 500 })],
    });
    const connection = await connectPrepared(client);

    const messages = await connection.timelineAt("!project-x:workspace.example", "$500");
    expect(messages.map((message) => message.body)).toEqual(["history"]);
  });

  it("retry hands the SAME pending event back to the SDK — client.resendEvent, by the room's own pending list", async () => {
    const pending = pendingEvent({ id: "~!project-x:workspace.example:txn4", sender: "@ana:workspace.example", body: "offline", status: EventStatus.NOT_SENT });
    const room = summaryRoom({
      roomId: "!project-x:workspace.example",
      name: "project-x",
      joinRule: "invite",
      members: [{ userId: "@ana:workspace.example", name: "ana" }],
      notificationCount: 0,
      highlightCount: 0,
      events: [],
      pendingEvents: [pending],
    });
    const client = fakeClient({ rooms: [room] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.retry("!project-x:workspace.example", "~!project-x:workspace.example:txn4");
    expect(client.resendEvent).toHaveBeenCalledWith(pending, room);

    // An id this room has no pending event for costs nothing to ask again.
    await connection.retry("!project-x:workspace.example", "~gone");
    expect(client.resendEvent).toHaveBeenCalledTimes(1);
  });

  it("cancel hands the SAME pending event to client.cancelPendingEvent, synchronously", async () => {
    const pending = pendingEvent({ id: "~!project-x:workspace.example:txn5", sender: "@ana:workspace.example", body: "offline", status: EventStatus.NOT_SENT });
    const room = summaryRoom({
      roomId: "!project-x:workspace.example",
      name: "project-x",
      joinRule: "invite",
      members: [{ userId: "@ana:workspace.example", name: "ana" }],
      notificationCount: 0,
      highlightCount: 0,
      events: [],
      pendingEvents: [pending],
    });
    const client = fakeClient({ rooms: [room] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    connection.cancel("!project-x:workspace.example", "~!project-x:workspace.example:txn5");
    expect(client.cancelPendingEvent).toHaveBeenCalledWith(pending);
  });

  it("subscribe fires on this device's own local-echo status changes too — room news, no arrival", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const heard: Array<{ roomId: string; arrival: unknown }> = [];
    connection.subscribe((roomId, arrival) => heard.push({ roomId, arrival }));
    const localEchoHandler = client.on.mock.calls.find(([event]) => event === RoomEvent.LocalEchoUpdated)?.[1] as (
      event: MatrixEvent,
      room: Room,
    ) => void;
    const room = client.getRoom("!x")!;

    localEchoHandler?.(pendingEvent({ id: "~x", sender: "@ana:workspace.example", body: "offline", status: EventStatus.NOT_SENT }), room);

    expect(heard).toEqual([{ roomId: "!project-x:workspace.example", arrival: undefined }]);
  });
});

describe("the share wire (#66)", () => {
  const STAGED = { name: "notes.txt", mimeType: "text/plain", size: 5, bytes: new TextEncoder().encode("hello").buffer as ArrayBuffer };

  it("uploads bytes to the homeserver's media store and answers the stable reference, reporting progress", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const progress: Array<[number, number]> = [];
    const shared = await connection.uploadFile(STAGED, (sent, total) => progress.push([sent, total]));

    expect(client.uploadContent).toHaveBeenCalledWith(expect.any(Blob), {
      name: "notes.txt",
      type: "text/plain",
      progressHandler: expect.any(Function),
    });
    // The seam forwards the SDK's own byte accounting — the visible progress
    // is the upload's truth, not a spinner pretending.
    const opts = vi.mocked(client.uploadContent).mock.calls[0]![1] as { progressHandler?: (progress: { loaded: number; total: number }) => void };
    opts.progressHandler?.({ loaded: 3, total: 5 });
    expect(progress).toEqual([[3, 5]]);
    expect(shared).toEqual({ name: "notes.txt", mimeType: "text/plain", size: 5, url: "mxc://workspace.example/abc123", image: false });
  });

  it("marks an image share by its declared type — never a filename guess", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const shared = await connection.uploadFile({ name: "diagram.png", mimeType: "image/png", size: 2048, bytes: new ArrayBuffer(2048) });

    expect(shared.image).toBe(true);
    expect(shared.url).toBe("mxc://workspace.example/abc123");
  });

  it("sends a share as the m.file / m.image wire shape core #190's adapter reads back", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.sendFile("!project-x:workspace.example", {
      name: "notes.txt",
      mimeType: "text/plain",
      size: 5,
      url: "mxc://workspace.example/abc123",
      image: false,
    });
    expect(client.sendMessage).toHaveBeenLastCalledWith("!project-x:workspace.example", {
      msgtype: "m.file",
      body: "notes.txt",
      filename: "notes.txt",
      url: "mxc://workspace.example/abc123",
      info: { mimetype: "text/plain", size: 5 },
    });

    await connection.sendFile("!project-x:workspace.example", {
      name: "diagram.png",
      mimeType: "image/png",
      size: 2048,
      url: "mxc://workspace.example/img1",
      image: true,
    });
    expect(client.sendMessage).toHaveBeenLastCalledWith("!project-x:workspace.example", {
      msgtype: "m.image",
      body: "diagram.png",
      filename: "diagram.png",
      url: "mxc://workspace.example/img1",
      info: { mimetype: "image/png", size: 2048 },
    });
  });

  it("loads a share's bytes with the member's own token in a header — never in the URL — or null, honestly", async () => {
    const client = fakeClient();
    vi.mocked(client.mxcUrlToHttp).mockReturnValue("https://workspace.example/_matrix/client/v1/media/download/workspace.example/abc123");
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new Blob(["hello"], { type: "text/plain" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const blob = await connection.loadMedia("mxc://workspace.example/abc123");
    expect(await blob?.text()).toBe("hello");
    // Authenticated media (MSC3916): the 7th argument is useAuthentication,
    // and an <img>/<a> cannot send a header, so the seam does the fetch —
    // the token rides Authorization, and no URL ever carries it.
    expect(client.mxcUrlToHttp).toHaveBeenCalledWith("mxc://workspace.example/abc123", undefined, undefined, undefined, undefined, undefined, true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://workspace.example/_matrix/client/v1/media/download/workspace.example/abc123",
      { headers: { Authorization: `Bearer ${SESSION.accessToken}` } },
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain(SESSION.accessToken);

    // A homeserver that refuses, or a connection that drops, is null — the
    // card keeps its facts; nothing is faked.
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    expect(await connection.loadMedia("mxc://workspace.example/gone")).toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await connection.loadMedia("mxc://workspace.example/abc123")).toBeNull();
    // A reference the SDK cannot translate is never fetched.
    fetchMock.mockClear();
    vi.mocked(client.mxcUrlToHttp).mockReturnValue(null);
    expect(await connection.loadMedia("not-a-reference")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("#219: a link preview reads the homeserver's Open Graph fields, or null for anything short of all three missing or a refusal", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const preview = await connection.getUrlPreview("https://example.com");
    expect(client.getUrlPreview).toHaveBeenCalledWith("https://example.com", expect.any(Number));
    expect(preview).toEqual({
      title: "Example",
      description: "An example page.",
      // Usually an mxc:// reference — Synapse re-hosts the image through
      // its own media store rather than handing back a raw third-party URL.
      image: "mxc://workspace.example/preview1",
    });

    // A field the homeserver left out reads as null, never as an empty string.
    client.getUrlPreview.mockResolvedValueOnce({ "og:title": "Title only", "og:type": "website", "og:url": "https://example.com" });
    expect(await connection.getUrlPreview("https://example.com")).toEqual({ title: "Title only", description: null, image: null });

    // Nothing preview-able at all is null, not an empty object a card would render blank.
    client.getUrlPreview.mockResolvedValueOnce({ "og:type": "website", "og:url": "https://example.com" });
    expect(await connection.getUrlPreview("https://example.com")).toBeNull();

    // A homeserver that refuses outright (previews off, or a page it won't
    // fetch) is the same quiet null — never an error a member sees.
    client.getUrlPreview.mockRejectedValueOnce(new Error("preview_url is disabled"));
    expect(await connection.getUrlPreview("https://example.com")).toBeNull();
  });

  it("a refused upload or send states its reason: the workspace's own limit, its own words, or the connection", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);
    const staged = { name: "deck.pdf", mimeType: "application/pdf", size: 3, bytes: new ArrayBuffer(3) };
    const refused = (errcode: string, message: string): MatrixError => Object.assign(new MatrixError({ errcode, error: message }), { errcode, message });

    // The homeserver's own upload limit — a door this client does not know
    // the size of, named as the workspace's.
    client.uploadContent.mockRejectedValueOnce(refused("M_TOO_LARGE", "Upload request body is too large"));
    await expect(connection.uploadFile(staged)).rejects.toThrow("over the workspace's own upload limit");

    // Any other refusal carries the workspace's own words.
    client.uploadContent.mockRejectedValueOnce(refused("M_FORBIDDEN", "You are not allowed to upload"));
    await expect(connection.uploadFile(staged)).rejects.toThrow("You are not allowed to upload");

    // No answer at all is a connection problem, said so.
    client.uploadContent.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(connection.uploadFile(staged)).rejects.toThrow("couldn't reach the workspace");

    // The same reasons on the send half.
    client.sendMessage.mockRejectedValueOnce(refused("M_FORBIDDEN", "You don't have permission to post"));
    await expect(
      connection.sendFile("!project-x:workspace.example", { name: "deck.pdf", mimeType: "application/pdf", size: 3, url: "mxc://workspace.example/x", image: false }),
    ).rejects.toThrow("You don't have permission to post");
  });

  it("an edited share folds its label only — the reference and the declared facts stand (core #190)", async () => {
    const events = [
      fakeEvent({
        type: "m.room.message",
        sender: "@ana:workspace.example",
        msgtype: "m.file",
        body: "draft-v1.txt",
        ts: 1_000,
        url: "mxc://workspace.example/draft1",
        info: { mimetype: "text/plain", size: 900 },
      }),
      // The sharer renames their own share: a replacement of the same kind.
      fakeEvent({
        type: "m.room.message",
        sender: "@ana:workspace.example",
        msgtype: "m.file",
        body: "* draft-v2.txt",
        ts: 2_000,
        relatesTo: { rel_type: "m.replace", event_id: "$1000" },
        newContent: { msgtype: "m.file", body: "draft-v2.txt" },
      }),
      // A kind flip is not an edit — a replacement that would turn a share
      // into text (or back) changes what the message IS, and folds nothing.
      fakeEvent({
        type: "m.room.message",
        sender: "@ana:workspace.example",
        msgtype: "m.text",
        body: "* not a share",
        ts: 3_000,
        relatesTo: { rel_type: "m.replace", event_id: "$1000" },
        newContent: { msgtype: "m.text", body: "not a share" },
      }),
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

    const messages = await connection.timeline("!project-x:workspace.example");
    expect(messages).toEqual([
      {
        eventId: "$1000",
        roomId: "!project-x:workspace.example",
        senderId: "@ana:workspace.example",
        senderName: "ana",
        body: "draft-v2.txt", // the replacement's label
        parts: null,
        file: { name: "draft-v2.txt", mimeType: "text/plain", size: 900, url: "mxc://workspace.example/draft1", image: false }, // the facts stand
        originServerTs: 1_000,
        edited: true,
        redacted: false,
        reactions: [],
        thread: null,
        threadRootEventId: null,
        replyToEventId: null,
      },
    ]);
  });
});

describe("#214 — creating a group conversation and inviting people", () => {
  it("createRoom makes a private, invite-only room with the given name and topic", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await expect(connection.createRoom("Project X", "Launch planning")).resolves.toBe("!fresh:workspace.example");
    // private_chat is the only preset the org wall allows a member to
    // create with (`duo_org_wall/rules.py`'s `ALLOWED_PRESETS`) — never
    // public_chat, which would be refused outright.
    expect(client.createRoom).toHaveBeenCalledWith({ preset: "private_chat", name: "Project X", topic: "Launch planning" });
  });

  it("createRoom omits a blank topic rather than sending empty words", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.createRoom("Project X", "   ");

    expect(client.createRoom).toHaveBeenCalledWith({ preset: "private_chat", name: "Project X" });
  });

  it("invite adds a workspace user to an existing room", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.invite("!project-x:workspace.example", "@carol:workspace.example");

    expect(client.invite).toHaveBeenCalledWith("!project-x:workspace.example", "@carol:workspace.example");
  });

  it("an invite across organisations is refused, and the org wall's own sentence is what the UI is given", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);
    const refused = (errcode: string, message: string): MatrixError => Object.assign(new MatrixError({ errcode, error: message }), { errcode, message });

    // The exact sentence `duo_org_wall/rules.py`'s ERR_INVITE sends back —
    // this is the server's refusal, not a client-side guess about orgs.
    client.invite.mockRejectedValueOnce(refused("M_FORBIDDEN", "Invites across organisations are not allowed."));

    await expect(connection.invite("!project-x:workspace.example", "@bose.ana:otherorg.example")).rejects.toThrow(
      "Invites across organisations are not allowed.",
    );
  });

  it("createRoom's own refusal (the org wall, or a dropped connection) is surfaced the same honest way", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);
    const refused = (errcode: string, message: string): MatrixError => Object.assign(new MatrixError({ errcode, error: message }), { errcode, message });

    client.createRoom.mockRejectedValueOnce(refused("M_FORBIDDEN", "This room cannot be created."));
    await expect(connection.createRoom("Project X", "")).rejects.toThrow("This room cannot be created.");

    client.createRoom.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(connection.createRoom("Project X", "")).rejects.toThrow("couldn't reach the workspace");
  });

  it("rooms() reads only joined rooms — an invited-but-not-joined room is not a conversation yet", async () => {
    const client = fakeClient({
      rooms: [
        summaryRoom({
          roomId: "!project-x:workspace.example",
          name: "project-x",
          joinRule: "invite",
          members: [{ userId: "@ana:workspace.example", name: "ana" }],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
        }),
        summaryRoom({
          roomId: "!not-yet:workspace.example",
          name: "not-yet",
          joinRule: "invite",
          members: [],
          notificationCount: 0,
          highlightCount: 0,
          events: [],
          membership: "invite",
        }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect((await connection.rooms()).map((room) => room.roomId)).toEqual(["!project-x:workspace.example"]);
  });

  it("invites() reads the pending invites — a direct invite tells itself apart from a group one, and names who asked", async () => {
    const client = fakeClient({
      rooms: [
        inviteRoom({ roomId: "!dm-invite:workspace.example", name: null, inviterId: "@bose:workspace.example", inviterName: "Bose", direct: true }),
        inviteRoom({ roomId: "!group-invite:workspace.example", name: "project-x", inviterId: "@carol:workspace.example", inviterName: "Carol" }),
      ],
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(await connection.invites()).toEqual([
      { roomId: "!dm-invite:workspace.example", kind: "direct", name: null, inviterId: "@bose:workspace.example", inviterName: "Bose" },
      { roomId: "!group-invite:workspace.example", kind: "group", name: "project-x", inviterId: "@carol:workspace.example", inviterName: "Carol" },
    ]);
  });

  it("joinRoom accepts a pending invite — the homeserver's own join, nothing more", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.joinRoom("!group-invite:workspace.example");

    expect(client.joinRoom).toHaveBeenCalledWith("!group-invite:workspace.example");
  });

  it("declining an invite is leave — Matrix models both the same way, and the seam adds no second verb", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.leave("!group-invite:workspace.example");

    expect(client.leave).toHaveBeenCalledWith("!group-invite:workspace.example");
  });
});

/**
 * A room shaped for #211's backward pagination and #212's read marker: a
 * live timeline whose pagination token `scrollback` (mocked per test) can
 * clear to signal "the beginning", and the two doors a read position can
 * come from — the account's own `m.fully_read` marker, and (its fallback)
 * this account's read receipt.
 */
function paginatingRoom(shape: {
  roomId: string;
  events: MatrixEvent[];
  paginationToken?: string | null;
  fullyRead?: string;
  readUpTo?: string | null;
}): Room {
  let token: string | null = shape.paginationToken === undefined ? "tok0" : shape.paginationToken;
  const timeline = {
    getEvents: () => shape.events,
    getPaginationToken: () => token,
    setPaginationToken: (next: string | null) => {
      token = next;
    },
  };
  return {
    roomId: shape.roomId,
    getMyMembership: () => "join",
    getLiveTimeline: () => timeline,
    getPendingEvents: () => [],
    getMember: () => null,
    getAccountData: (type: string) =>
      type === "m.fully_read" && shape.fullyRead
        ? ({ getContent: () => ({ event_id: shape.fullyRead }) } as MatrixEvent)
        : undefined,
    getEventReadUpTo: () => shape.readUpTo ?? null,
    getUnfilteredTimelineSet: () => ({}),
    loadMembersIfNeeded: vi.fn(async () => true),
  } as unknown as Room;
}

describe("#211: scrolling back through older messages", () => {
  it("asks the homeserver for an older page and folds it into the live timeline", async () => {
    const events = [fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "newer", ts: 10 })];
    const room = paginatingRoom({ roomId: "!r:workspace.example", events, paginationToken: "tok1" });
    const client = fakeClient({ rooms: [room] });
    client.scrollback.mockImplementation(async (r: Room) => {
      events.unshift(fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "older", ts: 5 }));
      (r.getLiveTimeline() as unknown as { setPaginationToken: (t: string | null) => void }).setPaginationToken(null);
      return r;
    });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const result = await connection.loadOlder("!r:workspace.example");

    expect(client.scrollback).toHaveBeenCalledWith(room, 30);
    // The homeserver's own token ran out in this one page: the very first
    // message has been reached (#211 AC2), not a guess from the page size.
    expect(result).toEqual({ loadedMore: true, atStart: true });
    const messages = await connection.timeline("!r:workspace.example");
    expect(messages.map((message) => message.body)).toEqual(["older", "newer"]);
  });

  it("answers atStart without asking again once the homeserver's own token is already exhausted", async () => {
    const room = paginatingRoom({ roomId: "!r:workspace.example", events: [], paginationToken: null });
    const client = fakeClient({ rooms: [room] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const result = await connection.loadOlder("!r:workspace.example");

    expect(client.scrollback).not.toHaveBeenCalled();
    expect(result).toEqual({ loadedMore: false, atStart: true });
  });

  it("a connection hiccup answers 'not yet the beginning' rather than throwing", async () => {
    const room = paginatingRoom({ roomId: "!r:workspace.example", events: [], paginationToken: "tok1" });
    const client = fakeClient({ rooms: [room] });
    client.scrollback.mockRejectedValue(new Error("offline"));
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await expect(connection.loadOlder("!r:workspace.example")).resolves.toEqual({ loadedMore: false, atStart: false });
  });

  it("a room this account isn't in answers as if already at the beginning", async () => {
    const client = fakeClient();
    client.getRoom.mockReturnValue(undefined);
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await expect(connection.loadOlder("!gone:workspace.example")).resolves.toEqual({ loadedMore: false, atStart: true });
    expect(client.scrollback).not.toHaveBeenCalled();
  });
});

describe("#212: the read marker and the unread line", () => {
  it("readMarker prefers the account's own m.fully_read marker", async () => {
    const room = paginatingRoom({ roomId: "!r:workspace.example", events: [], fullyRead: "$5", readUpTo: "$1" });
    const client = fakeClient({ rooms: [room] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(connection.readMarker("!r:workspace.example")).toBe("$5");
  });

  it("falls back to this account's own read receipt when no marker has ever been set", async () => {
    const room = paginatingRoom({ roomId: "!r:workspace.example", events: [], readUpTo: "$3" });
    const client = fakeClient({ rooms: [room] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(connection.readMarker("!r:workspace.example")).toBe("$3");
  });

  it("answers null when neither a marker nor a receipt exists", async () => {
    const room = paginatingRoom({ roomId: "!r:workspace.example", events: [] });
    const client = fakeClient({ rooms: [room] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(connection.readMarker("!r:workspace.example")).toBeNull();
  });

  it("unreadBoundaryFrom finds the first main-flow row after the anchor, skipping a reaction in between", async () => {
    const events = [
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "read", ts: 1 }),
      fakeEvent({ type: "m.reaction", sender: "@bose:workspace.example", ts: 2, relatesTo: { rel_type: "m.annotation", event_id: "$1", key: "👍" } }),
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "unread", ts: 3 }),
    ];
    const room = paginatingRoom({ roomId: "!r:workspace.example", events });
    const client = fakeClient({ rooms: [room] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(connection.unreadBoundaryFrom("!r:workspace.example", "$1")).toEqual({ kind: "found", eventId: "$3" });
  });

  it("skips a thread reply — it never renders in the main flow", async () => {
    const events = [
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "root", ts: 1 }),
      fakeEvent({
        type: "m.room.message",
        sender: "@bose:workspace.example",
        msgtype: "m.text",
        body: "reply",
        ts: 2,
        relatesTo: { rel_type: "m.thread", event_id: "$1" },
      }),
      fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "next in main flow", ts: 3 }),
    ];
    const room = paginatingRoom({ roomId: "!r:workspace.example", events });
    const client = fakeClient({ rooms: [room] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(connection.unreadBoundaryFrom("!r:workspace.example", "$1")).toEqual({ kind: "found", eventId: "$3" });
  });

  it("answers 'unknown' when the anchor is older than anything loaded (#211 is how a caller goes looking for it)", async () => {
    const events = [fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "only one loaded", ts: 9 })];
    const room = paginatingRoom({ roomId: "!r:workspace.example", events });
    const client = fakeClient({ rooms: [room] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(connection.unreadBoundaryFrom("!r:workspace.example", "$1")).toEqual({ kind: "unknown" });
  });

  it("answers 'none' when the anchor already covers the newest loaded message", async () => {
    const events = [fakeEvent({ type: "m.room.message", sender: "@bose:workspace.example", msgtype: "m.text", body: "latest", ts: 1 })];
    const room = paginatingRoom({ roomId: "!r:workspace.example", events });
    const client = fakeClient({ rooms: [room] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(connection.unreadBoundaryFrom("!r:workspace.example", "$1")).toEqual({ kind: "none" });
  });

  it("advanceReadMarker sets m.fully_read at the given event — never touching the read receipt", async () => {
    const room = paginatingRoom({ roomId: "!r:workspace.example", events: [] });
    const client = fakeClient({ rooms: [room] });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.advanceReadMarker("!r:workspace.example", "$7");

    expect(client.setRoomReadMarkers).toHaveBeenCalledWith("!r:workspace.example", "$7");
    expect(client.sendReadReceipt).not.toHaveBeenCalled();
  });
});

describe("the profile wire (#224)", () => {
  it("reads the member's own name and picture from the homeserver's profile endpoint, not a local cache", async () => {
    const client = fakeClient();
    client.getProfileInfo.mockResolvedValueOnce({ displayname: "Ana", avatar_url: "mxc://workspace.example/ana-avatar" });
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    const profile = await connection.profile();

    expect(client.getProfileInfo).toHaveBeenCalledWith(SESSION.userId);
    expect(profile).toEqual({ name: "Ana", avatarUrl: "mxc://workspace.example/ana-avatar" });
  });

  it("answers nulls when the homeserver has neither on record, rather than guessing", async () => {
    const client = fakeClient();
    client.getProfileInfo.mockResolvedValueOnce({});
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    expect(await connection.profile()).toEqual({ name: null, avatarUrl: null });
  });

  it("setDisplayName calls the SDK's own verb with exactly the name given", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);

    await connection.setDisplayName("Ana Ng");

    expect(client.setDisplayName).toHaveBeenCalledWith("Ana Ng");
  });

  it("setAvatarUrl uploads the bytes through the same door as a share, then points the account's avatar at the upload", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);
    const staged = { name: "me.png", mimeType: "image/png", size: 4, bytes: new ArrayBuffer(4) };

    const mxcUri = await connection.setAvatarUrl(staged);

    expect(client.uploadContent).toHaveBeenCalledWith(expect.any(Blob), { name: "me.png", type: "image/png" });
    expect(client.setAvatarUrl).toHaveBeenCalledWith("mxc://workspace.example/abc123");
    // The seam answers what it set — a caller can render it without asking the homeserver to repeat itself.
    expect(mxcUri).toBe("mxc://workspace.example/abc123");
  });

  it("a refused name or picture change states its reason the same way a refused share does", async () => {
    const client = fakeClient();
    vi.mocked(createClient).mockReturnValue(client);
    const connection = await connectPrepared(client);
    const refused = (errcode: string, message: string): MatrixError => Object.assign(new MatrixError({ errcode, error: message }), { errcode, message });

    client.setDisplayName.mockRejectedValueOnce(refused("M_FORBIDDEN", "Display names may not be empty"));
    await expect(connection.setDisplayName("")).rejects.toThrow("Display names may not be empty");

    const staged = { name: "me.png", mimeType: "image/png", size: 4, bytes: new ArrayBuffer(4) };
    client.uploadContent.mockRejectedValueOnce(refused("M_TOO_LARGE", "Upload request body is too large"));
    await expect(connection.setAvatarUrl(staged)).rejects.toThrow("over the workspace's own upload limit");

    // A connection drop between the upload and the account write is said as one, not a stack trace.
    client.setAvatarUrl.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(connection.setAvatarUrl(staged)).rejects.toThrow("couldn't reach the workspace");
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

  it("no module in the share path imports the daemon's api — sharing is not importing, structurally (#66)", () => {
    // The modules a share touches, from the pick to the wire: the policy,
    // the seam, the card, and the two routes that render or compose one.
    // None may reach the daemon's client (`src/api/*`) — the backend's own
    // structural pin (core PR #223), mirrored here: there is no module path
    // from "a file was shared in a conversation" to "it was imported".
    const sharePath = [
      join("src", "workspace", "sharing.ts"),
      join("src", "workspace", "matrix.ts"),
      join("src", "components", "SharedFileCard.tsx"),
      join("src", "routes", "Room.tsx"),
      join("src", "routes", "Thread.tsx"),
    ];
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders = sharePath.filter((relative) =>
      /from\s+"(\.\.?\/)+(.*\/)?api\/[^"]+"/.test(readFileSync(join(root, relative), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
