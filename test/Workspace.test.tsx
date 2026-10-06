import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, signIn } from "../src/workspace/matrix.js";
import { workspaceSessionUrl } from "../src/api/hosted.js";
import type { ChannelSummary, LiveArrival, NotificationMode, RoomInvite, RoomMessage, RoomSummary, SharedFile, WorkspaceConnection, WorkspaceSession } from "../src/workspace/matrix.js";
import { WorkspaceSignInDialog } from "../src/components/WorkspaceSignInDialog.js";
import type { StagedShare } from "../src/workspace/sharing.js";
import { stubDesktop } from "./desktop.js";
import { inTauriShell, leaveTauriShell } from "./platformFakes.js";
import { composed, composerText, pressEnter, setComposer, typeInto } from "./composerHelpers.js";

/*
 * #62: the app's front door becomes two doors — a workspace sign-in (who you
 * are, in an org) and a duo pairing (which only you reach) — with separate
 * lifetimes. The Matrix seam (`src/workspace/matrix.ts`) is the one module
 * that would load matrix-js-sdk; it is mocked here wholesale, the same way
 * the Tauri seams are, so the ACs test the client's surfaces against the
 * wire contract the core's identity/directory work (digital-duo #187)
 * fixed: the person signs in as their own Matrix user, and a duo is its own
 * user (`@duo-<owner>`) the client recognizes structurally.
 */
vi.mock("../src/workspace/matrix.js", () => ({
  signIn: vi.fn(),
  connect: vi.fn(),
}));

/*
 * #69: the notification plugin, mocked the same way — with browser-parity
 * defaults (every call rejects, permission resolves "denied"), so the
 * suite's existing behavior is exactly what a plain tab produces. The
 * dispatch tests flip the permission to granted and read the posted
 * notifications off `sendNotification`.
 */
const notificationPlugin = {
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<string>>(),
  sendNotification: vi.fn<(options: { id?: number; title: string; body: string }) => void>(),
  onAction: vi.fn<(cb: (notification: { id?: number }) => void) => Promise<{ unregister: () => void }>>(),
};

vi.mock("@tauri-apps/plugin-notification", () => notificationPlugin);

const SESSION: WorkspaceSession = {
  homeserverUrl: "https://workspace.example",
  userId: "@ana:workspace.example",
  accessToken: "syt_workspace_token",
  deviceId: "YGBNAUIOMK",
};

/**
 * #63: the list's raw material — one direct (members, no name), one group
 * (named, carrying a colleague's duo), one channel (named, public). The
 * seam orders by latest activity; the fixture is written in that order so
 * a shuffle inside a test would still be caught by the order assertions.
 */
function roomsFixture(): RoomSummary[] {
  const now = Date.now();
  const hour = 3_600_000;
  return [
    {
      roomId: "!direct:workspace.example",
      kind: "direct",
      name: null,
      topic: null,
      avatarUrl: null,
      members: [{ userId: "@bose:workspace.example", name: "Bose" }],
      latest: { at: now - hour, body: "lunch?" },
      unread: { notifications: 0, mentions: 0 },
      muted: false,
      notifications: "all",
      canEdit: { name: false, topic: false, avatar: false },
    },
    {
      roomId: "!project-x:workspace.example",
      kind: "group",
      name: "project-x",
      topic: null,
      avatarUrl: null,
      members: [
        { userId: "@bose:workspace.example", name: "Bose" },
        { userId: "@duo-carol:workspace.example", name: "duo-carol" },
      ],
      latest: { at: now - 2 * hour, body: "ship it" },
      unread: { notifications: 3, mentions: 0 },
      muted: false,
      notifications: "all",
      canEdit: { name: true, topic: true, avatar: true },
    },
    {
      roomId: "!announce:workspace.example",
      kind: "channel",
      name: "announce",
      topic: null,
      avatarUrl: null,
      members: [{ userId: "@dee:workspace.example", name: "Dee" }],
      latest: { at: now - 3 * hour, body: "all-hands friday" },
      unread: { notifications: 0, mentions: 0 },
      muted: false,
      notifications: "all",
      canEdit: { name: false, topic: false, avatar: false },
    },
  ];
}

/** The directory the new-conversation search reads (#63 AC3): one person, one duo. */
const PEOPLE = [
  { userId: "@carol:workspace.example", name: "Carol" },
  { userId: "@duo-carol:workspace.example", name: "duo-carol" },
];

function messageFor(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId" | "senderId" | "body">): RoomMessage {
  return {
    roomId: "!project-x:workspace.example",
    senderName: "",
    originServerTs: 1_700_000_000_000,
    edited: false,
    redacted: false,
    reactions: [],
    thread: null,
    threadRootEventId: null,
    replyToEventId: null,
    parts: null,
    ...over,
  };
}

const PROJECT_TIMELINE: RoomMessage[] = [
  messageFor({ eventId: "$1", senderId: "@bose:workspace.example", senderName: "Bose", body: "what's our refund policy?" }),
  messageFor({ eventId: "$2", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "Refunds within 30 days, full amount." }),
];

/**
 * #64's raw material: a root message with a colleague's-duo reply in its
 * thread (the reply itself carries `threadRootEventId`, so the main flow
 * filters it out and the preview carries it instead), beside a plain
 * unthreaded message.
 */
const THREADED_TIMELINE: RoomMessage[] = [
  messageFor({
    eventId: "$1",
    senderId: "@bose:workspace.example",
    senderName: "Bose",
    body: "what's our refund policy?",
    thread: {
      replyCount: 1,
      latestReply: { senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "np, 30 days" },
    },
  }),
  messageFor({ eventId: "$2", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "Refunds within 30 days, full amount." }),
  messageFor({ eventId: "$r1", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "np, 30 days", threadRootEventId: "$1" }),
];

/**
 * A fake connection the ACs drive: rooms and timelines resolve from
 * `state`, `deliver` plays a live arrival into the open subscription, and
 * the #63 verbs mutate `state` the way the homeserver's own state would
 * move under the same op — the list's reflection after a mutation is the
 * server's answer, not a local flag.
 */
function fakeConnection(state: {
  rooms: RoomSummary[];
  timelines: Record<string, RoomMessage[]>;
  people?: Array<{ userId: string; name: string }>;
  /** #214: pending invites, separate from `rooms` — an invite is not a conversation yet. */
  invites?: RoomInvite[];
  /** #214: the org Space's channels, as `channels()` would list them from its hierarchy. */
  channels?: ChannelSummary[];
  /** #209: the next `send`/`replyInThread` ends in the row going failed, like the homeserver refused it — consumed once. */
  failNextSend?: boolean;
}) {
  // Every surface that subscribes hears every arrival — the way the real
  // seam's client.on does. (#69's dispatcher subscribes beside the list
  // and the room, so a single stored listener would no longer model it.)
  const listeners = new Set<(roomId: string, arrival?: LiveArrival) => void>();
  const roomAt = (roomId: string): number => state.rooms.findIndex((room) => room.roomId === roomId);
  const timelineOf = (roomId: string): RoomMessage[] => (state.timelines[roomId] ??= []);
  const messageAt = (roomId: string, eventId: string): number => timelineOf(roomId).findIndex((message) => message.eventId === eventId);
  /** Tells every subscriber room news with no arrival — #209's own send changing status is this, the same as a reaction or an amendment. */
  const notify = (roomId: string): void => {
    for (const listener of listeners) {
      listener(roomId);
    }
  };
  let pendingSeq = 0;
  /**
   * #209: the local-echo half every send-like verb shares — a pending row
   * lands in the SAME timeline `timeline()` reads (never a second, cache-only
   * copy), synchronously with the call, the way matrix-js-sdk's own
   * `room.addPendingEvent` does. `state.failNextSend` (consumed once) turns
   * the eventual answer into a failure — the row stays, marked failed, in
   * place of the homeserver's confirmation this fake never fabricates.
   */
  const localEcho = (roomId: string, row: RoomMessage): string => {
    const list = timelineOf(roomId);
    list.push(row);
    notify(roomId);
    if (state.failNextSend) {
      state.failNextSend = false;
      const at = messageAt(roomId, row.eventId);
      if (at >= 0) {
        list[at] = { ...list[at]!, pending: false, failed: true };
      }
      notify(roomId);
      return "failed";
    }
    return "ok";
  };
  const connection: WorkspaceConnection = {
    userId: SESSION.userId,
    profile: vi.fn(async () => ({ name: null, avatarUrl: null })),
    setDisplayName: vi.fn(async () => {}),
    setAvatarUrl: vi.fn(async () => "mxc://workspace.example/avatar"),
    rooms: vi.fn(async () =>
      // A fresh array of fresh objects per call, like the real seam's
      // projection: TanStack's structural sharing would otherwise see the
      // same instance and skip the re-render an invalidation asked for.
      state.rooms.map((room) => ({ ...room, members: [...room.members] })),
    ),
    timeline: vi.fn(async (roomId: string) => [...(state.timelines[roomId] ?? [])]),
    send: vi.fn(
      async (
        roomId: string,
        body: string,
        mentions?: Parameters<WorkspaceConnection["send"]>[2],
        replyToEventId?: Parameters<WorkspaceConnection["send"]>[3],
      ) => {
        const eventId = `~send-${(pendingSeq += 1)}`;
        const outcome = localEcho(
          roomId,
          messageFor({
            eventId,
            senderId: SESSION.userId,
            senderName: "ana",
            body,
            pending: true,
            parts: mentions?.length ? [] : null,
            replyToEventId: replyToEventId ?? null,
          }),
        );
        if (outcome === "failed") {
          throw new Error("offline");
        }
      },
    ),
    // #66's share half: the upload resolves the staged bytes to the stable
    // reference (reporting full progress, the honest single-chunk case),
    // sendFile is the wire act, and loadMedia is the member's own
    // authenticated fetch of a reference's bytes (the token rides a header;
    // an <img> or <a> cannot send one).
    uploadFile: vi.fn(async (staged: StagedShare, onProgress?: (sent: number, total: number) => void) => {
      onProgress?.(staged.size, staged.size);
      return {
        name: staged.name,
        mimeType: staged.mimeType,
        size: staged.size,
        url: `mxc://workspace.example/${encodeURIComponent(staged.name)}`,
        image: staged.mimeType.startsWith("image/"),
      };
    }),
    sendFile: vi.fn(async (roomId: string, file: SharedFile) => {
      const eventId = `~share-${(pendingSeq += 1)}`;
      localEcho(roomId, messageFor({ eventId, senderId: SESSION.userId, senderName: "ana", body: file.name, file, pending: true }));
    }),
    loadMedia: vi.fn(async (url: string): Promise<Blob | null> => new Blob([`bytes of ${url}`], { type: "application/octet-stream" })),
    // #219: no fixture in this file posts a link a card should render —
    // LinkPreview.test.tsx pins the preview itself — so this fake simply
    // has nothing to answer, the same honest "nothing to show" a homeserver
    // with previews off would give back.
    getUrlPreview: vi.fn(async () => null),
    subscribe: vi.fn((handler: (roomId: string, arrival?: LiveArrival) => void) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    }),
    stop: vi.fn(async () => {}),
    // The homeserver's own read accounting moves — what another device
    // would also see on its next sync. #220: reading the conversation also
    // clears an explicit "mark unread" flag, the same as the real seam.
    markRead: vi.fn(async (roomId: string) => {
      const at = roomAt(roomId);
      if (at >= 0) {
        const next: RoomSummary = { ...state.rooms[at]!, unread: { notifications: 0, mentions: 0 } };
        delete (next as { markedUnread?: true }).markedUnread;
        state.rooms[at] = next;
      }
    }),
    // #220: the account's own "come back to this" flag — set with nothing
    // new having arrived, the same server-side footing as every other read
    // state here.
    markUnread: vi.fn(async (roomId: string) => {
      const at = roomAt(roomId);
      if (at >= 0) {
        state.rooms[at] = { ...state.rooms[at]!, markedUnread: true };
      }
    }),
    startDirect: vi.fn(async (userId: string) => {
      const roomId = `!fresh-${userId.slice(1).replace(/[^a-z0-9-]/gi, "")}:workspace.example`;
      state.rooms.push({
        roomId,
        kind: "direct",
        name: null,
        topic: null,
        avatarUrl: null,
        members: [{ userId, name: null }],
        latest: null,
        unread: { notifications: 0, mentions: 0 },
        muted: false,
        notifications: "all",
        canEdit: { name: false, topic: false, avatar: false },
      });
      return roomId;
    }),
    // #214: a fresh private group — the member its sole member until
    // `invite` adds people, the way the real seam's `createRoom` behaves.
    createRoom: vi.fn(async (name: string) => {
      const roomId = `!fresh-${name.toLowerCase().replace(/[^a-z0-9-]/gi, "-")}:workspace.example`;
      state.rooms.push({
        roomId,
        kind: "group",
        name,
        topic: null,
        avatarUrl: null,
        members: [],
        latest: null,
        unread: { notifications: 0, mentions: 0 },
        muted: false,
        notifications: "all",
        canEdit: { name: true, topic: true, avatar: true },
      });
      return roomId;
    }),
    invite: vi.fn(async (roomId: string, userId: string) => {
      const at = roomAt(roomId);
      if (at >= 0 && !state.rooms[at]!.members.some((member) => member.userId === userId)) {
        state.rooms[at] = { ...state.rooms[at]!, members: [...state.rooms[at]!.members, { userId, name: null }] };
      }
    }),
    // #214: a fresh channel — restricted to the org Space and listed in it,
    // the way the real seam's `createChannel` behaves; findable by
    // colleagues through `channels()`.
    createChannel: vi.fn(async (name: string) => {
      const roomId = `!channel-${name.toLowerCase().replace(/[^a-z0-9-]/gi, "-")}:workspace.example`;
      state.rooms.push({
        roomId,
        kind: "channel",
        name,
        topic: null,
        avatarUrl: null,
        members: [],
        latest: null,
        unread: { notifications: 0, mentions: 0 },
        muted: false,
        notifications: "all",
        canEdit: { name: true, topic: true, avatar: true },
      });
      state.channels = [...(state.channels ?? []), { roomId, name, topic: null, memberCount: 1, joined: true }];
      return roomId;
    }),
    channels: vi.fn(async () => [...(state.channels ?? [])]),
    joinChannel: vi.fn(async (roomId: string) => {
      const channel = (state.channels ?? []).find((candidate) => candidate.roomId === roomId);
      if (!channel || channel.joined) {
        return;
      }
      state.channels = (state.channels ?? []).map((candidate) => (candidate.roomId === roomId ? { ...candidate, joined: true } : candidate));
      state.rooms.push({
        roomId,
        kind: "channel",
        name: channel.name,
        topic: channel.topic,
        avatarUrl: null,
        members: [],
        latest: null,
        unread: { notifications: 0, mentions: 0 },
        muted: false,
        notifications: "all",
        canEdit: { name: false, topic: false, avatar: false },
      });
    }),
    invites: vi.fn(async () => [...(state.invites ?? [])]),
    joinRoom: vi.fn(async (roomId: string) => {
      const invite = (state.invites ?? []).find((candidate) => candidate.roomId === roomId);
      state.invites = (state.invites ?? []).filter((candidate) => candidate.roomId !== roomId);
      if (invite) {
        state.rooms.push({
          roomId,
          kind: invite.kind,
          name: invite.name,
          topic: null,
          avatarUrl: null,
          members: invite.inviterId ? [{ userId: invite.inviterId, name: invite.inviterName }] : [],
          latest: null,
          unread: { notifications: 0, mentions: 0 },
          muted: false,
          notifications: "all",
          canEdit: { name: false, topic: false, avatar: false },
        });
      }
    }),
    leave: vi.fn(async (roomId: string) => {
      const at = state.rooms.findIndex((room) => room.roomId === roomId);
      if (at >= 0) {
        state.rooms.splice(at, 1);
      }
      state.invites = (state.invites ?? []).filter((candidate) => candidate.roomId !== roomId);
    }),
    // #69: the tri-state the surfaces write — the homeserver's own state
    // moves under it the way another device would see it move. ("nothing"
    // IS the mute #63 wrote; one verb now, for one action.)
    setNotificationMode: vi.fn(async (roomId: string, mode: NotificationMode) => {
      const at = roomAt(roomId);
      if (at >= 0) {
        state.rooms[at] = { ...state.rooms[at]!, notifications: mode, muted: mode === "nothing" };
      }
    }),
    // #223: the homeserver's own state moves under these the same way the
    // notification mode above does — the next `rooms()` read is what every
    // surface (sidebar, header) shows, never a locally-assumed value.
    setRoomName: vi.fn(async (roomId: string, name: string) => {
      const at = roomAt(roomId);
      if (at >= 0) {
        state.rooms[at] = { ...state.rooms[at]!, name };
      }
    }),
    setRoomTopic: vi.fn(async (roomId: string, topic: string) => {
      const at = roomAt(roomId);
      if (at >= 0) {
        state.rooms[at] = { ...state.rooms[at]!, topic };
      }
    }),
    setRoomAvatar: vi.fn(async (roomId: string, mxcUrl: string) => {
      const at = roomAt(roomId);
      if (at >= 0) {
        state.rooms[at] = { ...state.rooms[at]!, avatarUrl: mxcUrl };
      }
    }),
    searchPeople: vi.fn(async (query: string) =>
      (state.people ?? []).filter((person) => person.name.toLowerCase().includes(query.toLowerCase())),
    ),
    // #207: local room matching and a direct profile lookup — minimal fakes,
    // since the real matching rules are pinned at the seam
    // (WorkspaceMatrixSeam.test.ts); this file only needs a whole connection.
    findRooms: vi.fn(async (query: string) => {
      const needle = query.trim().toLowerCase();
      return needle === ""
        ? [...state.rooms]
        : state.rooms.filter(
            (room) =>
              (room.name ?? "").toLowerCase().includes(needle) ||
              room.members.some((member) => (member.name ?? "").toLowerCase().includes(needle)),
          );
    }),
    getProfile: vi.fn(async (userId: string) => {
      const person = (state.people ?? []).find((candidate) => candidate.userId === userId);
      return person ? { userId: person.userId, name: person.name, avatarUrl: null } : null;
    }),
    // #70: search and landing at a hit are pinned by WorkspaceSearch.test.tsx;
    // this fake only has to be a whole connection.
    searchMessages: vi.fn(async () => ({ hits: [], next: null })),
    // #222: mentions are pinned by Mentions.test.tsx; this fake only has to be a whole connection.
    mentions: vi.fn(async () => []),
    timelineAt: vi.fn(async (roomId: string) => [...(state.timelines[roomId] ?? [])]),
    // #211/#212: this file's ACs don't exercise scroll-back or the unread
    // line — RoomScrollback.test.tsx pins those. A fixed "already caught up"
    // answer keeps this a whole connection without inventing history.
    loadOlder: vi.fn(async () => ({ loadedMore: false, atStart: true })),
    readMarker: vi.fn(() => null),
    unreadBoundaryFrom: vi.fn(() => ({ kind: "none" as const })),
    advanceReadMarker: vi.fn(async () => {}),
    // #64's message verbs — each one moves the timeline the way the
    // homeserver's own state would move under the same op, so the
    // surface's reflection is always the server's next answer.
    edit: vi.fn(async (roomId: string, eventId: string, body: string) => {
      const at = messageAt(roomId, eventId);
      if (at >= 0) {
        timelineOf(roomId)[at] = { ...timelineOf(roomId)[at]!, body, edited: true };
      }
    }),
    delete: vi.fn(async (roomId: string, eventId: string) => {
      const at = messageAt(roomId, eventId);
      if (at >= 0) {
        timelineOf(roomId)[at] = { ...timelineOf(roomId)[at]!, body: "", redacted: true };
      }
    }),
    react: vi.fn(async (roomId: string, eventId: string, key: string) => {
      const at = messageAt(roomId, eventId);
      if (at < 0) {
        return;
      }
      const message = timelineOf(roomId)[at]!;
      const existing = message.reactions.find((reaction) => reaction.key === key);
      timelineOf(roomId)[at] = {
        ...message,
        reactions: existing
          ? message.reactions.map((reaction) => (reaction.key === key ? { ...reaction, count: reaction.count + 1, mine: true } : reaction))
          : [...message.reactions, { key, count: 1, mine: true }],
      };
    }),
    unreact: vi.fn(async (roomId: string, eventId: string, key: string) => {
      const at = messageAt(roomId, eventId);
      if (at < 0) {
        return;
      }
      const message = timelineOf(roomId)[at]!;
      timelineOf(roomId)[at] = {
        ...message,
        reactions: message.reactions
          .map((reaction) => (reaction.key === key ? { ...reaction, count: reaction.count - 1, mine: false } : reaction))
          .filter((reaction) => reaction.count > 0),
      };
    }),
    replyInThread: vi.fn(async (roomId: string, rootEventId: string, body: string) => {
      const eventId = `~reply-${(pendingSeq += 1)}`;
      const rootAt = messageAt(roomId, rootEventId);
      if (rootAt >= 0) {
        const list = timelineOf(roomId);
        const root = list[rootAt]!;
        list[rootAt] = {
          ...root,
          thread: {
            replyCount: (root.thread?.replyCount ?? 0) + 1,
            latestReply: { senderId: SESSION.userId, senderName: "ana", body },
          },
        };
      }
      const outcome = localEcho(
        roomId,
        messageFor({ eventId, senderId: SESSION.userId, senderName: "ana", body, threadRootEventId: rootEventId, pending: true }),
      );
      if (outcome === "failed") {
        throw new Error("refused");
      }
    }),
    // #209: Retry tries the SAME row again (flips it back to pending — the
    // test confirms it the ordinary way, via `deliver`); Cancel takes the
    // row back outright, the way `client.cancelPendingEvent` does.
    retry: vi.fn(async (roomId: string, eventId: string) => {
      const list = timelineOf(roomId);
      const at = messageAt(roomId, eventId);
      if (at >= 0) {
        list[at] = { ...list[at]!, pending: true, failed: false };
        notify(roomId);
      }
    }),
    cancel: vi.fn((roomId: string, eventId: string) => {
      const list = timelineOf(roomId);
      const at = messageAt(roomId, eventId);
      if (at >= 0) {
        list.splice(at, 1);
        notify(roomId);
      }
    }),
  };
  return {
    connection,
    // A live arrival: an unseen event id appends, a seen one replaces —
    // exactly what a homeserver sync does with an edit or a redaction.
    // The arrival half (#69) says who spoke and whether it mentioned the
    // member — what a notification decides on.
    deliver: (message: RoomMessage, mentionsMe = false) => {
      const list = timelineOf(message.roomId);
      const at = list.findIndex((existing) => existing.eventId === message.eventId);
      // #209: the homeserver's echo of THIS device's own send swaps the
      // matching pending row in place — the real seam's local-echo id swap
      // (`handleRemoteEcho`), never a second, duplicate row.
      const pendingAt =
        at < 0 && message.senderId === SESSION.userId
          ? list.findIndex(
              (existing) =>
                existing.pending === true && existing.body === message.body && existing.threadRootEventId === message.threadRootEventId,
            )
          : -1;
      if (at >= 0) {
        list[at] = message;
      } else if (pendingAt >= 0) {
        list[pendingAt] = message;
      } else {
        list.push(message);
        // #65: a first-time arrival that mentions this user moves the
        // homeserver's mention accounting with it (the spec's
        // `.m.rule.is_user_mention` reading `m.mentions.user_ids` — the
        // badge is the server's count, not something the client tallies),
        // and a mention is a notification too. An edit never re-counts.
        if (
          message.senderId !== SESSION.userId &&
          message.parts?.some((part) => part.kind === "mention" && part.userId === SESSION.userId)
        ) {
          const roomIndex = roomAt(message.roomId);
          if (roomIndex >= 0) {
            const unread = state.rooms[roomIndex]!.unread;
            state.rooms[roomIndex] = {
              ...state.rooms[roomIndex]!,
              unread: { notifications: unread.notifications + 1, mentions: unread.mentions + 1 },
            };
          }
        }
      }
      const arrival: LiveArrival = { senderId: message.senderId, senderName: message.senderName, body: message.body, mentionsMe };
      for (const listener of listeners) {
        listener(message.roomId, arrival);
      }
    },
    // #223 AC2: a colleague renames the conversation on their own device.
    // The homeserver's sync delivers no arrival for this (it's room news,
    // not message news) — just the roomId, same as the seam's own
    // ROOM_INFO_EVENT_TYPES handling (WorkspaceMatrixSeam.test.ts pins
    // that half); this fake moves `state.rooms` the way that next
    // `rooms()` read would, and notifies every subscriber the same way.
    renameRoomElsewhere: (roomId: string, name: string) => {
      const at = roomAt(roomId);
      if (at >= 0) {
        state.rooms[at] = { ...state.rooms[at]!, name };
      }
      for (const listener of listeners) {
        listener(roomId);
      }
    },
  };
}

