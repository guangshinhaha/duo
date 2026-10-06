import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, X } from "lucide-react";
import { RoomDuoAnswer } from "../components/RoomDuoAnswer.js";
import { RoomDuoMessage } from "../components/RoomDuoMessage.js";
import { RoomPersonMessage } from "../components/RoomPersonMessage.js";
import { LinkPreviewCard } from "../components/LinkPreviewCard.js";
import { MessageBodyHtml } from "../components/MessageBodyHtml.js";
import { InfoButton } from "../shell/InfoButton.js";
import { ChatTimelineList, useChatTimeline } from "../shell/useChatTimeline.js";
import { useTouchPrimary } from "../shell/useMediaQuery.js";
import { useLongPress } from "../shell/useLongPress.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/primitives/DropdownMenu.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { SharedFileCard } from "../components/SharedFileCard.js";
import { Timestamp } from "../components/Timestamp.js";
import { roomTitle } from "../shell/roomTitle.js";
import { addressed, mentionLabelOf, mentionPillClassName } from "../workspace/mentions.js";
import { ChatEditor, type ChatEditorHandle } from "../composer/ChatEditor.js";
import { FactCheckAssist } from "../composer/FactCheckAssist.js";
import { mentionCandidatesOf } from "../composer/mentionOffer.js";
import { RewriteMenu } from "../composer/RewriteMenu.js";
import type { RewriteInstruction } from "../composer/rewrite.js";
import { readFactCheckPref } from "../factCheckPrefs.js";
import type { RoomMemberRef, RoomMessage, UnreadBoundary, WorkspaceConnection } from "../workspace/matrix.js";
import { escalationOf, plainPreview, readDuoAnswer } from "../workspace/duoAnswer.js";
import { duoOwnerLabel, isDuoUserId, localpartOf } from "../workspace/identity.js";
import { duoConversationOf, questionOutcomes, questionOutcomeWords, type QuestionOutcome } from "../workspace/duoConversation.js";
import { DuoConversationBanner } from "../components/DuoConversationBanner.js";
import { formatBytes, shareRefusalOf, stageFile, type StagedShare } from "../workspace/sharing.js";
import { messagePermalink, roomHref, threadHref } from "../workspace/links.js";
import { firstLinkOf } from "../workspace/linkPreview.js";
import { readUrlPreviewPref } from "../urlPreviewPrefs.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/primitives/Dialog.js";
import { PinAnswerDialog } from "../components/PinAnswerDialog.js";
import { useHeld } from "../components/primitives/useHeld.js";
import { EmojiPicker } from "../components/EmojiPicker.js";
import { readReactionRecents, recordReactionRecent } from "../reactionRecents.js";

/**
 * #62 + #63 + #64: one conversation — the timeline, the message verbs, and
 * the composer. Who said what is read STRUCTURALLY: a duo-shaped sender
 * (`@duo-<owner>`, identity.ts) renders as the multi-party
 * `RoomDuoMessage` with the possessive attribution ("carol's duo") derived
 * from the id, and a person renders `RoomPersonMessage` by their name. A
 * display name can claim anything; the user-id grammar cannot — which is
 * the whole of AR-13 in a shared room.
 *
 * The verbs (#64) are all homeserver operations — edit, delete, react,
 * reply-in-thread move the server's own state, and the surface renders the
 * next answer, never a local pretense of one. The one deliberate local
 * half is the optimistic send (#64 AC1): the sender's words render
 * immediately, marked as on their way, and the homeserver's echo replaces
 * them.
 *
 * Opening the conversation is also reading it (#63): the read position is
 * a receipt on the member's account, sent once the timeline has loaded —
 * the homeserver's own durable state, which is why the unread badge clears
 * on every device, not just here.
 *
 * Live arrivals land through the query cache: the subscription invalidates
 * the timeline, the refetch is the truth, and no message is ever spliced
 * in from a second source.
 *
 * #68: for an owner with a paired duo, the conversation also shows the
 * drafts the duo made for messages that arrived here — the shell's
 * `RoomDrafts`, handed in as a slot and rendered in a region of its own
 * beside the composer, never in the transcript.
 */

/** The reaction keys the picker offers — a fixed, readable set, not a free-text field. */
const REACTION_CHOICES = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;

/** The quiet per-row action idiom — present for a keyboard, unloud for an eye. */
const rowActionClass =
  "inline-flex min-h-9 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-provenance text-[var(--muted)]";

/**
 * #252: the trigger for a phone's message-actions sheet — invisible until a
 * keyboard reaches it (`sr-only`/`focus:not-sr-only`, the standard
 * skip-link idiom), since the usual way there is a long press, not a tap.
 */
const sheetTriggerClass = `${rowActionClass} sr-only focus:not-sr-only`;

/** #211: how near the scroll container's own top counts as "scrolled to the top" — close enough that the member doesn't have to hit the exact pixel. */
const SCROLLBACK_TRIGGER_PX = 80;

/** #212: how long the "New messages" line has to sit in view before the member's read marker actually advances past it (AC3) — long enough that flying past it while scrolling doesn't count as having read it. */
const UNREAD_DWELL_MS = 900;

/** #211/#212: how many pages "Jump to first unread" may page backward looking for an off-screen read-marker anchor before falling back to "jump to the top" — bounded, so a very old marker never turns into loading a room's whole history. */
const UNREAD_SEARCH_PAGE_CAP = 10;

export { roomHref, threadHref };

/** The latest reply's author as the id says they are — "carol's duo" from `@duo-carol`, never a chosen name. */
function threadPreviewLabel(reply: { senderId: string; senderName: string }): string {
  return mentionLabelOf(reply.senderId, reply.senderName);
}

/**
 * #65: one mention pill. A duo's pill IS the duo — its label re-derived
 * from the user id here at the render site (the projection already did;
 * this is the same structural rule holding at the last inch, so no lying
 * delivered label can put the owner's name on the duo), carried visually
 * by the dashed border the duo's own messages use. A person's pill is
 * solid and reads the label the projection resolved. The pill's text is
 * the addressed words the body carries — the same "@" the composer's pick
 * left there.
 */
function MentionPill({ userId, label }: { userId: string; label: string }) {
  return (
    <span className={mentionPillClassName(userId)} data-mentioned-user={userId} data-testid="room-mention">
      {addressed(userId, label)}
    </span>
  );
}

/**
 * #215: the quote a reply carries — who it answers and a snippet of what
 * they said, read from this device's own copy of the conversation (never a
 * second fetch). `quoted` is undefined when that copy doesn't hold the
 * original: the row still says it's a reply (the row below still renders),
 * it just can't say to what — honest about the gap rather than inventing
 * words. Clicking a quote whose original IS held brings it into view
 * (`onJump`, wired to `Room`'s own scroll-and-highlight, the same one a
 * search landing uses) — a simple in-page jump, not a permalink (#225).
 */
function ReplyQuote({ quoted, onJump }: { quoted: RoomMessage | undefined; onJump?: () => void }) {
  if (quoted === undefined) {
    return (
      <p className="mb-1 rounded-[var(--r-sm)] border-l-2 border-[var(--edge)] pl-2 type-provenance italic text-[var(--faint)]" data-testid="reply-quote">
        Replying to a message not shown here
      </p>
    );
  }
  const label = mentionLabelOf(quoted.senderId, quoted.senderName);
  const snippet = quoted.redacted ? "Message deleted" : quoted.file !== undefined ? quoted.file.name : plainPreview(quoted.body);
  const quoteBody = (
    <p className="mb-1 line-clamp-2 rounded-[var(--r-sm)] border-l-2 border-[var(--edge)] pl-2 text-left type-provenance text-[var(--muted)]">
      <span className="text-[var(--text)]">{label}</span> {snippet}
    </p>
  );
  return onJump === undefined ? (
    <div data-testid="reply-quote">{quoteBody}</div>
  ) : (
    <button className="block w-full" data-testid="reply-quote" type="button" onClick={onJump}>
      {quoteBody}
    </button>
  );
}

/** The message's words for rendering: the plain body, or its parts with a pill at each mention (#65). */
function messageWords(message: RoomMessage): ReactNode {
  if (message.parts === null) {
    return message.body;
  }
  return message.parts.map((part, index) =>
    part.kind === "mention" ? <MentionPill key={index} label={part.label} userId={part.userId} /> : part.text,
  );
}

/**
 * #212: the "New messages" divider — drawn once, above the first unread row,
 * and watched against the scroll container it sits in. A dwell, not a
 * glance: the member's read marker only moves once this has sat IN VIEW for
 * a beat (`onRead`, after `UNREAD_DWELL_MS`), never just because the
 * conversation was opened (AC3) — and `onVisibilityChange` is the other
 * half of AC2, telling the room whether "Jump to first unread" belongs on
 * screen right now. happy-dom (this app's test environment) stubs
 * `IntersectionObserver` without ever calling back, and a very old browser
 * may have none at all — either way the line just sits there, inert, rather
 * than throwing: a caller that wants the dwell behaviour pinned supplies its
 * own observer in tests.
 */
