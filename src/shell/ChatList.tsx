import { Fragment, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Ellipsis, Settings as SettingsIcon, SquarePen, UsersRound } from "lucide-react";
import type { DuoApiConfig } from "../api/client.js";
import { usePendingT4, useRecordOutcome } from "../api/queries.js";
import { Mark } from "../components/Mark.js";
import { ConversationSearch } from "../components/ConversationSearch.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/primitives/Dialog.js";
import { useHeld } from "../components/primitives/useHeld.js";
import { TickingCount, useLingering } from "../components/TickingCount.js";
import { NewConversationDialog } from "../components/NewConversationDialog.js";
import { NewRoomDialog } from "../components/NewRoomDialog.js";
import { InviteToRoomDialog } from "../components/InviteToRoomDialog.js";
import { PendingInvites } from "../components/PendingInvites.js";
import { NoDuoPanel } from "../components/NoDuoPanel.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { Timestamp } from "../components/Timestamp.js";
import { HostedWorkspaceStatus } from "../components/HostedWorkspaceStatus.js";
import { isHostedAccess, useWorkspaceAccess } from "../workspace/access.js";
import { plainPreview } from "../workspace/duoAnswer.js";
import { roomHref } from "../workspace/links.js";
import type { NotificationMode, RoomSummary, WorkspaceConnection, WorkspaceSession } from "../workspace/matrix.js";
import type { Route } from "./routes.js";
import { roomDuoLabels, roomTitle, soleDuoLabel } from "./roomTitle.js";
import { bridgedHref, bridgedTitle, useBridgedChats, type BridgedChat } from "./bridged.js";
import { SourceBadge } from "./BridgedChat.js";
import { useWaitingItems, waitingWords, swipeActionsOf, type WaitingItem } from "./waiting.js";
import { useMentions } from "./mentions.js";
import { SwipeRow } from "./SwipeRow.js";
import { DESKTOP_QUERY, useMediaQuery } from "./useMediaQuery.js";
import { DuoLine } from "../components/DuoLine.js";
import { useSyncStatus } from "../sync.js";
import { useTrainingCount } from "../components/TrainingCards.js";
import type { HairlineState } from "../components/ConfidenceHairline.js";

function initialsOf(title: string): string {
  const words = title.split(/[\s,]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

/** A stable hue for a person's tile from a seed (their id, or the room's) — the same person reads the same colour every time, with no picture to store (#208). */
function hueOf(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

/**
 * A row's picture. A duo — yours or a colleague's — is always the mark and
 * never initials, so a duo cannot be mistaken for a person in the list
 * (Hairline P1); a person is their initials on a coloured tile (#208: a
 * stable colour per `seed` stands in for a picture — uploading one is out
 * of scope), a group or channel a `#`.
 */
function Avatar({ kind, title, seed }: { kind: "duo" | "person" | "group"; title: string; seed?: string }) {
  const hue = kind === "person" ? hueOf(seed ?? title) : null;
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)] type-identifier text-[var(--muted)]"
      data-kind={kind}
      data-testid="chat-avatar"
      style={hue === null ? undefined : { background: `hsl(${hue} 55% 90%)`, color: `hsl(${hue} 45% 32%)` }}
    >
      {kind === "duo" ? <Mark /> : kind === "group" ? "#" : initialsOf(title)}
    </span>
  );
}

/** One line in the list: the row's link, and (for a conversation) the member's own verbs behind a "more" control. */
function Row({
  href,
  active,
  avatar,
  title,
  badges,
  preview,
  previewTestId,
  meta,
  children,
  more,
  ids = { entry: "conversations-entry", link: "conversations-room", title: "room-title" },
}: {
  ids?: { entry: string; link: string; title: string };
  href: string;
  active: boolean;
  avatar: ReactNode;
  title: string;
  badges?: ReactNode;
  preview: ReactNode;
  previewTestId?: string;
  meta?: ReactNode;
  children?: ReactNode;
  more?: ReactNode;
}) {
  return (
    <div className="flex flex-col" data-testid={ids.entry}>
      <div className={`flex items-stretch gap-1 rounded-[var(--r-md)] ${active ? "bg-[var(--surface-2)]" : ""}`}>
        <a
          aria-current={active ? "page" : undefined}
          className="press grid min-h-14 min-w-0 flex-1 grid-cols-[auto_1fr_auto] items-center gap-3 rounded-[var(--r-md)] px-2 py-2"
          data-testid={ids.link}
          href={href}
        >
          {avatar}
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              {/* The name wins the space (#208): members and a duo label
                  ride the secondary line instead, so nothing here competes
                  with the title for width and it is never cut to a letter. */}
              <span className="min-w-0 flex-1 truncate type-body text-[var(--text)]" data-testid={ids.title}>
                {title}
              </span>
              {badges}
            </span>
            <span className="truncate type-provenance text-[var(--muted)]" data-testid={previewTestId}>
              {preview}
            </span>
          </span>
          <span className="flex flex-col items-end gap-1 type-provenance text-[var(--faint)]">{meta}</span>
        </a>
        {more}
      </div>
      {children}
    </div>
  );
}