/** The list entry for a room, by the title it renders under. */
function entryFor(title: string): HTMLElement {
  const entry = screen
    .getAllByTestId("conversations-entry")
    .find((candidate) => within(candidate).getByTestId("room-title").textContent === title);
  expect(entry, `no conversations entry titled ${JSON.stringify(title)}`).toBeDefined();
  return entry!;
}

/** The rendered message row containing a body — the timeline's and the thread view's rows share the testid. */
function messageRow(body: string): HTMLElement {
  const row = screen.getAllByTestId("room-message").find((candidate) => within(candidate).queryByText(body) !== null);
  expect(row, `no message row containing ${JSON.stringify(body)}`).toBeDefined();
  return row!;
}

/** Navigate the way the browser would follow an in-app hash link (happy-dom doesn't follow anchors). */
function navigate(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
}

/** Fresh module registry per render: the app's module-level QueryClient must not carry cache across tests. */
async function renderApp() {
  vi.resetModules();
  const { App } = await import("../src/App.js");
  return render(<App />);
}

function seedSession() {
  localStorage.setItem("duo.workspace-session", JSON.stringify(SESSION));
}

function seedPairing() {
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
}

/** Daemon answers for the queries a paired shell runs (roster, pending drafts): empty and successful. */
function stubDaemonFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(signIn).mockReset();
  vi.mocked(connect).mockReset();
  // Browser parity by default (#69): the shell's plugin calls reject the
  // way they do in a plain tab, so nothing notifies unless a test grants it.
  notificationPlugin.isPermissionGranted.mockReset();
  notificationPlugin.requestPermission.mockReset();
  notificationPlugin.sendNotification.mockReset();
  notificationPlugin.onAction.mockReset();
  notificationPlugin.isPermissionGranted.mockRejectedValue(new Error("window.__TAURI_INTERNALS__ is undefined"));
  notificationPlugin.requestPermission.mockResolvedValue("denied");
  notificationPlugin.onAction.mockRejectedValue(new Error("window.__TAURI_INTERNALS__ is undefined"));
});

afterEach(() => {
  leaveTauriShell();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

describe("#62 AC1 — signing in to the workspace works", () => {
  it("the front door offers the workspace sign-in, with duo pairing still there beside it", async () => {
    await renderApp();

    expect(screen.getByRole("heading", { name: "Sign in to your workspace" })).toBeInTheDocument();
    // The pairing path keeps its own fields — a reasonable front door for one
    // person pairing their phone, still one form away.
    expect(screen.getByPlaceholderText("100.64.1.5:7717")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /token/i })).toBeInTheDocument();
  });

  it("signing in reaches conversations, with no duo pairing having happened", async () => {
    vi.mocked(signIn).mockResolvedValue(SESSION);
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    // URL normalization (https, trailing slash) is the seam's rule and the
    // seam suite pins it; here the form hands the address through as typed.
    fireEvent.change(screen.getByLabelText("Homeserver"), { target: { value: "https://workspace.example" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ana" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    expect(screen.getByText("project-x")).toBeInTheDocument();
    expect(screen.getByText("Bose")).toBeInTheDocument();
    expect(signIn).toHaveBeenCalledWith("https://workspace.example", "ana", "correct horse");
    // No pairing happened: the duo credential store is untouched.
    expect(localStorage.getItem("duo.api-config")).toBeNull();
  });

  it("rejected credentials stay on the door, saying the homeserver refused them", async () => {
    vi.mocked(signIn).mockRejectedValue(new Error("The workspace refused these sign-in details."));

    await renderApp();
    fireEvent.change(screen.getByLabelText("Homeserver"), { target: { value: "https://workspace.example" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ana" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByTestId("setup-workspace-error")).toHaveTextContent("The workspace refused these sign-in details.");
    expect(screen.queryByTestId("conversations-list")).toBeNull();
    expect(localStorage.getItem("duo.workspace-session")).toBeNull();
  });
});

describe("#62 AC2 — pairing a duo is a separate, later step", () => {
  it("an unpaired member lands on Conversations, reads a room, and a colleague's duo is labelled structurally", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();

    // The empty hash is Conversations for a signed-in member — the default
    // space, not a duo surface demanding pairing.
    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    // The entry is a real link to the room's own address; happy-dom's click
    // doesn't follow hashes, so the test drives the same navigation the
    // browser would.
    // #63's entry markup puts the title in its own element inside the link;
    // the destination is the link's, resolved by role.
    expect(screen.getByRole("link", { name: /project-x/ })).toHaveAttribute("href", "#chat/!project-x%3Aworkspace.example");
    window.location.hash = "#chat/!project-x%3Aworkspace.example";
    window.dispatchEvent(new Event("hashchange"));

    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("room-person-message-author")).toHaveTextContent("Bose");
    // The duo's message carries whose it is from the structural id
    // (`@duo-carol` → carol), never from a display name the sender chose.
    expect(screen.getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");
  });

  it("messaging works fully: sending posts through the connection, and a live arrival renders", async () => {
    seedSession();
    const state = { rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } };
    const fake = fakeConnection(state);
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#chat/!project-x%3Aworkspace.example";
    window.dispatchEvent(new Event("hashchange"));
    await screen.findByTestId("room-timeline");

    setComposer(screen.getByLabelText("Message project-x"), "thanks all");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fake.connection.send).toHaveBeenCalledWith("!project-x:workspace.example", "thanks all"));
    // The composer clears on a successful send — the room is the record.
    await waitFor(() => expect(composerText(screen.getByLabelText("Message project-x"))).toBe(""));

    // A live arrival (someone else's message, or ours echoed back by the
    // homeserver) renders without a manual refresh.
    const reply = messageFor({ eventId: "$3", senderId: "@carol:workspace.example", senderName: "Carol", body: "np" });
    act(() => fake.deliver(reply));
    await waitFor(() => expect(screen.getByText("np")).toBeInTheDocument());
  });

  it("duo surfaces explain that no duo is connected, and pairing is offered rather than demanded", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // A duo surface, navigated directly: the explanation, and the offer.
    window.location.hash = "#review";
    window.dispatchEvent(new Event("hashchange"));
    const noDuo = await screen.findByTestId("no-duo");
    expect(noDuo).toHaveTextContent("No duo is connected on this device.");
    // The route's own panel and the sidebar's condensed one both offer it (#68 made #review a real address for a member, so both stand).
    expect(screen.getAllByTestId("no-duo-pair")[0]).toHaveTextContent("Pair your duo");
    // Offered, not demanded: nothing modal is in the way.
    expect(screen.queryByTestId("pair-duo-dialog")).toBeNull();
  });

  it("pairing from the offer pairs the duo, and the member shell gains its duo surfaces", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    stubDaemonFetch();

    await renderApp();
    await screen.findByTestId("conversations-list");
    // The list itself offers the duo — pairing is offered, never demanded.
    fireEvent.click(await screen.findByTestId("no-duo-pair"));

    fireEvent.change(await screen.findByLabelText("Daemon address"), { target: { value: "100.64.1.5:7717" } });
    fireEvent.change(screen.getByRole("textbox", { name: /token/i }), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
    // The dialog closes behind the pairing, and the duo's own surface takes over.
    await waitFor(() => expect(screen.queryByTestId("pair-duo-dialog")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("duo-link")).toBeInTheDocument());
    expect(screen.queryByTestId("no-duo")).toBeNull();
  });
});

describe("#62 AC3 — both credentials are managed", () => {
  it("settings shows both connections, and signing out ends only the workspace one", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#settings/advanced";
    window.dispatchEvent(new Event("hashchange"));

    const workspace = await screen.findByTestId("settings-workspace");
    expect(workspace).toHaveTextContent("@ana:workspace.example");
    expect(workspace).toHaveTextContent("https://workspace.example");
    // The duo connection is shown beside it, in effect.
    expect(screen.getByTestId("settings-address")).toHaveTextContent("http://100.64.1.5:7717");

    fireEvent.click(screen.getByTestId("settings-sign-out"));

    await waitFor(() => expect(localStorage.getItem("duo.workspace-session")).toBeNull());
    // The pairing survives: the two connections end independently.
    await waitFor(() => expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
    // Still the owner's shell — the duo surfaces stand without the workspace.
    await waitFor(() => expect(screen.getByTestId("duo-link")).toBeInTheDocument());
  });

  it("forgetting the duo keeps the workspace session, and the member shell stands", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#settings/advanced";
    window.dispatchEvent(new Event("hashchange"));
    fireEvent.click((await screen.findAllByTestId("settings-unpair"))[0]);
    fireEvent.click(screen.getByTestId("settings-unpair-confirm"));

    await waitFor(() => expect(localStorage.getItem("duo.api-config")).toBeNull());
    expect(JSON.parse(localStorage.getItem("duo.workspace-session") ?? "null")).toEqual(SESSION);
    // Conversations is still the member's default space — the unpaired
    // member's shell stands on the workspace alone. (#settings stays
    // mounted — the member's own navigation keeps standing — so walk to
    // Conversations the way the sidebar's link would.)
    window.location.hash = "#conversations";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(screen.getByTestId("conversations-list")).toBeInTheDocument());
  });
});

describe("#62 AC4 — signing out leaves nothing behind", () => {
  it("clears cached messages and cached duo data, while the pairing itself survives", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    // A persisted cache blob from before: what signing out must not leave readable.
    localStorage.setItem("duo-cache", JSON.stringify({ clientState: {}, buster: "delivery" }));

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#settings/advanced";
    window.dispatchEvent(new Event("hashchange"));
    fireEvent.click(await screen.findByTestId("settings-sign-out"));

    await waitFor(() => {
      expect(localStorage.getItem("duo-cache")).toBeNull();
      expect(localStorage.getItem("duo.workspace-session")).toBeNull();
    });
    expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({ baseUrl: "http://100.64.1.5:7717", token: "tok" });
  });
});

describe("#62 — the both-credentials shell and the failing-connection edge", () => {
  it("a paired member signed in opens on the chat list, with the duo pinned above the conversations", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();

    // The chat list is the default space, and your duo is always its first row:
    // pinned above the people, never a section of its own.
    const list = await screen.findByTestId("conversations-list");
    const duo = screen.getByTestId("duo-link");
    expect(duo).toHaveAttribute("href", "#duo");
    expect(duo.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(duo).getByTestId("chat-avatar")).toHaveAttribute("data-kind", "duo");
  });

  it("a connection that cannot be established says so and offers the way out", async () => {
    seedSession();
    vi.mocked(connect).mockRejectedValue(new Error("The workspace didn't answer."));

    await renderApp();

    const failure = await screen.findByTestId("workspace-error");
    expect(failure).toHaveTextContent("The workspace didn't answer.");
    fireEvent.click(screen.getByTestId("workspace-error-sign-out"));
    await waitFor(() => expect(localStorage.getItem("duo.workspace-session")).toBeNull());
  });
});

