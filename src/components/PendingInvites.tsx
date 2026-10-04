import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { roomHref } from "../workspace/links.js";
import type { RoomInvite, WorkspaceConnection } from "../workspace/matrix.js";

/** What a pending invite row titles itself by: the room's own name, else who asked. */
function inviteTitle(invite: RoomInvite): string {
  return invite.name ?? invite.inviterName ?? "Conversation";
}

/**
 * #214: invites the member hasn't decided yet — a room they can't open
 * until they accept (`rooms()` reads only joined rooms; an unaccepted
 * invite is Synapse's stripped state, not a conversation). Reuses the
 * existing leave verb to decline: Matrix models accepting and declining an
 * invite as join and leave, the same two verbs the list already has for a
 * room the member is IN, so this adds one new one (`joinRoom`) rather than
 * a parallel accept/decline pair.
 */
export function PendingInvites({ connection }: { connection: WorkspaceConnection }) {
  const queryClient = useQueryClient();
  const invites = useQuery({
    queryKey: ["workspace", "invites"],
    queryFn: () => connection.invites(),
    meta: { target: "workspace" },
  });
  const [busyRoomId, setBusyRoomId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
  };

  const accept = (roomId: string): void => {
    if (busyRoomId !== null) {
      return;
    }
    setBusyRoomId(roomId);
    setError(null);
    connection
      .joinRoom(roomId)
      .then(() => {
        window.location.hash = roomHref(roomId);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't accept the invite — try again."))
      .finally(() => {
        setBusyRoomId(null);
        refresh();
      });
  };

  const decline = (roomId: string): void => {
    if (busyRoomId !== null) {
      return;
    }
    setBusyRoomId(roomId);
    setError(null);
    connection
      .leave(roomId)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't decline the invite — try again."))
      .finally(() => {
        setBusyRoomId(null);
        refresh();
      });
  };

  const rows = invites.data ?? [];
  if (rows.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 px-2 pb-2" data-testid="pending-invites">
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="pending-invite-error" role="alert">
          {error}
        </p>
      )}
      {rows.map((invite) => (
        <div className="shape-entry flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-testid="pending-invite" key={invite.roomId}>
          <div className="flex min-w-0 flex-col">
            <span className="truncate type-body text-[var(--text)]" data-testid="pending-invite-title">
              {inviteTitle(invite)}
            </span>
            {invite.inviterName !== null && (
              <span className="type-provenance text-[var(--muted)]">
                {invite.kind === "direct" ? "Wants to message you" : `Invited by ${invite.inviterName}`}
              </span>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--muted)] disabled:opacity-40"
              data-testid="pending-invite-decline"
              disabled={busyRoomId === invite.roomId}
              onClick={() => decline(invite.roomId)}
              type="button"
            >
              Decline
            </button>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
              data-testid="pending-invite-accept"
              disabled={busyRoomId === invite.roomId}
              onClick={() => accept(invite.roomId)}
              type="button"
            >
              {busyRoomId === invite.roomId ? "Joining…" : "Accept"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
