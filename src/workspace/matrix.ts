import {
  ClientEvent,
  createClient,
  MatrixError,
  MsgType,
  NotificationCountType,
  PushRuleKind,
  ReceiptType,
  RoomEvent,
  SyncState,
  type MatrixClient,
  type MatrixEvent,
  type Room as MatrixRoom,
} from "matrix-js-sdk";
import { localpartOf } from "./identity.js";

/**
 * #62: the workspace seam — the one module this app has that speaks
 * matrix-js-sdk, the way `tray.ts` and `dockBadge.ts` are the one modules
 * that speak Tauri (pinned by test/WorkspaceMatrixSeam.test.ts's scan).
 * Everything above it (Setup, App, the Conversations and Room routes) is
 * written against these functions and interfaces and knows nothing about
 * the SDK, which is what keeps the daemon-only flows from ever loading it.
 *
 * The ratified platform decision (core PR #194, `docs/workspace-platform.md`)
 * is Matrix with our own client, so the person signs in to the homeserver
 * as their own user here; the duo signs in nowhere on this device — it is
 * its own user (`@duo-<owner>`, identity.ts) whose credentials are created
 * daemon-side and never leave the daemon.
 *
 * Nothing persists at the SDK layer, deliberately: every client this module
 * builds carries no store, no session store, and no web storage, so a
 * workspace session exists in exactly one place — this app's own credential
 * store (`session.ts`) — and signing out (#62 AC4) has no warm SDK state to
 * leave behind.
 */

/** This device's workspace sign-in: who the member is, over which homeserver. */
export interface WorkspaceSession {
  /** The org homeserver's base URL (https only — the token rides this URL). */
  readonly homeserverUrl: string;
  /** The member's own Matrix user id, e.g. `@ana:workspace.example`. */
  readonly userId: string;
  readonly accessToken: string;
  readonly deviceId: string;
}

/** What a room IS to the member reading the list — the shape drives how the entry reads, not just how it looks. */
export type RoomKind = "direct" | "group" | "channel";

/** One member of a room besides the member themselves — the id is the fact, the name the room's claim. */
export interface RoomMemberRef {
  readonly userId: string;
  readonly name: string | null;
}

/**
 * One room of the workspace, as the conversations list reads it (#63):
 * who's in it, what was last said and when, what's unread (and how much of
 * it mentions the member), and whether the member muted it. Every field is
 * the homeserver's own state — the list renders the server's answer, which
 * is why it reads the same on every device.
 */
export interface RoomSummary {
  readonly roomId: string;
  readonly kind: RoomKind;
  /** The room's own name — null when it has none (a direct conversation shows its members instead). */
  readonly name: string | null;
  /** The other joined members; the member's own id never lists. */
  readonly members: readonly RoomMemberRef[];
  /** The latest text message, by homeserver time — null when the room has never said anything. */
  readonly latest: { readonly at: number; readonly body: string } | null;
  /** The server's unread accounting: total notifications, and how many of them mention the member. */
  readonly unread: { readonly notifications: number; readonly mentions: number };
  /** The member's own mute rule for this room, held by the account — not a preference of this device. */
  readonly muted: boolean;
}

/**
 * One message of a room timeline, projected: text messages only (`m.text` —
 * files, notices, and topic changes are not conversation turns), with the
 * sender's id carried structurally so the render can tell a duo from a
 * person by the user-id grammar rather than by anything the sender chose.
 */
export interface RoomMessage {
  readonly eventId: string;
  readonly roomId: string;
  readonly senderId: string;
  /** The sender's name from room membership, or the localpart when the room hasn't told us — a display name is a claim; the id is a fact. */
  readonly senderName: string;
  readonly body: string;
  /** The homeserver's epoch-ms timestamp — server time, not arrival time. */
  readonly originServerTs: number;
}