describe("#63 AC1 — the list triages without opening anything", () => {
  it("shows each conversation's name or members, the latest word, and unread — newest first", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // #208: sectioned — channels and groups first (by recency within the
    // section: project-x spoke more recently than announce), then direct
    // messages — never one flat list ordered by recency alone.
    expect(screen.getAllByTestId("room-title").map((title) => title.textContent)).toEqual(["project-x", "announce", "Bose"]);

    // A direct conversation has no name to show: its members are the title.
    const direct = entryFor("Bose");
    expect(within(direct).getByTestId("room-preview")).toHaveTextContent("lunch?");
    expect(within(direct).getByTestId("timestamp")).toBeInTheDocument();
    expect(within(direct).queryByTestId("room-unread")).toBeNull();

    // A named room shows the name, the latest word, its age, and the badge.
    const group = entryFor("project-x");
    expect(within(group).getByTestId("room-preview")).toHaveTextContent("ship it");
    expect(within(group).getByTestId("timestamp")).toBeInTheDocument();
    expect(within(group).getByTestId("room-unread")).toHaveAttribute("aria-label", "3 unread");

    // A channel reads by its name too — one list, three kinds, no opening.
    const channel = entryFor("announce");
    expect(within(channel).getByTestId("room-preview")).toHaveTextContent("all-hands friday");
    expect(within(channel).queryByTestId("room-unread")).toBeNull();
  });
});

describe("#63 AC2 — mentions outrank unread", () => {
  it("a conversation that mentioned the member is distinguishable from merely unread", async () => {
    seedSession();
    const rooms = roomsFixture();
    // project-x mentioned the member twice among five unread; Bose is
    // merely unread — same list, different demands.
    rooms[1] = { ...rooms[1]!, unread: { notifications: 5, mentions: 2 } };
    rooms[0] = { ...rooms[0]!, unread: { notifications: 3, mentions: 0 } };
    const fake = fakeConnection({ rooms, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    const mentioned = entryFor("project-x");
    expect(within(mentioned).getByTestId("room-mentions")).toHaveTextContent("2");
    expect(within(mentioned).getByTestId("room-unread")).toHaveAttribute("aria-label", "5 unread");

    const merelyUnread = entryFor("Bose");
    expect(within(merelyUnread).queryByTestId("room-mentions")).toBeNull();
    expect(within(merelyUnread).getByTestId("room-unread")).toHaveAttribute("aria-label", "3 unread");
  });
});

describe("#63 AC3 — conversations can be started, left and muted", () => {
  it("starting a conversation searches the workspace's people and opens the room it creates", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, people: PEOPLE });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    fireEvent.click(await screen.findByTestId("conversations-new"));

    fireEvent.change(await screen.findByLabelText("Search people"), { target: { value: "carol" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    // #247: the directory answers people AND duos, but carol's duo belongs
    // to carol — one row for her, with "Ask Carol's duo" beside "Message"
    // on it, never a second result of its own.
    const results = await screen.findAllByTestId("new-conversation-person");
    expect(results.map((result) => result.textContent)).toEqual(["Carol"]);
    expect(screen.getByTestId("new-conversation-ask-duo")).toHaveTextContent("Ask Carol's duo");
    fireEvent.click(screen.getByRole("button", { name: /^Carol/ }));

    await waitFor(() => expect(fake.connection.startDirect).toHaveBeenCalledWith("@carol:workspace.example"));
    // The conversation opens: the new room is the surface, not a closed dialog.
    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
    expect(screen.queryByTestId("new-conversation-dialog")).toBeNull();
  });

  it("#247: 'Ask their duo' on the person's own row reaches the duo directly, from the id grammar — no second result needed to find it", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, people: PEOPLE });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    fireEvent.click(await screen.findByTestId("conversations-new"));
    fireEvent.change(await screen.findByLabelText("Search people"), { target: { value: "carol" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    fireEvent.click(await screen.findByTestId("new-conversation-ask-duo"));

    await waitFor(() => expect(fake.connection.startDirect).toHaveBeenCalledWith("@duo-carol:workspace.example"));
    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
  });

  it("the notification setting is the server's fact — nothing mutes as before, both directions read back (#69 AC1)", async () => {
    seedSession();
    const rooms = roomsFixture();
    const fake = fakeConnection({ rooms, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    // The query cache persists itself on its own throttle (`duo-cache`), which is not a store of this setting — only a store the setting would live in counts.
    const settingStores = () => JSON.stringify(Object.keys(localStorage).filter((key) => key !== "duo-cache").sort());
    const beforeKeys = settingStores();

    // A conversation's own verbs sit behind its "more" control.
    fireEvent.click(within(entryFor("project-x")).getByTestId("room-more"));
    const setting = within(entryFor("project-x")).getByTestId("room-notifications");
    expect(setting).toHaveValue("all");

    fireEvent.change(setting, { target: { value: "nothing" } });

    await waitFor(() => expect(fake.connection.setNotificationMode).toHaveBeenCalledWith("!project-x:workspace.example", "nothing"));
    // The reflection is the connection's next answer — what any of the
    // member's devices would render from the same server-side rule.
    await waitFor(() => expect(within(entryFor("project-x")).getByTestId("room-muted")).toBeInTheDocument());
    await waitFor(() => expect(within(entryFor("project-x")).getByTestId("room-notifications")).toHaveValue("nothing"));

    fireEvent.change(within(entryFor("project-x")).getByTestId("room-notifications"), { target: { value: "mentions" } });

    await waitFor(() => expect(fake.connection.setNotificationMode).toHaveBeenCalledWith("!project-x:workspace.example", "mentions"));
    await waitFor(() => expect(within(entryFor("project-x")).queryByTestId("room-muted")).toBeNull());
    await waitFor(() => expect(within(entryFor("project-x")).getByTestId("room-notifications")).toHaveValue("mentions"));
    // Cross-device is server-side by construction: no local store appeared.
    expect(settingStores()).toBe(beforeKeys);
  });

  it("leaving a conversation asks first, then removes it from the list", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    fireEvent.click(screen.getByRole("button", { name: "More for announce" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave announce" }));
    fireEvent.click(await screen.findByTestId("leave-conversation-confirm"));

    await waitFor(() => expect(fake.connection.leave).toHaveBeenCalledWith("!announce:workspace.example"));
    await waitFor(() => expect(screen.queryByText("announce")).toBeNull());
    // The others stand: leaving one conversation leaves the rest of the
    // list — project-x (Channels) still ahead of Bose (Direct messages).
    expect(screen.getAllByTestId("room-title").map((title) => title.textContent)).toEqual(["project-x", "Bose"]);
  });
});

describe("#214 — creating a group conversation and inviting people", () => {
  it("creates a private group and invites a colleague in the same flow", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, people: PEOPLE });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    fireEvent.click(await screen.findByTestId("conversations-new-room"));

    fireEvent.change(await screen.findByLabelText("Group name"), { target: { value: "Launch Squad" } });
    fireEvent.click(screen.getByTestId("new-room-create"));

    await waitFor(() => expect(fake.connection.createRoom).toHaveBeenCalledWith("Launch Squad", ""));

    // The same dialog moves from naming the room to inviting into it.
    fireEvent.change(await screen.findByLabelText("Search people"), { target: { value: "carol" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const results = await screen.findAllByTestId("new-room-person");
    fireEvent.click(results[0]!); // Carol, not her duo

    await waitFor(() => expect(fake.connection.invite).toHaveBeenCalledWith(expect.stringMatching(/^!fresh-/), "@carol:workspace.example"));
    await screen.findByText(/Invited/);

    fireEvent.click(screen.getByTestId("new-room-done"));

    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
    expect(screen.queryByTestId("new-room-dialog")).toBeNull();
  });

  it("skipping the invite step still creates the room — invitations aren't mandatory", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, people: PEOPLE });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    fireEvent.click(await screen.findByTestId("conversations-new-room"));
    fireEvent.change(await screen.findByLabelText("Group name"), { target: { value: "Launch Squad" } });
    fireEvent.click(screen.getByTestId("new-room-create"));

    await waitFor(() => expect(fake.connection.createRoom).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId("new-room-done"));

    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
    expect(fake.connection.invite).not.toHaveBeenCalled();
  });

  it("inviting a colleague into an existing room uses that room's own invite — not a new direct message", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, people: PEOPLE });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    fireEvent.click(within(entryFor("project-x")).getByTestId("room-more"));
    fireEvent.click(screen.getByRole("button", { name: "Invite to project-x" }));

    fireEvent.change(await screen.findByLabelText("Search people"), { target: { value: "carol" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click((await screen.findAllByTestId("invite-to-room-person"))[0]!);

    await waitFor(() => expect(fake.connection.invite).toHaveBeenCalledWith("!project-x:workspace.example", "@carol:workspace.example"));
  });

  it("a direct conversation has no 'Invite' control — it's just its two members", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, people: PEOPLE });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    fireEvent.click(within(entryFor("Bose")).getByTestId("room-more"));

    expect(screen.queryByRole("button", { name: "Invite to Bose" })).toBeNull();
  });

  it("an invite across organisations is refused, and the server's own sentence is shown beside that person — the room and dialog stand", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, people: PEOPLE });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    // The org wall's own refusal (digital-duo#235's duo_org_wall, ERR_INVITE)
    // — the seam forwards it verbatim; this is what the UI must show.
    vi.mocked(fake.connection.invite).mockRejectedValueOnce(new Error("The workspace said: Invites across organisations are not allowed."));

    await renderApp();
    await screen.findByTestId("conversations-list");
    fireEvent.click(within(entryFor("project-x")).getByTestId("room-more"));
    fireEvent.click(screen.getByRole("button", { name: "Invite to project-x" }));
    fireEvent.change(await screen.findByLabelText("Search people"), { target: { value: "carol" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click((await screen.findAllByTestId("invite-to-room-person"))[0]!);

    expect(await screen.findByTestId("invite-to-room-error")).toHaveTextContent("Invites across organisations are not allowed.");
    // Refused, not silently dropped — and nothing else about the room moved.
    expect(screen.getByTestId("invite-to-room-dialog")).toBeInTheDocument();
  });

  it("an invitee sees a pending invite and can accept it, landing in the room", async () => {
    seedSession();
    const invite: RoomInvite = { roomId: "!team:workspace.example", kind: "group", name: "team", inviterId: "@bose:workspace.example", inviterName: "Bose" };
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, invites: [invite] });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();

    const row = await screen.findByTestId("pending-invite");
    expect(row).toHaveTextContent("team");
    expect(row).toHaveTextContent("Invited by Bose");
    // It is not also a room in the ordinary list — it can't be opened yet.
    expect(screen.queryAllByTestId("room-title").map((title) => title.textContent)).not.toContain("team");

    fireEvent.click(within(row).getByTestId("pending-invite-accept"));

    await waitFor(() => expect(fake.connection.joinRoom).toHaveBeenCalledWith("!team:workspace.example"));
    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
    expect(screen.queryByTestId("pending-invite")).toBeNull();
  });

  it("an invitee can decline a pending invite — it's gone, the way leaving a room works", async () => {
    seedSession();
    const invite: RoomInvite = { roomId: "!team:workspace.example", kind: "group", name: "team", inviterId: "@bose:workspace.example", inviterName: "Bose" };
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, invites: [invite] });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    const row = await screen.findByTestId("pending-invite");

    fireEvent.click(within(row).getByTestId("pending-invite-decline"));

    await waitFor(() => expect(fake.connection.leave).toHaveBeenCalledWith("!team:workspace.example"));
    await waitFor(() => expect(screen.queryByTestId("pending-invite")).toBeNull());
  });

  it("a direct-message invite reads as a message request, not 'invited by' noise", async () => {
    seedSession();
    const invite: RoomInvite = { roomId: "!dm:workspace.example", kind: "direct", name: null, inviterId: "@bose:workspace.example", inviterName: "Bose" };
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, invites: [invite] });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();

    const row = await screen.findByTestId("pending-invite");
    expect(row).toHaveTextContent("Bose");
    expect(row).toHaveTextContent("Wants to message you");
  });
});

describe("#214 — channels: findable within your org", () => {
  it("the dialog offers Channel beside Private group, and Channel creates a channel — not a group", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, people: PEOPLE });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    fireEvent.click(await screen.findByTestId("conversations-new-room"));
    expect(await screen.findByTestId("new-room-kind-group")).toHaveTextContent("Private group");
    fireEvent.click(within(screen.getByTestId("new-room-kind-channel")).getByRole("radio"));

    fireEvent.change(await screen.findByLabelText("Channel name"), { target: { value: "Launch" } });
    fireEvent.click(screen.getByTestId("new-room-create"));

    await waitFor(() => expect(fake.connection.createChannel).toHaveBeenCalledWith("Launch", ""));
    expect(fake.connection.createRoom).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId("new-room-done"));
    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
  });

  it("Private group stays the default — a group is still made with createRoom", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, people: PEOPLE });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    fireEvent.click(await screen.findByTestId("conversations-new-room"));
    fireEvent.change(await screen.findByLabelText("Group name"), { target: { value: "Squad" } });
    fireEvent.click(screen.getByTestId("new-room-create"));

    await waitFor(() => expect(fake.connection.createRoom).toHaveBeenCalledWith("Squad", ""));
    expect(fake.connection.createChannel).not.toHaveBeenCalled();
  });

  it.each([
    "Only a room open to your own organisation, and that you are in, can be listed here.",
    "Only the person who listed a room here can change or remove that listing.",
  ])("the org wall's listing refusal is shown in its own words, and the dialog stands: %s", async (sentence) => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, people: PEOPLE });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    vi.mocked(fake.connection.createChannel).mockRejectedValueOnce(new Error(`The workspace said: ${sentence}`));

    await renderApp();
    fireEvent.click(await screen.findByTestId("conversations-new-room"));
    fireEvent.click(within(await screen.findByTestId("new-room-kind-channel")).getByRole("radio"));
    fireEvent.change(await screen.findByLabelText("Channel name"), { target: { value: "Launch" } });
    fireEvent.click(screen.getByTestId("new-room-create"));

    expect(await screen.findByTestId("new-room-error")).toHaveTextContent(sentence);
    expect(screen.getByTestId("new-room-dialog")).toBeInTheDocument();
  });

  it("browsing lists the org's channels; Join joins one and lands in it, and one already joined offers Open", async () => {
    seedSession();
    const fake = fakeConnection({
      rooms: roomsFixture(),
      timelines: {},
      people: PEOPLE,
      channels: [
        { roomId: "!general:workspace.example", name: "general", topic: "Everything", memberCount: 4, joined: true },
        { roomId: "!launch:workspace.example", name: "launch", topic: null, memberCount: 1, joined: false },
      ],
    });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    fireEvent.click(await screen.findByTestId("conversations-new-room"));
    fireEvent.click(await screen.findByTestId("new-room-browse"));

    const rows = await screen.findAllByTestId("channel-row");
    expect(rows.map((row) => within(row).getByTestId("channel-row-title").textContent)).toEqual(["general", "launch"]);
    expect(rows[0]).toHaveTextContent("Everything · 4 members");
    expect(within(rows[0]!).getByTestId("channel-row-open")).toBeInTheDocument();

    fireEvent.click(within(rows[1]!).getByTestId("channel-row-join"));

    await waitFor(() => expect(fake.connection.joinChannel).toHaveBeenCalledWith("!launch:workspace.example"));
    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
    expect(screen.queryByTestId("new-room-dialog")).toBeNull();
  });

  it("a refused join shows the workspace's sentence beside that channel", async () => {
    seedSession();
    const fake = fakeConnection({
      rooms: roomsFixture(),
      timelines: {},
      channels: [{ roomId: "!launch:workspace.example", name: "launch", topic: null, memberCount: 1, joined: false }],
    });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    vi.mocked(fake.connection.joinChannel).mockRejectedValueOnce(new Error("The workspace said: This room has members from another organisation."));

    await renderApp();
    fireEvent.click(await screen.findByTestId("conversations-new-room"));
    fireEvent.click(await screen.findByTestId("new-room-browse"));
    fireEvent.click(await screen.findByTestId("channel-row-join"));

    expect(await screen.findByTestId("channel-join-error")).toHaveTextContent("This room has members from another organisation.");
  });

  it("with no org Space, browsing says why instead of an empty list", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    vi.mocked(fake.connection.channels).mockRejectedValue(new Error("Your organisation's space isn't set up for this account yet."));

    await renderApp();
    fireEvent.click(await screen.findByTestId("conversations-new-room"));
    fireEvent.click(await screen.findByTestId("new-room-browse"));

    expect(await screen.findByTestId("channels-error")).toHaveTextContent("space isn't set up");
  });
});

