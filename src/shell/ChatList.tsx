import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Settings as SettingsIcon, SquarePen } from "lucide-react";
import type { DuoApiConfig } from "../api/client.js";
import { usePendingT4 } from "../api/queries.js";
import { Mark } from "../components/Mark.js";
import { ConversationSearch } from "../components/ConversationSearch.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/primitives/Dialog.js";
import { NewConversationDialog } from "../components/NewConversationDialog.js";
import { NoDuoPanel } from "../components/NoDuoPanel.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { Timestamp } from "../components/Timestamp.js";
import { WorkspaceNotSetUp } from "../components/WorkspaceNotSetUp.js";
import { useWorkspaceAccess } from "../workspace/access.js";
import { plainPreview } from "../workspace/duoAnswer.js";
import { roomHref } from "../workspace/links.js";
import type { NotificationMode, RoomSummary, WorkspaceConnection, WorkspaceSession } from "../workspace/matrix.js";
import type { Route } from "./routes.js";
import { roomDuoLabels, roomTitle, soleDuoLabel } from "./roomTitle.js";
import { useWaitingItems, waitingWords, type WaitingItem } from "./waiting.js";
import type { HairlineState } from "../components/ConfidenceHairline.js";

function initialsOf(title: string): string {
  const words = title.split(/[\s,]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

/**
 * A row's picture. A duo — yours or a colleague's — is always the mark and
 * never initials, so a duo cannot be mistaken for a person in the list
 * (Hairline P1); a person is their initials on a plain tile, a group a `#`.
 */
function Avatar({ kind, title }: { kind: "duo" | "person" | "group"; title: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)] type-identifier text-[var(--muted)]"
      data-kind={kind}
      data-testid="chat-avatar"
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
          className="grid min-h-14 min-w-0 flex-1 grid-cols-[auto_1fr_auto] items-center gap-3 rounded-[var(--r-md)] px-2 py-2"
          data-testid={ids.link}
          href={href}
        >
          {avatar}
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate type-body text-[var(--text)]" data-testid={ids.title}>
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
  const workspaceAccess = useWorkspaceAccess();
  const [newOpen, setNewOpen] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState<RoomSummary | null>(null);
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
  const waitingByRoom = useMemo(() => new Map(waiting.items.filter((item) => item.roomId !== null).map((item) => [item.roomId!, item])), [waiting.items]);
  const duoWaiting = waiting.items.find((item) => item.kind === "duo") ?? null;
  const roomRows = rooms.data ?? [];
  const activeRoom = typeof route === "object" && "chat" in route ? route.chat : typeof route === "object" && "thread" in route ? route.thread.roomId : null;

  // The addresses in list order — what J/K and ⌘1–9 walk.
  const hrefs = useMemo(
    () => (filterWaiting ? waiting.items.map((item) => item.href) : [...(api ? ["#duo"] : []), ...roomRows.map((room) => roomHref(room.roomId))]),
    [api, roomRows, filterWaiting, waiting.items],
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
          const kind: "duo" | "person" | "group" =
            item.kind === "duo" || item.kind === "confirmations" || sole ? "duo" : room && room.name !== null ? "group" : "person";
          const isActive =
            item.kind === "chat"
              ? activeRoom === item.roomId
              : item.kind === "duo"
                ? duoActive
                : item.kind === "confirmations"
                  ? route === "confirmations"
                  : activeDraft === item.key;
          return (
            <Row
              active={isActive}
              avatar={<Avatar kind={kind} title={title} />}
              href={item.href}
              ids={{ entry: "waiting-entry", link: "waiting-link", title: "waiting-title" }}
              key={`${item.kind}:${item.key}`}
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
            />
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
      if (session) {
        // A stored session is still connecting: not "nothing here".
        return <RouteLoading variant="rows" />;
      }
      // A hosted build has no way in to offer (#127): it says the workspace
      // isn't set up, with no sign-in button.
      if (workspaceAccess.kind === "hosted-pending") {
        return <WorkspaceNotSetUp className="flex flex-col gap-1 p-4" />;
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
    return (
      <ConversationSearch connection={connection} rooms={rooms.data} titleOf={roomTitle}>
        {rooms.data.length === 0 ? (
          <p className="p-4 type-body text-[var(--muted)]" data-testid="conversations-empty">
            No conversations yet. When someone messages you, it appears here.
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-1" data-testid="conversations-list">
            {rooms.data.map((room) => {
              const sole = soleDuoLabel(room);
              const title = sole ?? roomTitle(room);
              const duoLabels = sole ? [] : roomDuoLabels(room);
              const more = openMore === room.roomId;
              return (
                <Row
                  active={activeRoom === room.roomId}
                  avatar={<Avatar kind={sole ? "duo" : room.name !== null ? "group" : "person"} title={title} />}
                  badges={
                    <>
                      {room.muted && (
                        <span className="type-provenance uppercase text-[var(--faint)]" data-testid="room-muted">
                          Muted
                        </span>
                      )}
                      {duoLabels.map((label) => (
                        <span className="truncate type-provenance text-[var(--muted)]" data-testid="room-duo" key={label}>
                          {label}
                        </span>
                      ))}
                    </>
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
                    ) : room.latest ? (
                      plainPreview(room.latest.body)
                    ) : (
                      "No messages yet."
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
            })}
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
            {api ? (
              <>
                <DuoRow active={duoActive} waiting={duoWaiting} />
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
      {newOpen && connection && (
        <NewConversationDialog
          connection={connection}
          onOpenChange={setNewOpen}
          onStarted={(roomId) => {
            setNewOpen(false);
            refresh();
            window.location.hash = roomHref(roomId);
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
        {leaveTarget && (
          <DialogContent data-testid="leave-conversation-dialog">
            <DialogTitle>Leave {roomTitle(leaveTarget)}?</DialogTitle>
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
  return (
    <a
      aria-current={current ? "page" : undefined}
      className={`inline-flex min-h-8 items-center gap-2 rounded-full border border-[var(--edge)] px-3 type-provenance ${active ? "bg-[var(--surface-2)] text-[var(--text)]" : "text-[var(--muted)]"}`}
      data-testid="waiting-chip"
      href="#waiting"
    >
      Waiting on you
      {count > 0 && (
        <span className="type-identifier text-[var(--accent)]" data-testid="waiting-badge">
          {count}
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

/** Your duo — pinned first, always there, and the only row that is not a person or a colleague's duo. */
function DuoRow({ waiting, active }: { waiting: WaitingItem | null; active: boolean }) {
  const count = waiting?.count ?? 0;
  return (
    <Row
      active={active}
      avatar={<Avatar kind="duo" title="Your duo" />}
      href="#duo"
      ids={{ entry: "duo-entry", link: "duo-link", title: "duo-title" }}
      meta={count > 0 ? <CountPill label={`${count} waiting on you`} n={count} testId="duo-row-count" /> : null}
      preview={waiting ? <><DraftLine state={waiting.state} />{waitingWords(waiting)}</> : "Ask your duo anything"}
      previewTestId="duo-row-preview"
      title="Your duo"
    />
  );
}
