import { useState, type FormEvent } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import { isDuoUserId, duoOwnerLabel, localpartOf } from "../workspace/identity.js";
import type { WorkspaceConnection } from "../workspace/matrix.js";

/**
 * #63: starting a conversation — search the workspace's people directory,
 * pick who, and the direct room opens. The directory answers people and
 * duos both, and a duo is addressed by what its user id says it is
 * ("carol's duo", from the `@duo-` grammar) — never by the display name a
 * profile chose for itself.
 */
export function NewConversationDialog({
  connection,
  onOpenChange,
  onStarted,
}: {
  connection: WorkspaceConnection;
  onOpenChange: (open: boolean) => void;
  onStarted: (roomId: string) => void;
}) {
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
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-testid="new-conversation-dialog">
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
                {labelFor(person)}
              </button>
            ))}
          </div>
        )}
        <DialogClose asChild>
          <button className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body">
            Cancel
          </button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

/** Who a directory entry reads as: a duo by its owner (from the id's grammar), a person by their name. */
function labelFor(person: { userId: string; name: string }): string {
  if (isDuoUserId(person.userId)) {
    return `${duoOwnerLabel(person.userId) ?? localpartOf(person.userId)}'s duo`;
  }
  return person.name;
}