describe("#247 — a duo's latest word in a conversation is attributed to its owner, never listed as a second speaker", () => {
  it("a conversation whose latest word is a colleague's duo says so, attributed to the owner, before it's opened", async () => {
    seedSession();
    const rooms = roomsFixture();
    const withDuoLatest = rooms.map((candidate) =>
      candidate.roomId === "!project-x:workspace.example"
        ? { ...candidate, latest: { ...candidate.latest!, senderId: "@duo-carol:workspace.example" } }
        : candidate,
    );
    const fake = fakeConnection({ rooms: withDuoLatest, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // Whose duo it is comes from the member id's grammar, not a name.
    expect(within(entryFor("project-x")).getAllByTestId("room-duo").map((chip) => chip.textContent)).toEqual(["carol's duo"]);
    expect(within(entryFor("Bose")).queryByTestId("room-duo")).toBeNull();
  });

  it("a duo merely riding in the room — not the latest sender — never appears in the preview", async () => {
    seedSession();
    // `roomsFixture`'s project-x carries carol's duo as a member, but its
    // `latest` has no `senderId` (never a duo's own word) — the preview
    // must say nothing about the duo at all.
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    expect(within(entryFor("project-x")).queryByTestId("room-duo")).toBeNull();
  });
});

describe("#63 — read state is durable, not local", () => {
  it("opening a conversation marks it read over the connection, and the badge clears on return", async () => {
    seedSession();
    const rooms = roomsFixture();
    rooms[1] = { ...rooms[1]!, unread: { notifications: 3, mentions: 0 } };
    const fake = fakeConnection({ rooms, timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    expect(within(entryFor("project-x")).getByTestId("room-unread")).toHaveAttribute("aria-label", "3 unread");

    window.location.hash = "#chat/!project-x%3Aworkspace.example";
    window.dispatchEvent(new Event("hashchange"));
    await screen.findByTestId("room-timeline");

    // The read marker went to the server — the receipt is the record, so
    // every other device reads the conversation as read too.
    await waitFor(() => expect(fake.connection.markRead).toHaveBeenCalledWith("!project-x:workspace.example"));

    window.location.hash = "#conversations";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(within(entryFor("project-x")).queryByTestId("room-unread")).toBeNull());
  });
});

describe("#220 — a conversation can be marked read or unread from the list", () => {
  it("marking a conversation unread shows a badge with no new messages, and marking it read clears it", async () => {
    seedSession();
    // "announce" starts with nothing server-counted as unread (unlike
    // "project-x", which this fixture seeds with 3) — the clean slate
    // "mark as unread" is meant to flag.
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    expect(within(entryFor("announce")).queryByTestId("room-unread")).toBeNull();
    expect(within(entryFor("announce")).queryByTestId("room-unread-dot")).toBeNull();

    fireEvent.click(within(entryFor("announce")).getByTestId("room-more"));
    fireEvent.click(within(entryFor("announce")).getByTestId("room-mark-unread"));

    await waitFor(() => expect(fake.connection.markUnread).toHaveBeenCalledWith("!announce:workspace.example"));
    // The flag, not a true count: a dot, never a number.
    await waitFor(() => expect(within(entryFor("announce")).getByTestId("room-unread-dot")).toBeInTheDocument());

    fireEvent.click(within(entryFor("announce")).getByTestId("room-mark-read"));

    await waitFor(() => expect(fake.connection.markRead).toHaveBeenCalledWith("!announce:workspace.example"));
    await waitFor(() => expect(within(entryFor("announce")).queryByTestId("room-unread-dot")).toBeNull());
  });

  it("marking as read also clears a genuinely unread conversation's badge — the same server-side flag either way", async () => {
    seedSession();
    const rooms = roomsFixture();
    rooms[1] = { ...rooms[1]!, unread: { notifications: 3, mentions: 0 } };
    const fake = fakeConnection({ rooms, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    expect(within(entryFor("project-x")).getByTestId("room-unread")).toHaveAttribute("aria-label", "3 unread");

    fireEvent.click(within(entryFor("project-x")).getByTestId("room-more"));
    fireEvent.click(within(entryFor("project-x")).getByTestId("room-mark-read"));

    await waitFor(() => expect(fake.connection.markRead).toHaveBeenCalledWith("!project-x:workspace.example"));
    await waitFor(() => expect(within(entryFor("project-x")).queryByTestId("room-unread")).toBeNull());
  });
});

describe("#225 — a link to one message", () => {
  it("opening a matrix.to-style permalink against this app lands in the conversation", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    navigate("#/!project-x:workspace.example/$2?via=workspace.example");

    await screen.findByTestId("room-timeline");
    expect(screen.getByTestId("room-header")).toHaveTextContent("project-x");
  });

  it("a link to a conversation this account can't see says so, rather than opening an empty room", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    navigate("#/!elsewhere:other-org.example/$nope?via=other-org.example");

    expect(await screen.findByTestId("room-not-accessible")).toHaveTextContent(/can.t see this conversation/i);
    expect(screen.queryByTestId("room-composer")).toBeNull();
  });

  describe("copying a message's link", () => {
    const writeText = vi.fn(async () => {});
    beforeEach(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      writeText.mockClear();
    });
    afterEach(() => {
      Reflect.deleteProperty(navigator, "clipboard");
    });

    it("copies the message's matrix.to permalink and confirms it", async () => {
      seedSession();
      const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
      vi.mocked(connect).mockResolvedValue(fake.connection);

      await renderApp();
      navigate("#chat/!project-x%3Aworkspace.example");
      await screen.findByTestId("room-timeline");

      const row = messageRow("Refunds within 30 days, full amount.");
      fireEvent.click(within(row).getByTestId("room-message-copy-link"));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://matrix.to/#/!project-x:workspace.example/$2?via=workspace.example"));
      await waitFor(() => expect(within(row).getByTestId("room-message-copy-link")).toHaveTextContent("Copied"));
    });

    it("says so plainly when the clipboard refuses", async () => {
      writeText.mockRejectedValue(new Error("denied"));
      seedSession();
      const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
      vi.mocked(connect).mockResolvedValue(fake.connection);

      await renderApp();
      navigate("#chat/!project-x%3Aworkspace.example");
      await screen.findByTestId("room-timeline");

      const row = messageRow("Refunds within 30 days, full amount.");
      fireEvent.click(within(row).getByTestId("room-message-copy-link"));

      await waitFor(() => expect(within(row).getByTestId("room-message-copy-link")).toHaveTextContent("Copy failed"));
    });
  });
});

describe("#64 AC1 — messages send and arrive", () => {
  it("a sent message renders immediately for its sender, and the homeserver's echo confirms it", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    setComposer(screen.getByLabelText("Message project-x"), "thanks all");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // Same frame as the click — the composer never waits on the homeserver
    // to clear (#209): no `await`/`waitFor` stands between the click and
    // this assertion.
    expect(composerText(screen.getByLabelText("Message project-x"))).toBe("");
    // Immediately — nothing has arrived from anywhere yet; the row is
    // matrix-js-sdk's own local echo (Detached pending-event ordering),
    // read straight off the connection, never a second copy this client
    // wrote. The waitFor only rides out the cache's microtask flush: no
    // arrival is coming (deliver is the only arrival path, and it hasn't
    // run), so the row can owe to the click alone.
    const optimistic = await waitFor(() => messageRow("thanks all"));
    expect(within(optimistic).getByTestId("room-message-pending")).toBeInTheDocument();
    expect(fake.connection.send).toHaveBeenCalledWith("!project-x:workspace.example", "thanks all");

    // The homeserver's echo — a real event id — replaces the optimistic
    // copy; the words stand without the marker, and there is exactly one
    // row for them (no duplicate between the local echo and the echo).
    act(() => fake.deliver(messageFor({ eventId: "$echo", senderId: SESSION.userId, senderName: "ana", body: "thanks all" })));
    await waitFor(() => expect(screen.queryByTestId("room-message-pending")).toBeNull());
    expect(screen.getAllByText("thanks all")).toHaveLength(1);
  });

  it("a background refetch during sending doesn't remove the pending row (#209) — it's read from the same place every time, not a second copy", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    setComposer(screen.getByLabelText("Message project-x"), "thanks all");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const optimistic = await waitFor(() => messageRow("thanks all"));
    expect(within(optimistic).getByTestId("room-message-pending")).toBeInTheDocument();

    // An unrelated event — someone else's message, landing while ours is
    // still on its way — forces exactly the kind of refetch that used to
    // race the old hand-rolled echo and wipe it.
    act(() => fake.deliver(messageFor({ eventId: "$bose2", senderId: "@bose:workspace.example", senderName: "Bose", body: "fyi" })));
    await waitFor(() => expect(screen.getByText("fyi")).toBeInTheDocument());
    // Ours is still exactly where it was, still marked pending.
    expect(within(messageRow("thanks all")).getByTestId("room-message-pending")).toBeInTheDocument();
  });
});

describe("#64 AC2 — editing and deleting are honest", () => {
  it("an edit replaces the words and is marked as an edit; a delete strikes the message, behind a confirm", async () => {
    seedSession();
    const own = messageFor({ eventId: "$mine", senderId: SESSION.userId, senderName: "ana", body: "the policy doc says 30 days" });
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE, own] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("the policy doc says 30 days")).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit message"), { target: { value: "the policy doc says 30 days, no exceptions" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fake.connection.edit).toHaveBeenCalledWith("!project-x:workspace.example", "$mine", "the policy doc says 30 days, no exceptions"));
    // The homeserver's next answer carries the new words and the mark.
    await waitFor(() => expect(within(messageRow("the policy doc says 30 days, no exceptions")).getByTestId("room-message-edited")).toBeInTheDocument());

    fireEvent.click(within(messageRow("the policy doc says 30 days, no exceptions")).getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByTestId("delete-message-confirm"));

    await waitFor(() => expect(fake.connection.delete).toHaveBeenCalledWith("!project-x:workspace.example", "$mine"));
    // The words go; the place stays honest — a struck message says so, it
    // doesn't silently vanish and reshuffle the room.
    await waitFor(() => expect(screen.getByTestId("room-message-deleted")).toHaveTextContent("Message deleted"));
  });

  it("another member's edit arrives without a refresh, marked as an edit", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    // Bose amends their own message: the same event id comes back with new
    // words and the edit mark — a sync, not a refresh.
    act(() =>
      fake.deliver(messageFor({ eventId: "$1", senderId: "@bose:workspace.example", senderName: "Bose", body: "what IS our refund policy?", edited: true })),
    );

    // The refetch the arrival kicked off is async; waitFor polls the same
    // mounted DOM — no manual refresh, no remount.
    const row = await waitFor(() => messageRow("what IS our refund policy?"));
    expect(within(row).getByTestId("room-message-edited")).toBeInTheDocument();
    expect(within(row).queryByText("what's our refund policy?")).toBeNull();
  });

  it("only a message that arrives while the room is open rises in: history renders in place (#192)", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");
    for (const row of screen.getAllByTestId("room-message")) {
      expect(row.className).not.toContain("motion-rise");
    }

    act(() => fake.deliver(messageFor({ eventId: "$live", senderId: "@bose:workspace.example", senderName: "Bose", body: "one more thing" })));
    const arrived = await waitFor(() => messageRow("one more thing"));
    expect(arrived.className).toContain("motion-rise");
    // The ones that were already here still sit still.
    expect(screen.getAllByTestId("room-message").filter((row) => row.className.includes("motion-rise"))).toHaveLength(1);
  });

  it("the owner's own message never rises in: it already appeared where they typed it, and its echo id changing must not play it twice (#192 review)", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    act(() => fake.deliver(messageFor({ eventId: "$mine", senderId: SESSION.userId, senderName: "ana", body: "sending this myself" })));
    const mine = await waitFor(() => messageRow("sending this myself"));
    expect(mine.className).not.toContain("motion-rise");
  });
});

describe("#64 AC3 — threads and reactions work", () => {
  it("a reaction renders under its message — in the conversation and inside the thread view — and the chip is a toggle", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...THREADED_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("what's our refund policy?")).getByRole("button", { name: "React" }));
    fireEvent.click(within(await screen.findByTestId("reaction-picker")).getByRole("button", { name: "React 👍" }));

    await waitFor(() => expect(fake.connection.react).toHaveBeenCalledWith("!project-x:workspace.example", "$1", "👍"));
    await waitFor(() => expect(within(messageRow("what's our refund policy?")).getByTestId("room-reaction")).toHaveTextContent("👍 1"));

    // The reaction follows the message into its thread view.
    navigate("#chat/!project-x%3Aworkspace.example/thread/%241");
    expect(await screen.findByTestId("thread-timeline")).toBeInTheDocument();
    // A thread has its own header, where the Info button lives (#184).
    expect(within(screen.getByTestId("thread-header")).getByRole("heading", { level: 1 })).toHaveTextContent("thread");
    expect(within(messageRow("what's our refund policy?")).getByTestId("room-reaction")).toHaveTextContent("👍 1");

    // Back in the conversation, the chip takes the reaction back.
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");
    fireEvent.click(within(messageRow("what's our refund policy?")).getByTestId("room-reaction"));
    await waitFor(() => expect(fake.connection.unreact).toHaveBeenCalledWith("!project-x:workspace.example", "$1", "👍"));
    await waitFor(() => expect(within(messageRow("what's our refund policy?")).queryByTestId("room-reaction")).toBeNull());
  });

  it("a thread renders in the conversation as a preview and in the thread view as replies; posting into it works", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...THREADED_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    // In the conversation: the thread's existence, its count, and its
    // latest word — attributed to whose it IS (the id grammar, not a name).
    const preview = within(messageRow("what's our refund policy?")).getByTestId("room-thread-preview");
    expect(preview).toHaveTextContent("carol's duo");
    expect(preview).toHaveTextContent("np, 30 days");
    expect(preview).toHaveTextContent("1 reply");
    expect(screen.getByTestId("open-thread")).toHaveAttribute("href", "#chat/!project-x%3Aworkspace.example/thread/%241");
    // The reply itself is not a row of the main flow — it lives behind the preview.
    expect(screen.queryByText("np, 30 days")).toBeNull();

    navigate("#chat/!project-x%3Aworkspace.example/thread/%241");
    expect(await screen.findByTestId("thread-timeline")).toBeInTheDocument();
    // The thread view: the root, and the reply — a duo's, labelled structurally (#60's rule).
    expect(screen.getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");
    expect(screen.getByText("np, 30 days")).toBeInTheDocument();

    setComposer(screen.getByLabelText("Reply in thread"), "thanks!");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fake.connection.replyInThread).toHaveBeenCalledWith("!project-x:workspace.example", "$1", "thanks!"));
    await waitFor(() => expect(screen.getByText("thanks!")).toBeInTheDocument());

    // Back in the conversation, the preview carries the new latest word and count.
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");
    const updated = within(messageRow("what's our refund policy?")).getByTestId("room-thread-preview");
    await waitFor(() => expect(updated).toHaveTextContent("2 replies"));
    expect(updated).toHaveTextContent("thanks!");
  });
});

describe("#215 — replying to a message with a quote, outside a thread", () => {
  it("Reply loads the composer with a cancellable quote, and Send carries it to the wire and renders it", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("what's our refund policy?")).getByRole("button", { name: "Reply" }));
    const preview = await screen.findByTestId("reply-preview");
    expect(preview).toHaveTextContent("Bose");
    expect(preview).toHaveTextContent("what's our refund policy?");

    setComposer(screen.getByLabelText("Message project-x"), "30 days");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // Same frame as the click (#209): the quote preview clears with the
    // rest of the composer, and never waits on the homeserver.
    expect(screen.queryByTestId("reply-preview")).toBeNull();
    expect(fake.connection.send).toHaveBeenCalledWith("!project-x:workspace.example", "30 days", [], "$1");

    // The sent reply shows a quote of the original (#215 AC2).
    const sent = await waitFor(() => messageRow("30 days"));
    const quote = within(sent).getByTestId("reply-quote");
    expect(quote).toHaveTextContent("Bose");
    expect(quote).toHaveTextContent("what's our refund policy?");
  });

  it("Cancel clears the quote without touching the words already typed", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("what's our refund policy?")).getByRole("button", { name: "Reply" }));
    await screen.findByTestId("reply-preview");
    setComposer(screen.getByLabelText("Message project-x"), "still drafting");

    fireEvent.click(screen.getByTestId("reply-preview-cancel"));

    expect(screen.queryByTestId("reply-preview")).toBeNull();
    expect(composerText(screen.getByLabelText("Message project-x"))).toBe("still drafting");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    // No reply target survives the cancel: an ordinary send, same shape as
    // ever (#64 AC1's own assertion pins this exact 2-argument call).
    expect(fake.connection.send).toHaveBeenCalledWith("!project-x:workspace.example", "still drafting");
  });

  it("clicking a reply's quote scrolls to the original and marks it", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    // #248: the transcript is virtualized — the jump is the virtualizer scrolling its own container to the row.
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("what's our refund policy?")).getByRole("button", { name: "Reply" }));
    setComposer(screen.getByLabelText("Message project-x"), "30 days");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const sent = await waitFor(() => messageRow("30 days"));

    scrollTo.mockClear();
    fireEvent.click(within(sent).getByTestId("reply-quote"));

    expect(scrollTo).toHaveBeenCalled();
    await waitFor(() => expect(messageRow("what's our refund policy?")).toHaveAttribute("aria-current", "true"));
    scrollTo.mockRestore();
  });
});

describe("#64 AC4 — read state is maintained", () => {
  it("opening a thread directly receipts the room — the read position holds on the thread route too", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...THREADED_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    // The member lands on the list — no room was opened — and jumps
    // straight into a thread by its address.
    await screen.findByTestId("conversations-list");
    expect(fake.connection.markRead).not.toHaveBeenCalled();

    navigate("#chat/!project-x%3Aworkspace.example/thread/%241");
    expect(await screen.findByTestId("thread-timeline")).toBeInTheDocument();
    await waitFor(() => expect(fake.connection.markRead).toHaveBeenCalledWith("!project-x:workspace.example"));
  });
});

/*
 * #65: mentioning — the product's central gesture, done the Matrix way: the
 * composer offers the room's members (people and the duos present, told
 * apart by the user-id grammar, never by a chosen name), the pick rides the
 * wire as `m.mentions.user_ids` (what the homeserver's push rules read —
 * AC4's "notified according to their settings" is server state, and the
 * client's whole duty is the correct wire shape), and the duo's answer —
 * arrived through its owner's daemon, late if the Mac was asleep — renders
 * in the conversation like any duo message, with its permissions outcome in
 * the daemon's own words, verbatim.
 */

