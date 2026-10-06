import type { DuoApiConfig } from "../api/client.js";
import { useKnowledge } from "../api/queries.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { ScheduledSends } from "../components/ScheduledSends.js";
import { corpusSentence, lastImportSentence } from "../profile/knowledgeWords.js";
import type { WorkspaceConnection } from "../workspace/matrix.js";
import { useWaitingItems } from "./waiting.js";

/**
 * The pane beside the "Waiting on you" list (`#waiting`): what the queue is,
 * and where to start. The decisions themselves are made in the chats (and
 * on the draft pages) the list's rows open — this is only the front door to
 * them, and the answer to "is there anything?".
 *
 * An empty queue is this app's opening screen for weeks (AR-19), so it makes
 * the product's argument, not an apology: the headline stays the headline,
 * and beneath it what the duo knows so far and the one thing that would teach
 * it more — every count the daemon's own (#45's read) and every sentence the
 * one Knowledge ships. That second read is gated to fire only once the queue
 * is known empty, and a failed read never blanks the queue it decorates.
 */
export function WaitingHome({ api, connection = null }: { api: DuoApiConfig; connection?: WorkspaceConnection | null }) {
  const waiting = useWaitingItems(api, connection);
  const knowledge = useKnowledge(api, { enabled: !waiting.isLoading && waiting.count === 0 });

  if (waiting.isLoading) {
    return <RouteLoading />;
  }
  if (waiting.error) {
    return <RouteError api={api} error={waiting.error} onRetry={waiting.refetch} />;
  }
  if (waiting.count === 0) {
    const known = knowledge.data;
    return (
      <div className="p-6" data-testid="waiting-home-empty">
        <h1 className="type-heading motion-rise">Nothing waiting on you.</h1>
        <div className="shape-container mt-4 flex max-w-xl flex-col gap-2 p-4" data-testid="waiting-home-knowledge">
          {known?.records && known.corpus ? (
            <>
              <p className="type-body text-[var(--text)]">
                It has read {known.records.total} of your messages and notes so far · {lastImportSentence(known.lastImport)}
              </p>
              <p className="type-body text-[var(--text)]">{corpusSentence(known.corpus)}</p>
            </>
          ) : knowledge.isLoading ? (
            // The read is on its way — a quiet shape, not a word.
            <div className="shape-entry-quiet motion-skeleton p-4" />
          ) : null}
          <p className="type-provenance text-[var(--muted)]">⌘K searches what your duo knows.</p>
        </div>
        <ScheduledSends api={api} />
      </div>
    );
  }
  const oldest = waiting.items[0]!;
  return (
    <div className="flex max-w-xl flex-col gap-3 p-6" data-testid="waiting-home">
      <h1 className="type-heading">Waiting on you</h1>
      <p className="type-body text-[var(--muted)]">
        {waiting.count === 1 ? "One decision is waiting on you." : `${waiting.count} decisions are waiting on you.`} They are decided in the chat
        they belong to, oldest first. J and K move between them.
      </p>
      <a
        className="inline-flex min-h-11 items-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)]"
        data-testid="waiting-home-start"
        href={oldest.href}
      >
        Start with the oldest
      </a>
      <ScheduledSends api={api} />
    </div>
  );
}
