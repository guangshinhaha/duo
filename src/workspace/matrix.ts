import {
  ClientEvent,
  createClient,
  EventType,
  MatrixError,
  MsgType,
  NotificationCountType,
  PushRuleKind,
  ReceiptType,
  RelationType,
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

/** One aggregated reaction under a message: the emoji, how many, and whether this member is among them. */
export interface ReactionSummary {
  readonly key: string;
  readonly count: number;
  /** True when this account's own reaction is one of the count — the chip's toggle half. */
  readonly mine: boolean;
}

/** What a message with a thread knows about its replies: how many, and the latest word. */
export interface ThreadSummary {
  readonly replyCount: number;
  readonly latestReply: { readonly senderId: string; readonly senderName: string; readonly body: string } | null;
}

/**
 * One message of a room timeline, projected (#64): text messages only
 * (`m.text` — files, notices, and topic changes are not conversation turns),
 * with the sender's id carried structurally so the render can tell a duo
 * from a person by the user-id grammar rather than by anything the sender
 * chose. The verbs' outcomes arrive folded the way the homeserver folds
 * them: an edit is the base's new words at the base's place (marked), a
 * delete keeps the row and strikes the words, reactions aggregate under
 * their key, and a thread's replies belong to the thread — the main flow
 * carries the root's summary of them, not the replies themselves.
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
  /** True when a same-sender replacement amended these words — the "(edited)" mark is the honesty. */
  readonly edited: boolean;
  /** True when the homeserver struck the event — the row keeps its place, the words go. */
  readonly redacted: boolean;
  /** The reactions under this message, aggregated by key. */
  readonly reactions: readonly ReactionSummary[];
  /** This message's thread, as the main flow reads it — null when it never got a reply. */
  readonly thread: ThreadSummary | null;
  /** The root this message answers inside a thread — null in the main flow. */
  readonly threadRootEventId: string | null;
  /** #64 AC1: this device's own optimistic copy — sent, not yet the homeserver's record. */
  readonly pending?: boolean;
}