describe("#65 AC1 — people and duos are both mentionable", () => {
  it("typing @ offers the people and the duos present, clearly distinguished", async () => {
    seedSession();
    // project-x's members are one person (Bose) and one duo (duo-carol) —
    // the fixture's order is the offer's order.
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    const composer = screen.getByLabelText("Message project-x");
    typeInto(composer, "@");

    const offer = await screen.findByTestId("mention-offer");
    const options = within(offer).getAllByTestId("mention-option");
    expect(options).toHaveLength(2);
    // The person is offered by their name; the duo by whose it is — the
    // same structural grammar every attribution uses.
    expect(within(options[0]!).getByTestId("mention-kind").textContent).toBe("person");
    expect(options[0]).toHaveTextContent("Bose");
    expect(within(options[1]!).getByTestId("mention-kind").textContent).toBe("duo");
    expect(options[1]).toHaveTextContent("carol's duo");

    // The typed fragment narrows the offer, the way an address bar does.
    typeInto(composer, "bo");
    await waitFor(() =>
      expect(within(screen.getByTestId("mention-offer")).getAllByTestId("mention-option")).toHaveLength(1),
    );
    expect(within(screen.getByTestId("mention-offer")).getAllByTestId("mention-option")[0]).toHaveTextContent("Bose");
  });

  it("a mention deleted from the text doesn't ride the wire", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    const composer = screen.getByLabelText("Message project-x");
    typeInto(composer, "@ca");
    fireEvent.click((await screen.findByTestId("mention-offer")).querySelector('[data-testid="mention-option"]')!);
    await waitFor(() => expect(composed(composer).mentions).toHaveLength(1));

    // The pick landed in the text — then the sender thought better of it
    // and wrote something else. What the message doesn't say, the wire
    // doesn't claim: no m.mentions for a mention no longer in the body.
    setComposer(composer, "never mind");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(fake.connection.send).toHaveBeenCalledWith("!project-x:workspace.example", "never mind");
  });
});

describe("#65 AC2 — mentioning a duo asks it", () => {
  it("a mention of a duo rides the wire to it, and its answer renders in the conversation", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    const composer = screen.getByLabelText("Message project-x");
    typeInto(composer, "@ca");
    // "@ca" narrows the offer to the duo alone — the person's label doesn't
    // begin with it.
    const offerEl = await screen.findByTestId("mention-offer");
    const duoOption = [...offerEl.querySelectorAll('[data-testid="mention-option"]')].find((option) =>
      option.textContent?.includes("carol's duo"),
    )!;
    fireEvent.click(duoOption);
    // Picking closes the offer and leaves the addressed words in the text.
    await waitFor(() => expect(screen.queryByTestId("mention-offer")).toBeNull());
    expect(composerText(composer)).toBe("@carol's duo ");
    // The pick is a pill in the editor — the duo's own dashed idiom.
    expect(composer.querySelector('[data-testid="composer-mention"]')).toHaveAttribute("data-mentioned-user", "@duo-carol:workspace.example");

    typeInto(composer, "what's our refund policy?");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    // The mention rode the wire: the body says it in words people read,
    // m.mentions says it in ids the homeserver's push rules read, and the
    // pick's id+label pair is what the seam anchors the pill from.
    expect(fake.connection.send).toHaveBeenCalledWith(
      "!project-x:workspace.example",
      "@carol's duo what's our refund policy?",
      [{ userId: "@duo-carol:workspace.example", label: "carol's duo" }],
    );

    // The answer arrives — here, one that was held while its owner's Mac
    // was asleep (#186's held-not-lost) and landed when it woke. The client
    // renders it when it arrives and synthesizes nothing before: no local
    // "the duo is thinking", no invented "will answer later".
    const LATE_ANSWER = "Refunds within 30 days, full amount. (I was asleep — this was waiting for me.)";
    act(() =>
      fake.deliver(
        messageFor({ eventId: "$9", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: LATE_ANSWER }),
      ),
    );
    const row = await waitFor(() => messageRow(LATE_ANSWER));
    expect(within(row).getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");
  });
});

describe("#65 AC3 — a duo that may not answer says so", () => {
  it("the permissions outcome renders verbatim — passed on or declined, in the daemon's own words", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    // The daemon's own composed outcomes (digital-duo public-answer.ts:
    // withPublicAttribution wraps PUBLIC_PASSED_ON_MESSAGE /
    // PUBLIC_REFUSAL_MESSAGE with the identity line) — the exact bytes the
    // client must show as-is. The comparison is on textContent directly:
    // no matcher's whitespace normalization may stand in for "verbatim".
    const attribution = "— carol's duo speaking here, not carol directly.";
    const passedOn = `I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.\n\n${attribution}`;
    const declined = `That's not something I speak for the owner on. I've passed it on to them, without saying anything more about it here.\n\n${attribution}`;

    act(() =>
      fake.deliver(messageFor({ eventId: "$p", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: passedOn })),
    );
    // Multi-line bodies never match queryByText (its matcher normalizes the
    // node's text but not the expected string), so the row is found by a
    // raw-substring probe and "verbatim" is pinned on raw textContent —
    // byte-exact by construction, no normalization standing in for it.
    const passedRow = await waitFor(() => {
      const row = screen
        .getAllByTestId("room-message")
        .find((candidate) => candidate.textContent?.includes("passed it on to the owner, and they'll follow up."));
      expect(row).toBeDefined();
      return row!;
    });
    expect(passedRow.textContent).toContain(passedOn);
    expect(within(passedRow).getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");

    act(() =>
      fake.deliver(messageFor({ eventId: "$d", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: declined })),
    );
    const declinedRow = await waitFor(() => {
      const row = screen
        .getAllByTestId("room-message")
        .find((candidate) => candidate.textContent?.includes("not something I speak for the owner on"));
      expect(row).toBeDefined();
      return row!;
    });
    expect(declinedRow.textContent).toContain(declined);
  });
});

/*
 * #65's receiving half: a mentioning message arrives carrying its parts
 * (the seam's projection of the formatted body's anchors), and the client
 * renders each mention as the mention it is — the pill. A duo's pill IS
 * the duo: its label is re-derived from the user id at the render site, so
 * a display name a sender claimed for it can never put the owner's name on
 * somebody's duo.
 */
describe("#65 — a delivered mention renders as the mention it is", () => {
  it("person and duo pills render from the parts, the duo's label from its id, never a claimed name", async () => {
    seedSession();
    // Bose's message mentions a person and a duo. The duo's part carries a
    // lying label — a display name somebody chose — and the pill must not
    // believe it: the grammar says whose duo it is, the same structural
    // rule message attribution has always followed.
    const fake = fakeConnection({
      rooms: roomsFixture(),
      timelines: {
        "!project-x:workspace.example": [
          messageFor({
            eventId: "$m1",
            senderId: "@bose:workspace.example",
            senderName: "Bose",
            body: "@Carol, @carol's duo — what's our refund policy?",
            parts: [
              { kind: "mention", userId: "@carol:workspace.example", label: "Carol" },
              { kind: "text", text: ", " },
              { kind: "mention", userId: "@duo-carol:workspace.example", label: "The Refund Bot" },
              { kind: "text", text: " — what's our refund policy?" },
            ],
          }),
        ],
      },
    });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    const pills = await screen.findAllByTestId("room-mention");
    expect(pills).toHaveLength(2);
    // The person's pill: their resolved label, the accent's solid border.
    expect(pills[0]).toHaveTextContent("@Carol");
    expect(pills[0].dataset.mentionedUser).toBe("@carol:workspace.example");
    expect(pills[0].className).toContain("border-[var(--accent)]");
    // The duo's pill: "carol's duo" from `@duo-carol` — not "The Refund
    // Bot" — wearing the dashed idiom the duo's own messages wear.
    expect(pills[1]).toHaveTextContent("@carol's duo");
    expect(pills[1].dataset.mentionedUser).toBe("@duo-carol:workspace.example");
    expect(pills[1].className).toContain("border-dashed");
    // The pill said the words; the body's plain text no longer repeats them.
    expect(screen.queryByText("@Carol, @carol's duo — what's our refund policy?")).toBeNull();
  });
});

/*
 * #65's badge: a mention of you is not just any unread — the list's entry
 * for that conversation carries the mention badge beside the unread count,
 * the client-visible receipt of the homeserver's push accounting (the
 * spec's `.m.rule.is_user_mention` reading `m.mentions.user_ids` — #65
 * AC4's "notified according to their settings" lands as server state; this
 * is the count arriving back).
 */
describe("#65 — a mention of you marks the conversation in the list", () => {
  it("a delivered mention-of-you raises the mention badge beside the unread count", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // project-x starts at 3 unread, no mentions — the badge isn't there.
    expect(within(entryFor("project-x")).getByTestId("room-unread").getAttribute("aria-label")).toBe("3 unread");
    expect(within(entryFor("project-x")).queryByTestId("room-mentions")).toBeNull();

    // Bose mentions ana; the arrival moves the server's counts — a mention
    // is also a notification — and the entry shows both.
    act(() =>
      fake.deliver(
        messageFor({
          eventId: "$m2",
          senderId: "@bose:workspace.example",
          senderName: "Bose",
          body: "@ana — can you look at this?",
          parts: [
            { kind: "mention", userId: "@ana:workspace.example", label: "ana" },
            { kind: "text", text: " — can you look at this?" },
          ],
        }),
      ),
    );

    await waitFor(() => expect(within(entryFor("project-x")).getByTestId("room-mentions").textContent).toBe("@ 1"));
    expect(within(entryFor("project-x")).getByTestId("room-unread").getAttribute("aria-label")).toBe("4 unread");
  });
});

describe("#64 — a refused verb says so, honestly (failed paths)", () => {
  it("a send the homeserver never got shows on its own row, failed, with Retry — the words are not lost (#209)", async () => {
    seedSession();
    const state = { rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] }, failNextSend: true };
    const fake = fakeConnection(state);
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    setComposer(screen.getByLabelText("Message project-x"), "thanks all");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // The composer clears the same frame as Enter — it never held the
    // words past that, so a later refusal has nothing of its own to lose.
    expect(composerText(screen.getByLabelText("Message project-x"))).toBe("");
    // The row stays — marked failed, not gone — and the words are right there on it.
    const row = await waitFor(() => messageRow("thanks all"));
    await waitFor(() => expect(within(row).getByTestId("room-message-failed")).toBeInTheDocument());
    expect(within(row).queryByTestId("room-message-pending")).toBeNull();
    expect(screen.getByText("thanks all")).toBeInTheDocument();

    // Retry tries the same row again — this time the homeserver answers.
    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fake.connection.retry).toHaveBeenCalled());
    await waitFor(() => expect(within(messageRow("thanks all")).getByTestId("room-message-pending")).toBeInTheDocument());
    act(() => fake.deliver(messageFor({ eventId: "$echo", senderId: SESSION.userId, senderName: "ana", body: "thanks all" })));
    await waitFor(() => expect(screen.queryByTestId("room-message-failed")).toBeNull());
    expect(screen.getAllByText("thanks all")).toHaveLength(1);
  });

  it("Cancel takes a failed send back — no Retry left for it, nothing else in the room moves", async () => {
    seedSession();
    const state = { rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] }, failNextSend: true };
    const fake = fakeConnection(state);
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    setComposer(screen.getByLabelText("Message project-x"), "never mind");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const row = await waitFor(() => messageRow("never mind"));
    await waitFor(() => expect(within(row).getByTestId("room-message-failed")).toBeInTheDocument());

    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(fake.connection.cancel).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("never mind")).toBeNull());
    // The rest of the room's own history is untouched.
    expect(screen.getByText("what's our refund policy?")).toBeInTheDocument();
  });

  it("an edit the workspace refuses leaves the words standing and says so", async () => {
    seedSession();
    const own = messageFor({ eventId: "$mine", senderId: SESSION.userId, senderName: "ana", body: "the policy doc says 30 days" });
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE, own] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    vi.mocked(fake.connection.edit).mockRejectedValueOnce(new Error("refused"));

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("the policy doc says 30 days")).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit message"), { target: { value: "changed words" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The refusal is said, and the server's next answer keeps the base's
    // words — the edit never happened, and the row doesn't pretend it did.
    await waitFor(() => expect(screen.getByTestId("room-message-error")).toHaveTextContent("The workspace didn't take that — try again."));
    await waitFor(() => expect(screen.getByText("the policy doc says 30 days")).toBeInTheDocument());
    expect(screen.queryByText("changed words")).toBeNull();
  });

  it("a delete the workspace refuses keeps the message, keeps the ask open, and says so", async () => {
    seedSession();
    const own = messageFor({ eventId: "$mine", senderId: SESSION.userId, senderName: "ana", body: "the policy doc says 30 days" });
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE, own] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    vi.mocked(fake.connection.delete).mockRejectedValueOnce(new Error("refused"));

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("the policy doc says 30 days")).getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByTestId("delete-message-confirm"));

    // The confirm doesn't close behind a refused delete — the words still
    // stand, and the ask stays with its answer.
    await waitFor(() => expect(screen.getByTestId("delete-message-error")).toHaveTextContent("The workspace didn't take that — try again."));
    expect(screen.getByTestId("delete-message-dialog")).toBeInTheDocument();
    expect(screen.getByText("the policy doc says 30 days")).toBeInTheDocument();
    expect(screen.queryByTestId("room-message-deleted")).toBeNull();
  });

  it("a reaction the workspace refuses says so and never shows the chip", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    vi.mocked(fake.connection.react).mockRejectedValueOnce(new Error("refused"));

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("what's our refund policy?")).getByRole("button", { name: "React" }));
    fireEvent.click(within(await screen.findByTestId("reaction-picker")).getByRole("button", { name: "React 👍" }));

    await waitFor(() => expect(screen.getByTestId("room-message-error")).toHaveTextContent("The workspace didn't take that — try again."));
    expect(screen.queryByTestId("room-reaction")).toBeNull();
  });

  it("a thread reply the homeserver never got shows failed, with Retry — same behaviour as the main flow (#209)", async () => {
    seedSession();
    const state = { rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...THREADED_TIMELINE] }, failNextSend: true };
    const fake = fakeConnection(state);
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example/thread/%241");
    await screen.findByTestId("thread-timeline");

    setComposer(screen.getByLabelText("Reply in thread"), "thanks!");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    // The composer clears the same frame as Enter.
    expect(composerText(screen.getByLabelText("Reply in thread"))).toBe("");
    const row = await waitFor(() => messageRow("thanks!"));
    await waitFor(() => expect(within(row).getByTestId("room-message-failed")).toBeInTheDocument());
    expect(screen.getByText("thanks!")).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fake.connection.retry).toHaveBeenCalled());
    await waitFor(() => expect(within(messageRow("thanks!")).getByTestId("room-message-pending")).toBeInTheDocument());
  });
});

/*
 * #69: what interrupts the member becomes a setting with three voices —
 * the per-conversation mode (server-side, so every device answers the
 * same), do-not-disturb (this device's own rule, holding everything back
 * and recording what it held), and the duo's own acts as a category no
 * conversation setting can silence. The dispatch lives in the app shell:
 * it hears the same live arrivals every surface hears and decides, before
 * the shell posts anything, whether this arrival interrupts.
 */
describe("#69 AC1 — an arrival interrupts by the conversation's setting", () => {
  it("all lets everything through, mentions holds the plain, nothing holds all", async () => {
    seedSession();
    const rooms = roomsFixture();
    rooms[1] = { ...rooms[1]!, notifications: "mentions" };
    rooms[2] = { ...rooms[2]!, muted: true, notifications: "nothing" };
    const fake = fakeConnection({ rooms, timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    inTauriShell(); // #320: the Mac app, so getPlatform() picks the Tauri adapter
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // project-x is mentions-only: plain words never interrupt…
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$n1", senderId: "@bose:workspace.example", senderName: "Bose", body: "plain words" }));
    });
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();
    // …a mention does, under the app's name, saying who, where, and what.
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$n2", senderId: "@bose:workspace.example", senderName: "Bose", body: "@ana — ping" }), true);
    });
    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Duo", body: "Bose in project-x: @ana — ping" }),
      ),
    );

    // announce is nothing: not even a mention interrupts.
    await act(async () => {
      fake.deliver(
        messageFor({ eventId: "$n3", roomId: "!announce:workspace.example", senderId: "@dee:workspace.example", senderName: "Dee", body: "@ana, all-hands" }),
        true,
      );
    });
    expect(notificationPlugin.sendNotification).toHaveBeenCalledTimes(1);

    // direct is all (the default): plain words interrupt.
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$n4", roomId: "!direct:workspace.example", senderId: "@bose:workspace.example", senderName: "Bose", body: "lunch?" }));
    });
    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Bose in Bose: lunch?" }),
      ),
    );
  });

  it("the member's own words never interrupt, and an open conversation is not interrupted about itself", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    inTauriShell(); // #320: the Mac app, so getPlatform() picks the Tauri adapter
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // Own words — sent from this device or any other — are not news.
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$o1", senderId: SESSION.userId, senderName: "ana", body: "from my other device" }));
    });
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();

    // The room the member is looking at does not interrupt about itself —
    // a notification for what the open window already shows is noise.
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$n5", senderId: "@bose:workspace.example", senderName: "Bose", body: "while you watch" }), true);
    });
    await waitFor(() => expect(messageRow("while you watch")).toBeInTheDocument());
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();
  });
});

