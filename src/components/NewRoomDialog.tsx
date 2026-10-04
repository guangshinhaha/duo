import { useState, type FormEvent } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import { isDuoUserId, duoOwnerLabel, localpartOf } from "../workspace/identity.js";
import type { WorkspaceConnection } from "../workspace/matrix.js";

/**
 * #214: making a project a room — name it, optionally give it a topic, and
 * invite colleagues before it opens (or skip that and invite later from the
 * room itself). Always a private group: `connection.createRoom` is
 * invite-only by construction (see its doc in matrix.ts for why there is no
 * "channel" option here yet — the org wall refuses every member's attempt
 * to publish a room to any directory, so there is no safe way to offer
 * "findable in the org" without risking a room that leaks across orgs).
 *
 * Each invite is its own call, not one invite list on `createRoom`: the org
 * wall refuses a room's creation OUTRIGHT if any invite in it crosses an
 * org (`duo_org_wall/rules.py`'s `may_create_room`), which would otherwise
 * cost the whole room over one bad pick. Inviting one at a time means a
 * refused colleague is just that — refused — and the room, and everyone
 * else already invited, stand.
 */
export function NewRoomDialog({
  connection,
  open = true,
  onOpenChange,
  onCreated,
}: {
  connection: WorkspaceConnection;
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (roomId: string) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent data-testid="new-room-dialog">
        <NewRoomBody connection={connection} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

function NewRoomBody({ connection, onCreated }: { connection: WorkspaceConnection; onCreated: (roomId: string) => void }) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Once a room exists, invites happen against ITS id — the form moves from
  // "name this room" to "who's in it", in one dialog.
  const [roomId, setRoomId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly { userId: string; name: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [invited, setInvited] = useState<readonly string[]>([]);
  const [inviting, setInviting] = useState<string | null>(null);
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({});

  const create = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) {
      return;
    }
    setCreating(true);
    setCreateError(null);
    connection
      .createRoom(trimmed, topic)
      .then((id) => setRoomId(id))
      .catch((error: unknown) => setCreateError(error instanceof Error ? error.message : "Couldn't create the room — try again."))
      .finally(() => setCreating(false));
  };

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
    if (!roomId || inviting !== null) {
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
      // The org wall's own refusal (e.g. a cross-org colleague) — surfaced
      // beside that person, not as a blanket "something went wrong": the
      // room and every other invite already sent still stand.
      .catch((error: unknown) =>
        setInviteErrors((errors) => ({ ...errors, [userId]: error instanceof Error ? error.message : "Couldn't invite them — try again." })),
      )
      .finally(() => setInviting(null));
  };

  if (roomId === null) {
    return (
      <>
        <DialogTitle>New group</DialogTitle>
        <DialogDescription>Name it for what it&apos;s about — you&apos;ll invite people next.</DialogDescription>
        <form className="flex flex-col gap-2" onSubmit={create}>
          <label className="flex flex-col gap-1 type-body">
            Name
            <input
              aria-label="Group name"
              autoFocus
              className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
              onChange={(e) => {
                setName(e.target.value);
                setCreateError(null);
              }}
              placeholder="Project X"
              value={name}
            />
          </label>
          <label className="flex flex-col gap-1 type-body">
            Topic (optional)
            <input
              aria-label="Group topic"
              className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What it's for"
              value={topic}
            />
          </label>
          {createError && (
            <p className="type-body text-[var(--refused)]" data-testid="new-room-error">
              {createError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <button className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" type="button">
                Cancel
              </button>
            </DialogClose>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
              data-testid="new-room-create"
              disabled={creating || name.trim().length === 0}
              type="submit"
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </>
    );
  }

  return (
    <>
      <DialogTitle>Invite people to {name.trim()}</DialogTitle>
      <DialogDescription>Search your workspace for colleagues to add — or skip this and invite them later from the room.</DialogDescription>
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
        <p className="type-body text-[var(--refused)]" data-testid="new-room-search-error">
          {searchError}
        </p>
      )}
      {results !== null && results.length === 0 && (
        <p className="type-body text-[var(--muted)]" data-testid="new-room-none">
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
                  data-testid="new-room-person"
                  disabled={inviting !== null || already}
                  onClick={() => invite(person.userId)}
                  type="button"
                >
                  {labelFor(person)} {already && "— Invited"}
                </button>
                {inviteErrors[person.userId] && (
                  <p className="type-body text-[var(--refused)]" data-testid="new-room-invite-error">
                    {inviteErrors[person.userId]}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)]"
          data-testid="new-room-done"
          onClick={() => onCreated(roomId)}
          type="button"
        >
          Done
        </button>
      </div>
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
