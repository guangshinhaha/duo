import {
  ClientEvent,
  createClient,
  Direction,
  EventStatus,
  EventType,
  MatrixError,
  Method,
  MsgType,
  NotificationCountType,
  PendingEventOrdering,
  Preset,
  PushRuleKind,
  ReceiptType,
  RelationType,
  RoomEvent,
  SyncState,
  TweakName,
  type INotification,
  type INotificationsResponse,
  type MatrixClient,
  type MatrixEvent,
  type Room as MatrixRoom,
} from "matrix-js-sdk";
// #207: case- and accent-insensitive matching for the one search box's
// display-name matching — Apache-2.0, the SDK's own fold (it also strips the
// zero-width tricks a name can carry), used exactly as Element uses it
// rather than reimplemented here. Never used on a user id (see
// `matchesQuery` and `searchPeople`'s exact-id branch below): its homoglyph
// pass folds visually-similar sequences, which is right for matching a
// typed name and wrong for an id meant to resolve to one exact account.
import { normalize } from "matrix-js-sdk/lib/utils";
import { duoOwnerUserIdOf, localpartOf } from "./identity.js";
import { normalizeHomeserverUrl } from "../homeserver.js";
import { markdownToHtml } from "./markdown.js";
import {
  mentionAnchorsFrom,
  mentionLabelOf,
  partsFromBody,
  withMentionAnchors,
  type MentionAnchor,
  type MessageMention,
  type MessagePart,
} from "./mentions.js";
import { isImageType, type StagedShare } from "./sharing.js";

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
  /**
   * The homeserver's device for this credential. Null for a hosted session
   * (#127): an operator-minted credential has no device, and none is needed —
   * the client is built with no device id and end-to-end encryption is never
   * started, which is the only thing a device id is for here.
   */
  readonly deviceId: string | null;
}

/** What a room IS to the member reading the list — the shape drives how the entry reads, not just how it looks. */
export type RoomKind = "direct" | "group" | "channel";

/**
 * What may interrupt the member from one conversation (#69): everything,
 * mentions alone, or nothing. Server-side state — "nothing" is the
 * account's own push rule (the mute #63 wrote), the audible modes stand
 * in the room's account data beside it — so every device answers the
 * question the same way.
 */
export type NotificationMode = "all" | "mentions" | "nothing";

/** One member of a room besides the member themselves — the id is the fact, the name the room's claim. */
export interface RoomMemberRef {
  readonly userId: string;
  readonly name: string | null;
  /**
   * For a duo-shaped member id, the human owner's own display name — from
   * this room's membership when the owner is in it, else the workspace's
   * profile for them. Absent when neither answered: the caller falls back
   * to the id grammar's own label ("carol's duo") rather than show nothing.
   * Never present for a person: a duo's chip is attributed structurally
   * (identity.ts), never by a name anyone chose for themselves.
   */
  readonly ownerName?: string;
}

/**
 * Whether THIS member may change a group conversation's name, topic and
 * picture (#223) — each one its own power-level gate, read once from the
 * room's `m.room.power_levels` state and this member's own level
 * (`room.getMember(selfId)?.powerLevel`), so the edit controls can show
 * enabled or disabled honestly instead of attempting a call and translating
 * a predictable refusal afterwards. A homeserver that changes the room's
 * power levels between this read and the member's next edit can still
 * refuse the edit itself — that refusal is still handled, as a fallback.
 */
export interface RoomEditPermissions {
  readonly name: boolean;
  readonly topic: boolean;
  readonly avatar: boolean;
}

/**
 * One person's profile, looked up directly (#207): the homeserver's own
 * answer to "who is this id", not waited on from room membership — the way
 * to show a name, and an avatar, for someone the one search box found but
 * no shared room has introduced yet. Null from the lookup, not this shape,
 * is how a caller hears "the server won't say".
 */
export interface PersonProfile {
  readonly userId: string;
  /** The server's profile name, else the localpart — a display name is still a claim, never the id. */
  readonly name: string;
  readonly avatarUrl: string | null;
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
  /** The room's own topic (#223) — null when it has none. */
  readonly topic: string | null;
  /** The room's own picture (#223): an `mxc://` reference, the same shape every other media reference in this app carries — null when it has none. */
  readonly avatarUrl: string | null;
  /** The other joined members; the member's own id never lists. */
  readonly members: readonly RoomMemberRef[];
  /** The latest text message, by homeserver time — null when the room has never said anything. */
  readonly latest: { readonly at: number; readonly body: string } | null;
  /**
   * The room's own last-activity clock (`room.getLastActiveTimestamp()`) —
   * what the sidebar sorts by within a section. Usually tracks `latest.at`
   * but isn't the same fact: a room can stir (a join, a name change) with no
   * new word said. Optional only so a hand-built fixture elsewhere in this
   * codebase (one that predates this field) still satisfies the type; the
   * live projection always sets it.
   */
  readonly lastActiveAt?: number;
  /** The server's unread accounting: total notifications, and how many of them mention the member. */
  readonly unread: { readonly notifications: number; readonly mentions: number };
  /** The member's own mute rule for this room, held by the account — not a preference of this device. */
  readonly muted: boolean;
  /** What may interrupt from this room (#69) — the same server answer on every device; `muted` is its "nothing" half. */
  readonly notifications: NotificationMode;
  /** #223: whether this member may edit the room's name, topic and picture — read client-side so the UI never has to guess from a failed call. */
  readonly canEdit: RoomEditPermissions;
  /**
   * #220: this member explicitly flagged the room unread (MSC2867's
   * `m.marked_unread` room account data) — "come back to this", not the
   * server's own unread count, which is why it can be true even with
   * `unread.notifications` at 0. True only — absent rather than carrying an
   * explicit `false`, the same convention `RoomMemberRef.ownerName` uses for
   * "no", so an existing fixture elsewhere in this codebase still satisfies
   * the type. `markRead` clears it, wherever that's called from.
   */
  readonly markedUnread?: true;
}

/**
 * A room invite as the invitee reads it (#214): who invited, what kind of
 * room it is, and its name — enough to decide without joining first.
 * Deliberately not a `RoomSummary`: an unaccepted invite is Synapse's
 * stripped slice of room state (`invite_room_state`), not the room itself —
 * folding the two together would make `rooms()` show a room this member
 * cannot yet open, or `invites()` promise facts (a member list, a latest
 * word) that stripped state doesn't carry.
 */
export interface RoomInvite {
  readonly roomId: string;
  readonly kind: RoomKind;
  /** The room's own name — null when it has none (mirrors `RoomSummary.name`). */
  readonly name: string | null;
  /** Who sent the invite — null on the rare stripped state that doesn't say. */
  readonly inviterId: string | null;
  readonly inviterName: string | null;
}

/**
 * #219: a link's title, description and image, as the homeserver's own
 * `/preview_url` returned them (Open Graph-ish fields; absent ones read as
 * null, never as an empty string a card would render as blank space). The
 * image, when there is one, is almost always an `mxc://` reference — Synapse
 * re-hosts the page's image through its own media store rather than handing
 * the client a raw third-party URL — so it resolves through `loadMedia`
 * exactly like a shared file's thumbnail does, never fetched directly.
 */
export interface UrlPreview {
  readonly title: string | null;
  readonly description: string | null;
  readonly image: string | null;
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
 * A file shared in a conversation (#66): what every `m.file`/`m.image`
 * message carries on the wire — the name the sender gave it, the type they
 * claimed, the size they declared, and the homeserver's own stable content
 * reference (`mxc://…`, core #190's `WorkspaceFileReference`). The `image`
 * flag is the message's own msgtype (`m.image` shares render inline;
 * everything else is a file card) — never a guess from a filename.
 */
export interface SharedFile {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly url: string;
  readonly image: boolean;
}

/**
 * One message of a room timeline, projected (#64): conversation turns —
 * text (`m.text`), and shared files and images (#66: `m.file`/`m.image`)
 * — with the sender's id carried structurally so the render can tell a duo
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
  /**
   * #65: the body in parts when the message was sent with mention anchors
   * — words and mention pills, split where each pill's words sit. Null
   * when the body is plain words (or the anchors don't line up with it):
   * the render shows the plain body rather than guessing pills. A fold
   * (an edit) drops the pills — this client sends no anchors with an
   * edit, and words that moved render honestly as words.
   */
  readonly parts: readonly MessagePart[] | null;
  /**
   * #213: this turn's `formatted_body`, when it carries one
   * (`format === "org.matrix.custom.html"`) — another client's bold,
   * lists, code, quotes, tables. Absent for plain words, a share, or a
   * fold (an edit): the same cases `parts` already goes null for, since
   * both are read off the same `formatted_body`. The render sanitizes
   * this to the spec's allowed tag list before showing it — never shown
   * raw.
   */
  readonly formattedBody?: string;
  /**
   * #213: the already-resolved label for each mention anchor the
   * `formattedBody` above carries, keyed by user id — the identical
   * resolution `parts` uses (room membership for a person, the id's
   * grammar for a duo), computed once here so the formatted-HTML renderer
   * never needs the SDK's own membership lookup to show a pill correctly.
   * Absent alongside `formattedBody` when there's nothing to carry it for.
   */
  readonly mentionLabels?: Readonly<Record<string, string>>;
  /** The share this message IS, when it is one — null/absent for text. Sharing reaches people, never any corpus. */
  readonly file?: SharedFile;
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
  /**
   * #215: the message this one quotes, outside a thread — the spec's plain
   * reply relation (`m.relates_to["m.in_reply_to"]`, no `rel_type`), read
   * only when that's what it is: a thread reply's own fallback carries the
   * same key nested a level deeper (inside the thread relation), and that
   * is never read as this field — a thread already owns its replies, a
   * second "replying to" badge on top would say the same thing twice. Null
   * when the message isn't a reply, or quotes something not held in this
   * device's own copy of the conversation (`conversation`, at the render
   * site) — the quote then simply doesn't render, rather than guessing.
   */
  readonly replyToEventId: string | null;
  /**
   * #64 AC1 / #209: this device's own send, still on its way — read straight
   * from matrix-js-sdk's own local-echo state (`room.getPendingEvents()`,
   * `event.status` SENDING/QUEUED/SENT), never a second copy this client
   * invented. True until the homeserver's echo folds it into the live
   * timeline, at which point it is an ordinary row.
   */
  readonly pending?: boolean;
  /**
   * #209: the homeserver never got this message (`EventStatus.NOT_SENT`) and
   * the SDK has stopped retrying it on its own — the row stays, with its
   * words, so Retry (`WorkspaceConnection.retry`) or Cancel
   * (`WorkspaceConnection.cancel`) can act on it. Never set alongside
   * `pending`.
   */
  readonly failed?: boolean;
}

/**
 * A NEW text message arriving live (#69): who spoke (the id is the fact,
 * the name the room's claim), the words, and whether the message mentions
 * the member — the structured half the push rules read is the same half
 * an arrival reads. This is what a notification decides on; the surfaces
 * that only refresh ignore it and read the projection like everyone else.
 */
export interface LiveArrival {
  readonly senderId: string;
  readonly senderName: string;
  readonly body: string;
  readonly mentionsMe: boolean;
}

/** One line of the words around a search hit — who said it (by id, with the name the workspace holds for them) and what. */
export interface SearchContextLine {
  readonly senderId: string;
  readonly senderName: string;
  readonly body: string;
}

/**
 * One result of a message search (#70): a text message somewhere in the
 * member's conversations, with the conversation it was said in, who said it
 * — the id carried structurally, so a duo's answer is attributed from the
 * user-id grammar like every other message (#60) — and the few lines said
 * around it. This is the WORKSPACE's search, the shared one: what people and
 * duos said in conversations the member is in. It is never the corpus search
 * (#46), which is private, on the owner's Mac, and reaches this type by no
 * road.
 */
export interface MessageSearchHit {
  readonly eventId: string;
  readonly roomId: string;
  readonly senderId: string;
  /** The room's own record of the sender's name, else the search's profile, else the localpart — a claim; the id is the fact. */
  readonly senderName: string;
  readonly body: string;
  /** The homeserver's epoch-ms timestamp. */
  readonly originServerTs: number;
  /** The root this hit answers inside a thread — null for a message in the main flow. Opening a threaded hit lands in its thread. */
  readonly threadRootEventId: string | null;
  /** The lines said just before and just after, each in the order it was said. */
  readonly context: { readonly before: readonly SearchContextLine[]; readonly after: readonly SearchContextLine[] };
}

/** One page of a message search: the hits, and the homeserver's token for the next page (null when this was the last). */
export interface MessageSearchPage {
  readonly hits: readonly MessageSearchHit[];
  readonly next: string | null;
}

/**
 * Where the "New messages" line belongs in a room's LOADED window (#212),
 * measured from a frozen read-marker anchor (`WorkspaceConnection.readMarker`)
 * against the homeserver's own event order — never a row index, so a
 * reaction or an edit sitting at the anchor doesn't miscount:
 *  - `found`: the first row the main flow would render after the anchor.
 *  - `none`: nothing unread to show — either the anchor already covers the
 *    newest loaded message, or there is no anchor at all (no marker has
 *    ever been set and this account has no read receipt here either).
 *  - `unknown`: the anchor event is older than anything paginated into this
 *    room yet. #211 is how a caller goes looking for it — `loadOlder`,
 *    bounded, with "jump to the top" a reasonable fallback if it doesn't
 *    turn up quickly.
 */
export type UnreadBoundary =
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly eventId: string }
  | { readonly kind: "unknown" };