describe("#69 AC2 — do not disturb holds everything back, visibly", () => {
  it("a manual do-not-disturb keeps the interruption off and keeps the record for afterwards", async () => {
    seedSession();
    localStorage.setItem("duo.dnd", JSON.stringify({ manual: true, from: null, to: null }));
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    inTauriShell(); // #320: the Mac app, so getPlatform() picks the Tauri adapter
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");

    await act(async () => {
      fake.deliver(messageFor({ eventId: "$m1", senderId: "@bose:workspace.example", senderName: "Bose", body: "held words" }), true);
    });
    // Nothing interrupts — not the mention the setting would otherwise let through.
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();

    // What was missed is visible afterwards, in the place the member set the rule.
    navigate("#settings/notifications");
    const missed = await screen.findByTestId("missed-list");
    const entry = within(missed).getByTestId("missed-entry");
    expect(entry).toHaveTextContent("Bose in project-x: held words");
    // The record points back at where it happened — the entry itself is the
    // link. ("!" is one of encodeURIComponent's unreserved characters; ":" is
    // not — the same address the conversations list links with.)
    expect(entry.getAttribute("href")).toBe("#chat/!project-x%3Aworkspace.example");

    fireEvent.click(screen.getByTestId("missed-clear"));
    await waitFor(() => expect(screen.queryByTestId("missed-entry")).toBeNull());
    expect(localStorage.getItem("duo.missed")).toBe("[]");
  });

  it("do not disturb turns on and off here, and quiet hours persist on this device", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#settings/notifications");

    expect(await screen.findByTestId("dnd-toggle")).toHaveTextContent("Turn on do not disturb");
    fireEvent.click(screen.getByTestId("dnd-toggle"));
    await waitFor(() => expect(screen.getByTestId("dnd-status")).toHaveTextContent("Do not disturb is on."));
    expect(JSON.parse(localStorage.getItem("duo.dnd")!)).toEqual({ manual: true, from: null, to: null });

    fireEvent.change(screen.getByTestId("dnd-from"), { target: { value: "22:00" } });
    fireEvent.change(screen.getByTestId("dnd-to"), { target: { value: "07:00" } });
    expect(JSON.parse(localStorage.getItem("duo.dnd")!)).toEqual({ manual: true, from: "22:00", to: "07:00" });

    fireEvent.click(screen.getByTestId("dnd-toggle"));
    await waitFor(() => expect(screen.getByTestId("dnd-status")).toHaveTextContent("Do not disturb is off."));
  });
});

/** The push channel's client half: a socket the test opens and speaks for. */
function stubDraftPushSocket() {
  class FakeSocket {
    static instances: FakeSocket[] = [];
    listeners = new Map<string, Array<(event: unknown) => void>>();
    sent: string[] = [];
    constructor() {
      FakeSocket.instances.push(this);
    }
    addEventListener(type: string, cb: (event: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
    }
    removeEventListener() {}
    send(data: string) {
      this.sent.push(data);
    }
    close() {}
    open() {
      this.listeners.get("open")?.forEach((cb) => cb(new Event("open")));
    }
    message(data: unknown) {
      this.listeners.get("message")?.forEach((cb) => cb({ data: JSON.stringify(data) }));
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  return FakeSocket;
}

describe("#69 AC3 — the owner's duo acting on their behalf is its own category", () => {
  it("the member's own duo answering in a conversation says so, in words no message uses", async () => {
    seedSession();
    const rooms = roomsFixture();
    rooms[1] = {
      ...rooms[1]!,
      members: [...rooms[1]!.members, { userId: "@duo-ana:workspace.example", name: "duo-ana" }],
    };
    const fake = fakeConnection({ rooms, timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    inTauriShell(); // #320: the Mac app, so getPlatform() picks the Tauri adapter
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // The member's own duo (@duo-ana — the id grammar says whose) speaks in
    // the room: neither "a message" nor "a draft" — the duo acted.
    await act(async () => {
      fake.deliver(
        messageFor({ eventId: "$duo1", senderId: "@duo-ana:workspace.example", senderName: "duo-ana", body: "Answered on the owner's behalf: 30 days." }),
      );
    });
    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Your duo answered on your behalf in project-x." }),
      ),
    );

    // A colleague's duo is a participant, not the member's own — its words
    // are a message like any person's, governed by the room's setting.
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$duo2", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "carol's duo speaks" }));
    });
    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "carol's duo in project-x: carol's duo speaks" }),
      ),
    );
  });

  it("an escalation arriving from the daemon notifies as the duo's own act, not as a waiting draft", async () => {
    seedSession();
    seedPairing();
    // The daemon's answer for the one draft the push names: an escalation.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/drafts/d1")) {
          return new Response(JSON.stringify({ id: "d1", escalated: true, refused: false }), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    inTauriShell(); // #320: the Mac app, so getPlatform() picks the Tauri adapter
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    const FakeSocket = stubDraftPushSocket();

    await renderApp();
    await screen.findByTestId("conversations-list");
    await act(async () => {
      FakeSocket.instances[0].open();
      FakeSocket.instances[0].message({ type: "draft-ready", draftId: "d1" });
    });

    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Your duo escalated a question to you." }),
      ),
    );
    // It never said the draft copy — the two categories cannot blur.
    const bodies = notificationPlugin.sendNotification.mock.calls.map((call) => call[0].body);
    expect(bodies).not.toContain("A new draft is waiting for your review.");
  });
});

/*
 * #69's product rule: the owner's duo answering, escalating, or refusing on
 * their behalf is the one notification that can never be fully turned off.
 * "Fully" is the point — a conversation set to nothing, and a do-not-disturb
 * that holds everything, both leave it standing: the first cannot reach it
 * (the act belongs to no conversation), the second only defers it into the
 * record Settings shows. And no control anywhere offers to silence it.
 */
describe("#69 AC3 — the duo's own acts can never be fully turned off", () => {
  function roomsWithOwnDuoIn(notifications: "nothing" | "mentions") {
    const rooms = roomsFixture();
    rooms[1] = {
      ...rooms[1]!,
      muted: notifications === "nothing",
      notifications,
      members: [...rooms[1]!.members, { userId: "@duo-ana:workspace.example", name: "duo-ana" }],
    };
    return rooms;
  }

  it.each(["nothing", "mentions"] as const)("a conversation set to %s still announces the member's own duo answering", async (mode) => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsWithOwnDuoIn(mode), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    inTauriShell(); // #320: the Mac app, so getPlatform() picks the Tauri adapter
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // A person in the same room stays governed by the setting…
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$s1", senderId: "@bose:workspace.example", senderName: "Bose", body: "plain words" }));
    });
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();
    // …the duo's act on the member's behalf is not a message and is not silenced by it.
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$s2", senderId: "@duo-ana:workspace.example", senderName: "duo-ana", body: "30 days." }));
    });
    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Your duo answered on your behalf in project-x." }),
      ),
    );
  });

  it("do not disturb defers it into the record instead of dropping it", async () => {
    seedSession();
    localStorage.setItem("duo.dnd", JSON.stringify({ manual: true, from: null, to: null }));
    const fake = fakeConnection({ rooms: roomsWithOwnDuoIn("nothing"), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    inTauriShell(); // #320: the Mac app, so getPlatform() picks the Tauri adapter
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$d1", senderId: "@duo-ana:workspace.example", senderName: "duo-ana", body: "30 days." }));
    });
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();

    navigate("#settings/notifications");
    const entry = within(await screen.findByTestId("missed-list")).getByTestId("missed-entry");
    expect(entry).toHaveTextContent("Your duo answered on your behalf in project-x.");
    expect(entry.getAttribute("href")).toBe("#chat/!project-x%3Aworkspace.example");
  });

  it("an escalation is held by do not disturb the same way, and waits in the record", async () => {
    seedSession();
    seedPairing();
    localStorage.setItem("duo.dnd", JSON.stringify({ manual: true, from: null, to: null }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/drafts/d2")) {
          return new Response(JSON.stringify({ id: "d2", escalated: true, refused: true }), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    inTauriShell(); // #320: the Mac app, so getPlatform() picks the Tauri adapter
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);
    const FakeSocket = stubDraftPushSocket();

    await renderApp();
    await screen.findByTestId("conversations-list");
    await act(async () => {
      FakeSocket.instances[0].open();
      FakeSocket.instances[0].message({ type: "draft-ready", draftId: "d2" });
    });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("duo.missed") ?? "[]")).toHaveLength(1));
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();

    navigate("#settings/notifications");
    const entry = within(await screen.findByTestId("missed-list")).getByTestId("missed-entry");
    expect(entry).toHaveTextContent("Your duo refused to answer for you.");
    expect(entry.getAttribute("href")).toBe("#draft/d2");
  });

  it("no setting offers to silence the category — do not disturb defers, and that is all the member is given", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#settings/notifications");
    const section = await screen.findByTestId("settings-notifications");

    // The only switches are this device's do-not-disturb and its window; the
    // words for turning off "duo" / "on your behalf" appear nowhere here.
    expect(within(section).getAllByRole("button").map((b) => b.textContent)).toEqual(["Turn on do not disturb"]);
    expect(section.textContent ?? "").not.toMatch(/on your behalf|mute (my )?duo|turn off duo/i);
  });
});

/** #66: one share's facts as a timeline row carries them. */
function sharedMessageFor(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId" | "senderId"> & { file: SharedFile }): RoomMessage {
  return messageFor({ ...over, body: over.file.name });
}

