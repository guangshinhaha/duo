import { useEffect, useState } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import { roomTitle } from "../shell/roomTitle.js";
import type { RoomSummary, WorkspaceConnection } from "../workspace/matrix.js";

/**
 * #292: forwarding one or several messages to another conversation — a
 * room picker over `findRooms` (#207's local filter, the same door
 * `CommandSearch` and `NewConversationDialog` already search or start
 * conversations through — never a fresh network ask for something this
 * client already has). Choosing a room hands its id to the caller's own
 * `onForward`, which composes and sends the forwarded words — this dialog
 * knows nothing of that shape, only which room was picked.
 */
export function ForwardMessageDialog({
  connection,
  open,
  onOpenChange,
  count,
  onForward,
}: {
  connection: WorkspaceConnection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many messages this will forward — words only, never more precision than the member asked for. */
  count: number;
  onForward: (targetRoomId: string) => Promise<void>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {open && (
        <DialogContent data-testid="forward-message-dialog">
          <ForwardMessageBody connection={connection} count={count} onDone={() => onOpenChange(false)} onForward={onForward} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function ForwardMessageBody({
  connection,
  count,
  onForward,
  onDone,
}: {
  connection: WorkspaceConnection;
  count: number;
  onForward: (targetRoomId: string) => Promise<void>;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<readonly RoomSummary[]>([]);
  const [forwarding, setForwarding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Local to what this client already has (#207's own rule for `findRooms`)
  // — every keystroke, no debounce, no network call.
  useEffect(() => {
    let cancelled = false;
    connection
      .findRooms(query.trim())
      .then((found) => {
        if (!cancelled) {
          setMatches(found);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMatches([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection, query]);

  const forward = (targetRoomId: string): void => {
    if (forwarding !== null) {
      return;
    }
    setForwarding(targetRoomId);
    setError(null);
    onForward(targetRoomId)
      .then(() => onDone())
      .catch(() => setError("The workspace didn't take that — try again."))
      .finally(() => setForwarding(null));
  };

  return (
    <>
      <DialogTitle>Forward</DialogTitle>
      <DialogDescription>
        {count === 1
          ? "Choose a conversation — it will say where it came from."
          : `Choose a conversation — all ${count} messages will say where they came from.`}
      </DialogDescription>
      <input
        aria-label="Search conversations"
        className="min-h-11 w-full rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 text-[var(--text)]"
        data-testid="forward-message-search"
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search conversations"
        value={query}
      />
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="forward-message-error">
          {error}
        </p>
      )}
      {matches.length === 0 ? (
        <p className="type-body text-[var(--muted)]" data-testid="forward-message-none">
          No conversations found.
        </p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {matches.map((room) => (
            <li key={room.roomId}>
              <button
                className="min-h-11 w-full rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-left type-body text-[var(--text)] disabled:opacity-40"
                data-testid="forward-message-room"
                disabled={forwarding !== null}
                onClick={() => forward(room.roomId)}
                type="button"
              >
                {forwarding === room.roomId ? "Forwarding…" : roomTitle(room)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <DialogClose asChild>
        <button className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body">
          Cancel
        </button>
      </DialogClose>
    </>
  );
}
