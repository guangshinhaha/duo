import {
  ClientEvent,
  createClient,
  MatrixError,
  MsgType,
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

/** One room of the workspace, as the conversations list reads it. */
export interface RoomSummary {
  readonly roomId: string;
  readonly name: string;
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
  rooms(): Promise<readonly RoomSummary[]>;
  timeline(roomId: string): Promise<readonly RoomMessage[]>;
  send(roomId: string, body: string): Promise<void>;
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

/** Hold the workspace connection for a stored session — resolves at the first completed sync, then serves rooms and timelines from it. */
export async function connect(session: WorkspaceSession): Promise<WorkspaceConnection> {
  const client = createClient({
    baseUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    userId: session.userId,
  });
  await firstPreparedSync(client);
  return {
    rooms: async () => client.getRooms().map((room) => ({ roomId: room.roomId, name: room.name || room.roomId })),
    timeline: async (roomId) => timelineOf(client, roomId),
    send: async (roomId, body) => {
      await client.sendMessage(roomId, { msgtype: MsgType.Text, body });
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