describe("#66 — sharing files and images in a conversation", () => {
  const ROOM = "!project-x:workspace.example";
  const PDF_SHARE: SharedFile = { name: "refund-policy.pdf", mimeType: "application/pdf", size: 48_000, url: "mxc://workspace.example/policy1", image: false };
  const IMAGE_SHARE: SharedFile = { name: "whiteboard.png", mimeType: "image/png", size: 204_800, url: "mxc://workspace.example/img1", image: true };

  // jsdom has neither object URLs nor navigation: the blob URLs are numbered
  // stand-ins, and a download is the anchor click the card makes — captured.
  const downloads: { download: string; href: string }[] = [];
  let anchorClick: { mockRestore: () => void } | undefined;
  beforeEach(() => {
    downloads.length = 0;
    let sequence = 0;
    Object.assign(URL, { createObjectURL: () => `blob:mock/${(sequence += 1)}`, revokeObjectURL: () => {} });
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ download: this.download, href: this.href });
    });
  });
  afterEach(() => {
    anchorClick?.mockRestore();
  });

  /** Opens project-x (Bose, carol's duo) with the given timelines. */
  async function openRoom(timelines: Record<string, RoomMessage[]> = { [ROOM]: [...PROJECT_TIMELINE] }) {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");
    return fake;
  }

  /** Puts files in the member's hand and picks them, the way the input does — settled when each is a chip or a refusal naming it. */
  async function pick(files: File[]): Promise<void> {
    fireEvent.change(screen.getByTestId("attach-file-input"), { target: { files } });
    await waitFor(() => {
      for (const file of files) {
        const staged = screen.queryAllByTestId("attachment-chip").some((chip) => chip.textContent?.includes(file.name));
        const refused = screen.queryByTestId("room-composer-error")?.textContent?.includes(file.name) ?? false;
        expect(staged || refused).toBe(true);
      }
    });
  }

  it("a shared file renders an honest card — name, size, type, download — and an image renders a thumbnail", async () => {
    const fake = await openRoom({
      [ROOM]: [
        ...PROJECT_TIMELINE,
        sharedMessageFor({ eventId: "$f1", senderId: "@bose:workspace.example", senderName: "Bose", file: PDF_SHARE }),
        sharedMessageFor({ eventId: "$f2", senderId: "@carol:workspace.example", senderName: "Carol", file: IMAGE_SHARE }),
      ],
    });

    const shares = await screen.findAllByTestId("room-file");
    expect(shares).toHaveLength(2);

    const fileShare = within(shares[0]!);
    expect(fileShare.queryByTestId("room-file-image")).toBeNull(); // a PDF is not previewed — no preview is faked
    expect(fileShare.getByTestId("room-file-name")).toHaveTextContent("refund-policy.pdf");
    expect(fileShare.getByTestId("room-file-facts")).toHaveTextContent("47 KiB");
    expect(fileShare.getByTestId("room-file-facts")).toHaveTextContent("application/pdf");
    // Nothing is fetched until the member asks: a 16 MiB file is not
    // pulled into every reader's browser just for being in the flow.
    expect(fake.connection.loadMedia).not.toHaveBeenCalledWith("mxc://workspace.example/policy1");
    await act(async () => {
      fireEvent.click(fileShare.getByTestId("room-file-download"));
    });
    await waitFor(() => expect(downloads).toEqual([{ download: "refund-policy.pdf", href: expect.stringMatching(/^blob:mock\//) }]));
    expect(fake.connection.loadMedia).toHaveBeenCalledWith("mxc://workspace.example/policy1");

    // The stack makes thumbnails cheap: the img is the thumbnail, its bytes
    // loaded through the member's own authenticated fetch.
    const imageShare = within(shares[1]!);
    await waitFor(() => expect(imageShare.getByTestId("room-file-image")).toHaveAttribute("src", expect.stringMatching(/^blob:mock\//)));
    expect(imageShare.getByTestId("room-file-image")).toHaveAttribute("alt", "whiteboard.png");
    expect(fake.connection.loadMedia).toHaveBeenCalledWith("mxc://workspace.example/img1");
    expect(imageShare.getByTestId("room-file-download")).toBeInTheDocument();
  });

  it("#218: clicking the thumbnail opens the image full screen, with the thumbnail's own bytes — Esc closes it", async () => {
    const fake = await openRoom({
      [ROOM]: [...PROJECT_TIMELINE, sharedMessageFor({ eventId: "$f1", senderId: "@bose:workspace.example", senderName: "Bose", file: IMAGE_SHARE })],
    });

    const thumbnail = await screen.findByTestId("room-file-image");
    const thumbnailSrc = thumbnail.getAttribute("src");
    expect(thumbnailSrc).toMatch(/^blob:mock\//);

    expect(screen.queryByTestId("image-viewer")).toBeNull();
    fireEvent.click(screen.getByTestId("room-file-image-trigger"));
    const viewer = await screen.findByTestId("image-viewer");

    // The full-screen image is the same blob the thumbnail already held —
    // never a second fetch against the raw mxc reference, authenticated or not.
    expect(within(viewer).getByTestId("image-viewer-image")).toHaveAttribute("src", thumbnailSrc);
    expect(fake.connection.loadMedia).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(viewer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("image-viewer")).toBeNull());
  });

  it("#218: the viewer's download button fetches the file the same authenticated way the card's own download does", async () => {
    const fake = await openRoom({
      [ROOM]: [...PROJECT_TIMELINE, sharedMessageFor({ eventId: "$f1", senderId: "@bose:workspace.example", senderName: "Bose", file: IMAGE_SHARE })],
    });

    await screen.findByTestId("room-file-image");
    fireEvent.click(screen.getByTestId("room-file-image-trigger"));
    const viewer = await screen.findByTestId("image-viewer");

    await act(async () => {
      fireEvent.click(within(viewer).getByTestId("image-viewer-download"));
    });
    await waitFor(() => expect(downloads).toEqual([{ download: "whiteboard.png", href: expect.stringMatching(/^blob:mock\//) }]));
    expect(fake.connection.loadMedia).toHaveBeenCalledWith("mxc://workspace.example/img1");

    // The close button also works, same as Escape.
    fireEvent.click(within(viewer).getByTestId("image-viewer-close"));
    await waitFor(() => expect(screen.queryByTestId("image-viewer")).toBeNull());
  });

  it("#218: the image zooms on click — fit to screen, then its own size — a plain toggle, not a gesture", async () => {
    await openRoom({
      [ROOM]: [...PROJECT_TIMELINE, sharedMessageFor({ eventId: "$f1", senderId: "@bose:workspace.example", senderName: "Bose", file: IMAGE_SHARE })],
    });

    await screen.findByTestId("room-file-image");
    fireEvent.click(screen.getByTestId("room-file-image-trigger"));
    const viewer = await screen.findByTestId("image-viewer");

    const zoom = within(viewer).getByTestId("image-viewer-zoom");
    expect(zoom).toHaveAccessibleName("Zoom in");
    fireEvent.click(zoom);
    expect(zoom).toHaveAccessibleName("Zoom out");
    fireEvent.click(zoom);
    expect(zoom).toHaveAccessibleName("Zoom in");
  });

  it("bytes this member can't load keep the facts and say so — no broken thumbnail, no silent dead link", async () => {
    seedSession();
    const fake = fakeConnection({
      rooms: roomsFixture(),
      timelines: { [ROOM]: [...PROJECT_TIMELINE, sharedMessageFor({ eventId: "$f1", senderId: "@bose:workspace.example", senderName: "Bose", file: IMAGE_SHARE })] },
    });
    vi.mocked(fake.connection.loadMedia).mockResolvedValue(null);
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-file");

    await waitFor(() => expect(fake.connection.loadMedia).toHaveBeenCalled());
    expect(screen.queryByTestId("room-file-image")).toBeNull(); // no bytes, no thumbnail — the card, honestly
    expect(screen.getByTestId("room-file-facts")).toHaveTextContent("whiteboard.png");
    expect(screen.getByTestId("room-file-facts")).toHaveTextContent("image/png");
    // The download says why it did nothing, and can be tried again.
    await act(async () => {
      fireEvent.click(screen.getByTestId("room-file-download"));
    });
    expect(await screen.findByTestId("room-file-error")).toHaveTextContent("Couldn't load whiteboard.png");
    expect(downloads).toEqual([]);
  });

  it("a duo's share is attributed to its owner in the duo's own container — a file is a message, and AR-13 holds for it", async () => {
    await openRoom({
      [ROOM]: [...PROJECT_TIMELINE, sharedMessageFor({ eventId: "$f1", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", file: PDF_SHARE })],
    });
    const share = await screen.findByTestId("room-file");
    const container = share.closest('[data-testid="room-duo-message"]');
    expect(container).not.toBeNull();
    expect(within(container as HTMLElement).getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");
    expect(share.closest('[data-testid="room-person-message"]')).toBeNull();
  });

  it("a share offers a download and nothing that imports it — importing is another act, owned and labelled elsewhere", async () => {
    await openRoom({
      [ROOM]: [...PROJECT_TIMELINE, sharedMessageFor({ eventId: "$f1", senderId: "@bose:workspace.example", senderName: "Bose", file: PDF_SHARE })],
    });
    const share = await screen.findByTestId("room-file");
    expect(within(share).queryAllByRole("button").map((button) => button.textContent)).toEqual(["Download"]);
    expect(within(share).queryByText(/import|corpus|learn/i)).toBeNull();
  });

  it("attaching and sending shares the file: upload through the seam, m.file on the wire, the share in the flow", async () => {
    const fake = await openRoom();

    await pick([new File([new Uint8Array([104, 101, 108, 108, 111])], "notes.txt", { type: "text/plain" })]);
    expect(screen.getByTestId("attachment-chip")).toHaveTextContent("notes.txt");
    expect(screen.getByTestId("attachment-chip")).toHaveTextContent("5 B");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    expect(fake.connection.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "notes.txt", mimeType: "text/plain", size: 5 }),
      expect.any(Function),
    );
    await waitFor(() =>
      expect(fake.connection.sendFile).toHaveBeenCalledWith(ROOM, {
        name: "notes.txt",
        mimeType: "text/plain",
        size: 5,
        url: "mxc://workspace.example/notes.txt",
        image: false,
      }),
    );
    // The share renders at once as this member's marked copy.
    expect(await screen.findByTestId("room-file")).toBeInTheDocument();
    // And the composer lets go of it — the room is the record.
    await waitFor(() => expect(screen.queryByTestId("attachment-chip")).toBeNull());
  });

  it("attach, then ask: the files ride immediately before the question — the association convention the backend reads", async () => {
    const fake = await openRoom();

    await pick([
      new File([new Uint8Array([1])], "one.txt", { type: "text/plain" }),
      new File([new Uint8Array([2])], "two.txt", { type: "text/plain" }),
    ]);
    // The room has a duo member, and the composer says what that means.
    const note = screen.getByTestId("attachment-note");
    expect(note).toHaveTextContent("carol's duo");
    expect(note).toHaveTextContent("32 KiB");
    expect(note).toHaveTextContent("can't read images yet");
    expect(note).toHaveTextContent("never imports");

    setComposer(screen.getByLabelText("Message project-x"), "what do these say?");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    // Contiguous, same sender, same room: upload → m.file → m.file → the
    // question, in exactly the order the wire carries them.
    const [uploadOne, uploadTwo] = vi.mocked(fake.connection.uploadFile).mock.invocationCallOrder;
    const [fileOne, fileTwo] = vi.mocked(fake.connection.sendFile).mock.invocationCallOrder;
    const [question] = vi.mocked(fake.connection.send).mock.invocationCallOrder;
    expect(fileOne).toBeGreaterThan(uploadOne);
    expect(uploadTwo).toBeGreaterThan(fileOne);
    expect(fileTwo).toBeGreaterThan(uploadTwo);
    expect(question).toBeGreaterThan(fileTwo);
    expect(fake.connection.send).toHaveBeenCalledWith(ROOM, "what do these say?");
    // Both shares and the question left the composer.
    await waitFor(() => expect(screen.queryByTestId("attachment-chip")).toBeNull());
    expect(composerText(screen.getByLabelText("Message project-x"))).toBe("");
  });

  it("the upload's progress is visible while it runs, and the composer rests when it ends", async () => {
    const fake = await openRoom();
    let report: (sent: number, total: number) => void = () => {};
    let finish: (shared: SharedFile) => void = () => {};
    vi.mocked(fake.connection.uploadFile).mockImplementationOnce(
      (_staged, onProgress) =>
        new Promise<SharedFile>((resolve) => {
          report = onProgress ?? (() => {});
          finish = resolve;
        }),
    );

    await pick([new File([new Uint8Array(1000)], "report.pdf", { type: "application/pdf" })]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(screen.getByTestId("room-composer-status")).toHaveTextContent("Uploading report.pdf…");

    act(() => report(250, 1000));
    expect(screen.getByTestId("room-composer-status")).toHaveTextContent("Uploading report.pdf… 25%");
    act(() => report(1000, 1000));
    expect(screen.getByTestId("room-composer-status")).toHaveTextContent("Uploading report.pdf… 100%");

    await act(async () => {
      finish({ name: "report.pdf", mimeType: "application/pdf", size: 1000, url: "mxc://workspace.example/report", image: false });
    });
    await waitFor(() => expect(screen.queryByTestId("room-composer-status")).toBeNull());
    expect(fake.connection.sendFile).toHaveBeenCalled();
  });

  it("a room with no duo says so — the share is for the people here", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!announce:workspace.example": [] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#chat/!announce%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    await pick([new File([new Uint8Array([1])], "announce.txt", { type: "text/plain" })]);
    expect(screen.getByTestId("attachment-note")).toHaveTextContent("no duo is here");
    expect(screen.getByTestId("attachment-note")).toHaveTextContent("never imports");
  });

  it("share limits refuse by naming the limit, and keep the message", async () => {
    await openRoom();

    // A 9 MiB image against this app's 8 MiB image limit.
    await pick([new File([new Uint8Array(9 * 1024 * 1024)], "big.png", { type: "image/png" })]);
    expect(screen.getByTestId("room-composer-error")).toHaveTextContent("big.png is 9 MiB — conversation image shares cap at 8 MiB.");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();

    // A 17 MiB file against this app's 16 MiB file limit — and the refusal
    // names THIS limit, not the duo's 32 KiB reading cap.
    await pick([new File([new Uint8Array(17 * 1024 * 1024)], "deck.pdf", { type: "application/pdf" })]);
    expect(screen.getByTestId("room-composer-error")).toHaveTextContent("deck.pdf is 17 MiB — conversation file shares cap at 16 MiB.");
    expect(screen.getByTestId("room-composer-error").textContent).not.toContain("32 KiB");

    // A fourth attachment names the count — the door a duo grounds by.
    await pick([
      new File([new Uint8Array([1])], "one.txt", { type: "text/plain" }),
      new File([new Uint8Array([1])], "two.txt", { type: "text/plain" }),
      new File([new Uint8Array([1])], "three.txt", { type: "text/plain" }),
    ]);
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(3);
    await pick([new File([new Uint8Array([1])], "four.txt", { type: "text/plain" })]);
    expect(screen.getByTestId("room-composer-error")).toHaveTextContent("four.txt wasn't added — a message carries at most 3 attachments.");
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(3);
    expect(screen.getAllByTestId("attachment-chip").some((chip) => chip.textContent?.includes("four.txt"))).toBe(false);
  });

  it("an upload the workspace refuses states the file, keeps the attachment, and never sends the question past it", async () => {
    const fake = await openRoom();
    vi.mocked(fake.connection.uploadFile).mockRejectedValueOnce(new Error("notes.txt is over the workspace's own upload limit."));

    await pick([new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" })]);
    setComposer(screen.getByLabelText("Message project-x"), "what does this say?");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    // The reason the workspace gave is the reason stated — not a bare "failed".
    await waitFor(() => expect(screen.getByTestId("room-composer-error")).toHaveTextContent("The workspace didn't take notes.txt"));
    expect(screen.getByTestId("room-composer-error")).toHaveTextContent("notes.txt is over the workspace's own upload limit.");
    // Nothing is lost: the file stays attached, the words stay typed, and
    // the question was not sent riding the wrong (empty) set of files.
    expect(screen.getByTestId("attachment-chip")).toHaveTextContent("notes.txt");
    expect(composerText(screen.getByLabelText("Message project-x"))).toBe("what does this say?");
    expect(fake.connection.sendFile).not.toHaveBeenCalled();
    expect(fake.connection.send).not.toHaveBeenCalled();
  });
});

describe("#217 — paste or drop a screenshot or file into the composer", () => {
  async function openRoom() {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");
    return fake;
  }

  it("pasting an image from the clipboard attaches it, the same door the file picker uses", async () => {
    await openRoom();
    const file = new File([new Uint8Array([1, 2, 3])], "screenshot.png", { type: "image/png" });

    fireEvent.paste(screen.getByLabelText("Message project-x"), { clipboardData: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId("attachment-chip")).toHaveTextContent("screenshot.png"));
  });

  it("a paste with no files (ordinary text) attaches nothing", async () => {
    await openRoom();

    fireEvent.paste(screen.getByLabelText("Message project-x"), { clipboardData: { files: [] } });

    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("dropping a file attaches it with the existing upload flow, and a drop-target shows only while dragging", async () => {
    const fake = await openRoom();
    const composer = screen.getByTestId("room-composer");
    const file = new File([new Uint8Array(10)], "notes.txt", { type: "text/plain" });

    expect(screen.queryByTestId("composer-drop-target")).toBeNull();
    fireEvent.dragEnter(composer, { dataTransfer: { files: [] } });
    expect(screen.getByTestId("composer-drop-target")).toBeInTheDocument();

    fireEvent.drop(composer, { dataTransfer: { files: [file] } });
    expect(screen.queryByTestId("composer-drop-target")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("attachment-chip")).toHaveTextContent("notes.txt"));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(fake.connection.sendFile).toHaveBeenCalledWith("!project-x:workspace.example", {
        name: "notes.txt",
        mimeType: "text/plain",
        size: 10,
        url: "mxc://workspace.example/notes.txt",
        image: false,
      }),
    );
  });

  it("the existing upload limits and errors apply to a dropped file too — nothing bypasses the picker's own refusal", async () => {
    await openRoom();
    const composer = screen.getByTestId("room-composer");
    const tooBig = new File([new Uint8Array(17 * 1024 * 1024)], "deck.pdf", { type: "application/pdf" });

    fireEvent.drop(composer, { dataTransfer: { files: [tooBig] } });

    await waitFor(() => expect(screen.getByTestId("room-composer-error")).toHaveTextContent("deck.pdf"));
    expect(screen.queryByTestId("attachment-chip")).toBeNull();
  });

  it("a drag that leaves without dropping clears the indicator", async () => {
    await openRoom();
    const composer = screen.getByTestId("room-composer");

    fireEvent.dragEnter(composer, { dataTransfer: { files: [] } });
    expect(screen.getByTestId("composer-drop-target")).toBeInTheDocument();
    fireEvent.dragLeave(composer, { dataTransfer: { files: [] } });

    expect(screen.queryByTestId("composer-drop-target")).toBeNull();
  });
});

/*
 * #127 (hide-the-form half): a hosted build (VITE_DUO_DAEMON_URL set) never
 * shows the homeserver form — its workspace is the operator's, not something
 * the person types an address for. Where the daemon has no workspace to hand
 * out (or this device is not paired to the account's server), Conversations
 * and Settings say the workspace isn't set up instead. A personal daemon
 * (no env var) keeps the manual form, exactly as #62 built it. The
 * auto-connect half follows in "#127 — a hosted device connects by itself".
 */
describe("#127 — hosted builds never show the homeserver form", () => {
  const HOSTED_ORIGIN = "https://duo-daemon.example.org";

  async function goTo(hash: string) {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
  }

  /** A hosted sign-in leaves this record beside the pairing; `connectManually` (Advanced) clears it. */
  function seedHostedAccount() {
    localStorage.setItem("duo.hosted-account", JSON.stringify({ origin: HOSTED_ORIGIN, ownerName: "Ada", isAdmin: false }));
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Conversations says the workspace isn't set up, with no sign-in button", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    seedPairing();
    seedHostedAccount();
    stubDaemonFetch();
    window.location.hash = "#conversations";

    await renderApp();

    expect(await screen.findByTestId("workspace-not-set-up")).toHaveTextContent("Workspace isn't set up yet");
    expect(screen.queryByTestId("conversations-signin")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in to a workspace" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Homeserver")).not.toBeInTheDocument();
  });

  it("Settings says the same, and never opens the sign-in dialog", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    seedPairing();
    seedHostedAccount();
    stubDaemonFetch();
    window.location.hash = "#settings/advanced";

    await renderApp();

    const workspace = await screen.findByTestId("settings-workspace");
    expect(within(workspace).getByTestId("workspace-not-set-up")).toHaveTextContent("Workspace isn't set up yet");
    expect(screen.queryByTestId("settings-workspace-signin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-signin-dialog")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Homeserver")).not.toBeInTheDocument();
  });

  it("the front door's Advanced (address) screen offers pairing, not a homeserver form", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    // Arrive at the front door itself (#signin), not the bare root, which
    // redirects a signed-out visitor to the landing page.
    window.location.hash = "#signin";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ googleClientId: "abc" }), { status: 200 })));

    await renderApp();
    fireEvent.click(await screen.findByTestId("landing-advanced"));

    expect(await screen.findByRole("heading", { name: "Pair a duo instead" })).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-not-set-up")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Homeserver")).not.toBeInTheDocument();
  });

  it("a hosted server without Google sign-in leads with pairing, with no workspace note above it", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    // Arrive at the front door itself (#signin), not the bare root, which
    // redirects a signed-out visitor to the landing page.
    window.location.hash = "#signin";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ googleClientId: null }), { status: 200 })));

    await renderApp();

    expect(await screen.findByRole("heading", { name: "Pair a duo instead" })).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-not-set-up")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Homeserver")).not.toBeInTheDocument();
  });

  it("a hosted build paired to a personal daemon via Advanced keeps the manual form (AC 4)", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    window.location.hash = "#signin";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return new Response(JSON.stringify(url.endsWith("/hosted/config") ? { googleClientId: "abc" } : []), { status: 200 });
      }),
    );
    await renderApp();

    // The front door's Advanced door: pair by address, no hosted sign-in.
    fireEvent.click(await screen.findByTestId("landing-advanced"));
    fireEvent.change(await screen.findByLabelText("Daemon address"), { target: { value: "http://100.64.1.5:7717" } });
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    window.location.hash = "#settings/advanced";
    window.dispatchEvent(new Event("hashchange"));
    expect(await screen.findByTestId("settings-workspace-signin")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-not-set-up")).not.toBeInTheDocument();
    expect(localStorage.getItem("duo.hosted-account")).toBeNull();
  });

  it("a hosted device never connects with a stored manual sign-in: its session comes from the daemon", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    seedPairing();
    seedHostedAccount();
    seedSession();
    stubDaemonFetch();
    window.location.hash = "#conversations";

    await renderApp();

    expect(await screen.findByTestId("workspace-not-set-up")).toBeInTheDocument();
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("the sign-in dialog renders nothing for a hosted device, even when asked to open", () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    seedHostedAccount();

    render(<WorkspaceSignInDialog open onOpenChange={() => {}} onSession={() => {}} />);

    expect(screen.queryByTestId("workspace-signin-dialog")).not.toBeInTheDocument();
  });

  it("a personal daemon keeps the manual form: Conversations and Settings both offer the sign-in", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", "");
    seedPairing();
    stubDaemonFetch();
    window.location.hash = "#conversations";

    await renderApp();

    fireEvent.click(await screen.findByTestId("conversations-signin"));
    expect(await screen.findByTestId("workspace-signin-dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Homeserver")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-not-set-up")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId("workspace-signin-dialog"), { key: "Escape" });
    await goTo("#settings/advanced");
    expect(await screen.findByTestId("settings-workspace-signin")).toHaveTextContent("Sign in to a workspace");
  });
});

/*
 * #127 (auto-connect half): after Google sign-in the app asks the paired
 * daemon for the person's own workspace session and connects with it — no
 * form, no typing. The credential is held in memory only, is renewed under
 * the open connection, is answered afresh when the workspace refuses it, and
 * is ended at the workspace on sign-out. (The hook's timing and error table
 * is pinned in test/HostedWorkspace.test.tsx; this is the wiring.)
 */
