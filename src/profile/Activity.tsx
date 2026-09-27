import type { DuoApiConfig } from "../api/client.js";
import { useAudit } from "../api/queries.js";
import type { AuditEntry } from "../api/types.js";
import { DuoLine } from "../components/DuoLine.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { PatternSection, RateSection } from "./Patterns.js";
import { PUBLIC_PASSED_ON_MESSAGE } from "../workspace/duoAnswer.js";
import { plainAsker, relativeDay } from "./words.js";

/** What became of a question somebody asked through one of your links, said plainly. */
function outcomeOf(entry: AuditEntry): "refused" | "passed on" | "answered" {
  if (entry.declined) {
    return "refused";
  }
  const text = entry.answerText ?? "";
  return text === PUBLIC_PASSED_ON_MESSAGE || /passed (it|this one) (on )?to the owner/i.test(text) ? "passed on" : "answered";
}

const OUTCOME_WORDS = { refused: "refused — a boundary you set", "passed on": "passed to you", answered: "answered for you" } as const;

/**
 * One exchange, people first: who, what became of it, when — the words an
 * owner would use ("Rae · answered for you · Tuesday"). The exact question and
 * answer, the exact time and the daemon's own asker reference are one tap
 * away, because the record must stay exact even where the summary is plain.
 * The asker wrote the question, not the owner: only the duo's answer is
 * behind the duo's line (AR-13 cuts both ways).
 */
function Exchange({ entry }: { entry: AuditEntry }) {
  const outcome = outcomeOf(entry);
  return (
    <li className="shape-entry flex flex-col gap-2 p-4" data-testid="activity-entry">
      <p className="type-body" data-testid="activity-summary">
        {plainAsker(entry.askerRef, entry.askerResolved)} · {OUTCOME_WORDS[outcome]} · {relativeDay(entry.createdAt)}
      </p>
      <details>
        <summary className="cursor-pointer type-provenance text-[var(--muted)]">Details</summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="type-body" data-testid="activity-question">
            {entry.question}
          </p>
          <DuoLine attributionTestId="activity-answer-attribution" label="Your duo" state={outcome === "refused" ? "refused" : "neutral"} testId="activity-answer">
            <span data-testid="audit-answer">{entry.answerText}</span>
          </DuoLine>
          <p className="type-identifier text-[var(--faint)]" data-testid="activity-record">
            {new Date(entry.createdAt).toLocaleString()} · {entry.askerRef}
            {entry.askerResolved ? "" : " · unresolved"}
          </p>
        </div>
      </details>
    </li>
  );
}

/**
 * What your duo did, and where it runs out (the profile's Activity tab): the
 * people who asked it something through your links and what became of each
 * — newest first, in a person's terms — and, beneath it, the questions it
 * keeps having to ask you and how many were urgent: the clearest signal of
 * where its knowledge is thin. Read-only (AR-18): nothing here edits,
 * answers or redacts. To fix a gap, answer that question where it is asked.
 */
export function Activity({ api }: { api: DuoApiConfig }) {
  const audit = useAudit(api);
  if (audit.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (audit.error) {
    return <RouteError api={api} error={audit.error} onRetry={() => void audit.refetch()} />;
  }
  const entries = Array.isArray(audit.data) ? audit.data : [];
  return (
    <div className="flex max-w-2xl flex-col gap-6 p-6" data-testid="activity-tab">
      <section className="flex flex-col gap-3" data-testid="activity-asked">
        <h2 className="type-heading">Asked through your links</h2>
        {entries.length === 0 ? (
          <p className="type-body text-[var(--muted)]" data-testid="activity-empty">
            No one has asked your duo anything yet. When someone does — and it answers, passes it to you, or refuses — it shows here.
          </p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="activity-list">
            {[...entries].reverse().map((entry) => (
              <Exchange entry={entry} key={entry.id} />
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-3" data-testid="activity-runs-out">
        <h2 className="type-heading">Where it runs out</h2>
        <p className="type-provenance text-[var(--muted)]">What your duo keeps having to ask you about. Answering one queues a standing-order candidate.</p>
        <RateSection api={api} />
        <PatternSection api={api} />
      </section>
    </div>
  );
}