/**
 * One place the member was mentioned (#222): a message that named them,
 * wherever it was said — the homeserver's own highlight-tier notification
 * (`GET /notifications`, `only=highlight`), the same push-rule signal a
 * room's own mention badge counts (`RoomSummary.unread.mentions`). This is
 * NOT "Waiting on you": that is the duo's drafts awaiting the owner's
 * decision; this is raw `@mentions` of the member themselves, the two
 * never share a row. Projected like a timeline message — sender attributed
 * by id, with the same fallback to the localpart — so a mentions list and
 * a room's own timeline never disagree about who said what.
 */
export interface MentionHit {
  readonly eventId: string;
  readonly roomId: string;
  readonly senderId: string;
  /** The room's own record of the sender's name, else the localpart — a claim; the id is the fact (#60). */
  readonly senderName: string;
  readonly body: string;
  readonly originServerTs: number;
  /**
   * The homeserver's own record of whether this account's read receipt has
   * passed the event — informational only. Dismissing a mention from the
   * view is a separate, local choice (shell/mentions.ts): sending a receipt
   * at an arbitrary past event is not a verb this seam offers.
   */
  readonly read: boolean;
  /** The thread this mention answers inside, if any — null in the main flow. Opening a threaded mention lands in its thread, like a search hit (#70). */
  readonly threadRootEventId: string | null;
}

/**
 * The workspace refused this session's credential (`M_UNKNOWN_TOKEN`): it
 * expired, or was signed out elsewhere. Carries the homeserver's own errcode so
 * a caller that mocks this module can still recognise it by shape.
 */
export class SessionRejectedError extends Error {
  readonly errcode = "M_UNKNOWN_TOKEN";

  constructor() {
    super("The workspace no longer accepts this sign-in.");
    this.name = "SessionRejectedError";
  }
}

/** What a caller may hear from a held connection besides its data. */
export interface ConnectOptions {
  /** The workspace answered `M_UNKNOWN_TOKEN` after the connection was up (the credential expired): the sync has stopped. Called once. */
  readonly onSessionRejected?: () => void;
}

