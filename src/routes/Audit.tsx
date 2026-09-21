import type { DuoApiConfig } from "../api/client.js";
import { useAudit } from "../api/queries.js";
import type { AuditEntry } from "../api/types.js";
import { DuoMessage } from "../components/DuoMessage.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * One asked-and-answered pair. The question is *not* `OwnerMessage` — the
 * asker wrote it, not the owner, and AR-13's identity split cuts both ways:
 * only the duo's answer carries the duo's attribution.
 */
function AuditItem({ entry }: { entry: AuditEntry }) {
  return (
    <div className="flex flex-col gap-2 shape-entry p-4" data-testid="audit-entry">
      <div className="flex flex-wrap items-center gap-2 type-provenance text-[var(--muted)]">
        <span data-testid="audit-when">{formatWhen(entry.createdAt)}</span>
        <span className="type-identifier" data-testid="audit-asker">
          {entry.askerRef}
          {entry.askerResolved ? null : (
            <span className="ml-1 rounded-[var(--r-sm)] border border-dashed border-[var(--edge)] px-2 py-0" data-testid="audit-asker-unresolved">
              unresolved
            </span>
          )}
        </span>
        {entry.declined && (
          <span className="rounded-[var(--r-sm)] border border-[var(--edge)] px-2 py-0 text-[var(--refused)]" data-testid="audit-declined">
            declined
          </span>
        )}
      </div>
      <div className="type-body" data-testid="audit-question">
        {entry.question}
      </div>
      <DuoMessage>
        <span data-testid="audit-answer">{entry.answerText}</span>
      </DuoMessage>
    </div>
  );
}

/**
 * The permissions audit (`client-tech-design.md` §3.1, `GET /audit`): every
 * question someone asked this duo and what it answered — the owner's
 * check on what was said on their behalf. Answer text renders verbatim;
 * the daemon sends oldest first, so the list reverses to read newest
 * first. Read-only by design (AR-18): nothing here edits, answers, or
 * redacts.
 */
export function Audit({ api }: { api: DuoApiConfig }) {
  const { data: entries, isLoading, error, refetch } = useAudit(api);

  if (isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (error) {
    return <RouteError api={api} error={error} onRetry={() => void refetch()} />;
  }
  if (!entries || entries.length === 0) {
    return (
      <div className="p-6 text-[var(--muted)]" data-testid="audit-empty">
        No one has asked this duo anything yet. When someone does — and it answers, passes, or declines — the exchange lands here.
      </div>
    );
  }

  return (
    // #33: the log is one panel — a record, grouped as a record.
    <div className="p-6">
      <div className="shape-container flex flex-col gap-4 p-4" data-testid="audit-list">
        {[...entries].reverse().map((entry) => (
          <AuditItem key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