/** The 2px line that says how sure the draft behind a row is — the hairline, in the list. */
function DraftLine({ state }: { state: HairlineState | null }) {
  const colour =
    state === "confident" ? "var(--confident)" : state === "refused" ? "var(--refused)" : state === null ? "var(--accent)" : "var(--escalate)";
  return (
    <span
      aria-hidden="true"
      className="mr-2 inline-block align-middle"
      data-testid="draft-line"
      style={{ width: 2, height: 12, background: colour, opacity: state === "hedged" ? 0.45 : 1 }}
    />
  );
}

function CountPill({ n, label, testId, prefix = "" }: { n: number; label: string; testId: string; prefix?: string }) {
  return (
    <span
      aria-label={label}
      className="rounded-full bg-[var(--accent)] px-2 type-identifier text-[var(--bg)]"
      data-testid={testId}
    >
      {prefix}
      {n}
    </span>
  );
}

/**
 * The sidebar's own grouping (#208): a colleague's duo split out from a
 * person so it is never mistaken for one, channels and private groups
 * sharing the `#` shelf (neither is a person or a duo, and the issue names
 * no separate shelf for a private group), then direct messages — each
 * bucket keeping the order it arrived in (the seam's own recency order,
 * `rooms()`'s `lastActiveAt`/`latest.at` sort), with a muted conversation
 * slid to the end of its own bucket rather than off the list entirely. The
 * sort is stable (`Array.prototype.sort` has been since ES2019), so "muted
 * last" never reshuffles the recency order within either half.
 */
function sectionsOf(rooms: readonly RoomSummary[]): { channels: RoomSummary[]; directs: RoomSummary[]; duos: RoomSummary[] } {
  const channels: RoomSummary[] = [];
  const directs: RoomSummary[] = [];
  const duos: RoomSummary[] = [];
  for (const room of rooms) {
    if (soleDuoLabel(room) !== null) {
      duos.push(room);
    } else if (room.kind === "direct") {
      directs.push(room);
    } else {
      channels.push(room);
    }
  }
  const mutedLast = (list: RoomSummary[]): RoomSummary[] => [...list].sort((a, b) => Number(a.muted) - Number(b.muted));
  return { channels: mutedLast(channels), directs: mutedLast(directs), duos: mutedLast(duos) };
}

/** A section's own label, above its rows — hidden entirely when its section is empty, so a sparse workspace shows no empty shelves. */
function SectionHeader({ label, testId }: { label: string; testId: string }) {
  return (
    <div className="px-2 pb-1 pt-3 type-provenance uppercase tracking-wide text-[var(--faint)]" data-testid={testId}>
      {label}
    </div>
  );
}

/**
 * The list a person lives in (docs/design-language.md §6.2): people, groups
 * and colleagues' duos, one list, with the owner's own duo pinned first —
 * even with no workspace, so there is always something to talk to. The
 * member's verbs from the old conversations list live on here (start one,
 * leave one, set what may interrupt from one), each an operation on the
 * member's own account, so the list's reflection after any of them is the
 * server's next answer and never a flag this device keeps.
 *
 * "Waiting on you" is a filter link beside "All", with its own count: drafts
 * and confirmations are decided in the chat they belong to, and this is the
 * one place that says how many are left.
 */