/** The held workspace connection: rooms, timelines, the message verbs, and live arrivals. */
export interface WorkspaceConnection {
  /**
   * Swaps in a renewed credential without dropping the connection (#127: a
   * hosted session is refreshed before it expires, and the conversation on
   * screen must not blink). Absent on a stub.
   */
  renewToken?(accessToken: string): void;
  /** Whose connection this is — the member's own user id, the way the surface tells its own messages (editable, deletable) from everyone else's. */
  readonly userId: string;
  /** The member's conversations, ordered by latest activity — the server's answer, not this device's cache of it. */
  rooms(): Promise<readonly RoomSummary[]>;
  timeline(roomId: string): Promise<readonly RoomMessage[]>;
  /**
   * The window of a conversation around one event (#70) — what the
   * homeserver's `/context` holds around it, projected exactly like a
   * timeline. This is how a search hit is landed at in context even when
   * it is older than anything the live timeline carries. Empty for a
   * conversation this account is not in.
   */
  timelineAt(roomId: string, eventId: string): Promise<readonly RoomMessage[]>;
  /**
   * Extends a room's loaded window backward by one page of older messages
   * (#211): matrix-js-sdk's own `client.scrollback`, which paginates the
   * room's live timeline directly — the same timeline `timeline()` already
   * reads (`room.getLiveTimeline().getEvents()`) — so nothing here keeps a
   * second copy of history. `loadedMore` is false when the page brought in
   * nothing new (a connection hiccup, or the room was already fully loaded);
   * `atStart` is true once the homeserver's own backward pagination token
   * runs out — the conversation's very first message has been reached
   * (#211 AC2), not a guess from how many pages came back empty. A room
   * this account has left, or hasn't loaded at all yet, answers as if it
   * were already at the beginning — there is nothing further back a caller
   * could usefully ask for.
   */
  loadOlder(roomId: string): Promise<{ readonly loadedMore: boolean; readonly atStart: boolean }>;
  /**
   * Searches what was said (#70): the homeserver's own `POST /search` over
   * message bodies, in the member's words. Membership scoping is the
   * homeserver's rule — the request chooses no rooms — and the projection
   * refuses a result from a conversation this account is not joined to, so
   * nothing of another conversation can reach the surface. `next` is the
   * homeserver's page token. A refusal rejects; it is never an empty page.
   * This is the shared search. The corpus search (#46, private, on the
   * owner's Mac) is a different thing, served by a different module.
   */
  searchMessages(query: string, next?: string): Promise<MessageSearchPage>;
  /**
   * Every place the member was mentioned, across every conversation (#222):
   * the homeserver's own highlight notifications, newest first — re-sorted
   * here rather than trusted off the wire, since the spec does not pin an
   * order on the response. This is the raw `@mention` signal, not the
   * duo's drafts ("Waiting on you" is a different list, kept separate on
   * purpose — see matrix.ts's `MentionHit`).
   */
  mentions(): Promise<readonly MentionHit[]>;
  /**
   * Sends a text message (#65): the body says what people read; when the
   * message addresses members, the seam builds the spec's full mention
   * shape from their ids and labels — each mention's addressed words ride
   * `formatted_body` as a matrix.to permalink anchor (a duo's derived
   * from its user id, never from the caller's label), and the ids ride
   * `m.mentions.user_ids`, the structured half the homeserver's push
   * rules read — which is the whole of "notified according to their
   * settings" from the sender's side. Every send carries `m.mentions`
   * (empty when nothing is mentioned): the spec recommends it on each
   * event so the legacy display-name push rules can't fire on a message
   * that merely contains a name.
   *
   * #215: `replyToEventId`, when given, rides the spec's plain reply
   * relation (`m.relates_to["m.in_reply_to"]`) — a quote outside any
   * thread. It composes with mentions on the same event: a reply can
   * still address someone.
   */
  send(roomId: string, body: string, mentions?: readonly MessageMention[], replyToEventId?: string): Promise<void>;
  /**
   * #66: uploads bytes to the homeserver's media store and answers the
   * stable reference the file message will carry. The upload is the share's
   * people half — it stores bytes for the room; nothing about it reaches any
   * daemon. `onProgress` hears bytes moved, for a visible progress render.
   */
  uploadFile(file: StagedShare, onProgress?: (sent: number, total: number) => void): Promise<SharedFile>;
  /**
   * Sends the share itself: an `m.file`/`m.image` message carrying the
   * name, declared type, declared size, and the upload's `mxc://` reference
   * — the wire shape core #190's association convention reads (the asker's
   * own contiguous file messages immediately preceding their question).
   */
  sendFile(roomId: string, file: SharedFile): Promise<void>;
  /**
   * The bytes of a shared file, fetched as this member: the homeserver's
   * authenticated media endpoint (MSC3916) wants the member's token in a
   * header, which an `<img>` or `<a href>` cannot send — so the seam does
   * the fetch and the render holds the blob. Null when the reference can't
   * translate or the homeserver won't serve it: the card keeps its facts
   * and says so; nothing is faked.
   */
  loadMedia(url: string): Promise<Blob | null>;
  /**
   * #219: a link's preview metadata, when the homeserver has it — called
   * only when the viewing member opted in (urlPreviewPrefs.ts), because the
   * homeserver fetches the linked page itself to build this answer. Null
   * covers every way there is nothing to show: the link has no
   * preview-able metadata, the homeserver refuses to preview it, or the
   * request fails outright — a caller never needs to tell these apart, and
   * nothing here throws for the member to see as an error.
   */
  getUrlPreview(url: string): Promise<UrlPreview | null>;
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
   * #209: tries a failed send again — the same row, the same words. Acts on
   * matrix-js-sdk's own local echo (`client.resendEvent`); a row that isn't
   * failed, or has already gone, costs nothing to ask again.
   */
  retry(roomId: string, eventId: string): Promise<void>;
  /**
   * #209: takes a failed send back — the row goes, nothing is retried.
   * Synchronous: cancelling a local echo (`client.cancelPendingEvent`)
   * never reaches the homeserver, so there is nothing to await.
   */
  cancel(roomId: string, eventId: string): void;
  /**
   * Receipts the room's latest event — the member's read position, held by
   * the account, so every device reads the conversation as read (#63). This
   * is unconditional on open, same as it always was. #220: also clears an
   * explicit "mark unread" (`RoomSummary.markedUnread`) when one stands —
   * reading the conversation, however that happened (opening it, or "Mark
   * as read" from the list), is what that flag means to undo. #212's own
   * read marker (`readMarker`/`advanceReadMarker`, below) is a separate,
   * more careful fact — this verb neither reads nor writes it.
   */
  markRead(roomId: string): Promise<void>;
  /**
   * #220: flags the conversation unread with nothing new having arrived —
   * MSC2867's `m.marked_unread` room account data, the spec's own "come
   * back to this" convention, held by the account like every other read
   * state here, so it follows the member to their other devices. Idempotent,
   * the same as every other account-data write in this seam.
   */
  markUnread(roomId: string): Promise<void>;
  /**
   * This member's place in this room (#212): `m.fully_read`'s event id, or
   * — the one time no marker has ever been set here — this account's own
   * read receipt position, so a room opened for the first time since #212
   * shipped still anchors from somewhere real rather than nothing. Null
   * when neither exists (nobody, on any device, has ever read this room).
   *
   * Meant to be read ONCE per room-open and held by the caller: reading it
   * again mid-session would drift as this device's own receipt send
   * (`markRead`, unconditional on open) and this device's own marker
   * advances (`advanceReadMarker`, below) land — exactly the "not just by
   * opening it" #212 AC3 asks for. `unreadBoundaryFrom` is what a caller
   * asks, over and over as the window changes, using the anchor this
   * answered once.
   */
  readMarker(roomId: string): string | null;
  /**
   * Where the "New messages" line belongs (#212), measured from an anchor
   * event id a caller froze earlier (`readMarker`) against whatever this
   * room has loaded right now — see `UnreadBoundary`. Cheap and synchronous:
   * a caller may ask again after every page `loadOlder` brings in, without
   * a second network trip.
   */
  unreadBoundaryFrom(roomId: string, anchorEventId: string): UnreadBoundary;
  /**
   * Moves this member's read marker (#212): `m.fully_read`, the spec's own
   * place for "read up to here" — distinct from the read receipt `markRead`
   * sends (which still fires unconditionally on open, clearing the
   * sidebar's unread count the same as always). This is the ONE door that
   * moves it, and a caller is only meant to call it once the member has
   * actually had the event in view for a beat — never just because the
   * conversation was opened (#212 AC3).
   */
  advanceReadMarker(roomId: string, eventId: string): Promise<void>;
  /**
   * Names a group conversation (#223): `m.room.name`, the way every member's
   * sidebar and header read it. Gated client-side by `RoomSummary.canEdit`;
   * a homeserver refusal (e.g. a power level that changed since) still
   * throws, for the caller to show as a fallback.
   */
  setRoomName(roomId: string, name: string): Promise<void>;
  /** Sets a group conversation's topic (#223): `m.room.topic`, same gating as the name. */
  setRoomTopic(roomId: string, topic: string): Promise<void>;
  /**
   * Sets a group conversation's picture (#223): an `m.room.avatar` state
   * event pointing at an upload already on the homeserver's media store —
   * the picture rides the identical `uploadFile()` door a shared image
   * does (#66), validated by the same size and type rules, and this just
   * states the result as the room's own.
   */
  setRoomAvatar(roomId: string, mxcUrl: string): Promise<void>;
  /**
   * Creates a direct conversation with a workspace user (a person or a
   * colleague's duo) and answers its room id. #207: reuses a DM already
   * open with that person (the account's own `m.direct` record of it)
   * rather than opening a second one — the directory and the one search
   * box can both lead here, and choosing someone twice must land in the
   * same conversation, not a duplicate of it.
   */
  startDirect(userId: string): Promise<string>;
  /**
   * Creates a named, private group conversation (#214) and answers its room
   * id — `preset: private_chat`, invite-only, the member its sole member
   * until they invite people (now or later, through `invite`). There is no
   * "channel" counterpart here: a channel "findable in the org" needs an
   * org-scoped room directory, and the only directory Matrix has is the
   * homeserver's own room directory, which the org wall refuses every
   * member's attempt to publish into (`M_FORBIDDEN`, unconditionally —
   * `deploy/synapse/modules/duo_org_wall/rules.py`'s `may_publish`). Rather
   * than guess at a join rule that might leak a room across orgs, this seam
   * offers group rooms only until that gap is closed server-side.
   */
  createRoom(name: string, topic: string): Promise<string>;
  /**
   * Invites a workspace user into an existing room (#214) — unlike
   * `startDirect`, this adds someone to a room that already exists, during
   * its creation or long after. The org wall refuses an invite across
   * organisations with its own short, person-safe sentence (`M_FORBIDDEN`,
   * "Invites across organisations are not allowed."); this surfaces exactly
   * that sentence rather than inventing one, so the UI shows what the
   * server decided, never a client-side guess about who belongs where.
   */
  invite(roomId: string, userId: string): Promise<void>;
  /**
   * The invites waiting on this member's decision (#214): every room the
   * homeserver has sent an invite for that isn't joined or declined yet.
   * Reads from Synapse's stripped `invite_room_state` — what an invited
   * (not-yet-joined) client is handed — so this answers before `joinRoom`.
   */
  invites(): Promise<readonly RoomInvite[]>;
  /** Accepts a pending invite (#214): joins the room the invite named. Declining is `leave` — Matrix models both the same way. */
  joinRoom(roomId: string): Promise<void>;
  /** Leaves a conversation — the homeserver drops the membership, for every device at once. */
  leave(roomId: string): Promise<void>;
  /**
   * Sets what may interrupt from one conversation (#69): "nothing" is the
   * account's own push rule (the mute #63 wrote), the audible modes stand
   * in the room's account data — server-side state, the same on every
   * device. Idempotent: a mode another device already wrote costs nothing
   * to write again.
   */
  setNotificationMode(roomId: string, mode: NotificationMode): Promise<void>;
  /**
   * Searches the workspace's people directory (#207: the one search box's
   * People section, and the pencil dialog before it): three sources merged
   * and de-duplicated by user id — the members of rooms the member is
   * already in (local, instant, no network), the homeserver's user
   * directory (`searchUserDirectory`, membership-scoped there — Synapse
   * runs with `search_all_users: false`, so a colleague with no shared room
   * is invisible to it), and, only when the query is itself shaped like a
   * full user id (`@local:server`), an exact `getProfileInfo` lookup — the
   * one way to address someone the directory can't find because no room
   * has introduced you yet. An empty query answers nothing; this is a
   * search, not a roster.
   */
  searchPeople(query: string): Promise<readonly { userId: string; name: string }[]>;
  /**
   * Conversations matching a query (#207's Conversations section): local to
   * what this client already has — the room's own name, and for a direct
   * conversation, the other person's — never a network request, ranked by
   * latest activity. An empty query answers the member's most recent
   * conversations, for the box's empty state.
   */
  findRooms(query: string): Promise<readonly RoomSummary[]>;
  /**
   * One person's profile, fetched directly (#207's profile panel): name and
   * avatar from the homeserver's own record, not waited on from room
   * membership. Null when the server won't answer for this id — no shared
   * room (the org wall, #235, refuses it the same way) or an id that
   * doesn't exist.
   */
  getProfile(userId: string): Promise<PersonProfile | null>;
  /**
   * One subscription for the app's lifetime; the return value unsubscribes.
   * The arrival half (#69) rides only for a NEW text message — sender,
   * words, and whether it mentions the member, which is what a
   * notification decides on. An amendment or a reaction is room news,
   * not message news: the roomId arrives, the arrival doesn't — and so is
   * this device's own send changing status (#209: queued, sent, failed,
   * retried, cancelled), which rides the same arrival-less way.
   */
  subscribe(handler: (roomId: string, arrival?: LiveArrival) => void): () => void;
  /** Stops the connection. Idempotent. */
  stop(): Promise<void>;
}

export { normalizeHomeserverUrl };

/** The device name the homeserver shows beside this sign-in. */
const DEVICE_DISPLAY_NAME = "Duo";

/** How long `connect` waits for the first completed sync before giving up on the homeserver. */
const FIRST_SYNC_TIMEOUT_MS = 20_000;

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

/**
 * Turns whatever the homeserver or the network did to a share into the
 * reason the member reads (#66 AC4): the workspace's own upload limit is
 * named as such (this client can't know its size — the homeserver owns that
 * door, beside this app's own share limits), any other refusal carries the
 * workspace's own words, and no answer at all is a connection problem.
 */
function shareFailure(error: unknown, name: string): Error {
  if (error instanceof MatrixError) {
    if (error.errcode === "M_TOO_LARGE") {
      return new Error(`${name} is over the workspace's own upload limit.`);
    }
    return new Error(`The workspace said: ${error.message}${/[.!?]$/.test(error.message) ? "" : "."}`);
  }
  return new Error("The connection dropped — we couldn't reach the workspace.");
}

/**
 * Turns a room verb's refusal into the reason the member reads (#214): the
 * workspace's own words when it has them — the org wall's refusals (a
 * cross-org invite, a public room, a directory publish) are already a
 * short, person-safe sentence by design (`rules.py`'s module docstring),
 * so this frames rather than rewrites them — and a connection problem when
 * there is no answer at all.
 */
function roomFailure(error: unknown): Error {
  if (error instanceof MatrixError) {
    return new Error(`The workspace said: ${error.message}${/[.!?]$/.test(error.message) ? "" : "."}`);
  }
  return new Error("The connection dropped — we couldn't reach the workspace.");
}

