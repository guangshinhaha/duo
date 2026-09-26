import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ConversationSearch } from "../components/ConversationSearch.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/primitives/Dialog.js";
import { NewConversationDialog } from "../components/NewConversationDialog.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { Timestamp } from "../components/Timestamp.js";
import { WorkspaceNotSetUp } from "../components/WorkspaceNotSetUp.js";
import { useWorkspaceAccess } from "../workspace/access.js";
import { plainPreview } from "../workspace/duoAnswer.js";
import { duoOwnerLabel, isDuoUserId, localpartOf } from "../workspace/identity.js";
import { type NotificationMode, type RoomSummary, type WorkspaceConnection } from "../workspace/matrix.js";

/**
 * The title a room reads under: its name when it has one, its members when
 * it doesn't (a direct conversation IS its members), its id as the last
 * resort. Pure presentation over the projection — the Room route renders
 * the same title the list does, so both read from here.
 */
export function roomTitle(room: RoomSummary): string {
  if (room.name !== null) {
    return room.name;
  }
  const names = room.members.map((member) => member.name ?? localpartOf(member.userId));
  return names.length > 0 ? names.join(", ") : room.roomId;
}

/**
 * #62 + #63: the conversations list — the member's default space (§1.5:
 * people, groups, and colleagues' duos, all entries in one list), and the
 * place that answers "where am I needed?" without opening anything. Each
 * entry reads with its name or its members, the latest word and its age,
 * the unread badge — and, when the conversation mentioned the member, the
 * mention badge beside it (a mention is a demand; unread is only an
 * absence). A room carrying a colleague's duo says so on the entry, by the
 * `@duo-` grammar of the member id rather than any name the duo chose.
 *
 * The member's verbs live here too (#63): starting a conversation (the
 * workspace directory, searched), leaving one (asked, then done), and —
 * widened by #69 into the tri-state — setting what may interrupt from
 * one: all, mentions only, or nothing (the mute #63 wrote, named by what
 * it is). All three are homeserver operations on the member's own
 * account — which is why they hold on every device, and why the list's
 * reflection after any of them is the server's next answer, never a flag
 * this device keeps for itself.
 *
 * The workspace target label matters (#58): a workspace query failing at
 * the network level reads as THE WORKSPACE being unreachable, never as the
 * duo's daemon going quiet.
 */
export function Conversations({
  connection,
  error,
  onSignIn,
  onSignOut,
}: {
  connection: WorkspaceConnection | null;
  error: string | null;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const queryClient = useQueryClient();
  const workspaceAccess = useWorkspaceAccess();
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

  if (error !== null) {
    return (
      <div className="p-6" data-testid="workspace-error" role="alert">
        <h1 className="type-heading sr-only">Conversations</h1>
        <p className="type-body text-[var(--escalate)]">{error}</p>
        <button
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
          data-testid="workspace-error-sign-out"
          onClick={onSignOut}
        >
          Sign out
        </button>
      </div>
    );
  }

  if (!connection) {
    // Reached by URL without a session (the owner-only app has no link
    // here): say what's missing and offer the way in — never a dead end.
    // A hosted build has no way in to offer (#127): it says the workspace
    // isn't set up, with no sign-in button.
    if (workspaceAccess.kind === "hosted-pending") {
      return (
        <div className="p-6">
          <h1 className="type-heading sr-only">Conversations</h1>
          <WorkspaceNotSetUp className="flex flex-col gap-1" />
        </div>
      );
    }
    return (
      <div className="p-6">
        <h1 className="type-heading sr-only">Conversations</h1>
        <p className="type-body text-[var(--muted)]">Conversations live in your workspace — sign in on this device to see them.</p>
        <button
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)]"
          data-testid="conversations-signin"
          onClick={onSignIn}
        >
          Sign in to a workspace
        </button>
      </div>
    );
  }

  return <RoomList connection={connection} />;
}