describe("#127 — a hosted device connects by itself", () => {
  const HOSTED_ORIGIN = "https://duo-daemon.example.org";
  const HOMESERVER = "https://matrix.example.org";
  const DEVICE_TOKEN = "device-token-ada";
  const PAIRING = { baseUrl: `${HOSTED_ORIGIN}/t/ada`, token: DEVICE_TOKEN };

  interface Answer {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }

  let minted = 0;
  function granted(ttlMs = 24 * 3_600_000): Answer {
    minted += 1;
    return {
      status: 200,
      body: {
        homeserverUrl: HOMESERVER,
        userId: "@acme.ada:matrix.example.org",
        accessToken: `syt_hosted_${minted}`,
        deviceId: null,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      },
    };
  }

  function seedHostedDevice(origin: string = HOSTED_ORIGIN) {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    localStorage.setItem("duo.api-config", JSON.stringify(PAIRING));
    localStorage.setItem("duo.hosted-account", JSON.stringify({ origin, ownerName: "Ada", isAdmin: false }));
  }

  /** The daemon: session `POST` answers in order (the last repeats) and a `DELETE` is a 204; the workspace's logout is recorded; everything else is empty and fine. */
  function stubHostedNetwork(answers: Answer[]) {
    let asked = 0;
    const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("Authorization") });
        if (url === workspaceSessionUrl(PAIRING) && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        if (url === workspaceSessionUrl(PAIRING)) {
          const answer = answers[Math.min(asked, answers.length - 1)]!;
          asked += 1;
          return new Response(JSON.stringify(answer.body), { status: answer.status, headers: answer.headers });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    return {
      sessionCalls: () => calls.filter((call) => call.url === workspaceSessionUrl(PAIRING) && call.method === "POST"),
      dropCalls: () => calls.filter((call) => call.url === workspaceSessionUrl(PAIRING) && call.method === "DELETE"),
      logoutCalls: () => calls.filter((call) => call.url.endsWith("/_matrix/client/v3/logout")),
    };
  }

  beforeEach(() => {
    minted = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("Conversations loads with no further input, connecting with the daemon's session — no device, no form", async () => {
    seedHostedDevice();
    const net = stubHostedNetwork([granted()]);
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    window.location.hash = "#conversations";

    await renderApp();

    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    expect(net.sessionCalls()).toHaveLength(1);
    expect(net.sessionCalls()[0]!.authorization).toBe(`Bearer ${DEVICE_TOKEN}`);
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connect).mock.calls[0]![0]).toEqual({
      homeserverUrl: HOMESERVER,
      userId: "@acme.ada:matrix.example.org",
      accessToken: "syt_hosted_1",
      deviceId: null,
    });
    expect(screen.queryByLabelText("Homeserver")).not.toBeInTheDocument();
    expect(screen.queryByTestId("conversations-signin")).not.toBeInTheDocument();
  });

  it("holds the credential in memory only: it is in no browser store", async () => {
    seedHostedDevice();
    stubHostedNetwork([granted()]);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ rooms: roomsFixture(), timelines: {} }).connection);
    window.location.hash = "#conversations";

    await renderApp();
    await screen.findByTestId("conversations-list");

    expect(localStorage.getItem("duo.workspace-session")).toBeNull();
    const everything = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(everything).not.toContain("syt_hosted_1");
    expect(everything).not.toContain("matrix.example.org");
  });

  it("Settings names no address and no account id, and offers no sign-in or separate sign-out", async () => {
    seedHostedDevice();
    stubHostedNetwork([granted()]);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ rooms: roomsFixture(), timelines: {} }).connection);
    window.location.hash = "#settings/advanced";

    await renderApp();

    const workspace = await screen.findByTestId("settings-workspace");
    await waitFor(() => expect(within(workspace).getByTestId("workspace-status")).toHaveAttribute("data-state", "connected"));
    expect(workspace).not.toHaveTextContent("matrix.example.org");
    expect(workspace).not.toHaveTextContent("@acme.ada");
    expect(within(workspace).queryByRole("button")).not.toBeInTheDocument();
  });

  it("the daemon has no workspace to give (404): the note stays, nothing connects", async () => {
    seedHostedDevice();
    const net = stubHostedNetwork([{ status: 404, body: { error: { code: "workspace_not_configured", message: "no" } } }]);
    window.location.hash = "#conversations";

    await renderApp();

    expect(await screen.findByTestId("workspace-not-set-up")).toHaveTextContent("Workspace isn't set up yet");
    expect(net.sessionCalls()).toHaveLength(1);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("the person's account is still being made (503 pending): says it is setting things up, in plain words", async () => {
    seedHostedDevice();
    stubHostedNetwork([{ status: 503, body: { error: { code: "workspace_pending", message: "wait" } }, headers: { "Retry-After": "60" } }]);
    window.location.hash = "#conversations";

    await renderApp();

    const status = await screen.findByTestId("workspace-status");
    expect(status).toHaveTextContent("Setting things up…");
    expect(status).not.toHaveTextContent(/matrix|homeserver|token|server/i);
    expect(screen.queryByTestId("conversations-signin")).not.toBeInTheDocument();
  });

  it("the workspace is down (503 unavailable): says it could not reach the conversations and is trying again", async () => {
    seedHostedDevice();
    stubHostedNetwork([{ status: 503, body: { error: { code: "workspace_unavailable", message: "down" } }, headers: { "Retry-After": "60" } }]);
    window.location.hash = "#conversations";

    await renderApp();

    const status = await screen.findByTestId("workspace-status");
    expect(status).toHaveTextContent("Couldn't reach your conversations — trying again");
    expect(status).not.toHaveTextContent(/matrix|homeserver|token|server/i);
  });

  it("the daemon no longer knows this device (401): signed out, back to the sign-in front door with the reason", async () => {
    seedHostedDevice();
    stubHostedNetwork([{ status: 401, body: { error: { code: "unauthorized", message: "no" } } }]);
    window.location.hash = "#conversations";

    await renderApp();

    // The device is unpaired exactly as for any revoked device, and the front door says why.
    await waitFor(() => expect(localStorage.getItem("duo.api-config")).toBeNull());
    expect(await screen.findByText(/its device was revoked/i)).toBeInTheDocument();
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("a stored account for another server never gets the device token", async () => {
    seedHostedDevice("https://elsewhere.example.org");
    const net = stubHostedNetwork([granted()]);
    window.location.hash = "#conversations";

    await renderApp();

    expect(await screen.findByTestId("workspace-not-set-up")).toBeInTheDocument();
    expect(net.sessionCalls()).toEqual([]);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it("when the workspace stops accepting the credential, asks for a new session and connects again", async () => {
    seedHostedDevice();
    const net = stubHostedNetwork([granted(), granted()]);
    const first = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    const second = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValueOnce(first.connection).mockResolvedValueOnce(second.connection);
    window.location.hash = "#conversations";

    await renderApp();
    await screen.findByTestId("conversations-list");
    const options = vi.mocked(connect).mock.calls[0]![1] as { onSessionRejected: () => void };

    act(() => options.onSessionRejected());

    await waitFor(() => expect(vi.mocked(connect)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(connect).mock.calls[1]![0].accessToken).toBe("syt_hosted_2");
    expect(net.sessionCalls()).toHaveLength(2);
    // The daemon's copy of the refused credential was dropped before the new ask.
    expect(net.dropCalls()).toHaveLength(1);
    expect(first.connection.stop).toHaveBeenCalled();
    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
  });

  it("a first sync the workspace refuses (M_UNKNOWN_TOKEN) is answered the same way", async () => {
    seedHostedDevice();
    const net = stubHostedNetwork([granted(), granted()]);
    const refused = Object.assign(new Error("no longer accepted"), { errcode: "M_UNKNOWN_TOKEN" });
    vi.mocked(connect).mockRejectedValueOnce(refused);
    vi.mocked(connect).mockResolvedValueOnce(fakeConnection({ rooms: roomsFixture(), timelines: {} }).connection);
    window.location.hash = "#conversations";

    await renderApp();

    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    expect(net.sessionCalls()).toHaveLength(2);
    expect(net.dropCalls()).toHaveLength(1);
    expect(vi.mocked(connect).mock.calls[1]![0].accessToken).toBe("syt_hosted_2");
    // The person is never handed a sign-out button for something they did not cause.
    expect(screen.queryByTestId("workspace-error")).not.toBeInTheDocument();
  });

  it("renews the credential about an hour before it expires, under the open connection", async () => {
    seedHostedDevice();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const net = stubHostedNetwork([granted(), granted()]);
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    const renewToken = vi.fn();
    fake.connection.renewToken = renewToken;
    vi.mocked(connect).mockResolvedValue(fake.connection);
    window.location.hash = "#conversations";

    await renderApp();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    });

    expect(net.sessionCalls()).toHaveLength(2);
    expect(renewToken).toHaveBeenCalledWith("syt_hosted_2");
    // Renewed in place: no second connection, the first never stopped.
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(1);
    expect(fake.connection.stop).not.toHaveBeenCalled();
  });

  it("signing out ends the session at the workspace with its own credential, then forgets it and disconnects", async () => {
    seedHostedDevice();
    const net = stubHostedNetwork([granted()]);
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    window.location.hash = "#conversations";

    await renderApp();
    await screen.findByTestId("conversations-list");

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(net.logoutCalls()).toHaveLength(1));
    expect(net.logoutCalls()[0]).toEqual({
      url: `${HOMESERVER}/_matrix/client/v3/logout`,
      method: "POST",
      authorization: "Bearer syt_hosted_1",
    });
    // The daemon is told to forget its copy too, with the device token, at this duo's own route.
    await waitFor(() => expect(net.dropCalls()).toHaveLength(1));
    expect(net.dropCalls()[0]).toEqual({ url: workspaceSessionUrl(PAIRING), method: "DELETE", authorization: `Bearer ${DEVICE_TOKEN}` });
    await waitFor(() => expect(fake.connection.stop).toHaveBeenCalled());
    expect(localStorage.getItem("duo.api-config")).toBeNull();
    expect(screen.queryByTestId("conversations-list")).not.toBeInTheDocument();
    expect(JSON.stringify({ ...localStorage })).not.toContain("syt_hosted_1");
  });

  it("a connect that fails on its own (not a refused credential) is retried after 5s, 10s, 20s — the daemon answering in between does not reset the wait", async () => {
    seedHostedDevice();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const net = stubHostedNetwork([granted()]);
    vi.mocked(connect).mockRejectedValue(new Error("Failed to fetch"));
    window.location.hash = "#conversations";
    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    await renderApp();
    await advance(50);
    expect(net.sessionCalls()).toHaveLength(1);
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(1);
    // The person is told, plainly, and is not handed a sign-out for something they did not cause.
    expect(screen.getByTestId("workspace-status")).toHaveAttribute("data-state", "unreachable");
    expect(screen.queryByTestId("workspace-error")).not.toBeInTheDocument();
    // A plain failure is not a refused credential: nothing is dropped at the daemon.
    expect(net.dropCalls()).toHaveLength(0);

    await advance(4_900);
    expect(net.sessionCalls()).toHaveLength(1);
    await advance(1_100); // ~6s: the second ask, and a second failed connect
    expect(net.sessionCalls()).toHaveLength(2);
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(2);

    await advance(9_000); // 5s again would have asked by now; the wait is 10s
    expect(net.sessionCalls()).toHaveLength(2);
    await advance(2_000);
    expect(net.sessionCalls()).toHaveLength(3);
    expect(vi.mocked(connect)).toHaveBeenCalledTimes(3);

    await advance(19_000); // and now 20s
    expect(net.sessionCalls()).toHaveLength(3);
    await advance(2_000);
    expect(net.sessionCalls()).toHaveLength(4);
    expect(net.dropCalls()).toHaveLength(0);
  });

  it("signing out also clears a manual sign-in left in storage, which a hosted device ignores and Settings cannot clear", async () => {
    seedHostedDevice();
    seedSession();
    stubHostedNetwork([granted()]);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ rooms: roomsFixture(), timelines: {} }).connection);
    window.location.hash = "#conversations";

    await renderApp();
    await screen.findByTestId("conversations-list");
    expect(localStorage.getItem("duo.workspace-session")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(localStorage.getItem("duo.api-config")).toBeNull());
    await waitFor(() => expect(localStorage.getItem("duo.workspace-session")).toBeNull());
  });

  it("a personal daemon's manual sign-in is not touched by forgetting the pairing", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", "");
    seedPairing();
    seedSession();
    stubHostedNetwork([granted()]);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ rooms: roomsFixture(), timelines: {} }).connection);
    window.location.hash = "#conversations";

    await renderApp();
    await screen.findByTestId("conversations-list");
    fireEvent.click(screen.getByRole("button", { name: "Forget this device" }));

    await waitFor(() => expect(localStorage.getItem("duo.api-config")).toBeNull());
    // The pairing and the workspace sign-in are separate credentials: one ending leaves the other.
    expect(localStorage.getItem("duo.workspace-session")).not.toBeNull();
  });

  it("Conversations while connecting is one live region that changes text in place, with no talk of a daemon", async () => {
    seedHostedDevice();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === workspaceSessionUrl(PAIRING) ? new Promise<Response>((resolve) => (answer = resolve)) : new Response("[]", { status: 200 }),
      ),
    );
    window.location.hash = "#conversations";

    await renderApp();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    const region = screen.getByTestId("workspace-status");
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveTextContent("Connecting…");
    // A slow connect used to read "Still waiting on the daemon…": nothing a hosted person knows.
    expect(screen.queryByTestId("route-loading-slow")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/daemon/i);

    await act(async () => {
      answer(new Response(JSON.stringify({ error: { code: "workspace_unavailable", message: "down" } }), { status: 503, headers: { "Retry-After": "60" } }));
      await vi.advanceTimersByTimeAsync(0);
    });

    // The same element, new words: that is what a screen reader announces.
    expect(screen.getByTestId("workspace-status")).toBe(region);
    expect(region).toHaveTextContent("Couldn't reach your conversations");
    expect(screen.queryByTestId("route-loading")).not.toBeInTheDocument();
  });

  it("the not-set-up note is announced too: it lives inside the status region", async () => {
    seedHostedDevice();
    stubHostedNetwork([{ status: 404, body: { error: { code: "workspace_not_configured", message: "no" } } }]);
    window.location.hash = "#conversations";

    await renderApp();

    const note = await screen.findByTestId("workspace-not-set-up");
    expect(note.closest('[role="status"]')).not.toBeNull();
  });

  it("a personal daemon is unchanged: the stored sign-in connects as before, and the daemon is never asked for a session", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", "");
    seedPairing();
    seedSession();
    const net = stubHostedNetwork([granted()]);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ rooms: roomsFixture(), timelines: {} }).connection);
    window.location.hash = "#conversations";

    await renderApp();

    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    // Exactly the stored session and nothing more — no hosted options ride along.
    expect(vi.mocked(connect)).toHaveBeenCalledWith(SESSION);
    expect(net.sessionCalls()).toEqual([]);
    expect(net.logoutCalls()).toEqual([]);
  });
});

describe("#223 — naming a conversation, setting its topic, and its picture", () => {
  it("a member with permission edits the name from the Info panel, and both the header and the sidebar show it — for a colleague's own change too", async () => {
    stubDesktop();
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");
    expect(screen.getByTestId("room-header")).toHaveTextContent("project-x");

    // #223: the Info panel is the room-settings surface — open it, edit the
    // name there, same as the issue's "give it a name" asks.
    fireEvent.click(screen.getByTestId("info-toggle"));
    const panel = await screen.findByTestId("inspector");
    fireEvent.click(within(panel).getByTestId("room-settings-name-edit"));
    fireEvent.change(within(panel).getByTestId("room-settings-name-input"), { target: { value: "Project X" } });
    fireEvent.click(within(panel).getByTestId("room-settings-name-save"));

    await waitFor(() => expect(fake.connection.setRoomName).toHaveBeenCalledWith("!project-x:workspace.example", "Project X"));
    // AC2: the change shows in the conversation header AND the sidebar —
    // both read the same `rooms()` projection, invalidated after the save.
    await waitFor(() => expect(screen.getByTestId("room-header")).toHaveTextContent("Project X"));
    expect(entryFor("Project X")).toBeInTheDocument();

    // AC2, the other half: a colleague renames it from their own device.
    // The homeserver's sync delivers no "arrival" for this — the seam's own
    // ROOM_INFO_EVENT_TYPES handling (WorkspaceMatrixSeam.test.ts) turns a
    // bare m.room.name event into exactly this: a roomId with no message,
    // which still has to reach the header and the sidebar with nothing
    // done on this device at all.
    fake.renameRoomElsewhere("!project-x:workspace.example", "project-x (renamed)");
    await waitFor(() => expect(screen.getByTestId("room-header")).toHaveTextContent("project-x (renamed)"));
    expect(entryFor("project-x (renamed)")).toBeInTheDocument();
  });

  it("a member without permission sees the Info panel's name and topic, with no way to edit either", async () => {
    stubDesktop();
    seedSession();
    const readOnlyRooms = roomsFixture().map((room) =>
      room.roomId === "!project-x:workspace.example"
        ? { ...room, topic: "refunds and billing", canEdit: { name: false, topic: false, avatar: false } }
        : room,
    );
    const fake = fakeConnection({ rooms: readOnlyRooms, timelines: { "!project-x:workspace.example": [] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(screen.getByTestId("info-toggle"));
    const panel = await screen.findByTestId("inspector");
    expect(within(panel).getByTestId("room-settings-name")).toHaveTextContent("project-x");
    expect(within(panel).queryByTestId("room-settings-name-edit")).toBeNull();
    expect(within(panel).getByTestId("room-settings-topic")).toHaveTextContent("refunds and billing");
    expect(within(panel).queryByTestId("room-settings-topic-edit")).toBeNull();
    expect(within(panel).queryByTestId("room-picture-pick")).toBeNull();
  });
});

/*
 * #244: Enter sends, Shift+Enter makes a new line — the shared editor's
 * own key handling (#248's `ChatEditor`, ChatEditor.test.tsx) wired into
 * each composer. These are thin smoke tests confirming the wiring; the
 * rules themselves (IME, ⌘/Ctrl+Enter, Shift+Enter, touch) are covered
 * once, against the bare editor, in ChatEditor.test.tsx.
 */
describe("#244 — Enter sends in the conversation composer", () => {
  it("Enter sends the message and clears the field; Shift+Enter only adds a line", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    const field = screen.getByLabelText("Message project-x");
    typeInto(field, "shall we");
    pressEnter(field, { shiftKey: true });
    typeInto(field, "ship it");
    expect(fake.connection.send).not.toHaveBeenCalled();

    pressEnter(field);
    await waitFor(() => expect(fake.connection.send).toHaveBeenCalledWith("!project-x:workspace.example", "shall we\nship it"));
    expect(composerText(field)).toBe("");
  });

  it("#216: what the live shortcuts styled goes out as its markdown, literal characters untouched", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    const field = screen.getByLabelText("Message project-x");
    typeInto(field, "**ship** it, 2 * 3 times");
    // Styled in the editor as it was typed…
    expect(field.querySelector("strong")).toHaveTextContent("ship");
    pressEnter(field);
    // …and the body is the markdown source the seam turns into formatted_body (markdown.ts).
    await waitFor(() => expect(fake.connection.send).toHaveBeenCalledWith("!project-x:workspace.example", "**ship** it, 2 * 3 times"));
  });
});

describe("#244 — Enter sends in the thread composer", () => {
  it("Enter sends the reply and clears the field; Shift+Enter only adds a line", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...THREADED_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    navigate("#chat/!project-x%3Aworkspace.example/thread/%241");
    await screen.findByTestId("thread-timeline");

    const field = screen.getByLabelText("Reply in thread");
    typeInto(field, "thanks!");
    pressEnter(field, { shiftKey: true });
    expect(fake.connection.replyInThread).not.toHaveBeenCalled();

    pressEnter(field);
    await waitFor(() => expect(fake.connection.replyInThread).toHaveBeenCalledWith("!project-x:workspace.example", "$1", "thanks!"));
    expect(composerText(field)).toBe("");
  });
});
