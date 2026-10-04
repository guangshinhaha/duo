import { useState, type FormEvent } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import { directoryEntryLabel } from "../workspace/identity.js";
import type { WorkspaceConnection } from "../workspace/matrix.js";

/**
 * #63: starting a conversation — search the workspace's people directory,
 * pick who, and the direct room opens. The directory answers people and
 * duos both, and a duo is addressed by what its user id says it is
 * ("carol's duo", from the `@duo-` grammar) — never by the display name a
 * profile chose for itself.
 *
 * #207: this dialog's own search now shares its road with the one search
 * box (`CommandSearch.tsx`) — `searchPeople`'s three merged sources and the
 * fixed `startDirect` (reuses a DM already open with this person) live at
 * the seam (`matrix.ts`), so both surfaces answer the same way without this
 * dialog knowing anything changed. Kept as a thin, dedicated way in from the
 * pencil icon rather than retired, since nothing here duplicates
 * CommandSearch's suggestion UI — it is still its own small form.
 */
export function NewConversationDialog({
  connection,
  open = true,
  onOpenChange,
  onStarted,
}: {
  connection: WorkspaceConnection;
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (roomId: string) => void;
}) {
  // `open` is the parent's, so closing plays the exit before the body (and its search) unmounts.
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent data-testid="new-conversation-dialog">
        <NewConversationBody connection={connection} onStarted={onStarted} />
      </DialogContent>
    </Dialog>
  );
}

function NewConversationBody({ connection, onStarted }: { connection: WorkspaceConnection; onStarted: (roomId: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly { userId: string; name: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = (event: FormEvent): void => {
    event.preventDefault();
    const term = query.trim();
    if (!term || searching) {
      return;
    }
    setSearching(true);
    setError(null);
    connection
      .searchPeople(term)
      .then((people) => setResults(people))
      .catch(() => setError("The workspace didn't answer — try again."))
      .finally(() => setSearching(false));
  };

  const start = (userId: string): void => {
    if (starting !== null) {
      return;
    }
    setStarting(userId);
    setError(null);
    connection
      .startDirect(userId)
      .then((roomId) => onStarted(roomId))
      .catch(() => setError("Couldn't start the conversation — try again."))
      .finally(() => setStarting(null));
  };

  return (
    <>
      <DialogTitle>New conversation</DialogTitle>
      <DialogDescription>Search your workspace for the person — or colleague&apos;s duo — to talk with.</DialogDescription>
      <form className="flex gap-2" onSubmit={search}>
        <input
          aria-label="Search people"
          className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
          placeholder="Name or id"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setError(null);
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
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="new-conversation-error">
          {error}
        </p>
      )}
      {results !== null && results.length === 0 && (
        <p className="type-body text-[var(--muted)]" data-testid="new-conversation-none">
          No one found.
        </p>
      )}
      {results !== null && results.length > 0 && (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {results.map((person) => (
            <button
              className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-left type-body text-[var(--text)] disabled:opacity-40"
              data-testid="new-conversation-person"
              disabled={starting !== null}
              key={person.userId}
              onClick={() => start(person.userId)}
              type="button"
            >
              {directoryEntryLabel(person)}
            </button>
          ))}
        </div>
      )}
      <DialogClose asChild>
        <button className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body">
          Cancel
        </button>
      </DialogClose>
    </>
  );
}