/** The held workspace connection: rooms, timelines, the message verbs, and live arrivals. */
export interface WorkspaceConnection {
  /** Whose connection this is — the member's own user id, the way the surface tells its own messages (editable, deletable) from everyone else's. */
  readonly userId: string;
  /** The member's conversations, ordered by latest activity — the server's answer, not this device's cache of it. */
  rooms(): Promise<readonly RoomSummary[]>;
  timeline(roomId: string): Promise<readonly RoomMessage[]>;
  /**
   * Sends a text message (#65): the body says what people read; when the
   * message addresses members, their user ids ride `m.mentions.user_ids` —
   * the structured half the homeserver's push rules read, which is the
   * whole of "notified according to their settings" from the sender's side.
   */
  send(roomId: string, body: string, mentions?: readonly string[]): Promise<void>;
  /**
   * Amends this member's own message (#64): a replacement event — the new
   * words ride `m.new_content`, the relation points back at the base, and
   * every reader's homeserver folds them into one message marked as edited.
   */
  edit(roomId: string, eventId: string, body: string): Promise<void>;
  /** Strikes this member's own message: a redaction — the words go for everyone, the row keeps its place. */
  delete(roomId: string, eventId: string): Promise<void>;
  /** Adds this member's reaction under a message — an annotation keyed by the emoji. */
  react(roomId: string, eventId: string, key: string): Promise<void>;
  /** Takes this member's reaction back: redacts the member's own reaction event, never anyone else's. */
  unreact(roomId: string, eventId: string, key: string): Promise<void>;
  /**
   * Answers inside a message's thread: the reply relates to the root, so
   * the thread owns it — the main flow never shows it as a row.
   */
  replyInThread(roomId: string, rootEventId: string, body: string): Promise<void>;
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

/**
 * A relation as the sender wrote it — a claim until the projection checks
 * it (a foreign "replacement" is not an edit, it's an assertion about
 * someone else's words).
 */
interface Relation {
  readonly rel_type?: string;
  readonly event_id?: string;
  readonly key?: string;
}

function relationOf(event: MatrixEvent): Relation | undefined {
  return (event.getContent()?.["m.relates_to"] ?? undefined) as Relation | undefined;
}

/**
 * The timeline projection #64's message surface reads: same-sender
 * replacements fold into the base they amend (a stranger's edit is a claim,
 * not a change), reactions aggregate under their target and key with the
 * member's own marked, thread replies carry their root's id out of the main
 * flow, and a redaction keeps the row while striking the words.
 */
function timelineOf(client: MatrixClient, roomId: string): readonly RoomMessage[] {
  const room = client.getRoom(roomId);
  if (!room) {
    return [];
  }
  const events = room.getLiveTimeline().getEvents();
  const nameOf = (senderId: string): string => room.getMember(senderId)?.name || localpartOf(senderId);

  // Pass one — the bases: every text message in timeline order, with
  // same-sender replacements folded into the base they amend.
  interface Base {
    senderId: string;
    senderName: string;
    body: string;
    ts: number;
    edited: boolean;
    redacted: boolean;
    threadRootEventId: string | null;
  }
  const bases = new Map<string, Base>();
  for (const event of events) {
    if (event.getType() !== EventType.RoomMessage) {
      continue;
    }
    const senderId = event.getSender() ?? "";
    const relation = relationOf(event);
    if (event.isRedacted()) {
      // Struck: the words are gone and the relation with them. A struck
      // amendment is no amendment — and not a row either. Redaction is
      // judged before the content filter because a redaction prunes the
      // content (msgtype included) — a tombstone is a row by having been
      // said, not by still saying anything.
      if (relation?.rel_type === RelationType.Replace) {
        continue;
      }
      bases.set(event.getId() ?? "", {
        senderId,
        senderName: nameOf(senderId),
        body: "",
        ts: event.getTs(),
        edited: false,
        redacted: true,
        threadRootEventId: null,
      });
      continue;
    }
    if (event.getContent()?.msgtype !== MsgType.Text) {
      continue;
    }
    if (relation?.rel_type === RelationType.Replace) {
      // A replacement is not a row: it rewrites the base it points at, in
      // place — and only when the sender is the base's own author.
      const targetId = relation.event_id;
      const base = targetId !== undefined ? bases.get(targetId) : undefined;
      const newBody = (event.getContent()?.["m.new_content"] as { body?: string } | undefined)?.body;
      if (base && !base.redacted && targetId !== undefined && newBody !== undefined && senderId === base.senderId) {
        bases.set(targetId, { ...base, body: String(newBody), edited: true });
      }
      continue;
    }
    bases.set(event.getId() ?? "", {
      senderId,
      senderName: nameOf(senderId),
      body: String(event.getContent()?.body ?? ""),
      ts: event.getTs(),
      edited: false,
      redacted: false,
      threadRootEventId: relation?.rel_type === RelationType.Thread && relation.event_id !== undefined ? relation.event_id : null,
    });
  }

  // Pass two — reactions: annotations aggregate under their target and key,
  // one per sender — the spec's counting rule (client-server API §Event
  // annotations) is that a duplicate annotation of the same key from one
  // sender counts once, so the tally is the SET of senders, not the pile
  // of events: a resent 👍 is not a second person's agreement.
  const reactions = new Map<string, Map<string, Set<string>>>();
  for (const event of events) {
    if (event.getType() !== EventType.Reaction || event.isRedacted()) {
      continue;
    }
    const relation = relationOf(event);
    if (relation?.rel_type !== RelationType.Annotation || relation.event_id === undefined || relation.key === undefined) {
      continue;
    }
    const under = reactions.get(relation.event_id) ?? new Map<string, Set<string>>();
    const senders = under.get(relation.key) ?? new Set<string>();
    senders.add(event.getSender() ?? "");
    under.set(relation.key, senders);
    reactions.set(relation.event_id, under);
  }

  // Pass three — threads: each reply counts toward its root and may carry
  // the thread's latest word.
  const threads = new Map<string, { replyCount: number; latest: { senderId: string; senderName: string; body: string; ts: number } | null }>();
  for (const base of bases.values()) {
    if (base.threadRootEventId === null) {
      continue;
    }
    const bucket = threads.get(base.threadRootEventId) ?? { replyCount: 0, latest: null };
    threads.set(base.threadRootEventId, {
      replyCount: bucket.replyCount + 1,
      latest:
        bucket.latest === null || base.ts >= bucket.latest.ts
          ? { senderId: base.senderId, senderName: base.senderName, body: base.body, ts: base.ts }
          : bucket.latest,
    });
  }

  // The rows, in timeline order: each base stands where it was said,
  // carrying what the passes learned about it.
  const messages: RoomMessage[] = [];
  for (const [eventId, base] of bases) {
    const thread = threads.get(eventId);
    messages.push({
      eventId,
      roomId: room.roomId,
      senderId: base.senderId,
      senderName: base.senderName,
      body: base.body,
      originServerTs: base.ts,
      edited: base.edited,
      redacted: base.redacted,
      reactions: base.redacted
        ? []
        : [...(reactions.get(eventId) ?? new Map())].map(([key, senders]) => ({
            key,
            count: senders.size,
            mine: senders.has(client.getUserId() ?? ""),
          })),
      thread: thread
        ? {
            replyCount: thread.replyCount,
            latestReply:
              thread.latest === null
                ? null
                : { senderId: thread.latest.senderId, senderName: thread.latest.senderName, body: thread.latest.body },
          }
        : null,
      threadRootEventId: base.threadRootEventId,
    });
  }
  return messages;
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

/**
 * The event types a live arrival can change a timeline's projection under
 * (#64): a message, a reaction, or a redaction. Everything else on the
 * timeline stream leaves what the surface reads where it was.
 */
const LIVE_EVENT_TYPES = new Set<string>([EventType.RoomMessage, EventType.Reaction, EventType.RoomRedaction]);

/** Hold the workspace connection for a stored session — resolves at the first completed sync, then serves rooms and timelines from it. */
export async function connect(session: WorkspaceSession): Promise<WorkspaceConnection> {
  const client = createClient({
    baseUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    userId: session.userId,
  });
  await firstPreparedSync(client);
  return {
    userId: session.userId,
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
    send: async (roomId, body, mentions) => {
      // An empty mentions list is no mention: the key rides the wire only
      // when there is somebody addressed.
      await client.sendMessage(
        roomId,
        mentions && mentions.length > 0
          ? { msgtype: MsgType.Text, body, "m.mentions": { user_ids: [...mentions] } }
          : { msgtype: MsgType.Text, body },
      );
    },
    // The verbs are all homeserver operations on the room — the surface adds
    // no behaviour, it asks the server to move its own state and renders the
    // next answer. Each one maps to the Matrix event the spec prescribes.
    edit: async (roomId, eventId, body) => {
      await client.sendMessage(roomId, {
        msgtype: MsgType.Text,
        // The fallback body carries the edit convention's asterisk; the real
        // words ride m.new_content for clients that fold replacements.
        body: `* ${body}`,
        "m.new_content": { msgtype: MsgType.Text, body },
        "m.relates_to": { rel_type: RelationType.Replace, event_id: eventId },
      });
    },
    delete: async (roomId, eventId) => {
      await client.redactEvent(roomId, eventId);
    },
    react: async (roomId, eventId, key) => {
      await client.sendEvent(roomId, EventType.Reaction, {
        "m.relates_to": { rel_type: RelationType.Annotation, event_id: eventId, key },
      });
    },
    unreact: async (roomId, eventId, key) => {
      // Taking a reaction back is redacting MY reaction event — the one this
      // account sent for this message under this key, never anyone else's.
      const room = client.getRoom(roomId);
      const events = room?.getLiveTimeline().getEvents() ?? [];
      const mine = events.find((event) => {
        if (event.getType() !== EventType.Reaction || event.isRedacted() || event.getSender() !== session.userId) {
          return false;
        }
        const relation = relationOf(event);
        return relation?.rel_type === RelationType.Annotation && relation.event_id === eventId && relation.key === key;
      });
      const mineId = mine?.getId();
      if (mineId) {
        await client.redactEvent(roomId, mineId);
      }
    },
    replyInThread: async (roomId, rootEventId, body) => {
      // The wire shape is the thread relation plus its fallback reply
      // (clients that don't thread still see an in-reply-to, instead of
      // losing the answer's context wholesale): the relation targets the
      // ROOT — the thread's address — while the fallback names the most
      // recent message known in the thread (spec §Threads), the latest
      // reply this client has synced or the root itself when nothing has
      // answered yet. The SDK's m.relates_to typing models a relation OR a
      // reply, never both — the spec's thread fallback is exactly both —
      // so the relation is cast to the reply arm of the type sendMessage
      // takes, and the seam test pins the shape.
      const room = client.getRoom(roomId);
      const latestKnownReply = (room?.getLiveTimeline().getEvents() ?? [])
        .filter((event) => {
          if (event.getType() !== EventType.RoomMessage || event.isRedacted()) {
            return false;
          }
          const relation = relationOf(event);
          return relation?.rel_type === RelationType.Thread && relation.event_id === rootEventId;
        })
        .at(-1);
      await client.sendMessage(roomId, {
        msgtype: MsgType.Text,
        body,
        "m.relates_to": {
          rel_type: RelationType.Thread,
          event_id: rootEventId,
          is_falling_back: true,
          "m.in_reply_to": { event_id: latestKnownReply?.getId() ?? rootEventId },
        } as unknown as { "m.in_reply_to"?: { event_id: string } },
      });
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
        if (room && LIVE_EVENT_TYPES.has(event.getType())) {
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