/** The held workspace connection: rooms, timelines, sends, and live arrivals. */
export interface WorkspaceConnection {
  /** The member's conversations, ordered by latest activity — the server's answer, not this device's cache of it. */
  rooms(): Promise<readonly RoomSummary[]>;
  timeline(roomId: string): Promise<readonly RoomMessage[]>;
  send(roomId: string, body: string): Promise<void>;
  /**
   * Receipts the room's latest event — the member's read position, held by
   * the account, so every device reads the conversation as read (#63).
   */
  markRead(roomId: string): Promise<void>;
  /** Creates a direct conversation with a workspace user (a person or a colleague's duo) and answers its room id. */
  startDirect(userId: string): Promise<string>;
  /** Leaves a conversation — the homeserver drops the membership, for every device at once. */
  leave(roomId: string): Promise<void>;
  /** Sets or clears the account's mute rule for a room — server-side state, the same on every device. */
  setMuted(roomId: string, muted: boolean): Promise<void>;
  /** Searches the workspace's people directory: the way to address someone no shared room has introduced yet. */
  searchPeople(query: string): Promise<readonly { userId: string; name: string }[]>;
  /** One subscription for the app's lifetime; the return value unsubscribes. */
  subscribe(handler: (roomId: string) => void): () => void;
  /** Stops the connection. Idempotent. */
  stop(): Promise<void>;
}

/** The device name the homeserver shows beside this sign-in. */
const DEVICE_DISPLAY_NAME = "Duo";

/** How long `connect` waits for the first completed sync before giving up on the homeserver. */
const FIRST_SYNC_TIMEOUT_MS = 20_000;

function normalizeHomeserverUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "https:") {
    // The platform record's own rule for workspace URLs, mirrored from the
    // core's settings validation: the token rides this URL, so plaintext is
    // not a configuration, it's a leak.
    throw new Error(`The workspace address must start with https — sign-in details travel it in the clear otherwise (got ${JSON.stringify(url.protocol)}).`);
  }
  return url.origin;
}

/**
 * Sign in with member credentials: one throwaway client that logs in,
 * hands back the session, and is stopped. Username/password is the pilot's
 * flow — the workspace's accounts are the org's, and this client never
 * creates or provisions them.
 */
export async function signIn(homeserverUrl: string, username: string, password: string): Promise<WorkspaceSession> {
  const baseUrl = normalizeHomeserverUrl(homeserverUrl);
  const client = createClient({ baseUrl });
  try {
    const response = await client.login("m.login.password", {
      user: username.trim(),
      password,
      initial_device_display_name: DEVICE_DISPLAY_NAME,
    });
    return {
      homeserverUrl: baseUrl,
      userId: response.user_id,
      accessToken: response.access_token,
      deviceId: response.device_id,
    };
  } catch (error) {
    if (error instanceof MatrixError) {
      throw new Error(
        error.errcode === "M_FORBIDDEN"
          ? "The workspace refused these sign-in details — check the username and password."
          : `The workspace answered, but not with a sign-in: ${error.message}`,
      );
    }
    throw error;
  } finally {
    client.stopClient();
  }
}

/** Resolves when the first sync completes — the room state the homeserver held (including what arrived while away) has caught up. */
function firstPreparedSync(client: MatrixClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("The workspace didn't answer in time — check the address and try again."));
    }, FIRST_SYNC_TIMEOUT_MS);
    const onSync = (state: SyncState): void => {
      if (state !== SyncState.Prepared) {
        return;
      }
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off(ClientEvent.Sync, onSync);
    };
    client.on(ClientEvent.Sync, onSync);
    client.startClient({ lazyLoadMembers: true });
  });
}

function timelineOf(client: MatrixClient, roomId: string): readonly RoomMessage[] {
  const room = client.getRoom(roomId);
  if (!room) {
    return [];
  }
  return room
    .getLiveTimeline()
    .getEvents()
    .filter((event) => event.getType() === "m.room.message" && event.getContent()?.msgtype === MsgType.Text)
    .map((event) => {
      const senderId = event.getSender() ?? "";
      const member = room.getMember(senderId);
      return {
        eventId: event.getId() ?? "",
        roomId: room.roomId,
        senderId,
        senderName: member?.name ?? localpartOf(senderId),
        body: String(event.getContent()?.body ?? ""),
        originServerTs: event.getTs(),
      };
    });
}

/**
 * The room ids the account's own `m.direct` data marks direct — DM-ness is
 * the account's record of the conversation, not a guess from member counts
 * (a two-person group and a DM are different rooms to the member, and the
 * account knows which is which).
 */
function directRoomIdsOf(client: MatrixClient): Set<string> {
  const content = client.getAccountData("m.direct")?.getContent() as Record<string, readonly string[]> | undefined;
  const ids = new Set<string>();
  for (const roomIds of Object.values(content ?? {})) {
    for (const roomId of roomIds) {
      ids.add(roomId);
    }
  }
  return ids;
}