function UnreadLine({
  scrollerRef,
  onVisibilityChange,
  onRead,
}: {
  scrollerRef: RefObject<HTMLElement | null>;
  onVisibilityChange: (visible: boolean) => void;
  onRead: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The callbacks are the room's fresh closures each render; the observer —
  // and a dwell it may be timing — must outlive those renders.
  const visibility = useRef(onVisibilityChange);
  const read = useRef(onRead);
  useEffect(() => {
    visibility.current = onVisibilityChange;
    read.current = onRead;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      return;
    }
    let dwell: ReturnType<typeof setTimeout> | null = null;
    const clearDwell = (): void => {
      if (dwell !== null) {
        clearTimeout(dwell);
        dwell = null;
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries[0]?.isIntersecting ?? false;
        visibility.current(visible);
        clearDwell();
        if (visible) {
          dwell = setTimeout(() => read.current(), UNREAD_DWELL_MS);
        }
      },
      { root: scrollerRef.current, threshold: 0.5 },
    );
    observer.observe(el);
    return () => {
      clearDwell();
      observer.disconnect();
      // #248: the transcript is virtualized — a line whose row scrolls far
      // enough away unmounts, and an unmounted line is not in view: "Jump to
      // first unread" belongs on screen.
      visibility.current(false);
    };
  }, [scrollerRef]);

  return (
    <div className="flex items-center gap-2 py-1" data-testid="room-unread-line" ref={ref}>
      <span className="h-px flex-1 bg-[var(--accent)]" />
      <span className="type-provenance uppercase text-[var(--accent)]">New messages</span>
      <span className="h-px flex-1 bg-[var(--accent)]" />
    </div>
  );
}

/** #248: the virtualizer's first guesses, before a row is measured — a typical message, and a one-line status or note. */
const MESSAGE_ROW_ESTIMATE_PX = 96;
const STATUS_ROW_ESTIMATE_PX = 40;

/** One row of the transcript (#248) — the beginning-of-history note, another note, or a message. */
type RoomRow =
  | { readonly kind: "beginning" }
  | { readonly kind: "at-missing" }
  | { readonly kind: "empty" }
  | { readonly kind: "message"; readonly message: RoomMessage };

/** A row's stable key — the message's event id, or the status row's own name (never a valid event id). */
function roomRowKey(row: RoomRow): string {
  return row.kind === "message" ? row.message.eventId : `:${row.kind}`;
}

/**
 * The transcript's rows, top to bottom — the same pieces, in the same order
 * and under the same conditions, as the conversation has always drawn them;
 * now as rows the virtualizer can measure and place.
 */
function roomRowsOf({
  messages,
  at,
  atStart,
}: {
  messages: readonly RoomMessage[];
  at: string | undefined;
  /** #211: the homeserver has said there's nothing further back (never for a search window, which has no "further back"). */
  atStart: boolean;
}): RoomRow[] {
  // The main flow carries the roots; a thread's replies belong to the
  // thread, present here only as the root's summary of them.
  const mainFlow = messages.filter((message) => message.threadRootEventId === null);
  const rows: RoomRow[] = [];
  if (atStart && mainFlow.length > 0) {
    rows.push({ kind: "beginning" });
  }
  if (at !== undefined && !messages.some((message) => message.eventId === at)) {
    rows.push({ kind: "at-missing" });
  }
  if (mainFlow.length === 0) {
    if (at === undefined) {
      rows.push({ kind: "empty" });
    }
  } else {
    rows.push(...mainFlow.map((message) => ({ kind: "message" as const, message })));
  }
  return rows;
}