/** Resolves when the first sync completes — the room state the homeserver held (including what arrived while away) has caught up. */
function firstPreparedSync(client: MatrixClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("The workspace didn't answer in time — check the address and try again."));
    }, FIRST_SYNC_TIMEOUT_MS);
    const onSync = (state: SyncState, _previous: SyncState | null, data?: { error?: unknown }): void => {
      if (state === SyncState.Error && isTokenRejection(data?.error)) {
        // The sync stops itself on this answer and would never reach Prepared:
        // say so now instead of after the timeout.
        cleanup();
        reject(new SessionRejectedError());
        return;
      }
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
    // #209: Detached pending-event ordering keeps this device's own
    // in-flight sends out of the live timeline and in `room.getPendingEvents()`
    // instead — the projection folds them back in itself (`timelineOf`),
    // which is what lets a send render the instant it's handed to the SDK,
    // synchronously, before any network answer.
    client.startClient({ lazyLoadMembers: true, pendingEventOrdering: PendingEventOrdering.Detached });
  });
}

/** The homeserver's "this credential is no longer valid" answer, however the SDK wrapped it. */
function isTokenRejection(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { errcode?: unknown }).errcode === "M_UNKNOWN_TOKEN";
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
  /** #215: a plain reply's target — present with no `rel_type` for a reply outside a thread; a thread's own fallback nests this one level deeper, under the thread relation, which is a different shape entirely. */
  readonly "m.in_reply_to"?: { readonly event_id?: string };
}

function relationOf(event: MatrixEvent): Relation | undefined {
  return (event.getContent()?.["m.relates_to"] ?? undefined) as Relation | undefined;
}

/**
 * This device's own sends still in flight (#209): matrix-js-sdk's own
 * local-echo list, read defensively — a room the projection builds from a
 * search window, or a seam fixture that never asked for Detached ordering,
 * has none, and that is never this projection's problem to raise.
 */
function pendingEventsOf(room: MatrixRoom): readonly MatrixEvent[] {
  try {
    return room.getPendingEvents();
  } catch {
    return [];
  }
}

/**
 * #209: whether an event is this device's own send still on its way, or one
 * the homeserver never got — read straight from matrix-js-sdk's own
 * `event.status`, never a second, hand-rolled copy of it. A confirmed event
 * (synced, not a local echo) carries no status at all, so both are false.
 */
function localEchoFlagsOf(event: MatrixEvent): { pending: boolean; failed: boolean } {
  const status = event.status;
  return {
    pending: status === EventStatus.SENDING || status === EventStatus.QUEUED || status === EventStatus.ENCRYPTING || status === EventStatus.SENT,
    failed: status === EventStatus.NOT_SENT,
  };
}

/**
 * #212: whether an event is a row the MAIN FLOW would render — `timelineOf`'s
 * own rule for what counts as a message, minus thread replies (which render
 * under their root's preview, never as a main-flow row), re-asked here
 * rather than guessed, so the unread line's placement and the rows it sits
 * between can never disagree about what's on screen. A struck message still
 * counts (the row stays, striking only its words); a struck EDIT doesn't
 * (it was never a row of its own); and a replacement counts as nothing of
 * its own either, the same way `timelineOf`'s first pass treats it.
 */
function isMainFlowRow(event: MatrixEvent): boolean {
  if (event.getType() !== EventType.RoomMessage) {
    return false;
  }
  const relation = relationOf(event);
  if (relation?.rel_type === RelationType.Thread) {
    return false;
  }
  if (event.isRedacted()) {
    return relation?.rel_type !== RelationType.Replace;
  }
  if (relation?.rel_type === RelationType.Replace) {
    return false;
  }
  const msgtype = event.getContent()?.msgtype;
  return msgtype === MsgType.Text || msgtype === MsgType.File || msgtype === MsgType.Image;
}

/**
 * The timeline projection #64's message surface reads: same-sender
 * replacements fold into the base they amend (a stranger's edit is a claim,
 * not a change), reactions aggregate under their target and key with the
 * member's own marked, thread replies carry their root's id out of the main
 * flow, and a redaction keeps the row while striking the words.
 */