export function ChatList({
  api,
  session,
  connection,
  workspaceError,
  route,
  onSignIn,
  onPairDuo,
  onSignOutWorkspace,
  footer,
  titleAs: Title = "h2",
  filterWaiting = false,
}: {
  /** The "Waiting on you" filter is on: the list is the chats (and other places) holding a decision, oldest first. */
  filterWaiting?: boolean;
  /** The list's heading level: h1 when it is the whole page (a phone's home screen), h2 beside an open surface. */
  titleAs?: "h1" | "h2";
  api: DuoApiConfig | null;
  session: WorkspaceSession | null;
  connection: WorkspaceConnection | null;
  workspaceError: string | null;
  route: Route;
  onSignIn: () => void;
  onPairDuo: () => void;
  onSignOutWorkspace: () => void;
  footer?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const phone = !useMediaQuery(DESKTOP_QUERY);
  const workspaceAccess = useWorkspaceAccess();
  const [newOpen, setNewOpen] = useState(false);
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  // #214: who to invite into — set from a held room's "more" panel.
  const [inviteTarget, setInviteTarget] = useState<RoomSummary | null>(null);
  const [leaveTarget, setLeaveTarget] = useState<RoomSummary | null>(null);
  // The leave dialog keeps its words while it plays its exit.
  const heldLeave = useHeld(leaveTarget);
  const [leaving, setLeaving] = useState(false);
  const [busyRoomId, setBusyRoomId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openMore, setOpenMore] = useState<string | null>(null);

  // Live arrivals refresh the list the same way every other reader does:
  // invalidation, never a second copy of the data.
  useEffect(() => {
    if (!connection) {
      return;
    }
    return connection.subscribe(() => {
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    });
  }, [connection, queryClient]);

  const rooms = useQuery({
    queryKey: ["workspace", "rooms"],
    queryFn: () => connection!.rooms(),
    enabled: connection !== null,
    meta: { target: "workspace" },
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["workspace", "rooms"] });
  };

  const setMode = (room: RoomSummary, mode: NotificationMode): void => {
    if (busyRoomId !== null || !connection) {
      return;
    }
    setBusyRoomId(room.roomId);
    setActionError(null);
    connection
      .setNotificationMode(room.roomId, mode)
      .then(() => setActionError(null))
      .catch(() => setActionError("The workspace didn't take that — try again."))
      .finally(() => {
        setBusyRoomId(null);
        refresh();
      });
  };

  const confirmLeave = (): void => {
    if (!leaveTarget || leaving || !connection) {
      return;
    }
    setLeaving(true);
    setActionError(null);
    connection
      .leave(leaveTarget.roomId)
      .then(() => setLeaveTarget(null))
      .catch(() => setActionError("The workspace didn't take that — try again."))
      .finally(() => {
        setLeaving(false);
        refresh();
      });
  };

  const waiting = useWaitingItems(api, connection);
  // #222: the nav badge counts unread mentions only — read ones (and anything dismissed from the Mentions view) stay off it, the same "what's new" idiom as every other badge here.
  const mentionsUnread = useMentions(connection).unreadCount;
  const waitingByRoom = useMemo(() => new Map(waiting.items.filter((item) => item.roomId !== null).map((item) => [item.roomId!, item])), [waiting.items]);
  const duoWaiting = waiting.items.find((item) => item.kind === "duo") ?? null;
  const bridged = useBridgedChats(api).chats;
  const bridgedWaiting = useMemo(() => new Map(waiting.items.filter((item) => item.kind === "bridged").map((item) => [item.key, item])), [waiting.items]);
  const roomRows = rooms.data ?? [];
  // #208: grouped the way the list itself renders — Channels, then Direct
  // messages, then Duos — so ⌘1–9 and J/K (below) walk the rows in the same
  // order the eye does, never the server's flat recency order.
  const sections = useMemo(() => sectionsOf(roomRows), [roomRows]);
  const sectionedRoomRows = useMemo(() => [...sections.channels, ...sections.directs, ...sections.duos], [sections]);
  const activeRoom = typeof route === "object" && "chat" in route ? route.chat : typeof route === "object" && "thread" in route ? route.thread.roomId : null;

  // The addresses in list order — what J/K and ⌘1–9 walk.
  const hrefs = useMemo(
    () =>
      filterWaiting
        ? waiting.items.map((item) => item.href)
        : [...(api ? ["#duo", ...bridged.map((chat) => bridgedHref(chat.id))] : []), ...sectionedRoomRows.map((room) => roomHref(room.roomId))],
    [api, bridged, sectionedRoomRows, filterWaiting, waiting.items],
  );
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // A key event can target the window or document, which have no `closest`.
      const target = e.target as Partial<HTMLElement> | null;
      if (
        target &&
        typeof target.closest === "function" &&
        (target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") || target.isContentEditable)
      ) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        const href = hrefs[Number(e.key) - 1];
        if (href) {
          e.preventDefault();
          window.location.hash = href;
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "j" && e.key !== "k")) {
        return;
      }
      const current = window.location.hash.startsWith("#chat/") ? window.location.hash.split("/").slice(0, 2).join("/") : window.location.hash;
      const at = hrefs.findIndex((href) => href === current || (href === "#duo" && window.location.hash.startsWith("#duo")));
      const next = hrefs[at === -1 ? 0 : (at + (e.key === "j" ? 1 : -1) + hrefs.length) % hrefs.length];
      if (next) {
        e.preventDefault();
        window.location.hash = next;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hrefs]);

  const duoActive = route === "duo" || (typeof route === "object" && "profile" in route);

  const roomsById = new Map(roomRows.map((room) => [room.roomId, room]));
  const activeDraft = typeof route === "object" && "draft" in route ? route.draft : null;
  const renderWaiting = (): ReactNode => {
    // Beside an open pane, its headline says "Nothing waiting on you."; the list only says it when it is the whole page.
    const nothing = Title === "h1" ? "Nothing waiting on you." : "You're clear.";
    if (!api) {
      return (
        <p className="p-4 type-body text-[var(--muted)]" data-testid="waiting-empty">
          {nothing}
        </p>
      );
    }
    if (waiting.isLoading) {
      return <RouteLoading variant="rows" />;
    }
    if (waiting.error) {
      return (
        <div className="p-4">
          <p className="type-body text-[var(--escalate)]">Couldn&apos;t read what is waiting on you — try again.</p>
          <button
            className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
            onClick={waiting.refetch}
            type="button"
          >
            Try again
          </button>
        </div>
      );
    }
    if (waiting.items.length === 0) {
      return (
        <p className="p-4 type-body text-[var(--muted)]" data-testid="waiting-empty">
          {nothing}
        </p>
      );
    }
    return (
      <div className="mt-1 flex flex-col gap-1" data-testid="waiting-list">
        {waiting.items.map((item) => {
          const room = item.roomId !== null ? roomsById.get(item.roomId) : undefined;
          const sole = room ? soleDuoLabel(room) : null;
          const title =
            item.kind === "chat"
              ? (sole ?? (room ? roomTitle(room) : "Conversation"))
              : item.kind === "duo"
                ? "Your duo"
                : item.kind === "confirmations"
                  ? "Confirmations"
                  : (item.label ?? "Unknown origin");
          // #208: the icon follows the room's own `kind`, never whether it
          // happened to have a name — the same rule the full list uses.
          const kind: "duo" | "person" | "group" =
            item.kind === "duo" || item.kind === "confirmations" || sole ? "duo" : room ? (room.kind === "direct" ? "person" : "group") : "person";
          const isActive =
            item.kind === "chat"
              ? activeRoom === item.roomId
              : item.kind === "bridged"
                ? activeRoom === item.key
              : item.kind === "duo"
                ? duoActive
                : item.kind === "confirmations"
                  ? route === "confirmations"
                  : activeDraft === item.key;
          const row = (
            <Row
              active={isActive}
              avatar={<Avatar kind={kind} title={title} />}
              href={item.href}
              badges={item.source !== null ? <SourceBadge channelKind={item.source} testId="waiting-source" /> : undefined}
              ids={{ entry: "waiting-entry", link: "waiting-link", title: "waiting-title" }}
              meta={
                <>
                  <Timestamp iso={item.oldestAt} />
                  <CountPill label={`${item.count} waiting on you`} n={item.count} testId="waiting-count" />
                </>
              }
              preview={
                <>
                  <DraftLine state={item.state} />
                  {waitingWords(item)}
                  {item.question ? ` · ${item.question}` : ""}
                </>
              }
              previewTestId="waiting-preview"
              title={title}
            >
              {/* A draft that can be swiped away shows what would be sent — behind the duo's line, as it is everywhere — so a swipe is never blind. */}
              {phone && swipeActionsOf(item).send && (
                <div className="px-2 pb-2">
                  <DuoLine attributionTestId="waiting-draft-attribution" compact label="Your duo" state={item.state ?? "neutral"} testId="waiting-draft">
                    <p className="line-clamp-3 type-body" data-testid="waiting-draft-text">
                      {swipeActionsOf(item).send!.draftText}
                    </p>
                  </DuoLine>
                </div>
              )}
            </Row>
          );
          return phone && api ? (
            <WaitingSwipe api={api} item={item} key={`${item.kind}:${item.key}`}>
              {row}
            </WaitingSwipe>
          ) : (
            <Fragment key={`${item.kind}:${item.key}`}>{row}</Fragment>
          );
        })}
      </div>
    );
  };

  const renderRooms = (): ReactNode => {
    if (workspaceError !== null) {
      return (
        <div className="p-4" data-testid="workspace-error" role="alert">
          <p className="type-body text-[var(--escalate)]">{workspaceError}</p>
          <button
            className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
            data-testid="workspace-error-sign-out"
            onClick={onSignOutWorkspace}
          >
            Sign out
          </button>
        </div>
      );
    }
    if (!connection) {
      // A hosted build has no way in to offer (#127): the workspace connects
      // by itself, so this says where that has got to — never a sign-in button.
      if (isHostedAccess(workspaceAccess)) {
        // One persistent live region says where things stand and changes text
        // in place; the skeleton beside it is only the shape of what is coming.
        // Until the connection is in hand it is "connecting" whatever the daemon
        // has already answered.
        const waiting = workspaceAccess.kind === "hosted-connecting" || workspaceAccess.kind === "hosted-connected";
        return (
          <>
            <HostedWorkspaceStatus access={waiting ? { kind: "hosted-connecting" } : workspaceAccess} className="flex flex-col gap-1 p-4" />
            {waiting && <RouteLoading slowNote={null} variant="rows" />}
          </>
        );
      }
      if (session) {
        // A stored session is still connecting: not "nothing here".
        return <RouteLoading variant="rows" />;
      }
      return (
        <div className="flex flex-col gap-3 p-4" data-testid="conversations-not-connected">
          <p className="type-body text-[var(--muted)]">Conversations with people live in your workspace — sign in on this device to see them.</p>
          <button
            className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)]"
            data-testid="conversations-signin"
            onClick={onSignIn}
          >
            Sign in to a workspace
          </button>
        </div>
      );
    }
    if (rooms.isLoading) {
      return <RouteLoading variant="rows" />;
    }
    if (rooms.error !== null || rooms.data === undefined) {
      return (
        <div className="p-4">
          <p className="type-body text-[var(--escalate)]">The workspace didn&apos;t give up its conversations — try again.</p>
          <button
            className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
            onClick={() => void rooms.refetch()}
          >
            Try again
          </button>
        </div>
      );
    }
    const renderRoomRow = (room: RoomSummary): ReactNode => {
      const sole = soleDuoLabel(room);
      const title = sole ?? roomTitle(room);
      const duoLabels = sole ? [] : roomDuoLabels(room);
      // #208: the icon is the projection's own `kind`, never a guess from
      // whether the room happened to have a name — a named group and an
      // unnamed one must read the same way, and only `kind` agrees with
      // `directRoomIdsOf`'s DM record either way.
      const avatarKind: "duo" | "person" | "group" = sole ? "duo" : room.kind === "direct" ? "person" : "group";
      const more = openMore === room.roomId;
      return (
        <Row
          active={activeRoom === room.roomId}
          avatar={<Avatar kind={avatarKind} seed={room.roomId} title={title} />}
          badges={
            room.muted ? (
              <span className="type-provenance uppercase text-[var(--faint)]" data-testid="room-muted">
                Muted
              </span>
            ) : undefined
          }
          href={roomHref(room.roomId)}
          key={room.roomId}
          meta={
            <>
              {room.latest && <Timestamp iso={new Date(room.latest.at).toISOString()} />}
              <span className="flex items-center gap-1">
                {waitingByRoom.get(room.roomId) && (
                  <CountPill label={`${waitingByRoom.get(room.roomId)!.count} waiting on you`} n={waitingByRoom.get(room.roomId)!.count} testId="waiting-count" />
                )}
                {room.unread.mentions > 0 && <CountPill label={`${room.unread.mentions} mentions`} n={room.unread.mentions} prefix="@ " testId="room-mentions" />}
                {room.unread.notifications > 0 && (
                  <span
                    aria-label={`${room.unread.notifications} unread`}
                    className="rounded-full border border-[var(--edge)] px-2 type-identifier text-[var(--text)]"
                    data-testid="room-unread"
                  >
                    {room.unread.notifications}
                  </span>
                )}
              </span>
            </>
          }
          more={
            <button
              aria-expanded={more}
              aria-label={`More for ${title}`}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-md)] text-[var(--faint)]"
              data-testid="room-more"
              onClick={() => setOpenMore(more ? null : room.roomId)}
              type="button"
            >
              <Ellipsis aria-label={`More for ${title}`} size={16} />
            </button>
          }
          preview={
            waitingByRoom.get(room.roomId) ? (
              <>
                <DraftLine state={waitingByRoom.get(room.roomId)!.state} />
                {waitingWords(waitingByRoom.get(room.roomId)!)}
              </>
            ) : (
              <>
                {/* #208: a duo riding in the room is named on the secondary
                    line, not beside the title — the title is what must
                    never be cut to a letter. */}
                {duoLabels.length > 0 && (
                  <>
                    <span data-testid="room-duo">{duoLabels.join(", ")}</span>
                    {" · "}
                  </>
                )}
                {room.latest ? plainPreview(room.latest.body) : "No messages yet."}
              </>
            )
          }
          previewTestId="room-preview"
          title={title}
        >
          {more && (
            <div className="mx-2 mb-2 flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface)] p-2">
              {/* #69: the tri-state, in the app's select idiom — what may interrupt from this conversation. */}
              <select
                aria-label={`Notifications for ${title}`}
                className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 type-provenance text-[var(--muted)] disabled:opacity-40"
                data-testid="room-notifications"
                disabled={busyRoomId === room.roomId}
                onChange={(e) => setMode(room, e.target.value as NotificationMode)}
                value={room.notifications}
              >
                <option value="all">All messages</option>
                <option value="mentions">Mentions</option>
                <option value="nothing">Nothing</option>
              </select>
              {/* #214: invite someone into THIS room — a direct conversation is just its two members, so there's nothing to invite into. */}
              {room.kind !== "direct" && (
                <button
                  aria-label={`Invite to ${title}`}
                  className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance text-[var(--muted)] disabled:opacity-40"
                  data-testid="room-invite"
                  onClick={() => setInviteTarget(room)}
                  type="button"
                >
                  Invite
                </button>
              )}
              <button
                aria-label={`Leave ${title}`}
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance text-[var(--muted)] disabled:opacity-40"
                data-testid="room-leave"
                onClick={() => setLeaveTarget(room)}
                type="button"
              >
                Leave
              </button>
            </div>
          )}
        </Row>
      );
    };

    return (
      <ConversationSearch connection={connection} rooms={rooms.data} titleOf={roomTitle}>
        {rooms.data.length === 0 ? (
          <p className="p-4 type-body text-[var(--muted)]" data-testid="conversations-empty">
            No conversations yet. When someone messages you, it appears here.
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-1" data-testid="conversations-list">
            {sections.channels.length > 0 && (
              <>
                <SectionHeader label="Channels" testId="chat-section-channels" />
                {sections.channels.map(renderRoomRow)}
              </>
            )}
            {sections.directs.length > 0 && (
              <>
                <SectionHeader label="Direct messages" testId="chat-section-direct-messages" />
                {sections.directs.map(renderRoomRow)}
              </>
            )}
            {sections.duos.length > 0 && (
              <>
                <SectionHeader label="Duos" testId="chat-section-duos" />
                {sections.duos.map(renderRoomRow)}
              </>
            )}
          </div>
        )}
      </ConversationSearch>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-list">
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
        <Title className="type-heading">Chats</Title>
        <div className="flex items-center gap-1">
          {connection && (
            <button
              aria-label="New conversation"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-md)] text-[var(--muted)]"
              data-testid="conversations-new"
              onClick={() => setNewOpen(true)}
              type="button"
            >
              <SquarePen aria-label="New conversation" size={18} />
            </button>
          )}
          {connection && (
            <button
              aria-label="New group"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-md)] text-[var(--muted)]"
              data-testid="conversations-new-room"
              onClick={() => setNewRoomOpen(true)}
              type="button"
            >
              <UsersRound aria-label="New group" size={18} />
            </button>
          )}
          {connection && (
            <a
              aria-current={route === "mentions" ? "page" : undefined}
              aria-label={mentionsUnread > 0 ? `Mentions, ${mentionsUnread} unread` : "Mentions"}
              className="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-md)] text-[var(--muted)]"
              data-testid="chat-list-mentions"
              href="#mentions"
            >
              <AtSign aria-hidden="true" size={18} />
              {mentionsUnread > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-1 inline-flex size-4 items-center justify-center rounded-full bg-[var(--accent)] type-identifier text-[8px] text-[var(--bg)]"
                  data-testid="chat-list-mentions-badge"
                >
                  {mentionsUnread > 9 ? "9+" : mentionsUnread}
                </span>
              )}
            </a>
          )}
          <a
            aria-label="Settings"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-md)] text-[var(--muted)]"
            data-testid="chat-list-settings"
            href="#settings"
          >
            <SettingsIcon aria-label="Settings" size={18} />
          </a>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2" role="group" aria-label="Filter chats">
        <a
          aria-current={route === "chats" ? "page" : undefined}
          className={`inline-flex min-h-8 items-center rounded-full border border-[var(--edge)] px-3 type-provenance ${!filterWaiting ? "bg-[var(--surface-2)] text-[var(--text)]" : "text-[var(--muted)]"}`}
          data-testid="all-chip"
          href="#chats"
        >
          All
        </a>
        {api && <WaitingChip active={filterWaiting} count={waiting.count} current={route === "waiting"} />}
        {api && <ConfirmationsChip api={api} active={route === "confirmations"} />}
      </div>
      <nav aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {actionError && (
          <p className="mx-2 mb-2 type-body text-[var(--refused)]" data-testid="room-action-error" role="alert">
            {actionError}
          </p>
        )}
        {filterWaiting ? (
          renderWaiting()
        ) : (
          <>
            {/* #214: a room invite isn't a conversation yet — it reads above the list it would otherwise just sit inside, unopenable. */}
            {connection && <PendingInvites connection={connection} />}
            {api ? (
              <>
                <DuoRow active={duoActive} api={api} waiting={duoWaiting} />
                {bridged.map((chat) => (
                  <BridgedRow active={activeRoom === chat.id} chat={chat} key={chat.id} waiting={bridgedWaiting.get(chat.id) ?? null} />
                ))}
                <div className="mx-2 my-1 h-px bg-[var(--edge)]" />
              </>
            ) : (
              <NoDuoPanel condensed onPairDuo={onPairDuo} />
            )}
            {renderRooms()}
          </>
        )}
      </nav>
      {footer && <div className="flex flex-wrap items-center gap-x-4 border-t border-[var(--edge)] px-4 py-2">{footer}</div>}
      {connection && (
        <NewConversationDialog
          connection={connection}
          open={newOpen}
          onOpenChange={setNewOpen}
          onStarted={(roomId) => {
            setNewOpen(false);
            refresh();
            window.location.hash = roomHref(roomId);
          }}
        />
      )}
      {connection && (
        <NewRoomDialog
          connection={connection}
          open={newRoomOpen}
          onOpenChange={setNewRoomOpen}
          onCreated={(roomId) => {
            setNewRoomOpen(false);
            refresh();
            window.location.hash = roomHref(roomId);
          }}
        />
      )}
      {connection && inviteTarget && (
        <InviteToRoomDialog
          connection={connection}
          roomId={inviteTarget.roomId}
          roomTitle={roomTitle(inviteTarget)}
          open={inviteTarget !== null}
          onOpenChange={(open) => {
            if (!open) {
              setInviteTarget(null);
              setOpenMore(null);
            }
          }}
        />
      )}
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setLeaveTarget(null);
          }
        }}
        open={leaveTarget !== null}
      >
        {heldLeave && (
          <DialogContent data-testid="leave-conversation-dialog">
            <DialogTitle>Leave {roomTitle(heldLeave)}?</DialogTitle>
            <DialogDescription>
              You&apos;ll stop getting its messages. Whoever remains keeps the conversation, and you can be invited back.
            </DialogDescription>
            <div className="flex justify-end gap-2">
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
                data-testid="leave-conversation-cancel"
                onClick={() => setLeaveTarget(null)}
                type="button"
              >
                Stay
              </button>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--escalate)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
                data-testid="leave-conversation-confirm"
                disabled={leaving}
                onClick={confirmLeave}
                type="button"
              >
                {leaving ? "Leaving…" : "Leave"}
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

/** The "Waiting on you" filter and its count — the count is the one number the dock, the menu bar and the window title mirror too. */
function WaitingChip({ active, current, count }: { active: boolean; current: boolean; count: number }) {
  // The badge stays one tick past zero, so the last figure is seen leaving.
  const badge = useLingering(count);
  return (
    <a
      aria-current={current ? "page" : undefined}
      className={`inline-flex min-h-8 items-center gap-2 rounded-full border border-[var(--edge)] px-3 type-provenance ${active ? "bg-[var(--surface-2)] text-[var(--text)]" : "text-[var(--muted)]"}`}
      data-testid="waiting-chip"
      href="#waiting"
    >
      Waiting on you
      {badge && (
        <span className="type-identifier text-[var(--accent)]" data-testid="waiting-badge">
          <TickingCount value={count} />
        </span>
      )}
    </a>
  );
}

/**
 * What is staged for the owner's explicit yes (#52), reached until it moves
 * into the chats it belongs to (#145). Shown only while something waits: it
 * is a queue, not a place. Its count is part of Waiting on you as well.
 */
function ConfirmationsChip({ api, active }: { api: DuoApiConfig; active: boolean }) {
  const { data } = usePendingT4(api);
  const count = data?.length ?? 0;
  if (count === 0 && !active) {
    return null;
  }
  return (
    <a
      aria-current={active ? "page" : undefined}
      className={`inline-flex min-h-8 items-center gap-2 rounded-full border border-[var(--edge)] px-3 type-provenance ${active ? "bg-[var(--surface-2)] text-[var(--text)]" : "text-[var(--muted)]"}`}
      data-testid="confirmations-chip"
      href="#confirmations"
    >
      Confirmations
      {count > 0 && (
        <span className="type-identifier text-[var(--accent)]" data-testid="confirmations-badge">
          {count}
        </span>
      )}
    </a>
  );
}

/**
 * On a phone, a waiting row can be swiped (#153): left sends a confident
 * draft, right dismisses with an undo window. A row with nothing swipeable
 * behind it — several drafts, a hedged one, a passed-on question — is just a
 * row. Offline, nothing is swipeable: a decision is never queued (AR-15).
 */
function WaitingSwipe({ api, item, children }: { api: DuoApiConfig; item: WaitingItem; children: ReactNode }) {
  const record = useRecordOutcome(api);
  const { reachable } = useSyncStatus();
  const { send, dismiss } = swipeActionsOf(item);
  const sendRun = send && reachable ? () => record.mutateAsync({ draftId: send.id, outcome: "sent" }) : null;
  const dismissRun = dismiss && reachable ? () => record.mutateAsync({ draftId: dismiss.id, outcome: "discarded" }) : null;
  if (sendRun === null && dismissRun === null) {
    return <>{children}</>;
  }
  return (
    <SwipeRow dismiss={dismissRun} send={sendRun}>
      {children}
    </SwipeRow>
  );
}

/** A question from another platform, as a chat (#150): its source is on the row, so it never reads as a native one. */
function BridgedRow({ chat, waiting, active }: { chat: BridgedChat; waiting: WaitingItem | null; active: boolean }) {
  const title = bridgedTitle(chat);
  const last = chat.drafts[chat.drafts.length - 1]!;
  return (
    <Row
      active={active}
      avatar={<Avatar kind="person" title={title} />}
      badges={<SourceBadge channelKind={chat.channelKind} />}
      href={bridgedHref(chat.id)}
      ids={{ entry: "bridged-entry", link: "bridged-link", title: "bridged-row-title" }}
      meta={
        <>
          <Timestamp iso={chat.lastAt} />
          {waiting && <CountPill label={`${waiting.count} waiting on you`} n={waiting.count} testId="bridged-count" />}
        </>
      }
      preview={
        waiting ? (
          <>
            <DraftLine state={waiting.state} />
            {waitingWords(waiting)}
            {` · ${last.question}`}
          </>
        ) : (
          plainPreview(last.sentText ?? last.question)
        )
      }
      previewTestId="bridged-preview"
      title={title}
    />
  );
}

/** Your duo — pinned first, always there, and the only row that is not a person or a colleague's duo. */
function DuoRow({ api, waiting, active }: { api: DuoApiConfig; waiting: WaitingItem | null; active: boolean }) {
  const count = waiting?.count ?? 0;
  // Training is quiet: it never counts as waiting, but the row says there is something to look at.
  const training = useTrainingCount(api);
  return (
    <Row
      active={active}
      avatar={<Avatar kind="duo" title="Your duo" />}
      href="#duo"
      ids={{ entry: "duo-entry", link: "duo-link", title: "duo-title" }}
      meta={count > 0 ? <CountPill label={`${count} waiting on you`} n={count} testId="duo-row-count" /> : null}
      preview={
        waiting ? (
          <>
            <DraftLine state={waiting.state} />
            {waitingWords(waiting)}
          </>
        ) : training > 0 ? (
          `${training} ${training === 1 ? "thing" : "things"} to look at when you have a minute`
        ) : (
          "Ask your duo anything"
        )
      }
      previewTestId="duo-row-preview"
      title="Your duo"
    />
  );
}