export function Room({
  connection,
  roomId,
  at,
  drafts = null,
  onRewrite,
  onFactCheck,
  onPinAnswer,
  offTheRecordControl = null,
}: {
  connection: WorkspaceConnection | null;
  roomId: string;
  /** #70: the event a search hit landed at — the room reads in context around it. */
  at?: string;
  /**
   * #68: the owner's drafts for this conversation, when the shell has a duo
   * to ask — a slot, because the share path (#66) may not import the
   * daemon's client: this route renders where the drafts go and knows
   * nothing of where they come from.
   */
  drafts?: ReactNode;
  /**
   * #263: polishes the owner's OWN typed text. Plain callback props, not
   * the daemon's `DuoApiConfig` — this route is on the share path (#66's
   * structural pin, `test/WorkspaceMatrixSeam.test.ts`) and may never
   * import `src/api/*` itself. App.tsx owns the actual daemon call (the
   * same way it owns `drafts`'s `RoomDrafts`) and hands down only the
   * bound function; `undefined` (no paired duo) disables the feature.
   */
  onRewrite?: (text: string, instruction: RewriteInstruction) => Promise<string>;
  /** #264: same reasoning as `onRewrite` — a plain callback, never the daemon client itself. */
  onFactCheck?: (text: string, threadContext: string | null) => Promise<{ claim: string; concern: string; sourceLabel: string } | null>;
  /** duo#275: pins one of the owner's own messages as the exact answer to a question/topic — same reasoning as `onRewrite`/`onFactCheck`. `undefined` (no paired duo) hides the message action entirely. */
  onPinAnswer?: (pattern: string, answerText: string) => Promise<unknown>;
  /**
   * duo#274: the header's "don't learn from this conversation" control — a
   * rendered slot, same reasoning and shape as `drafts`'s `RoomDrafts`
   * (this route may never import `src/api/*` itself): App.tsx mounts
   * `OffTheRecordControl` here, keyed by the open room, or `null` with no
   * paired duo (there is nothing to mark off the record against).
   */
  offTheRecordControl?: ReactNode;
}) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!connection) {
      return;
    }
    return connection.subscribe((changedRoomId) => {
      void queryClient.invalidateQueries({ queryKey: ["workspace", "timeline", changedRoomId] });
      // #223: a name/topic/picture change (or anything else about a room)
      // is also room news — re-read the rooms projection so this header
      // (and `roomName` above) shows what the homeserver now says, even
      // when the chat list isn't mounted beside it to have asked already.
      void queryClient.invalidateQueries({ queryKey: ["workspace", "rooms"] });
    });
  }, [connection, queryClient]);

  const rooms = useQuery({
    queryKey: ["workspace", "rooms"],
    queryFn: () => connection?.rooms() ?? Promise.resolve([]),
    enabled: connection !== null,
    meta: { target: "workspace" },
  });
  // #70: landing at a search hit reads the window AROUND that event — history
  // the live timeline may never have carried — under its own key, still
  // inside the timeline's prefix, so live arrivals and verbs refresh it too.
  const timeline = useQuery({
    queryKey: at === undefined ? ["workspace", "timeline", roomId] : ["workspace", "timeline", roomId, "at", at],
    queryFn: () => (at === undefined ? connection!.timeline(roomId) : connection!.timelineAt(roomId, at)),
    enabled: connection !== null,
    meta: { target: "workspace" },
  });

  const room = rooms.data?.find((candidate) => candidate.roomId === roomId);
  const roomName = room ? roomTitle(room) : roomId;
  // #313: a conversation with a colleague's duo says so, persistently, and
  // each question in it says what became of it.
  const duoConversation = room ? duoConversationOf(room, connection?.userId ?? null) : null;
  const outcomes = useMemo(
    () => (duoConversation === null ? null : questionOutcomes(timeline.data ?? [], duoConversation.duoUserId)),
    [duoConversation?.duoUserId, timeline.data],
  );

  // Reading is an account-level fact: receipt the room's latest event once
  // the timeline is in hand, then let the list re-read the server's
  // accounting. A failed receipt leaves the room usable — the next open
  // tries again, and nothing local pretends it happened.
  useEffect(() => {
    // A window opened from a search hit is not the room's latest: reading
    // an old moment is not reading the conversation, so no receipt (#70).
    if (!connection || at !== undefined || !timeline.isSuccess || timeline.data === undefined) {
      return;
    }
    let cancelled = false;
    void connection
      .markRead(roomId)
      .then(() => {
        if (!cancelled) {
          void queryClient.invalidateQueries({ queryKey: ["workspace", "rooms"] });
        }
      })
      .catch(() => {
        // The unread badge keeps telling the truth; nothing else breaks.
      });
    return () => {
      cancelled = true;
    };
  }, [connection, roomId, at, timeline.isSuccess, timeline.data, queryClient]);

  // After a verb, the server's next answer is the only record: one
  // invalidation of the workspace's whole query tree, and every reader of
  // it (list, flow, previews) re-reads.
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
  };

  const [deleteTarget, setDeleteTarget] = useState<RoomMessage | null>(null);
  // The delete dialog stays mounted through its exit.
  const heldDelete = useHeld(deleteTarget);
  // Which messages were already here when the room opened: only what arrives after that rises in (B7).
  const seen = useRef<{ roomId: string; at: string | undefined; ids: Set<string> | null }>({ roomId, at, ids: null });
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // #215: the message the composer is about to quote — the room holds this,
  // not the composer, because it's set from a row's own "Reply" action.
  const [replyTarget, setReplyTarget] = useState<RoomMessage | null>(null);
  // #215: the row a quote was just clicked into — reuses the same outline
  // a search landing (`at`) already draws, briefly, so clicking a quote
  // reads as "there it is" rather than a silent jump.
  const [jumpedTo, setJumpedTo] = useState<string | null>(null);
  // #248: rows with something of the member's in progress (an open edit, a
  // picker, a verb on its way) — kept mounted however far they scroll away.
  const [activeRows, setActiveRows] = useState<ReadonlySet<string>>(() => new Set());
  const setRowActive = useCallback((eventId: string, active: boolean): void => {
    setActiveRows((current) => {
      if (current.has(eventId) === active) {
        return current;
      }
      const next = new Set(current);
      if (active) {
        next.add(eventId);
      } else {
        next.delete(eventId);
      }
      return next;
    });
  }, []);

  // #211: a scroll to the top extends the window backward one page at a
  // time; `atStart` is the homeserver's own word that there's nothing
  // further back, read once a page comes back saying so and held until the
  // room changes.
  const [olderState, setOlderState] = useState<{ loading: boolean; atStart: boolean }>({ loading: false, atStart: false });
  // #212: this member's read-marker anchor, frozen the moment this room is
  // opened (`connection.readMarker`, read once — see its own doc for why).
  const unreadAnchor = useRef<{ roomId: string; eventId: string | null } | null>(null);
  // Whether the dwell on the "New messages" line has already fired this
  // open — once true, the line itself stops rendering (#212's own "the line
  // disappears… once actually viewed").
  const [markedRead, setMarkedRead] = useState(false);
  // Whether the line is currently in the scroll container's own view —
  // "Jump to first unread" is for when it ISN'T (#212 AC2).
  const [dividerVisible, setDividerVisible] = useState(true);
  // #212: a jump to an unread line that a backward page has only just
  // loaded — carried to the commit that renders its row.
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  // Where this open has already landed (`roomId`, `at`) — the first scroll
  // happens once per open, never again as the timeline refreshes; and only
  // once it has does an arrival at the end pull the view along.
  const openKey = `${roomId}\u0000${at ?? ""}`;
  const [landed, setLanded] = useState<string | null>(null);

  useEffect(() => {
    setOlderState({ loading: false, atStart: false });
    setMarkedRead(false);
    setDividerVisible(true);
  }, [roomId, at]);

  // #212: freezing the anchor the moment this room is opened — re-reading
  // `readMarker` every render would drift as this device's own receipt send
  // (`markRead`, above) and its own marker advances (`handleRead`, below)
  // land, which is exactly the "not just by opening it" AC3 rules out.
  // Never for a search window (#70): no marker is kept for where a
  // permalink opened, so there is nothing to compare against. Reads
  // straight off the SDK's already-synced state — no network wait, so this
  // runs even while `timeline`'s own query is still loading.
  if (connection && at === undefined && (unreadAnchor.current === null || unreadAnchor.current.roomId !== roomId)) {
    unreadAnchor.current = { roomId, eventId: connection.readMarker(roomId) };
  }
  const anchorEventId = connection && at === undefined && unreadAnchor.current?.roomId === roomId ? unreadAnchor.current.eventId : null;
  const boundary: UnreadBoundary =
    connection && anchorEventId !== null ? connection.unreadBoundaryFrom(roomId, anchorEventId) : { kind: "none" };
  const unreadFoundEventId = !markedRead && boundary.kind === "found" ? boundary.eventId : null;

  // #248: the transcript's rows, in order — the beginning-of-history note,
  // either other note, then every main-flow message. Built before any early
  // return so the virtualizer (a hook) always sees the same calls.
  const rows = useMemo(
    () =>
      roomRowsOf({
        messages: timeline.data ?? [],
        at,
        atStart: at === undefined && !olderState.loading && olderState.atStart,
      }),
    [timeline.data, at, olderState],
  );
  const timelineView = useChatTimeline({
    count: rows.length,
    getKey: useCallback((index: number) => roomRowKey(rows[index]!), [rows]),
    estimateSize: useCallback((index: number) => (rows[index]!.kind === "message" ? MESSAGE_ROW_ESTIMATE_PX : STATUS_ROW_ESTIMATE_PX), [rows]),
    keepMounted: useMemo(
      () => rows.flatMap((row, index) => (row.kind === "message" && activeRows.has(row.message.eventId) ? [index] : [])),
      [rows, activeRows],
    ),
    follow: landed === openKey && at === undefined,
  });
  const { scrollToRow, scrollToEnd } = timelineView;
  const rowIndexOf = (eventId: string): number => rows.findIndex((row) => row.kind === "message" && row.message.eventId === eventId);
  useEffect(() => {
    if (pendingJump !== null) {
      scrollToRow(rowIndexOf(pendingJump));
      setPendingJump(null);
    }
    // Runs when a jump is staged (and the rows it targets have rendered).
  }, [pendingJump]);

  // The first look at a conversation (once per open): a search landing
  // (#70) centres its message; a known unread line (#212) centres that, so
  // "where I stopped reading" is what the member sees first; otherwise the
  // very end (#183) — the newest message and any draft after it.
  const lastMessage = timeline.data?.at(-1);
  useEffect(() => {
    if (timeline.data === undefined || !timelineView.ready || landed === openKey) {
      return;
    }
    // The timeline may first render from the persisted cache (last
    // session's copy, #30) before this open's own read lands. A landing
    // that targets a particular message waits for it — in that copy, or in
    // the fresh read — rather than spending itself on rows that don't hold
    // it yet; "the end" doesn't need to wait, and what the fresh read
    // appends then follows on.
    const target = at ?? unreadFoundEventId;
    const targetIndex = target === null ? -1 : rowIndexOf(target);
    if (target !== null && targetIndex < 0 && !timeline.isFetchedAfterMount) {
      return;
    }
    setLanded(openKey);
    if (targetIndex >= 0) {
      scrollToRow(targetIndex);
    } else if (at === undefined) {
      scrollToEnd();
    }
  });
  // The member's own send goes to the end, wherever they were reading —
  // they've just said something, and that's where it is. (Someone else's
  // arrival only follows when the member is already at the end:
  // `useChatTimeline`'s followOnAppend.)
  const ownLatest = lastMessage !== undefined && connection !== null && lastMessage.senderId === connection.userId && lastMessage.pending === true;
  const lastKey = lastMessage?.eventId;
  useEffect(() => {
    if (ownLatest && at === undefined) {
      scrollToEnd();
    }
    // Keyed on the newest message alone: a fresh own echo, once.
  }, [lastKey]);

  if (!connection || timeline.isLoading) {
    return (
      <div className="p-6">
        <h1 className="type-heading sr-only">{roomName}</h1>
        <RouteLoading variant="rows" />
      </div>
    );
  }
  if (timeline.error !== null || timeline.data === undefined) {
    return (
      <div className="p-6">
        <h1 className="type-heading sr-only">{roomName}</h1>
        <p className="type-body text-[var(--escalate)]">The workspace didn&apos;t give up this conversation — try again.</p>
        <button
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
          onClick={() => void timeline.refetch()}
        >
          Try again
        </button>
      </div>
    );
  }
  // #225: an address naming a room this account isn't in — wrong org, never
  // joined, or left since (a copied link's whole reason for AC3) — says so
  // plainly, rather than an empty room with a composer that could only fail
  // to send. `rooms()` already lists only joined rooms (#214), so "not
  // among them" is the one honest way to read "not accessible" here.
  if (rooms.isSuccess && room === undefined) {
    return (
      <div className="p-6">
        <h1 className="type-heading sr-only">{roomName}</h1>
        <p className="type-body text-[var(--escalate)]" data-testid="room-not-accessible">
          You can&apos;t see this conversation — it may be in a different organisation, or you may not be a member.
        </p>
        <a
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
          data-testid="room-not-accessible-back"
          href="#chats"
        >
          Back to conversations
        </a>
      </div>
    );
  }

  // Opening at a message and reading the whole room are different windows: what the second one adds is history, not news.
  if (seen.current.roomId !== roomId || seen.current.at !== at || seen.current.ids === null) {
    seen.current = { roomId, at, ids: new Set(timeline.data.map((message) => message.eventId)) };
  }
  const already = seen.current.ids;

  // #211: a scroll near the top of the loaded window extends it backward one
  // page — never for a search window (#70: there's no "further back" to a
  // fixed context window) or while a page is already on its way.
  const handleScroll = (): void => {
    // Not before the first landing: until then the view is at the top only
    // because nothing has scrolled it yet, not because the member went there.
    if (at !== undefined || landed !== openKey || olderState.loading || olderState.atStart) {
      return;
    }
    const el = timelineView.scrollerRef.current;
    if (!el || el.scrollTop > SCROLLBACK_TRIGGER_PX) {
      return;
    }
    // The page lands as rows prepended above the member's place, and the
    // virtualizer keeps that place (`anchorTo: "end"` — the row under the
    // viewport's top keeps its offset), so nothing here touches the scroll.
    setOlderState((state) => ({ ...state, loading: true }));
    void connection
      .loadOlder(roomId)
      .then(async (result) => {
        if (result.loadedMore) {
          await timeline.refetch();
        }
        setOlderState({ loading: false, atStart: result.atStart });
      })
      .catch(() => {
        setOlderState((state) => ({ ...state, loading: false }));
      });
  };

  // #215: a quote's original, brought into view and briefly outlined —
  // wherever it is in the loaded window, rendered right now or not.
  const jumpToMessage = (eventId: string): void => {
    scrollToRow(rowIndexOf(eventId));
    setJumpedTo(eventId);
    window.setTimeout(() => setJumpedTo((current) => (current === eventId ? null : current)), 1500);
  };

  // #212: the dwell already confirmed the member actually saw the line
  // (`UnreadLine`'s own timer) — this is the one call that moves the
  // homeserver's marker past it, and the one place the line stops rendering.
  const handleRead = (eventId: string): void => {
    setMarkedRead(true);
    void connection.advanceReadMarker(roomId, eventId).catch(() => undefined);
  };

  // The line rides on its row, so bringing the row into view brings the line.
  const scrollDividerIntoView = (): void => {
    if (unreadFoundEventId !== null) {
      scrollToRow(rowIndexOf(unreadFoundEventId));
    }
  };

  // #212's AC3 note and #211's own dependency: when the anchor is already on
  // screen, jumping is just scrolling to it; when it's older than anything
  // loaded (`unknown`), this pages backward looking for it — bounded — and
  // falls back to the top if it doesn't turn up quickly, same as #211 AC2's
  // own honest "this is the beginning" landing.
  const jumpToUnread = (): void => {
    if (boundary.kind === "found") {
      scrollDividerIntoView();
      return;
    }
    if (boundary.kind !== "unknown" || olderState.loading || anchorEventId === null) {
      return;
    }
    setOlderState((state) => ({ ...state, loading: true }));
    void (async () => {
      for (let page = 0; page < UNREAD_SEARCH_PAGE_CAP; page++) {
        const result = await connection.loadOlder(roomId);
        if (result.loadedMore) {
          await timeline.refetch();
        }
        const boundaryNow = connection.unreadBoundaryFrom(roomId, anchorEventId);
        if (boundaryNow.kind === "found" || result.atStart) {
          setOlderState({ loading: false, atStart: result.atStart });
          if (boundaryNow.kind === "found") {
            // The rows the page added render on the next commit; the jump
            // targets the line's row by key once they have.
            const target = boundaryNow.eventId;
            requestAnimationFrame(() => setPendingJump(target));
          } else {
            timelineView.scrollToTop();
          }
          return;
        }
      }
      setOlderState((state) => ({ ...state, loading: false }));
      timelineView.scrollToTop();
    })();
  };

  const showJumpToUnread =
    at === undefined && !markedRead && ((boundary.kind === "found" && !dividerVisible) || boundary.kind === "unknown");

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-[var(--edge)] px-4 py-2" data-testid="room-header">
        <h1 className="min-w-0 truncate type-heading">{roomName}</h1>
        {offTheRecordControl && <div className="ml-auto flex items-center">{offTheRecordControl}</div>}
        <InfoButton />
      </header>
      {duoConversation !== null && <DuoConversationBanner conversation={duoConversation} />}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* #211: a page on its way up top. Floats over the transcript rather
            than sitting in its flow: a line appearing above the member's place
            would push every row down without being one the virtualizer could
            anchor through. */}
        {at === undefined && olderState.loading && (
          <p
            className="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-full border border-[var(--edge)] bg-[var(--surface)] px-3 py-1 type-provenance text-[var(--muted)]"
            data-testid="room-loading-older"
          >
            Loading older messages…
          </p>
        )}
        <div className="relative flex-1 overflow-y-auto px-6" data-testid="room-scroller" ref={timelineView.scrollerRef} onScroll={handleScroll}>
          <a
            className="mt-6 inline-flex min-h-11 items-center self-start rounded-[var(--r-sm)] px-2 type-provenance uppercase text-[var(--muted)]"
            data-testid="back-to-conversations"
            href="#chats"
          >
            All conversations
          </a>
          <ChatTimelineList
            count={rows.length}
            testId="room-timeline"
            timeline={timelineView}
            renderRow={(index) => {
              const row = rows[index]!;
              switch (row.kind) {
                case "beginning":
                  // #211: the homeserver's own word — nothing further back
                  // than what's already loaded.
                  return (
                    <p className="py-2 text-center type-provenance text-[var(--muted)]" data-testid="room-beginning">
                      This is the beginning of the conversation.
                    </p>
                  );
                case "at-missing":
                  // The workspace's window didn't hold the message this address
                  // named (struck since, or never a row of this conversation) —
                  // said, rather than landing somewhere else quietly.
                  return (
                    <p className="text-[var(--muted)]" data-testid="room-at-missing">
                      That message isn&apos;t in what the workspace returned — it may have been deleted.
                    </p>
                  );
                case "empty":
                  return (
                    <p className="text-[var(--muted)]" data-testid="room-empty">
                      Nothing here yet — say something below.
                    </p>
                  );
                case "message": {
                  const message = row.message;
                  return (
                    <>
                      {/* #212: drawn once, right above the first row this member
                          hasn't seen yet — gone as soon as the dwell below
                          confirms they actually have. */}
                      {unreadFoundEventId === message.eventId && (
                        <UnreadLine
                          scrollerRef={timelineView.scrollerRef}
                          onVisibilityChange={setDividerVisible}
                          onRead={() => handleRead(message.eventId)}
                        />
                      )}
                      <RoomEntry
                        // #215: a search landing and a reply's own jump share one
                        // outline — whichever brought this row into view.
                        focused={message.eventId === at || message.eventId === jumpedTo}
                        // Only what someone else says rises in: the owner's own words already appeared where they typed them, and their echo id changing must not play it twice.
                        live={already !== null && !already.has(message.eventId) && message.senderId !== connection.userId}
                        message={message}
                        connection={connection}
                        roomId={roomId}
                        refresh={refresh}
                        conversation={timeline.data}
                        questionOutcome={
                          duoConversation === null ? null : questionOutcomeLine(outcomes?.get(message.eventId), duoConversation.ownerLabel)
                        }
                        onDelete={(message) => {
                          setDeleteError(null);
                          setDeleteTarget(message);
                        }}
                        onReply={at === undefined ? setReplyTarget : undefined}
                        onJumpToReply={jumpToMessage}
                        onActiveChange={setRowActive}
                        onPinAnswer={onPinAnswer}
                      />
                    </>
                  );
                }
              }
            }}
          />
          {/* #68, #183: the owner's drafts for this conversation, at the end of
              the owner's own view of it — unsent, visible only here, never
              part of what its members read until Send. Only at the live
              end: a view opened at an older message has newer ones after it. */}
          <div className="pb-6" ref={timelineView.footerRef}>
            {at === undefined && drafts}
          </div>
        </div>
      </div>
      {/* #212 AC2: the line itself is where it is; this is for when it isn't on screen. */}
      {showJumpToUnread && (
        <div className="border-t border-[var(--edge)] px-4 py-2">
          <button
            className="inline-flex min-h-9 items-center rounded-[var(--r-sm)] border border-[var(--accent)] px-3 type-provenance text-[var(--accent)]"
            data-testid="jump-to-unread"
            type="button"
            onClick={jumpToUnread}
          >
            Jump to first unread
          </button>
        </div>
      )}
      {at === undefined ? (
        <RoomComposer
          connection={connection}
          roomId={roomId}
          roomName={roomName}
          members={room?.members ?? []}
          replyTarget={replyTarget}
          onCancelReply={() => setReplyTarget(null)}
          onFactCheck={onFactCheck}
          onRewrite={onRewrite}
        />
      ) : (
        // A window into history has no composer: the words go to the live
        // conversation, one link away.
        <div className="border-t border-[var(--edge)] p-4">
          <a
            className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
            data-testid="room-back-to-latest"
            href={roomHref(roomId)}
          >
            Back to the latest messages
          </a>
        </div>
      )}
      {/* A delete asks first: the words go for everyone, and the surface
          says so in the same words it will show afterwards. */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
      >
        {heldDelete && (
          <DialogContent data-testid="delete-message-dialog">
            <DialogTitle>Delete this message?</DialogTitle>
            <DialogDescription>
              The words go for everyone in the conversation and cannot come back — the row stays behind, saying a message was struck.
            </DialogDescription>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
                data-testid="delete-message-cancel"
                onClick={() => setDeleteTarget(null)}
              >
                Keep it
              </button>
              <button
                className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] bg-[var(--escalate)] px-3 text-[var(--bg)] type-body"
                data-testid="delete-message-confirm"
                disabled={deleteBusy}
                onClick={() => {
                  const target = deleteTarget;
                  if (!target) {
                    return;
                  }
                  setDeleteBusy(true);
                  setDeleteError(null);
                  // A delete the workspace refuses must not close the ask
                  // behind it: the words still stand on the server, and the
                  // member deserves to hear the refusal where they acted.
                  void connection
                    .delete(roomId, target.eventId)
                    .then(() => {
                      setDeleteTarget(null);
                    })
                    .catch(() => {
                      setDeleteError("The workspace didn't take that — try again.");
                    })
                    .finally(() => {
                      setDeleteBusy(false);
                      refresh();
                    });
                }}
              >
                {deleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
            {deleteError && (
              <p className="mt-3 type-body text-[var(--refused)]" data-testid="delete-message-error">
                {deleteError}
              </p>
            )}
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

/**
 * One message's reading half — attribution by the id's grammar, the words,
 * the edit mark, the pending mark, the server's time, and the reactions
 * under it. Shared by the conversation's flow and the thread view (#64),
 * so a message reads identically wherever it's read; the conversation's
 * rows add the verbs around it, the thread view adds its own composer.
 * #66: a share renders as the SharedFileCard inside the same attribution
 * containers — a file message is a message, by whoever shared it.
 */
export function MessageBody({
  message,
  loadMedia,
  getUrlPreview,
  conversation = [],
  questionOutcome = null,
  onToggleReaction,
  onRetry,
  onCancel,
  onJumpToReply,
}: {
  message: RoomMessage;
  /** #313: what became of this question to a colleague's duo — answered, passed on, declined. */
  questionOutcome?: QuestionOutcomeLine | null;
  /** The member's own authenticated fetch of a shared file's bytes — the connection's, passed down so this stays a pure render. */
  loadMedia: (url: string) => Promise<Blob | null>;
  /** #219: the connection's own link-preview fetch — passed down for the same reason `loadMedia` is: this stays a pure render, never its own door to the SDK. */
  getUrlPreview: WorkspaceConnection["getUrlPreview"];
  /** The room's timeline, in order — what a passed-on question reads to see whether its owner has answered (#67). */
  conversation?: readonly RoomMessage[];
  onToggleReaction?: (message: RoomMessage, key: string, mine: boolean) => void;
  /** #209: tries a failed send again — offered only where a failed row can appear (the composer's own, main flow and thread alike). */
  onRetry?: (message: RoomMessage) => void;
  /** #209: takes a failed send back — the row goes. */
  onCancel?: (message: RoomMessage) => void;
  /** #215: the quote above a reply is clickable — brings its original into view, when this device already holds it (see `Room`'s `jumpToMessage`). */
  onJumpToReply?: (eventId: string) => void;
}) {
  const fromDuo = isDuoUserId(message.senderId);
  // #67: a duo's composed words read back as an answer, an outcome, or
  // nothing special — by the sender's id, never by what the words claim
  // (a person typing the same composition gets plain words). Words that
  // carry mention pills stay as they are: the daemon composes plain text.
  const duoReading = fromDuo && message.parts === null ? readDuoAnswer(message.body) : null;
  // #219: a preview rides below the plain words of a text message (never a
  // duo's composed answer, which already carries its own trust scaffolding,
  // and never a struck or shared-file row) — and only when the viewing
  // member opted in; readUrlPreviewPref() is checked here so a member who
  // hasn't opted in never even reaches LinkPreviewCard, which is where the
  // homeserver fetch would actually be asked for.
  const previewUrl =
    !message.redacted && message.file === undefined && duoReading === null && readUrlPreviewPref()
      ? firstLinkOf(message.body)
      : null;
  if (message.redacted) {
    // A struck message keeps its place and says so — the timeline never
    // reshuffles to hide that something was said.
    return (
      <div className="flex flex-col gap-1">
        <p
          className="rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3 type-body text-[var(--faint)] italic"
          data-testid="room-message-deleted"
        >
          Message deleted
        </p>
        <p className="type-provenance text-[var(--faint)]">
          <Timestamp iso={new Date(message.originServerTs).toISOString()} />
        </p>
      </div>
    );
  }
  // #215: the message this one quotes — read straight out of the window
  // this device already holds (`conversation`), never fetched fresh. Absent
  // when the message isn't a reply, or when its target isn't in that
  // window (an older message this device hasn't loaded, or one since
  // struck off the server and gone from every copy) — the quote then
  // simply doesn't render rather than guess at words nobody here has.
  const quoted = message.replyToEventId === null ? undefined : conversation.find((candidate) => candidate.eventId === message.replyToEventId);
  const content =
    message.file === undefined ? (
      duoReading ? (
        <RoomDuoAnswer
          escalation={escalationOf(message, conversation)}
          ownerLabel={duoOwnerLabel(message.senderId) ?? message.senderName}
          reading={duoReading}
        />
      ) : (
        <>
          {/* #213: another client's rich text — once there's a `formatted_body`
              it's the richer of the two, so it renders in place of the plain
              parts/body `messageWords` would otherwise show (which is itself
              only ever non-null when a `formatted_body` carried the mention
              anchors it was built from — see matrix.ts's `partsOfEvent`). */}
          {message.formattedBody !== undefined ? (
            <MessageBodyHtml formattedBody={message.formattedBody} loadMedia={loadMedia} mentionLabels={message.mentionLabels ?? {}} />
          ) : (
            messageWords(message)
          )}
          {previewUrl !== null && <LinkPreviewCard getUrlPreview={getUrlPreview} loadMedia={loadMedia} url={previewUrl} />}
        </>
      )
    ) : (
      <SharedFileCard file={message.file} loadMedia={loadMedia} />
    );
  return (
    <div className="flex flex-col gap-1">
      {fromDuo ? (
        <RoomDuoMessage ownerName={duoOwnerLabel(message.senderId) ?? message.senderName}>
          {message.replyToEventId !== null && (
            <ReplyQuote quoted={quoted} onJump={onJumpToReply && (() => onJumpToReply(message.replyToEventId!))} />
          )}
          {content}
        </RoomDuoMessage>
      ) : (
        <RoomPersonMessage authorName={message.senderName}>
          {message.replyToEventId !== null && (
            <ReplyQuote quoted={quoted} onJump={onJumpToReply && (() => onJumpToReply(message.replyToEventId!))} />
          )}
          {content}
        </RoomPersonMessage>
      )}
      <p className="type-provenance text-[var(--faint)]">
        <Timestamp iso={new Date(message.originServerTs).toISOString()} />
        {questionOutcome !== null && (
          <span className="ml-1" data-outcome={questionOutcome.outcome} data-testid="room-question-outcome">
            · {questionOutcome.words}
          </span>
        )}
        {message.edited && (
          <span className="ml-1" data-testid="room-message-edited">
            (edited)
          </span>
        )}
        {message.pending && (
          <span className="ml-1" data-testid="room-message-pending">
            Sending…
          </span>
        )}
        {message.failed && (
          <span className="ml-1" data-testid="room-message-failed">
            Not sent.
            {onRetry && (
              <button
                className="ml-1 underline"
                data-testid="room-message-retry"
                type="button"
                onClick={() => onRetry(message)}
              >
                Retry
              </button>
            )}
            {onCancel && (
              <button
                className="ml-1 underline"
                data-testid="room-message-cancel"
                type="button"
                onClick={() => onCancel(message)}
              >
                Cancel
              </button>
            )}
          </span>
        )}
      </p>
      {message.reactions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {message.reactions.map((reaction) => (
            <button
              key={reaction.key}
              className={`inline-flex min-h-9 items-center gap-1 rounded-full border px-2 type-provenance ${
                reaction.mine ? "border-[var(--accent)] text-[var(--text)]" : "border-[var(--edge)] text-[var(--muted)]"
              }`}
              data-testid="room-reaction"
              disabled={onToggleReaction === undefined}
              onClick={() => onToggleReaction?.(message, reaction.key, reaction.mine)}
            >
              <span aria-hidden="true">{reaction.key}</span> {reaction.count}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One row of the conversation's flow: the message, the verbs this member
 * may perform on it, and the thread it may have gathered. Own messages
 * (by sender id, never by display name) carry Edit and Delete; React and
 * Reply-in-thread are everyone's; the thread preview is the root's
 * summary, attributed structurally like any sender.
 *
 * #252: the verbs are no longer a permanent row. On a pointer device they're
 * a toolbar that appears on hover and on keyboard focus (and stays while
 * something they opened — the reaction picker, an edit — is still live, so
 * moving the mouse down into it never hides it mid-interaction). On a touch
 * device there's no hover to reveal anything, so a long press on the
 * message opens the same verbs as a sheet (the app's own `DropdownMenu`,
 * `useLongPress`'s gesture) — reachable without the gesture too, by a
 * keyboard, through a trigger that's invisible until it's focused.
 */
/** #313: one question's outcome, as the row shows it — null for a message that isn't a question to the duo. */
export interface QuestionOutcomeLine {
  readonly outcome: QuestionOutcome;
  readonly words: string;
}

function questionOutcomeLine(outcome: QuestionOutcome | undefined, ownerLabel: string): QuestionOutcomeLine | null {
  return outcome === undefined ? null : { outcome, words: questionOutcomeWords(outcome, ownerLabel) };
}

export function RoomEntry({
  message,
  focused = false,
  live = false,
  connection,
  roomId,
  refresh,
  conversation,
  questionOutcome = null,
  onDelete,
  onReply,
  onJumpToReply,
  onActiveChange,
  onPinAnswer,
}: {
  message: RoomMessage;
  /** Arrived while the room was open: it rises in. History never animates. */
  live?: boolean;
  /** #70/#215: the message a search hit landed at, or a quote's original just jumped to — marked (`Room` brings it into view). */
  focused?: boolean;
  connection: WorkspaceConnection;
  roomId: string;
  refresh: () => void;
  conversation: readonly RoomMessage[];
  /** #313: in a conversation with a colleague's duo, what became of this question. */
  questionOutcome?: QuestionOutcomeLine | null;
  onDelete: (message: RoomMessage) => void;
  /** #215: starts a reply to this message — the composer takes it from here. */
  onReply?: (message: RoomMessage) => void;
  /** #215: brings a quoted original into view — passed straight through to `MessageBody`. */
  onJumpToReply?: (eventId: string) => void;
  /**
   * #248: whether this row holds something of the member's in progress — an
   * open edit, an open reaction picker, a verb on its way. The transcript is
   * virtualized, and a row scrolled out of view unmounts; a row that's busy
   * like this asks to stay mounted so scrolling away never throws away an
   * edit half-typed.
   */
  onActiveChange?: (eventId: string, active: boolean) => void;
  /** duo#275: "Duo: always answer this way" — plain callback, see `Room`'s own doc comment on this prop. `undefined` hides the action. */
  onPinAnswer?: (pattern: string, answerText: string) => Promise<unknown>;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // #291: the full picker behind the quick six's "+" — its own flag so the
  // quick six's row (and its "stays open while busy" rule) is unchanged;
  // this just adds a dialog above it with every emoji, not six.
  const [fullPickerOpen, setFullPickerOpen] = useState(false);
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #225: entirely local — a permalink is built from facts already in hand,
  // no daemon or homeserver round-trip, so copying one never waits on
  // either and never competes with `busy`.
  const [linkState, setLinkState] = useState<"idle" | "copied" | "failed">("idle");
  // #252: a pointer over the row, or keyboard focus somewhere inside it —
  // either reveals the toolbar on a device that hovers. `focusWithin` tracks
  // real DOM focus (React's bubbling `onFocus`/`onBlur`), not a guess from
  // hover, so a keyboard user who never moves a mouse still sees what they
  // tabbed to.
  const [hovering, setHovering] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  // #252: the phone sheet (a controlled `DropdownMenu`) — open from a long
  // press, or from its own focus-reachable trigger.
  const [menuOpen, setMenuOpen] = useState(false);
  const touchPrimary = useTouchPrimary();
  const own = message.senderId === connection.userId;
  const active = editing || pickerOpen || fullPickerOpen || busy || menuOpen || pinDialogOpen;
  const toolbarVisible = active || hovering || focusWithin;
  useEffect(() => {
    onActiveChange?.(message.eventId, active);
    // Reported on change only; the callback is the room's own, stable for the open.
  }, [active, message.eventId]);
  const longPress = useLongPress(() => setMenuOpen(true), touchPrimary);

  // Every verb ends the same way: hand it to the homeserver, then re-read
  // the server's answer — the local copy never stands in for the record.
  const run = (op: Promise<void>): void => {
    setBusy(true);
    setError(null);
    op
      .then(() => undefined)
      .catch(() => setError("The workspace didn't take that — try again."))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };

  // #252: one list of what this member may do with this message, read once
  // and rendered two ways — a toolbar's buttons on a pointer device, a
  // sheet's items on a touch one — so which actions apply (own-message
  // Edit/Delete above all) is decided in exactly one place, not twice in
  // step.
  const actions: readonly {
    key: string;
    label: string;
    href?: string;
    onClick?: () => void;
    disabled?: boolean;
    testId?: string;
  }[] = [
    { key: "react", label: "React", onClick: () => setPickerOpen((open) => !open), disabled: busy || message.redacted },
    { key: "reply-thread", label: "Reply in thread", href: threadHref(roomId, message.eventId) },
    // #225: a pending or failed send's id is a local echo, not yet the
    // homeserver's own — there is nothing stable to point at until it lands.
    ...(!message.pending && !message.failed
      ? [
          {
            key: "copy-link",
            label: linkState === "copied" ? "Copied" : linkState === "failed" ? "Copy failed" : "Copy link",
            disabled: busy,
            testId: "room-message-copy-link",
            onClick: () => {
              const link = messagePermalink(roomId, message.eventId);
              const clipboard: Clipboard | undefined = navigator.clipboard;
              if (!clipboard) {
                setLinkState("failed");
                return;
              }
              clipboard
                .writeText(link)
                .then(() => setLinkState("copied"))
                .catch(() => setLinkState("failed"));
            },
          },
        ]
      : []),
    ...(onReply && !message.redacted
      ? [{ key: "reply", label: "Reply", disabled: busy, testId: "reply-action", onClick: () => onReply(message) }]
      : []),
    ...(own && !message.redacted && message.file === undefined
      ? [
          {
            key: "edit",
            label: "Edit",
            disabled: busy,
            onClick: () => {
              setDraft(message.body);
              setEditing(true);
            },
          },
        ]
      : []),
    ...(own && !message.redacted ? [{ key: "delete", label: "Delete", disabled: busy, onClick: () => onDelete(message) }] : []),
    // duo#275: pinning what the owner already sent — never a pending/failed
    // echo (nothing stable to quote yet), never a share (there is no exact
    // wording to pin), never a redacted row (the words are gone).
    ...(own && !message.redacted && !message.pending && !message.failed && message.file === undefined && onPinAnswer
      ? [{ key: "pin-answer", label: "Duo: always answer this way", disabled: busy, testId: "pin-answer-action", onClick: () => setPinDialogOpen(true) }]
      : []),
  ];

  const messageBody = (
    <MessageBody
      message={message}
      loadMedia={connection.loadMedia}
      getUrlPreview={connection.getUrlPreview}
      conversation={conversation}
      questionOutcome={questionOutcome}
      onToggleReaction={(target, key, mine) =>
        run(mine ? connection.unreact(roomId, target.eventId, key) : connection.react(roomId, target.eventId, key))
      }
      onRetry={(target) => run(connection.retry(roomId, target.eventId))}
      onCancel={(target) => {
        connection.cancel(roomId, target.eventId);
        refresh();
      }}
      onJumpToReply={onJumpToReply}
    />
  );

  return (
    <div
      aria-current={focused ? "true" : undefined}
      className={`flex flex-col gap-1 ${live ? "motion-rise" : ""} ${focused ? "rounded-[var(--r-md)] outline outline-2 outline-offset-4 outline-[var(--accent)]" : ""}`}
      data-focused={focused ? "true" : undefined}
      data-testid="room-message"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFocusWithin(false);
        }
      }}
      onFocus={() => setFocusWithin(true)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {/* #252: on touch, the bubble itself is the long-press surface — a
          hold opens the sheet below; a quick tap (the gesture's own
          `onClickCapture`) does nothing more than it always did. */}
      {touchPrimary ? (
        <div data-testid="room-message-bubble" {...longPress}>
          {messageBody}
        </div>
      ) : (
        messageBody
      )}
      {message.thread !== null && message.thread.replyCount > 0 && message.thread.latestReply !== null && (
        <p className="type-provenance text-[var(--muted)]" data-testid="room-thread-preview">
          {threadPreviewLabel(message.thread.latestReply)}: {plainPreview(message.thread.latestReply.body)} ·{" "}
          {message.thread.replyCount} {message.thread.replyCount === 1 ? "reply" : "replies"}{" "}
          <a className="underline" data-testid="open-thread" href={threadHref(roomId, message.eventId)}>
            Open thread
          </a>
        </p>
      )}
      {touchPrimary ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button className={sheetTriggerClass} data-testid="room-message-actions-trigger" type="button">
              Message actions
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" data-testid="room-message-actions">
            {actions.map((action) => (
              <DropdownMenuItem
                asChild={action.href !== undefined}
                data-testid={action.testId}
                disabled={action.disabled}
                key={action.key}
                onSelect={action.href === undefined ? () => action.onClick?.() : undefined}
              >
                {action.href !== undefined ? <a href={action.href}>{action.label}</a> : action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // #252: hidden until the row is hovered, focused (keyboard, Tab),
        // or something it opened is still active — never a permanent row.
        // `pointer-events-none` while hidden is belt-and-braces only: the
        // visibility is already gated above, this just keeps a stray mouse
        // from reaching an invisible button.
        <div
          className={`flex flex-wrap gap-1 transition-opacity motion-reduce:transition-none ${toolbarVisible ? "opacity-100" : "pointer-events-none opacity-0"}`}
          data-testid="room-message-actions"
        >
          {actions.map((action) =>
            action.href !== undefined ? (
              <a className={rowActionClass} data-testid={action.testId} href={action.href} key={action.key}>
                {action.label}
              </a>
            ) : (
              <button
                className={rowActionClass}
                data-testid={action.testId}
                disabled={action.disabled}
                key={action.key}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ),
          )}
        </div>
      )}
      {pickerOpen && !message.redacted && (
        <div className="flex flex-wrap gap-1" data-testid="reaction-picker">
          {REACTION_CHOICES.map((key) => (
            <button
              key={key}
              aria-label={`React ${key}`}
              className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-body"
              disabled={busy}
              onClick={() => {
                setPickerOpen(false);
                recordReactionRecent(key);
                run(connection.react(roomId, message.eventId, key));
              }}
            >
              {key}
            </button>
          ))}
          {/* #291: the quick six stays the fast path; this opens every other
              emoji in a searchable picker, a popover on a pointer device and
              a bottom sheet on touch (same `sheet` rule the rest of the app
              uses for a phone dialog). */}
          <button
            aria-label="More emoji"
            className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-body text-[var(--muted)]"
            data-testid="reaction-picker-more"
            disabled={busy}
            onClick={() => setFullPickerOpen(true)}
          >
            +
          </button>
        </div>
      )}
      <Dialog open={fullPickerOpen} onOpenChange={setFullPickerOpen}>
        <DialogContent data-testid="emoji-picker-dialog" sheet={touchPrimary}>
          <DialogTitle>React with an emoji</DialogTitle>
          <DialogDescription>Search any emoji, or pick one you've used recently.</DialogDescription>
          <EmojiPicker
            recents={fullPickerOpen ? readReactionRecents() : []}
            onPick={(emoji) => {
              setFullPickerOpen(false);
              setPickerOpen(false);
              recordReactionRecent(emoji);
              run(connection.react(roomId, message.eventId, emoji));
            }}
          />
        </DialogContent>
      </Dialog>
      {editing && (
        <form
          className="flex flex-col gap-2"
          data-testid="room-message-edit"
          onSubmit={(e) => {
            e.preventDefault();
            const body = draft.trim();
            if (body.length === 0) {
              return;
            }
            setEditing(false);
            run(connection.edit(roomId, message.eventId, body));
          }}
        >
          <textarea
            aria-label="Edit message"
            className="min-h-22 flex-1 resize-none rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-1 text-[var(--text)]"
            rows={Math.max(1, Math.min(8, draft.split("\n").length))}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
          />
          <div className="flex justify-end gap-2">
            <button
              className="inline-flex min-h-9 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance"
              disabled={busy}
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(message.body);
              }}
            >
              Cancel
            </button>
            <button
              className="inline-flex min-h-9 items-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] type-provenance disabled:opacity-40"
              disabled={busy || draft.trim().length === 0}
              type="submit"
            >
              Save
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="room-message-error">
          {error}
        </p>
      )}
      {onPinAnswer && (
        <PinAnswerDialog
          answerText={message.body}
          // Prefilled from the question this message replied to, when
          // there was one and this device's own copy of the conversation
          // still holds it — otherwise blank, and the owner names the
          // topic themselves.
          defaultPattern={
            message.replyToEventId ? (conversation.find((candidate) => candidate.eventId === message.replyToEventId)?.body ?? "") : ""
          }
          onOpenChange={setPinDialogOpen}
          onPin={onPinAnswer}
          open={pinDialogOpen}
        />
      )}
    </div>
  );
}

/**
 * The member's half of the room: a person saying something, on the app's
 * one composer editor (#248's `ChatEditor`, markdown mode — Enter sends,
 * Shift+Enter is a new line, #244). #64 AC1 / #209: the composer clears and the words
 * render immediately as the sender's own marked copy — matrix-js-sdk's own
 * local echo (`connect()`'s Detached pending-event ordering), never a
 * second copy this client writes into a cache. A failed send keeps its row,
 * marked failed, with Retry and Cancel (`MessageBody`/`RoomEntry`); the
 * composer itself never held the words past Enter, so there is nothing for
 * it to take back. #65: an "@" the member types offers the room's members —
 * people and the duos present, clearly distinguished — and the picks ride
 * the wire as m.mentions (the editor's own mention nodes, read at send time).
 *
 * #66 adds the share: files attach here, refuse or stage by this app's own
 * named share limits, then ride the submit — each attachment uploads and
 * sends as its own `m.file`/`m.image` message, in order, BEFORE the text.
 * That order is the backend's association convention made visible (core
 * #190: the asker's own contiguous file messages immediately preceding
 * their question in the same room), so "attach, then ask" is exactly what
 * the wire carries. Sharing is not importing — the upload goes to the
 * homeserver's media store for the people in the room, and nothing here
 * can reach any daemon's corpus.
 */
function RoomComposer({
  connection,
  roomId,
  roomName,
  members,
  replyTarget = null,
  onCancelReply,
  onRewrite,
  onFactCheck,
}: {
  connection: WorkspaceConnection;
  roomId: string;
  roomName: string;
  members: readonly RoomMemberRef[];
  /** #215: the message this send will quote — set by a row's "Reply" action, held by `Room`. */
  replyTarget?: RoomMessage | null;
  /** #215: cancels the reply in progress — the composer never holds this state itself, so cancelling and sending both just ask `Room` to let go of it. */
  onCancelReply?: () => void;
  /** #263/#264: `undefined` when there's no paired duo — the rewrite button disabled rather than hidden (see `RewriteMenu`'s own doc comment), and the fact-check assist never calling out. */
  onRewrite?: (text: string, instruction: RewriteInstruction) => Promise<string>;
  onFactCheck?: (text: string, threadContext: string | null) => Promise<{ claim: string; concern: string; sourceLabel: string } | null>;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const form = useRef<HTMLFormElement | null>(null);
  const editor = useRef<ChatEditorHandle | null>(null);
  // #264: this member's own opt-in, read fresh on mount — off unless
  // Settings says otherwise (factCheckPrefs.ts).
  const [factCheckEnabled] = useState<boolean>(readFactCheckPref);
  // The editor's composed body, mirrored for the one thing the form itself
  // needs to know before Send: whether there's anything to send at all.
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<StagedShare[]>([]);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();
  const disabled = (trimmed.length === 0 && attachments.length === 0) || pending;
  const duos = members.filter((member) => isDuoUserId(member.userId));
  // #65: who an "@" offers — the room's members, the member themself excepted.
  const mentionCandidates = useMemo(() => mentionCandidatesOf(members, connection.userId), [members, connection.userId]);
  // #217: a drag that enters a child element fires its own dragenter/
  // dragleave — a plain boolean would flicker the indicator every time the
  // pointer crosses an inner element's edge. The counter only reaches zero
  // once the drag has actually left every element of the composer.
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);

  /**
   * Stages what this app will share and says why about what it won't — the
   * refusal names the limit and keeps everything. #217: the exact same
   * door the file picker's input already used — a pasted image and a
   * dropped file are just a different SOURCE of the same `File` objects,
   * never a second validation path to keep in step with this one.
   */
  const stage = (files: Iterable<File>): void => {
    // Snapshot before the first await: resetting the input's value after
    // handing its FileList over empties the live list, and the member's
    // pick must not depend on that timing.
    const picked = [...files];
    void (async () => {
      const staged: StagedShare[] = [];
      const refusals: string[] = [];
      for (const file of picked) {
        const refusal = shareRefusalOf({ name: file.name, size: file.size, mimeType: file.type }, attachments.length + staged.length);
        if (refusal === null) {
          staged.push(await stageFile(file));
        } else {
          refusals.push(refusal);
        }
      }
      if (staged.length > 0) {
        setAttachments((current) => [...current, ...staged]);
      }
      if (refusals.length > 0) {
        setError(refusals.join(" "));
      }
    })();
  };

  return (
    <form
      className="relative border-t border-[var(--edge)] p-4"
      data-testid="room-composer"
      ref={form}
      // #217: drag-and-drop onto the composer area feeds the exact same
      // `stage` door the file picker uses — one validation path, two ways
      // in. `onDragOver` must still preventDefault even though this app
      // does nothing else there: without it the browser's own "this isn't
      // a drop target" refusal wins and `onDrop` never fires.
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragActive(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
          setDragActive(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragActive(false);
        if (e.dataTransfer.files.length > 0) {
          stage(e.dataTransfer.files);
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) {
          return;
        }
        // What the editor holds right now: the markdown source (#216 — the
        // seam turns it into `formatted_body`) and the mentions still in it.
        // A mention the member deleted is simply no longer a node, so it
        // can't ride the wire — what the message doesn't say, the wire
        // doesn't claim.
        const message = editor.current?.read() ?? { body: text, mentions: [] };
        const body = message.body.trim();
        const toShare = attachments;
        const livePicks = message.mentions;
        // #215: captured once, up front — `replyTarget` is `Room`'s state,
        // and `onCancelReply` below (the same call Cancel makes) asks it to
        // let go the instant the words are on their way, same as the text
        // and the attachments do.
        const replyingTo = replyTarget;
        setPending(true);
        setError(null);
        // The share walks one attachment at a time, in the order staged, so
        // each upload still starts only once the share ahead of it has left
        // for the wire — the association convention (core #190) needs that
        // order, even though none of these sends are awaited for it (#209).
        void (async () => {
          let sharedCount = 0;
          try {
            for (const staged of toShare) {
              setStatus(`Uploading ${staged.name}…`);
              const shared = await connection.uploadFile(staged, (sent, total) => {
                setStatus(total > 0 ? `Uploading ${staged.name}… ${Math.round((sent / total) * 100)}%` : `Uploading ${staged.name}…`);
              });
              setStatus(`Sharing ${staged.name}…`);
              // #209: handed to the homeserver without waiting on it —
              // matrix-js-sdk's own local echo puts the share's row in the
              // timeline the instant this call is made. A refusal shows on
              // that row (failed, with Retry), not here.
              connection.sendFile(roomId, shared).catch(() => undefined);
              sharedCount += 1;
            }
            if (body.length > 0) {
              // The question goes last and contiguous: the association
              // convention is the asker's own file messages immediately
              // preceding their text, same sender, same room. Same
              // fire-and-forget (#209): the row carries its own
              // "Sending…"/failed state from here on. #215: a reply rides
              // the same call, as a fourth argument only when it applies —
              // every other shape of this call (no mentions, no reply)
              // stays exactly as it was.
              (replyingTo !== null
                ? connection.send(roomId, body, livePicks, replyingTo.eventId)
                : livePicks.length > 0
                  ? connection.send(roomId, body, livePicks)
                  : connection.send(roomId, body)
              ).catch(() => undefined);
            }
            // The words are already on their way — the SDK's own local echo
            // carries them in the room's timeline — so the composer clears
            // without waiting on the homeserver (#209).
            editor.current?.clear();
            setAttachments([]);
            onCancelReply?.();
          } catch (error) {
            // Only an upload throws here — a refused send lives on its own
            // row instead (caught above). The rest stay attached and the
            // words stay typed: a question sent past a failed share would
            // ride the wrong set of files (#66 AC4).
            setAttachments(toShare.slice(sharedCount));
            setError(
              `The workspace didn't take ${toShare[sharedCount]!.name}. ${error instanceof Error && error.message.length > 0 ? `${error.message} ` : ""}It's still attached and your words are still here. Try again.`,
            );
          } finally {
            setPending(false);
            setStatus(null);
          }
        })();
      }}
    >
      {dragActive && (
        // #217: the visible drop-target — covers the composer for as long
        // as the drag sits over it, pointer-events off so the drop itself
        // still lands on the form underneath.
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[var(--r-sm)] border-2 border-dashed border-[var(--accent)] bg-[var(--surface-2)]"
          data-testid="composer-drop-target"
        >
          <p className="type-body text-[var(--text)]">Drop to attach</p>
        </div>
      )}
      {replyTarget !== null && (
        // #215: what Send is about to quote — the words at hand, not a
        // second fetch, and a cancel that leaves the composer's own text
        // and attachments exactly as they stood.
        <div className="mb-2 flex items-start gap-2 rounded-[var(--r-sm)] border-l-2 border-[var(--accent)] bg-[var(--surface-2)] px-2 py-1" data-testid="reply-preview">
          <p className="min-w-0 flex-1 truncate type-provenance text-[var(--muted)]">
            Replying to <span className="text-[var(--text)]">{mentionLabelOf(replyTarget.senderId, replyTarget.senderName)}</span>:{" "}
            {replyTarget.file !== undefined ? replyTarget.file.name : plainPreview(replyTarget.body)}
          </p>
          <button
            className="inline-flex items-center rounded-full px-1 text-[var(--muted)]"
            data-testid="reply-preview-cancel"
            type="button"
            onClick={() => onCancelReply?.()}
          >
            <X aria-label="Cancel reply" className="size-3.5" />
          </button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1" data-testid="attachment-row">
          {attachments.map((attachment, index) => (
            <span
              className="inline-flex min-h-9 items-center gap-1 rounded-full border border-[var(--edge)] px-2 type-provenance text-[var(--text)]"
              data-testid="attachment-chip"
              key={`${attachment.name}-${index}`}
            >
              <Paperclip aria-label="Attachment" className="size-3.5 shrink-0" />
              <span className="break-all">
                {attachment.name} · {formatBytes(attachment.size)}
              </span>
              <button
                className="inline-flex items-center rounded-full px-1 text-[var(--muted)]"
                data-testid="attachment-remove"
                disabled={pending}
                onClick={() => setAttachments((current) => current.filter((_, at) => at !== index))}
                type="button"
              >
                <X aria-label={`Remove ${attachment.name}`} className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-start gap-2">
        <input
          aria-label="Attach files"
          className="sr-only"
          data-testid="attach-file-input"
          multiple
          ref={fileInput}
          type="file"
          onChange={(e) => {
            if (e.currentTarget.files !== null) {
              stage(e.currentTarget.files);
            }
            // Reset so picking the same file again after removing it fires.
            e.currentTarget.value = "";
          }}
        />
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)] disabled:opacity-40"
          disabled={pending}
          onClick={() => fileInput.current?.click()}
          type="button"
        >
          <Paperclip aria-label="Attach files" className="size-4" />
        </button>
        {/* #263: polishes the owner's OWN typed text — disabled rather than
            hidden with no paired duo, so the control's presence doesn't
            itself signal whether a duo is paired. */}
        <RewriteMenu disabled={onRewrite === undefined} editorRef={editor} onRewrite={onRewrite ?? (() => Promise.reject(new Error("No duo is paired to rewrite with.")))} />
        <ChatEditor
          ariaLabel={`Message ${roomName}`}
          editorRef={editor}
          mentionCandidates={mentionCandidates}
          mode="markdown"
          placeholder={`Message ${roomName}`}
          // #217: a pasted screenshot is a clipboard file — the same `stage`
          // door the picker and a drop use; pasted words go into the editor.
          onFiles={stage}
          onSubmit={() => form.current?.requestSubmit()}
          onTextChange={(body) => {
            setText(body);
            setError(null);
          }}
        />
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
          disabled={disabled}
          type="submit"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
      {/* #264: never part of the visible layout beyond its own hover/tap
          card (a portal) — mounted here so it shares this composer's
          editor handle and live body without RoomComposer's own render
          tree needing to make room for it. */}
      <FactCheckAssist
        editorRef={editor}
        enabled={factCheckEnabled && onFactCheck !== undefined}
        text={text}
        onCheck={(checkText) =>
          onFactCheck
            ? onFactCheck(checkText, roomId)
            : Promise.resolve(null)
        }
      />
      {status !== null && (
        <p className="mt-2 type-provenance text-[var(--muted)]" data-testid="room-composer-status">
          {status}
        </p>
      )}
      {attachments.length > 0 && (
        <p className="mt-2 type-provenance text-[var(--muted)]" data-testid="attachment-note">
          {duos.length > 0
            ? `${duos.map((duo) => `${duoOwnerLabel(duo.userId) ?? localpartOf(duo.userId)}'s duo`).join(", ")} can read what you attach here when you ask next — text files up to 32 KiB are used to answer (the duo's own reading cap, smaller than this app's share limits); images are shared for people, and a duo can't read images yet — not yet. Sharing never imports: nothing is added to what any duo knows.`
            : "Attachments share with the people in this conversation — no duo is here. Sharing never imports: nothing is added to what any duo knows."}
        </p>
      )}
      {error && (
        <p className="mt-2 type-body text-[var(--refused)]" data-testid="room-composer-error">
          {error}
        </p>
      )}
    </form>
  );
}