function timelineOf(client: MatrixClient, roomId: string, around?: readonly MatrixEvent[]): readonly RoomMessage[] {
  const room = client.getRoom(roomId);
  if (!room) {
    return [];
  }
  // #70: the live timeline, or — landing at a search hit — the window the
  // homeserver's /context holds around it. One projection either way. The
  // live view also folds in this device's own sends still in flight (#209):
  // matrix-js-sdk's own local-echo list (Detached ordering keeps these out
  // of the live timeline proper), appended after it the way they were said
  // — a context window never carries them, there being nothing "in flight"
  // about history.
  const events = around ?? [...room.getLiveTimeline().getEvents(), ...pendingEventsOf(room)];
  const nameOf = (senderId: string): string => {
    const member = room.getMember(senderId);
    return nonIdName(member?.rawDisplayName ?? member?.name, senderId) ?? localpartOf(senderId);
  };
  // #213: a turn's formatted half, read only under the spec's own gate —
  // `format` must say so, and `formatted_body` must actually be the string
  // it promises. Absent for anything else (a share's content never carries
  // either), so the render falls back to the plain body honestly rather
  // than guessing at a shape that isn't there.
  const formattedBodyOf = (content: Record<string, unknown>): string | undefined =>
    content?.format === "org.matrix.custom.html" && typeof content?.formatted_body === "string" ? content.formatted_body : undefined;
  // #65: the pills the message was sent with, read from its formatted
  // body's matrix.to user anchors. A person's label prefers the room's own
  // record of their name (membership), else the anchor's text minus its
  // addressing "@" — the display name as of sending, the spec's own
  // guidance for anchor text. A duo's label is always the grammar's,
  // whatever the anchor claimed.
  const labelOfAnchor = (anchor: MentionAnchor): string => {
    const member = room.getMember(anchor.userId);
    return mentionLabelOf(anchor.userId, nonIdName(member?.rawDisplayName ?? member?.name, anchor.userId) ?? anchor.text.replace(/^@/, ""));
  };
  const partsOfEvent = (body: string, formattedBody: string | undefined): readonly MessagePart[] | null =>
    partsFromBody(body, mentionAnchorsFrom(formattedBody), labelOfAnchor);
  // #213: the same anchors' labels, keyed by user id, for the formatted-HTML
  // renderer — it reads `formatted_body` itself (sanitized) and needs a
  // pill's label without reaching back into the SDK's membership, which
  // only this seam may import. Absent when there's nothing to key (no
  // anchors) rather than an empty object for every plain-formatted turn.
  const mentionLabelsOf = (formattedBody: string | undefined): Readonly<Record<string, string>> | undefined => {
    const anchors = mentionAnchorsFrom(formattedBody);
    if (anchors.length === 0) {
      return undefined;
    }
    const labels: Record<string, string> = {};
    for (const anchor of anchors) {
      labels[anchor.userId] = labelOfAnchor(anchor);
    }
    return labels;
  };

  // Pass one — the bases: every conversation turn (text, and a shared
  // file or image) in timeline order, with same-sender replacements folded
  // into the base they amend.
  interface Base {
    msgtype: string;
    senderId: string;
    senderName: string;
    body: string;
    parts: readonly MessagePart[] | null;
    formattedBody: string | undefined;
    mentionLabels: Readonly<Record<string, string>> | undefined;
    file: SharedFile | undefined;
    ts: number;
    edited: boolean;
    redacted: boolean;
    threadRootEventId: string | null;
    replyToEventId: string | null;
    pending: boolean;
    failed: boolean;
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
        msgtype: MsgType.Text,
        senderId,
        senderName: nameOf(senderId),
        body: "",
        parts: null,
        formattedBody: undefined,
        mentionLabels: undefined,
        file: undefined,
        ts: event.getTs(),
        edited: false,
        redacted: true,
        threadRootEventId: null,
        replyToEventId: null,
        // A redaction only ever strikes a confirmed event — never one still
        // on its way, so the local-echo flags are moot here.
        pending: false,
        failed: false,
      });
      continue;
    }
    const msgtype = event.getContent()?.msgtype;
    const isShare = msgtype === MsgType.File || msgtype === MsgType.Image;
    if (msgtype !== MsgType.Text && !isShare) {
      continue;
    }
    if (relation?.rel_type === RelationType.Replace) {
      // A replacement is not a row: it rewrites the base it points at, in
      // place — and only when the sender is the base's own author, and the
      // new content is the same kind of turn the base was (an edit amends;
      // it never converts a text into a share or a share into a text). For
      // a share the amendment moves the label only — the reference and the
      // facts it declared stand (core #190: an edited file message updates
      // its body/label, nothing else).
      const targetId = relation.event_id;
      const base = targetId !== undefined ? bases.get(targetId) : undefined;
      const newContent = event.getContent()?.["m.new_content"] as { msgtype?: string; body?: string } | undefined;
      const newBody = newContent?.body;
      if (
        base &&
        !base.redacted &&
        targetId !== undefined &&
        newBody !== undefined &&
        senderId === base.senderId &&
        newContent?.msgtype === base.msgtype
      ) {
        bases.set(targetId, {
          ...base,
          body: String(newBody),
          // The fold keeps the replacement's words and drops the pills:
          // this client sends no anchors with an edit, and words that
          // moved render honestly as words. The formatted half goes with
          // them — the base's old `formatted_body` would otherwise outlive
          // the words it was shaped for, showing stale formatting over the
          // edit's plain ones.
          parts: null,
          formattedBody: undefined,
          mentionLabels: undefined,
          file: base.file === undefined ? undefined : { ...base.file, name: String(newBody) },
          edited: true,
        });
      }
      continue;
    }
    const content = event.getContent() as
      | {
          body?: unknown;
          format?: unknown;
          formatted_body?: unknown;
          filename?: unknown;
          url?: unknown;
          info?: { mimetype?: unknown; size?: unknown };
        }
      | undefined;
    const body = String(content?.body ?? "");
    // #213: a share's content never carries `formatted_body` for its own
    // caption today — only a text turn's formatted half is read.
    const formattedBody = isShare ? undefined : formattedBodyOf(content ?? {});
    bases.set(event.getId() ?? "", {
      msgtype: msgtype as string,
      senderId,
      senderName: nameOf(senderId),
      body,
      // #65: a share's label carries no pills — only a text turn has parts.
      parts: isShare ? null : partsOfEvent(body, formattedBody),
      formattedBody,
      mentionLabels: isShare ? undefined : mentionLabelsOf(formattedBody),
      // A share's facts are the sender's own declarations, carried as
      // declared — the homeserver owns the reference; the client asserts
      // nothing about either.
      file: isShare
        ? {
            name: typeof content?.filename === "string" && content.filename.length > 0 ? content.filename : body,
            mimeType: typeof content?.info?.mimetype === "string" ? content.info.mimetype : "",
            size: typeof content?.info?.size === "number" ? content.info.size : 0,
            url: typeof content?.url === "string" ? content.url : "",
            image: msgtype === MsgType.Image,
          }
        : undefined,
      ts: event.getTs(),
      edited: false,
      redacted: false,
      threadRootEventId: relation?.rel_type === RelationType.Thread && relation.event_id !== undefined ? relation.event_id : null,
      // #215: a plain reply carries the relation with no `rel_type` at
      // all — a thread reply's `rel_type` is `m.thread`, an edit's is
      // `m.replace` (handled above, never reaching here), so "no
      // rel_type, but an in-reply-to" is unambiguously this and nothing
      // else.
      replyToEventId:
        relation?.rel_type === undefined && typeof relation?.["m.in_reply_to"]?.event_id === "string"
          ? relation["m.in_reply_to"].event_id
          : null,
      ...localEchoFlagsOf(event),
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
      parts: base.parts,
      formattedBody: base.formattedBody,
      mentionLabels: base.mentionLabels,
      file: base.file,
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
      replyToEventId: base.replyToEventId,
      pending: base.pending ? true : undefined,
      failed: base.failed ? true : undefined,
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
 * The power level a room requires to send a state event of this type: the
 * event's own entry in `m.room.power_levels`, else the room's
 * `state_default`, else the spec's own default (50) — the same fallback
 * chain the homeserver itself applies when deciding whether to accept the
 * event, so this client's answer agrees with the server's.
 */
function requiredPowerLevelFor(content: { events?: Record<string, number>; state_default?: number } | undefined, eventType: string): number {
  return content?.events?.[eventType] ?? content?.state_default ?? 50;
}

/**
 * #223: whether THIS member may send each of the three state events a group
 * conversation's name, topic and picture ride on — read from the room's own
 * `m.room.power_levels` and this member's own level. No power-levels event
 * at all is read as the spec's defaults (a 50 state default, a 0 member
 * level absent an override), which is "cannot edit" for anyone the room
 * hasn't explicitly raised — the safe reading when the state is missing,
 * same as a server would apply it.
 */
function editPermissionsOf(room: MatrixRoom, selfId: string): RoomEditPermissions {
  const content = room.currentState?.getStateEvents(EventType.RoomPowerLevels, "")?.getContent() as
    | { events?: Record<string, number>; state_default?: number }
    | undefined;
  const myLevel = room.getMember(selfId)?.powerLevel ?? 0;
  return {
    name: myLevel >= requiredPowerLevelFor(content, EventType.RoomName),
    topic: myLevel >= requiredPowerLevelFor(content, EventType.RoomTopic),
    avatar: myLevel >= requiredPowerLevelFor(content, EventType.RoomAvatar),
  };
}

/**
 * Records a room as direct with the other person, under the account's own
 * `m.direct` data — merged with whatever is already there (another device's
 * DMs, or this one's earlier ones), never overwritten. Idempotent: calling
 * it again for a pairing already on record costs nothing.
 */
async function writeDirectRoom(client: MatrixClient, otherUserId: string, roomId: string): Promise<void> {
  const content = (client.getAccountData("m.direct")?.getContent() as Record<string, readonly string[]> | undefined) ?? {};
  const existing = content[otherUserId] ?? [];
  if (existing.includes(roomId)) {
    return;
  }
  await client.setAccountData("m.direct", { ...content, [otherUserId]: [...existing, roomId] });
}

/**
 * #208: `m.direct` isn't written for us by the SDK or the homeserver — a
 * room this account was invited to as a direct conversation (the invite's
 * own `is_direct` flag, which is what `getDMInviter()` reads back) stays
 * off the account's `m.direct` record even once joined, unless something
 * writes it. This backfills that record for every joined room the SDK can
 * still tell was such an invite, so a DM reads as one from the first list
 * read after joining — no second device, no second sync, needed.
 */
async function backfillMissingDirectRecords(client: MatrixClient, rooms: readonly MatrixRoom[]): Promise<Set<string>> {
  const directIds = directRoomIdsOf(client);
  for (const room of rooms) {
    if (directIds.has(room.roomId) || room.getMyMembership() !== "join") {
      continue;
    }
    const inviter = room.getDMInviter();
    if (!inviter) {
      continue;
    }
    await writeDirectRoom(client, inviter, room.roomId);
    directIds.add(room.roomId);
  }
  return directIds;
}

/**
 * Asks the SDK to load this room's membership if `lazyLoadMembers` (this
 * seam's `connect()`) left it unfetched — best-effort: a room whose
 * membership can't be loaded (offline, an older server) still renders with
 * whatever names are already known, never a blocked list.
 */
async function ensureMembersLoaded(room: MatrixRoom): Promise<void> {
  try {
    await room.loadMembersIfNeeded();
  } catch {
    // Best-effort: the names this call would have improved just stay
    // whatever they already were.
  }
}

/**
 * A member's own claimed name — never the user id itself. `lazyLoadMembers`
 * (this seam's `connect()`) means a membership event can be missing when
 * this is read, which is exactly what the SDK hands back as a "name": the
 * id, unchanged. Treating that as "no name" and falling back the same way a
 * truly blank record would is what keeps a raw id off the screen.
 */
function nonIdName(candidate: string | null | undefined, userId: string): string | null {
  return candidate && candidate !== userId ? candidate : null;
}

/** The room's own explicit name — null when none was set. Never `room.name`: the SDK always fills that in (a generated name from members when there's no `m.room.name`), which is exactly the fact the sidebar needs told apart from a real one (#208). */
function realRoomNameOf(room: MatrixRoom): string | null {
  const content = room.currentState.getStateEvents("m.room.name", "")?.getContent() as { name?: unknown } | undefined;
  const name = typeof content?.name === "string" ? content.name.trim() : "";
  return name.length > 0 ? name : null;
}

/**
 * The human owner's own display name behind a duo's user id (#208): this
 * room's membership when the owner happens to be in it (a group with both
 * the colleague and their duo), else the workspace's profile for them (a
 * 1:1 "colleague's duo" room the owner themselves never joined). Null when
 * neither answers — the caller falls back to the id grammar's own label
 * rather than show nothing. Cached per `rooms()` call: the same owner can
 * answer for several rooms (their duo can be in more than one), and this
 * asks the workspace for their profile at most once.
 */
async function ownerDisplayNameOf(
  client: MatrixClient,
  room: MatrixRoom,
  ownerId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cached = cache.get(ownerId);
  if (cached !== undefined) {
    return cached;
  }
  const member = room.getMember(ownerId);
  const fromRoom = nonIdName(member?.rawDisplayName ?? member?.name, ownerId);
  if (fromRoom !== null) {
    cache.set(ownerId, fromRoom);
    return fromRoom;
  }
  let name: string | null = null;
  try {
    const profile = await client.getProfileInfo(ownerId);
    name = nonIdName(typeof profile?.displayname === "string" ? profile.displayname : null, ownerId);
  } catch {
    name = null;
  }
  cache.set(ownerId, name);
  return name;
}

/**
 * One room as the conversations list reads it (#63). Every field is the
 * homeserver's own state: membership, notification accounting (and its
 * highlight half — mentions), the join rule behind group-vs-channel, the
 * account's mute rule and the notification mode it half-names (#69), and
 * (#223) the room's own topic and picture with this member's own edit
 * permissions for all three. Nothing here is invented client-side, which is
 * the whole of "reflected across their devices" — the list renders the same
 * server answer everywhere.
 */
async function projectRoom(
  client: MatrixClient,
  room: MatrixRoom,
  selfId: string,
  direct: boolean,
  mode: NotificationMode,
  ownerNameCache: Map<string, string | null>,
): Promise<RoomSummary> {
  const latestText = [...room.getLiveTimeline().getEvents()]
    .reverse()
    .find((event) => event.getType() === "m.room.message" && event.getContent()?.msgtype === MsgType.Text);
  const topicContent = room.currentState?.getStateEvents(EventType.RoomTopic, "")?.getContent() as { topic?: unknown } | undefined;
  const avatarContent = room.currentState?.getStateEvents(EventType.RoomAvatar, "")?.getContent() as { url?: unknown } | undefined;
  const members = await Promise.all(
    room
      .getMembers()
      .filter((member) => member.membership === "join" && member.userId !== selfId)
      .map(async (member): Promise<RoomMemberRef> => {
        const name = nonIdName(member.rawDisplayName ?? member.name, member.userId) ?? localpartOf(member.userId);
        const ownerId = duoOwnerUserIdOf(member.userId);
        const ownerName = ownerId === null ? null : await ownerDisplayNameOf(client, room, ownerId, ownerNameCache);
        return ownerName === null ? { userId: member.userId, name } : { userId: member.userId, name, ownerName };
      }),
  );
  return {
    roomId: room.roomId,
    kind: direct ? "direct" : room.getJoinRule() === "public" ? "channel" : "group",
    // The real name only — never the SDK's auto-generated fill-in. A room
    // with no `m.room.name` reads as having none here, so the sidebar's
    // icon (driven by `kind`, not by this) and its member-names fallback
    // (roomTitle.ts) are the ones that ever stand in for it (#208).
    name: realRoomNameOf(room),
    topic: typeof topicContent?.topic === "string" && topicContent.topic !== "" ? topicContent.topic : null,
    avatarUrl: typeof avatarContent?.url === "string" && avatarContent.url !== "" ? avatarContent.url : null,
    members,
    latest: latestText ? { at: latestText.getTs(), body: String(latestText.getContent()?.body ?? "") } : null,
    lastActiveAt: room.getLastActiveTimestamp(),
    unread: {
      notifications: room.getUnreadNotificationCount(NotificationCountType.Total),
      mentions: room.getUnreadNotificationCount(NotificationCountType.Highlight),
    },
    muted: mode === "nothing",
    notifications: mode,
    canEdit: editPermissionsOf(room, selfId),
    ...(markedUnreadOf(room) ? { markedUnread: true as const } : {}),
  };
}

/**
 * The room's notification mode (#69), read the way the server holds it:
 * the account's mute rule wins ("nothing"), the room's account data says
 * "mentions" when the member scoped it, and anything else is "all" — the
 * absence of a rule is the default, not a gap.
 */
function notificationModeOf(room: MatrixRoom, muted: boolean): NotificationMode {
  if (muted) {
    return "nothing";
  }
  try {
    const content = room.getAccountData("duo.notifications")?.getContent() as { mode?: unknown } | undefined;
    return content?.mode === "mentions" ? "mentions" : "all";
  } catch {
    return "all";
  }
}

/**
 * #220: whether this member explicitly flagged the room unread (MSC2867's
 * `m.marked_unread` room account data), read as defensively as the other
 * account-data flags above (`notificationModeOf`) — a fixture that predates
 * this, or carries no such accessor at all, reads as "no flag", never a
 * crash.
 */
function markedUnreadOf(room: MatrixRoom): boolean {
  try {
    const content = room.getAccountData("m.marked_unread")?.getContent() as { unread?: unknown } | undefined;
    return content?.unread === true;
  } catch {
    return false;
  }
}

/** How many older events one backward page asks the homeserver for (#211) — enough that a scroll to the top usually turns up another visible row in one page, small enough to stay quick. */
const SCROLLBACK_PAGE_SIZE = 30;

/** How many people a directory search answers with — enough to pick a colleague out, small enough to read. */
const PEOPLE_SEARCH_LIMIT = 10;

/** How many conversations a local room search answers with (#207) — a suggestion list, not the whole sidebar again. */
const ROOM_SEARCH_LIMIT = 8;

/** A Matrix user id, shaped enough to look up directly: `@local:server`. */
const USER_ID_SHAPE = /^@[^\s:]+:\S+$/;

/**
 * Whether a display name or room name matches a typed query (#207): case-
 * and accent-folded, so "José" matches "jose" — `normalize` is the SDK's own
 * fold (it already strips the zero-width tricks `removeHiddenChars` targets).
 * Never used on a user id: Matrix ids are case-sensitive, and folding one
 * could match — or fail to look up — the wrong account.
 */
function matchesQuery(candidate: string, needle: string): boolean {
  return needle === "" || normalize(candidate).includes(needle);
}

/** How many hits a search page asks for — enough to scan, small enough to read. */
const SEARCH_PAGE_SIZE = 20;

/** How many lines around each hit the search is asked to bring: enough to recognise the moment, not to reread it. */
const SEARCH_CONTEXT_LINES = 2;

/** How many highlight notifications a mentions read asks for: enough for "everywhere you were mentioned" to read as complete in the common case. */
const MENTIONS_LIMIT = 50;

/**
 * Whether a notification is actually highlight-tier. `only=highlight` on
 * the request is the ask; this is the check — a homeserver that answers
 * the filter loosely cannot put a non-mention on this list.
 */
function isHighlightedNotification(notification: INotification): boolean {
  return notification.actions.some(
    (action) => typeof action === "object" && action.set_tweak === TweakName.Highlight && action.value !== false,
  );
}

/** An event as the homeserver's `/search` hands it back — the SDK's own wire type, read through the one door. */
type SearchWireEvent = NonNullable<
  Awaited<ReturnType<MatrixClient["search"]>>["search_categories"]["room_events"]["results"]
>[number]["result"];

/**
 * A search result's conversation words: a text message that is a row of its
 * conversation. An edit's replacement event is not one — it amends a row that
 * exists elsewhere — and neither is a file, a notice, or anything else that
 * merely carries a body.
 */
function searchableText(event: SearchWireEvent): { body: string; threadRootEventId: string | null } | null {
  if (event.type !== EventType.RoomMessage || event.content?.msgtype !== MsgType.Text || typeof event.content.body !== "string") {
    return null;
  }
  const relation = event.content["m.relates_to"] as Relation | undefined;
  if (relation?.rel_type === RelationType.Replace) {
    return null;
  }
  return {
    body: event.content.body,
    threadRootEventId: relation?.rel_type === RelationType.Thread && relation.event_id !== undefined ? relation.event_id : null,
  };
}

/**
 * The event types a live arrival can change a timeline's projection under
 * (#64): a message, a reaction, or a redaction. Everything else on the
 * timeline stream leaves what the surface reads where it was.
 */
const LIVE_EVENT_TYPES = new Set<string>([EventType.RoomMessage, EventType.Reaction, EventType.RoomRedaction]);

/**
 * #223: the three state events a group conversation's name, topic and
 * picture ride on. A change arrives at every joined member's sync, not just
 * the member who made it — this is the other half of AC2 ("shows for
 * everyone"): a subscriber hears the room id the moment one of these lands,
 * the same door a new message uses, so the sidebar and header re-read the
 * homeserver's projection instead of a local guess.
 */
const ROOM_INFO_EVENT_TYPES = new Set<string>([EventType.RoomName, EventType.RoomTopic, EventType.RoomAvatar]);

/**
 * The room ids muted by the account's own push rules — one read, shared by
 * `rooms()` and `findRooms()` (#207) so the two never disagree about which
 * conversations are muted. A failed read answers "none known", the same
 * fallback `rooms()` always took, rather than a list that won't render.
 */
async function mutedRoomIdsOf(client: MatrixClient): Promise<Set<string>> {
  const pushRules = await client.getPushRules().catch(() => undefined);
  return new Set(
    (pushRules?.global.room ?? []).filter((rule) => rule.enabled && rule.actions.length === 0).map((rule) => rule.rule_id),
  );
}

/** Hold the workspace connection for a stored session — resolves at the first completed sync, then serves rooms and timelines from it. */
export async function connect(session: WorkspaceSession, options: ConnectOptions = {}): Promise<WorkspaceConnection> {
  // No `deviceId` on purpose, for a stored and a hosted session alike: the SDK
  // only needs one to start end-to-end encryption, which this client never
  // does (no crypto, no store — see the header), and its sync and REST calls
  // are authorised by the access token alone.
  const client = createClient({
    baseUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    userId: session.userId,
  });
  try {
    await firstPreparedSync(client);
  } catch (error) {
    // A connect that fails leaves no half-started client polling behind it.
    client.stopClient();
    throw error;
  }
  if (options.onSessionRejected) {
    const onRejected = options.onSessionRejected;
    const onSync = (state: SyncState, _previous: SyncState | null, data?: { error?: unknown }): void => {
      if (state === SyncState.Error && isTokenRejection(data?.error)) {
        client.off(ClientEvent.Sync, onSync);
        onRejected();
      }
    };
    client.on(ClientEvent.Sync, onSync);
  }
  return {
    renewToken: (accessToken) => {
      client.setAccessToken(accessToken);
    },
    userId: session.userId,
    rooms: async () => {
      // The mute half of the projection lives in the account's push rules —
      // one read for the whole list. The mode's audible half lives in each
      // room's own account data, which the sync already delivered with the
      // room.
      const mutedIds = await mutedRoomIdsOf(client);
      const rooms = client
        .getRooms()
        // #214: a room this member has been invited to but not joined is not
        // a conversation yet — it has no timeline, no member list the server
        // will hand over, nothing this projection can honestly fill in. It
        // surfaces through `invites()` instead, until accepted.
        .filter((room) => room.getMyMembership() === "join");
      // #208: lazy loading (this seam's `connect()`) means membership — and
      // so a real name — can still be unfetched the first time the list
      // reads a room. Asking for it here, before the names and avatars are
      // read off it, is what keeps a raw id from ever reaching the screen.
      await Promise.all(rooms.map((room) => ensureMembersLoaded(room)));
      const directIds = await backfillMissingDirectRecords(client, rooms);
      const ownerNameCache = new Map<string, string | null>();
      const projected = await Promise.all(
        rooms.map((room) => projectRoom(client, room, session.userId, directIds.has(room.roomId), notificationModeOf(room, mutedIds.has(room.roomId)), ownerNameCache)),
      );
      return projected.sort((a, b) => (b.lastActiveAt ?? b.latest?.at ?? Number.MIN_SAFE_INTEGER) - (a.lastActiveAt ?? a.latest?.at ?? Number.MIN_SAFE_INTEGER));
    },
    timeline: async (roomId) => {
      const room = client.getRoom(roomId);
      if (room) {
        await ensureMembersLoaded(room);
      }
      return timelineOf(client, roomId);
    },
    /**
     * #207's Conversations section: local to what this client already has —
     * `getVisibleRooms()` (unlike `getRooms()`, it hides a room an upgrade
     * replaced) matched on the room's own name and, for a direct
     * conversation, the other member's name (`guessDMUserId`) — ranked by
     * the room's last activity rather than the list's own "latest text
     * message" rule, so a room whose latest event isn't a text message
     * still ranks where it was last active. An empty query answers the
     * member's most recent conversations, capped the same as any match.
     * Shares `projectRoom` with `rooms()` (#208) so a suggestion reads the
     * same name, topic and owner-of-a-duo claim the full list would.
     */
    findRooms: async (query) => {
      const needle = normalize(query.trim());
      const mutedIds = await mutedRoomIdsOf(client);
      const joined = client.getVisibleRooms().filter((room) => room.getMyMembership() === "join");
      const directIds = await backfillMissingDirectRecords(client, joined);
      const matches = joined.filter((room) => {
        if (matchesQuery(room.normalizedName || room.name || "", needle)) {
          return true;
        }
        if (!directIds.has(room.roomId)) {
          return false;
        }
        const partnerId = room.guessDMUserId();
        const partnerName = room.getMember(partnerId)?.name || localpartOf(partnerId);
        return matchesQuery(partnerName, needle);
      });
      matches.sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp());
      const top = matches.slice(0, ROOM_SEARCH_LIMIT);
      await Promise.all(top.map((room) => ensureMembersLoaded(room)));
      const ownerNameCache = new Map<string, string | null>();
      return Promise.all(
        top.map((room) => projectRoom(client, room, session.userId, directIds.has(room.roomId), notificationModeOf(room, mutedIds.has(room.roomId)), ownerNameCache)),
      );
    },
    timelineAt: async (roomId, eventId) => {
      const room = client.getRoom(roomId);
      if (!room || room.getMyMembership() !== "join") {
        return [];
      }
      await ensureMembersLoaded(room);
      // The homeserver's /context, through the SDK: the event's window, or
      // the live timeline itself when the event is recent enough to be in it.
      const window = await client.getEventTimeline(room.getUnfilteredTimelineSet(), eventId);
      return timelineOf(client, roomId, window?.getEvents() ?? []);
    },
    loadOlder: async (roomId) => {
      const room = client.getRoom(roomId);
      if (!room || room.getMyMembership() !== "join") {
        // Nothing this account can ask the homeserver for here — the same
        // honest answer as having already reached the beginning.
        return { loadedMore: false, atStart: true };
      }
      if (room.getLiveTimeline().getPaginationToken(Direction.Backward) === null) {
        // Already established there's nothing further back — not a reason
        // to ask the homeserver again.
        return { loadedMore: false, atStart: true };
      }
      const before = room.getLiveTimeline().getEvents().length;
      try {
        await client.scrollback(room, SCROLLBACK_PAGE_SIZE);
      } catch {
        // A connection hiccup is not "the beginning" — the UI's own retry
        // (another scroll to the top) is what tries again.
        return { loadedMore: false, atStart: false };
      }
      const timeline = room.getLiveTimeline();
      return {
        loadedMore: timeline.getEvents().length > before,
        atStart: timeline.getPaginationToken(Direction.Backward) === null,
      };
    },
    searchMessages: async (query, next) => {
      const term = query.trim();
      if (term === "") {
        return { hits: [], next: null };
      }
      // The request names no rooms: which conversations are searched is the
      // homeserver's rule about this account, not a list this client keeps.
      const response = await client.search({
        body: {
          search_categories: {
            room_events: {
              search_term: term,
              keys: ["content.body"],
              filter: { limit: SEARCH_PAGE_SIZE },
              event_context: { before_limit: SEARCH_CONTEXT_LINES, after_limit: SEARCH_CONTEXT_LINES, include_profile: true },
            },
          },
        },
        next_batch: next,
      });
      const found = response.search_categories.room_events;
      // The last inch of membership: only conversations this account is in
      // now. The homeserver scopes the search; this keeps a slip of it (or a
      // membership just dropped) from ever putting another conversation's
      // words on this member's screen.
      const joined = new Set(client.getRooms().filter((room) => room.getMyMembership() === "join").map((room) => room.roomId));
      const hits: MessageSearchHit[] = [];
      for (const { result, context } of found.results ?? []) {
        const text = searchableText(result);
        if (text === null || !joined.has(result.room_id)) {
          continue;
        }
        const room = client.getRoom(result.room_id);
        const nameOf = (senderId: string): string => {
          const member = room?.getMember(senderId);
          return (
            nonIdName(member?.rawDisplayName ?? member?.name, senderId) ??
            nonIdName(context?.profile_info?.[senderId]?.displayname, senderId) ??
            localpartOf(senderId)
          );
        };
        // The listing order of events_before isn't fixed by the spec, so the
        // lines are read in the order they were said — by the server's time.
        const linesOf = (events: readonly SearchWireEvent[] | undefined): SearchContextLine[] =>
          [...(events ?? [])]
            .filter((event) => event.room_id === result.room_id)
            .sort((a, b) => a.origin_server_ts - b.origin_server_ts)
            .flatMap((event) => {
              const line = searchableText(event);
              return line === null ? [] : [{ senderId: event.sender, senderName: nameOf(event.sender), body: line.body }];
            });
        hits.push({
          eventId: result.event_id,
          roomId: result.room_id,
          senderId: result.sender,
          senderName: nameOf(result.sender),
          body: text.body,
          originServerTs: result.origin_server_ts,
          threadRootEventId: text.threadRootEventId,
          context: { before: linesOf(context?.events_before), after: linesOf(context?.events_after) },
        });
      }
      return { hits, next: found.next_batch ?? null };
    },
    mentions: async () => {
      // #222: the homeserver's own highlight tier — the same signal
      // `.m.rule.is_user_mention` raises for a room's unread-mentions count
      // (`projectRoom`'s `unread.mentions`, above). `only=highlight` is the
      // ask; `isHighlightedNotification` is the check.
      const response = await client.http.authedRequest<INotificationsResponse>(Method.Get, "/notifications", {
        limit: String(MENTIONS_LIMIT),
        only: "highlight",
      });
      const hits: MentionHit[] = [];
      for (const notification of response.notifications) {
        if (!isHighlightedNotification(notification)) {
          continue;
        }
        // The notification's own event carries no room id of its own on the
        // wire — the SDK's own notification-timeline handling gutwrenches it
        // on exactly the same way (client.ts's paginateEventTimeline).
        const event = client.getEventMapper()(notification.event);
        event.event.room_id = notification.room_id;
        if (event.getType() !== EventType.RoomMessage || event.getContent()?.msgtype !== MsgType.Text || event.isRedacted()) {
          // A mention can only ever ride a text turn's words; a share's
          // "body" is a filename, and a struck event has no words to read.
          continue;
        }
        const relation = relationOf(event);
        if (relation?.rel_type === RelationType.Replace) {
          // An edit's replacement event is not a row of its own — the same
          // rule the timeline and the search projections hold.
          continue;
        }
        const senderId = event.getSender() ?? "";
        const room = client.getRoom(notification.room_id);
        hits.push({
          eventId: event.getId() ?? "",
          roomId: notification.room_id,
          senderId,
          senderName: room?.getMember(senderId)?.name || localpartOf(senderId),
          body: String(event.getContent()?.body ?? ""),
          originServerTs: event.getTs(),
          read: notification.read,
          threadRootEventId: relation?.rel_type === RelationType.Thread && relation.event_id !== undefined ? relation.event_id : null,
        });
      }
      // Newest first: the wire's own order isn't pinned by the spec, so this
      // is read back deliberately rather than trusted.
      return [...hits].sort((a, b) => b.originServerTs - a.originServerTs);
    },
    send: async (roomId, body, mentions = [], replyToEventId) => {
      // #216: mentions anchor into the markdown SOURCE first — the body
      // with each addressed mention's words replaced by its matrix.to
      // anchor, still otherwise exactly what was typed — and markdown
      // turns the mix into the finished `formatted_body`. #65's own rule
      // (anchor text is the body's text there) still holds: `marked`
      // leaves an already-complete inline `<a>` tag's text untouched
      // beyond its own entity-escaping (a quote mark, not the
      // asterisks/underscores markdown would otherwise read as syntax),
      // which `mentions.ts`'s `unescapeHtml` already accounts for on the
      // way back in. `format`/`formatted_body` now ride on EVERY text
      // send, mentions or not: markdown is always applied, and a plain
      // sentence is still its own (trivial) formatting — `body` is what
      // every client, formatting-aware or not, reads regardless (#216 AC2).
      await client.sendMessage(roomId, {
        msgtype: MsgType.Text,
        body,
        format: "org.matrix.custom.html",
        formatted_body: markdownToHtml(withMentionAnchors(body, mentions)),
        "m.mentions": { user_ids: [...new Set(mentions.map((mention) => mention.userId))] },
        // #215: a quote outside a thread is the spec's plain reply
        // relation — no `rel_type`, unlike every other relation this seam
        // sends (replace, annotation, thread). Absent entirely when this
        // isn't a reply, never sent as some empty/null placeholder.
        ...(replyToEventId === undefined ? {} : { "m.relates_to": { "m.in_reply_to": { event_id: replyToEventId } } }),
      });
    },
    // The share path (#66): upload bytes, then send the message that
    // references them. Both are homeserver operations on the member's own
    // account — the same footing as every other verb here. Sharing is not
    // importing: no upload path reaches any daemon, and the seam offers no
    // operation that could.
    uploadFile: async (staged, onProgress) => {
      let content_uri: string;
      try {
        ({ content_uri } = await client.uploadContent(new Blob([staged.bytes], { type: staged.mimeType }), {
          name: staged.name,
          type: staged.mimeType,
          ...(onProgress === undefined ? {} : { progressHandler: (progress) => onProgress(progress.loaded, progress.total) }),
        }));
      } catch (error) {
        throw shareFailure(error, staged.name);
      }
      return { name: staged.name, mimeType: staged.mimeType, size: staged.size, url: content_uri, image: isImageType(staged.mimeType) };
    },
    sendFile: async (roomId, file) => {
      // The share's wire shape (spec §Send-to-room messaging): the name
      // rides `body` and `filename`, the upload's reference in `url`, the
      // declared facts in `info` — the shape core #190's adapter reads
      // back. The msgtype is spelled in each arm because the SDK types a
      // message content by its msgtype literal; a union of the two would
      // not type as either.
      const facts = { body: file.name, filename: file.name, url: file.url, info: { mimetype: file.mimeType, size: file.size } };
      try {
        await client.sendMessage(
          roomId,
          file.image ? { ...facts, msgtype: MsgType.Image } : { ...facts, msgtype: MsgType.File },
        );
      } catch (error) {
        throw shareFailure(error, file.name);
      }
    },
    loadMedia: async (url) => {
      // 7th argument: useAuthentication — the /client/v1/media path. The
      // token rides the Authorization header and never a URL (a URL is
      // logged, copied, and outlives the session).
      const href = client.mxcUrlToHttp(url, undefined, undefined, undefined, undefined, undefined, true);
      if (href === null || href === "") {
        return null;
      }
      try {
        const response = await fetch(href, { headers: { Authorization: `Bearer ${session.accessToken}` } });
        return response.ok ? await response.blob() : null;
      } catch {
        return null;
      }
    },
    getUrlPreview: async (url) => {
      // Not every link has preview-able metadata, and a homeserver may
      // refuse outright (previews turned off there, or a page it won't
      // fetch) — every one of those is the same answer to a caller that
      // only ever wants a card or nothing, never a visible error for a
      // member who asked for a quiet preview.
      try {
        const response = await client.getUrlPreview(url, Date.now());
        const title = typeof response["og:title"] === "string" ? response["og:title"] : null;
        const description = typeof response["og:description"] === "string" ? response["og:description"] : null;
        const image = typeof response["og:image"] === "string" ? response["og:image"] : null;
        return title === null && description === null && image === null ? null : { title, description, image };
      } catch {
        return null;
      }
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
    retry: async (roomId, eventId) => {
      const room = client.getRoom(roomId);
      const event = room && pendingEventsOf(room).find((pending) => pending.getId() === eventId);
      if (!room || !event) {
        // Already gone (sent, or cancelled from elsewhere) — nothing to retry.
        return;
      }
      await client.resendEvent(event, room);
    },
    cancel: (roomId, eventId) => {
      const room = client.getRoom(roomId);
      const event = room && pendingEventsOf(room).find((pending) => pending.getId() === eventId);
      if (event) {
        client.cancelPendingEvent(event);
      }
    },
    markRead: async (roomId) => {
      const room = client.getRoom(roomId);
      const events = room?.getLiveTimeline().getEvents() ?? [];
      const last = events[events.length - 1];
      if (last) {
        await client.sendReadReceipt(last, ReceiptType.Read, true);
      }
      // #220: reading the conversation — however that happened — undoes an
      // explicit "mark unread" the same way it undoes a true unread count.
      if (room && markedUnreadOf(room)) {
        await client.setRoomAccountData(roomId, "m.marked_unread", { unread: false });
      }
    },
    markUnread: async (roomId) => {
      await client.setRoomAccountData(roomId, "m.marked_unread", { unread: true });
    },
    readMarker: (roomId) => {
      const room = client.getRoom(roomId);
      if (!room) {
        return null;
      }
      const marker = room.getAccountData("m.fully_read")?.getContent() as { event_id?: unknown } | undefined;
      if (typeof marker?.event_id === "string" && marker.event_id !== "") {
        return marker.event_id;
      }
      // #212: nobody, on any device, has ever moved `m.fully_read` here —
      // the one fallback that still anchors from something real is this
      // account's own read receipt, which `markRead` (#63, unconditional on
      // open) has been advancing all along.
      return room.getEventReadUpTo(session.userId) ?? null;
    },
    unreadBoundaryFrom: (roomId, anchorEventId) => {
      const room = client.getRoom(roomId);
      if (!room) {
        return { kind: "none" };
      }
      const events = room.getLiveTimeline().getEvents();
      const anchorIndex = events.findIndex((event) => event.getId() === anchorEventId);
      if (anchorIndex === -1) {
        // Older than anything loaded here (#211's job to go looking) — not
        // the same as "nothing unread".
        return { kind: "unknown" };
      }
      for (let i = anchorIndex + 1; i < events.length; i++) {
        const event = events[i]!;
        if (isMainFlowRow(event)) {
          const eventId = event.getId();
          return eventId ? { kind: "found", eventId } : { kind: "none" };
        }
      }
      return { kind: "none" };
    },
    advanceReadMarker: async (roomId, eventId) => {
      await client.setRoomReadMarkers(roomId, eventId);
    },
    setRoomName: async (roomId, name) => {
      await client.setRoomName(roomId, name);
    },
    setRoomTopic: async (roomId, topic) => {
      await client.setRoomTopic(roomId, topic);
    },
    setRoomAvatar: async (roomId, mxcUrl) => {
      await client.sendStateEvent(roomId, EventType.RoomAvatar, { url: mxcUrl }, "");
    },
    startDirect: async (userId) => {
      // #207: a DM with this person may already exist — the account's own
      // `m.direct` record of which rooms are direct, cross-checked against
      // who each one is actually with (`guessDMUserId`). Reusing it is what
      // keeps "message them" from the directory and from the one search box
      // landing in the same conversation, never a second copy of it.
      const directIds = directRoomIdsOf(client);
      const existing = client
        .getVisibleRooms()
        .find((room) => room.getMyMembership() === "join" && directIds.has(room.roomId) && room.guessDMUserId() === userId);
      if (existing) {
        return existing.roomId;
      }
      const { room_id } = await client.createRoom({ is_direct: true, invite: [userId] });
      // #208: the homeserver doesn't infer DM-ness from `is_direct` on
      // create — only this account's own `m.direct` record says so, and
      // nothing writes it unless this does.
      await writeDirectRoom(client, userId, room_id);
      return room_id;
    },
    createRoom: async (name, topic) => {
      const trimmedTopic = topic.trim();
      try {
        const { room_id } = await client.createRoom({
          preset: Preset.PrivateChat,
          name: name.trim(),
          ...(trimmedTopic === "" ? {} : { topic: trimmedTopic }),
        });
        return room_id;
      } catch (error) {
        throw roomFailure(error);
      }
    },
    invite: async (roomId, userId) => {
      try {
        await client.invite(roomId, userId);
      } catch (error) {
        throw roomFailure(error);
      }
    },
    invites: async () => {
      return client
        .getRooms()
        .filter((room) => room.getMyMembership() === "invite")
        .map((room) => {
          // A DM invite says so structurally (the `is_direct` flag `startDirect`
          // set, read back by the SDK's own DM heuristic) — never guessed from
          // member count, the same rule `directRoomIdsOf` follows for joined
          // rooms. Anything else is a group: this seam creates no channel yet.
          const direct = room.getDMInviter() !== undefined;
          const inviterId = room.getDMInviter() ?? room.getMember(session.userId)?.events.member?.getSender() ?? null;
          return {
            roomId: room.roomId,
            kind: direct ? "direct" : room.getJoinRule() === "public" ? "channel" : "group",
            name: room.name || null,
            inviterId,
            inviterName: inviterId === null ? null : room.getMember(inviterId)?.name || localpartOf(inviterId),
          } satisfies RoomInvite;
        });
    },
    joinRoom: async (roomId) => {
      try {
        await client.joinRoom(roomId);
      } catch (error) {
        throw roomFailure(error);
      }
    },
    leave: async (roomId) => {
      await client.leave(roomId);
    },
    setNotificationMode: async (roomId, mode) => {
      if (mode === "nothing") {
        await client.addPushRule("global", PushRuleKind.RoomSpecific, roomId, { actions: [], conditions: [] });
        return;
      }
      // An audible mode stands where the mute rule isn't: clear it if
      // another device left it, and say the mode in the room's account
      // data. Both writes idempotently — a rule already gone is not an
      // error worth surfacing for a setting that changed nothing.
      await client.deletePushRule("global", PushRuleKind.RoomSpecific, roomId).catch(() => undefined);
      await client.setRoomAccountData(roomId, "duo.notifications", { mode });
    },
    searchPeople: async (query) => {
      const term = query.trim();
      if (term === "") {
        return [];
      }
      const needle = normalize(term);
      // De-duplicated by user id, first source wins the name shown — local
      // membership is the most likely to be right about who someone is
      // right now.
      const found = new Map<string, { userId: string; name: string }>();
      const add = (userId: string, name: string): void => {
        if (userId !== session.userId && !found.has(userId)) {
          found.set(userId, { userId, name });
        }
      };
      // 1. Local: members of rooms already shared — instant, no network,
      // and the one source that still answers when the directory below is
      // slow or down.
      for (const room of client.getVisibleRooms()) {
        if (room.getMyMembership() !== "join") {
          continue;
        }
        for (const member of room.getMembers()) {
          if (member.membership !== "join" || member.userId === session.userId) {
            continue;
          }
          const name = nonIdName(member.rawDisplayName ?? member.name, member.userId) ?? localpartOf(member.userId);
          if (matchesQuery(name, needle) || matchesQuery(member.userId, needle)) {
            add(member.userId, name);
          }
        }
      }
      // 2. The homeserver's user directory — membership-scoped there
      // (Synapse runs `search_all_users: false`), so it answers only people
      // who already share a room with this account. A failed directory read
      // still leaves the local and exact-id sources standing.
      try {
        const { results } = await client.searchUserDirectory({ term, limit: PEOPLE_SEARCH_LIMIT });
        for (const result of results) {
          add(result.user_id, nonIdName(result.display_name, result.user_id) ?? localpartOf(result.user_id));
        }
      } catch {
        // The directory is one of three sources; its absence isn't a refusal of the search.
      }
      // 3. Exact id: the one way to address someone the directory can't
      // find because no room has introduced you yet. Only when the query is
      // itself id-shaped, and used EXACTLY as typed (already trimmed above)
      // — a user id is case-sensitive, and `removeHiddenChars`/`normalize`
      // are fuzzy-matching tools, not safe for an exact lookup: the SDK's
      // own `removeHiddenChars` folds visually-similar sequences (its
      // homoglyph pass turns "m" into "rn", by its own comment), which
      // would send `getProfileInfo` looking for a different id than the one
      // typed.
      if (USER_ID_SHAPE.test(term) && !found.has(term)) {
        try {
          const profile = await client.getProfileInfo(term);
          add(term, nonIdName(profile.displayname, term) ?? localpartOf(term));
        } catch {
          // Not a real id, or the homeserver won't say — no exact match to add.
        }
      }
      return [...found.values()].slice(0, PEOPLE_SEARCH_LIMIT);
    },
    getProfile: async (userId) => {
      try {
        const info = await client.getProfileInfo(userId);
        return { userId, name: nonIdName(info.displayname, userId) ?? localpartOf(userId), avatarUrl: info.avatar_url ?? null };
      } catch {
        return null;
      }
    },
    subscribe: (handler) => {
      const listener = (event: MatrixEvent, room: MatrixRoom | undefined): void => {
        if (!room) {
          return;
        }
        if (ROOM_INFO_EVENT_TYPES.has(event.getType())) {
          // #223: room news, not message news — no arrival, just the roomId,
          // so every subscriber re-reads the next projection rather than
          // being told what changed.
          handler(room.roomId);
          return;
        }
        if (!LIVE_EVENT_TYPES.has(event.getType())) {
          return;
        }
        // The arrival half (#69): a NEW text message — not an amendment of
        // an old one, not a reaction — says who spoke and whether it
        // mentions the member, which is what a notification decides on.
        // Sender naming goes through membership the same door the timeline
        // projection's does, so the two can never disagree.
        let arrival: LiveArrival | undefined;
        const content = event.getContent() as {
          msgtype?: string;
          body?: string;
          "m.relates_to"?: { rel_type?: string };
          "m.mentions"?: { user_ids?: string[] };
        };
        if (
          event.getType() === EventType.RoomMessage &&
          content.msgtype === MsgType.Text &&
          content["m.relates_to"]?.rel_type !== RelationType.Replace
        ) {
          const senderId = event.getSender() ?? "";
          const sender = room.getMember(senderId);
          arrival = {
            senderId,
            senderName: nonIdName(sender?.rawDisplayName ?? sender?.name, senderId) ?? localpartOf(senderId),
            body: String(content.body ?? ""),
            mentionsMe: content["m.mentions"]?.user_ids?.includes(session.userId) ?? false,
          };
        }
        handler(room.roomId, arrival);
      };
      // #209: this device's own send changing status (queued → sent →
      // folded into the live timeline, or → failed, or retried, or
      // cancelled) is room news the same way a reaction or an amendment
      // is — the roomId rides, no arrival, because it is never a NEW
      // message a notification should act on.
      const localEchoListener = (_event: MatrixEvent, room: MatrixRoom): void => {
        handler(room.roomId);
      };
      client.on(RoomEvent.Timeline, listener);
      client.on(RoomEvent.LocalEchoUpdated, localEchoListener);
      return () => {
        client.off(RoomEvent.Timeline, listener);
        client.off(RoomEvent.LocalEchoUpdated, localEchoListener);
      };
    },
    stop: async () => {
      await client.stopClient();
    },
  };
}
