import { useState, type FormEvent } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import { isDuoUserId, duoOwnerLabel, localpartOf } from "../workspace/identity.js";
import type { WorkspaceConnection } from "../workspace/matrix.js";

/**
 * #214: inviting a colleague into a room that already exists — the "or
 * later" half of "invite people while creating it or later" (the other
 * half, inviting while creating, is `NewRoomDialog`). Search, then invite;
 * each invite is its own call, so one colleague the org wall refuses (a
 * cross-org invite, surfaced in the server's own words) never blocks
 * another, and the dialog stays open to try someone else.
 */
export function InviteToRoomDialog({
  connection,
  roomId,
  roomTitle,
  open,
  onOpenChange,
}: {
  connection: WorkspaceConnection;
  roomId: string;
  roomTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent data-testid="invite-to-room-dialog">
        <InviteToRoomBody connection={connection} roomId={roomId} roomTitle={roomTitle} />
      </DialogContent>
    </Dialog>
  );
}

function InviteToRoomBody({ connection, roomId, roomTitle }: { connection: WorkspaceConnection; roomId: string; roomTitle: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly { userId: string; name: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [invited, setInvited] = useState<readonly string[]>([]);
  const [inviting, setInviting] = useState<string | null>(null);
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({});

  const search = (event: FormEvent): void => {
    event.preventDefault();
    const term = query.trim();
    if (!term || searching) {
      return;
    }
    setSearching(true);
    setSearchError(null);
    connection
      .searchPeople(term)
      .then((people) => setResults(people))
      .catch(() => setSearchError("The workspace didn't answer — try again."))
      .finally(() => setSearching(false));
  };

  const invite = (userId: string): void => {
    if (inviting !== null) {
      return;
    }
    setInviting(userId);
    setInviteErrors((errors) => {
      const next = { ...errors };
      delete next[userId];
      return next;
    });
    connection
      .invite(roomId, userId)
      .then(() => setInvited((list) => [...list, userId]))
      .catch((error: unknown) =>
        setInviteErrors((errors) => ({ ...errors, [userId]: error instanceof Error ? error.message : "Couldn't invite them — try again." })),
      )
      .finally(() => setInviting(null));
  };

  return (
    <>
      <DialogTitle>Invite people to {roomTitle}</DialogTitle>
      <DialogDescription>Search your workspace for the colleague — or colleague&apos;s duo — to add.</DialogDescription>
      <form className="flex gap-2" onSubmit={search}>
        <input
          aria-label="Search people"
          className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
          placeholder="Name or id"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSearchError(null);
          }}
        />
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
          disabled={searching || query.trim().length === 0}
          type="submit"
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </form>
      {searchError && (
        <p className="type-body text-[var(--refused)]" data-testid="invite-to-room-search-error">
          {searchError}
        </p>
      )}
      {results !== null && results.length === 0 && (
        <p className="type-body text-[var(--muted)]" data-testid="invite-to-room-none">
          No one found.
        </p>
      )}
      {results !== null && results.length > 0 && (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {results.map((person) => {
            const already = invited.includes(person.userId);
            return (
              <div className="flex flex-col gap-1" key={person.userId}>
                <button
                  className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-left type-body text-[var(--text)] disabled:opacity-40"
                  data-testid="invite-to-room-person"
                  disabled={inviting !== null || already}
                  onClick={() => invite(person.userId)}
                  type="button"
                >
                  {labelFor(person)} {already && "— Invited"}
                </button>
                {inviteErrors[person.userId] && (
                  <p className="type-body text-[var(--refused)]" data-testid="invite-to-room-error">
                    {inviteErrors[person.userId]}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      <DialogClose asChild>
        <button className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body">
          Done
        </button>
      </DialogClose>
    </>
  );
}

/** Who a directory entry reads as: a duo by its owner (from the id's grammar), a person by their name. */
function labelFor(person: { userId: string; name: string }): string {
  if (isDuoUserId(person.userId)) {
    return `${duoOwnerLabel(person.userId) ?? localpartOf(person.userId)}'s duo`;
  }
  return person.name;
}