function RoomList({ connection }: { connection: WorkspaceConnection }) {
  const queryClient = useQueryClient();
  const rooms = useQuery({
    queryKey: ["workspace", "rooms"],
    queryFn: () => connection.rooms(),
    enabled: true,
    meta: { target: "workspace" },
  });
  // #63's verbs and their failure lane: every entry shares one line of
  // "the workspace didn't take that", because the failure is the
  // workspace's, not the entry's.
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyRoomId, setBusyRoomId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState<RoomSummary | null>(null);
  const [leaving, setLeaving] = useState(false);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["workspace", "rooms"] });
  };

  if (rooms.isLoading) {
    return (
      <div className="p-6">
        <h1 className="type-heading sr-only">Conversations</h1>
        <RouteLoading variant="rows" />
      </div>
    );
  }
  if (rooms.error !== null || rooms.data === undefined) {
    return (
      <div className="p-6">
        <h1 className="type-heading sr-only">Conversations</h1>
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

  // #69: what may interrupt from one conversation — all, mentions only,
  // or nothing (the mute #63 wrote, now named by what it is). One verb,
  // server-side like every other one: the reflection is the server's next
  // answer, so every device reads the same mode.
  const setMode = (room: RoomSummary, mode: NotificationMode): void => {
    if (busyRoomId !== null) {
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
    if (!leaveTarget || leaving) {
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

  return (
    <div className="flex h-full flex-col">
      <h1 className="type-heading sr-only">Conversations</h1>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center justify-between gap-2">
          <p className="type-provenance uppercase text-[var(--faint)]">Newest first</p>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)]"
            data-testid="conversations-new"
            onClick={() => setNewOpen(true)}
          >
            New conversation
          </button>
        </div>
        {actionError && (
          <p className="mt-2 type-body text-[var(--refused)]" data-testid="room-action-error" role="alert">
            {actionError}
          </p>
        )}
        {/* #70: search what was said — the shared, workspace-side search.
            While one is active its results stand in place of the list. */}
        <ConversationSearch connection={connection} rooms={rooms.data} titleOf={roomTitle}>
          {rooms.data.length === 0 ? (
            <p className="p-6 text-[var(--muted)]" data-testid="conversations-empty">
              No conversations yet. When someone messages you, it appears here.
            </p>
          ) : (
            <nav aria-label="Conversations" className="mt-2 flex flex-col gap-2" data-testid="conversations-list">
              {rooms.data.map((room) => (
                <ConversationEntry
                  busy={busyRoomId === room.roomId}
                  key={room.roomId}
                  onLeave={() => setLeaveTarget(room)}
                  onSetMode={(mode) => setMode(room, mode)}
                  room={room}
                />
              ))}
            </nav>
          )}
        </ConversationSearch>
      </div>
      {newOpen && (
        <NewConversationDialog
          connection={connection}
          onOpenChange={setNewOpen}
          onStarted={(roomId) => {
            setNewOpen(false);
            refresh();
            window.location.hash = `#room/${encodeURIComponent(roomId)}`;
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

/** One conversation as a row: the link, what it says about itself, and the member's verbs beside it. */
function ConversationEntry({
  room,
  busy,
  onSetMode,
  onLeave,
}: {
  room: RoomSummary;
  busy: boolean;
  onSetMode: (mode: NotificationMode) => void;
  onLeave: () => void;
}) {
  const title = roomTitle(room);
  // Whose duos ride in this room — read from member ids, never from names.
  const duoLabels = room.members
    .filter((member) => isDuoUserId(member.userId))
    .map((member) => `${duoOwnerLabel(member.userId) ?? localpartOf(member.userId)}'s duo`);

  return (
    <div className="flex items-stretch gap-2" data-testid="conversations-entry">
      <a
        className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-2 text-left"
        data-testid="conversations-room"
        href={`#room/${encodeURIComponent(room.roomId)}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="type-body text-[var(--text)]" data-testid="room-title">
            {title}
          </span>
          {room.muted && (
            <span className="type-provenance uppercase text-[var(--faint)]" data-testid="room-muted">
              Muted
            </span>
          )}
          {duoLabels.map((label) => (
            <span className="type-provenance text-[var(--muted)]" data-testid="room-duo" key={label}>
              {label}
            </span>
          ))}
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className="truncate type-body text-[var(--muted)]" data-testid="room-preview">
            {room.latest ? plainPreview(room.latest.body) : "No messages yet."}
          </span>
          {room.latest && <Timestamp iso={new Date(room.latest.at).toISOString()} />}
        </div>
        {(room.unread.notifications > 0 || room.unread.mentions > 0) && (
          <div className="mt-1 flex items-center gap-2">
            {room.unread.notifications > 0 && (
              <span
                className="rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-provenance text-[var(--text)]"
                data-testid="room-unread"
              >
                {room.unread.notifications} unread
              </span>
            )}
            {room.unread.mentions > 0 && (
              <span
                className="rounded-[var(--r-sm)] bg-[var(--accent)] px-2 type-provenance text-[var(--bg)]"
                data-testid="room-mentions"
              >
                @ {room.unread.mentions}
              </span>
            )}
          </div>
        )}
      </a>
      <div className="flex flex-col justify-center gap-1">
        {/* #69: the tri-state, in the app's select idiom. The label says
            what the control governs; the options say the three things it
            can mean — the same words the notification decision uses. */}
        <select
          aria-label={`Notifications for ${title}`}
          className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 type-provenance text-[var(--muted)] disabled:opacity-40"
          data-testid="room-notifications"
          disabled={busy}
          onChange={(e) => onSetMode(e.target.value as NotificationMode)}
          value={room.notifications}
        >
          <option value="all">All messages</option>
          <option value="mentions">Mentions</option>
          <option value="nothing">Nothing</option>
        </select>
        <button
          aria-label={`Leave ${title}`}
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-provenance text-[var(--muted)] disabled:opacity-40"
          data-testid="room-leave"
          onClick={onLeave}
          type="button"
        >
          Leave
        </button>
      </div>
    </div>
  );
}