/**
 * One room as the conversations list reads it (#63). Every field is the
 * homeserver's own state: membership, notification accounting (and its
 * highlight half — mentions), the join rule behind group-vs-channel, the
 * account's mute rule. Nothing here is invented client-side, which is the
 * whole of "reflected across their devices" — the list renders the same
 * server answer everywhere.
 */
function projectRoom(room: MatrixRoom, selfId: string, direct: boolean, muted: boolean): RoomSummary {
  const latestText = [...room.getLiveTimeline().getEvents()]
    .reverse()
    .find((event) => event.getType() === "m.room.message" && event.getContent()?.msgtype === MsgType.Text);
  return {
    roomId: room.roomId,
    kind: direct ? "direct" : room.getJoinRule() === "public" ? "channel" : "group",
    name: room.name || null,
    members: room
      .getMembers()
      .filter((member) => member.membership === "join" && member.userId !== selfId)
      .map((member) => ({ userId: member.userId, name: member.name || localpartOf(member.userId) })),
    latest: latestText ? { at: latestText.getTs(), body: String(latestText.getContent()?.body ?? "") } : null,
    unread: {
      notifications: room.getUnreadNotificationCount(NotificationCountType.Total),
      mentions: room.getUnreadNotificationCount(NotificationCountType.Highlight),
    },
    muted,
  };
}

/** How many people a directory search answers with — enough to pick a colleague out, small enough to read. */
const PEOPLE_SEARCH_LIMIT = 10;

/** Hold the workspace connection for a stored session — resolves at the first completed sync, then serves rooms and timelines from it. */
export async function connect(session: WorkspaceSession): Promise<WorkspaceConnection> {
  const client = createClient({
    baseUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    userId: session.userId,
  });
  await firstPreparedSync(client);
  return {
    rooms: async () => {
      // The mute half of the projection lives in the account's push rules —
      // one read for the whole list, and a failed read means "unmuted we
      // don't know", never a list that won't render.
      const pushRules = await client.getPushRules().catch(() => undefined);
      const mutedIds = new Set(
        (pushRules?.global.room ?? [])
          .filter((rule) => rule.enabled && rule.actions.length === 0)
          .map((rule) => rule.rule_id),
      );
      const directIds = directRoomIdsOf(client);
      return client
        .getRooms()
        .map((room) => projectRoom(room, session.userId, directIds.has(room.roomId), mutedIds.has(room.roomId)))
        .sort((a, b) => (b.latest?.at ?? Number.MIN_SAFE_INTEGER) - (a.latest?.at ?? Number.MIN_SAFE_INTEGER));
    },
    timeline: async (roomId) => timelineOf(client, roomId),
    send: async (roomId, body) => {
      await client.sendMessage(roomId, { msgtype: MsgType.Text, body });
    },
    markRead: async (roomId) => {
      const events = client.getRoom(roomId)?.getLiveTimeline().getEvents() ?? [];
      const last = events[events.length - 1];
      if (last) {
        await client.sendReadReceipt(last, ReceiptType.Read, true);
      }
    },
    startDirect: async (userId) => {
      const { room_id } = await client.createRoom({ is_direct: true, invite: [userId] });
      return room_id;
    },
    leave: async (roomId) => {
      await client.leave(roomId);
    },
    setMuted: async (roomId, muted) => {
      if (muted) {
        await client.addPushRule("global", PushRuleKind.RoomSpecific, roomId, { actions: [], conditions: [] });
      } else {
        await client.deletePushRule("global", PushRuleKind.RoomSpecific, roomId);
      }
    },
    searchPeople: async (query) => {
      const { results } = await client.searchUserDirectory({ term: query.trim(), limit: PEOPLE_SEARCH_LIMIT });
      return results
        .filter((result) => result.user_id !== session.userId)
        .map((result) => ({ userId: result.user_id, name: result.display_name || localpartOf(result.user_id) }));
    },
    subscribe: (handler) => {
      const listener = (event: MatrixEvent, room: MatrixRoom | undefined): void => {
        if (room && event.getType() === "m.room.message") {
          handler(room.roomId);
        }
      };
      client.on(RoomEvent.Timeline, listener);
      return () => {
        client.off(RoomEvent.Timeline, listener);
      };
    },
    stop: async () => {
      await client.stopClient();
    },
  };
}
