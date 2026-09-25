import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { RouteLoading } from "../components/RouteLoading.js";
import type { WorkspaceConnection } from "../workspace/matrix.js";

/**
 * #62: the conversations list — the member's default space (§1.5: people,
 * groups, and colleagues' duos, all entries in one list). Rooms arrive over
 * the held workspace connection; live activity (a message landing in any
 * room the subscription reports) refreshes the list with the rest, because
 * a room that just spoke is the room you'd open.
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
  const rooms = useQuery({
    queryKey: ["workspace", "rooms"],
    queryFn: () => connection.rooms(),
    enabled: true,
    meta: { target: "workspace" },
  });

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

  return (
    <div className="flex h-full flex-col">
      <h1 className="type-heading sr-only">Conversations</h1>
      <div className="flex-1 overflow-y-auto p-6">
        {rooms.data.length === 0 ? (
          <p className="p-6 text-[var(--muted)]" data-testid="conversations-empty">
            No conversations yet. When someone messages you, it appears here.
          </p>
        ) : (
          <nav aria-label="Conversations" className="flex flex-col gap-2" data-testid="conversations-list">
            {rooms.data.map((room) => (
              <a
                className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-2 text-left type-body text-[var(--text)]"
                data-testid="conversations-room"
                href={`#room/${encodeURIComponent(room.roomId)}`}
                key={room.roomId}
              >
                {room.name}
              </a>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
