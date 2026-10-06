import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useAudit, useCorrectPublicAnswer, usePublicAnswers } from "../api/queries.js";
import type { AuditEntry, DraftSource, PublicAnswerLogEntry } from "../api/types.js";
import { DuoLine } from "../components/DuoLine.js";
import { MutationError } from "../components/MutationError.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { PatternSection, RateSection } from "./Patterns.js";
import { PUBLIC_PASSED_ON_MESSAGE } from "../workspace/duoAnswer.js";
import { plainAsker, relativeDay } from "./words.js";

type ActivityOutcome = "refused" | "passed on" | "answered";
const OUTCOME_WORDS = { refused: "refused — a boundary you set", "passed on": "passed to you", answered: "answered for you" } as const;
const OUTCOME_FILTERS: ReadonlyArray<{ value: ActivityOutcome | "all"; label: string }> = [
  { value: "all", label: "Any outcome" },
  { value: "answered", label: "Answered" },
  { value: "passed on", label: "Passed on" },
  { value: "refused", label: "Refused" },
];
const DATE_FILTERS: ReadonlyArray<{ value: DateFilter; label: string }> = [
  { value: "all", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];
type DateFilter = "all" | "today" | "week" | "month";

/** What became of a question somebody asked through one of your links, said plainly. */
function outcomeOf(entry: AuditEntry): ActivityOutcome {
  if (entry.declined) {
    return "refused";
  }
  const text = entry.answerText ?? "";
  return text === PUBLIC_PASSED_ON_MESSAGE || /passed (it|this one) (on )?to the owner/i.test(text) ? "passed on" : "answered";
}

/**
 * One answer your duo gave on your behalf, from either log this tab reads
 * (#267): the CLI per-asker log (`GET /audit`) and the ask-link log
 * (`GET /mirror/public-answers`) are different daemon tables for different
 * surfaces, but to an owner they're the same fact — "my duo answered this
 * for me" — so they render as one list, newest first.
 */
interface ActivityItem {
  id: string;
  createdAt: string;
  askerRef: string;
  askerResolved: boolean;
  question: string;
  answerText: string;
  outcome: ActivityOutcome;
  sources: readonly DraftSource[];
  /** True only for a logged, un-corrected "answered" exchange from the ask-link log — the one kind `correctPublicAnswer` accepts. */
  correctable: boolean;
  /** The correction already sent for this entry, if any — nested under it rather than shown as its own row (#267 AC2: "visibly linked to the original answer"). */
  correction: PublicAnswerLogEntry | undefined;
}

function fromAudit(entry: AuditEntry): ActivityItem {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    askerRef: entry.askerRef,
    askerResolved: entry.askerResolved,
    question: entry.question,
    answerText: entry.answerText,
    outcome: outcomeOf(entry),
    sources: [],
    correctable: false,
    correction: undefined,
  };
}

function fromPublicAnswer(entry: PublicAnswerLogEntry, correctionsByOriginal: ReadonlyMap<string, PublicAnswerLogEntry>): ActivityItem {
  const outcome: ActivityOutcome = entry.outcome === "declined_refused" ? "refused" : entry.outcome === "passed_on" ? "passed on" : "answered";
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    askerRef: entry.askerRef,
    askerResolved: entry.askerResolved === true,
    question: entry.question,
    answerText: entry.text,
    outcome,
    sources: entry.sources,
    correctable: entry.outcome === "answered" && !correctionsByOriginal.has(entry.id),
    correction: correctionsByOriginal.get(entry.id),
  };
}

/** Same-calendar-day/week/month, local time — a preset an owner recognises, never a raw duration. */
function withinDateFilter(iso: string, filter: DateFilter, now: Date): boolean {
  if (filter === "all") {
    return true;
  }
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const when = new Date(iso);
  const days = Math.round((start(now) - start(when)) / (24 * 60 * 60 * 1000));
  if (filter === "today") {
    return days === 0;
  }
  if (filter === "week") {
    return days >= 0 && days < 7;
  }
  return when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth();
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** #267 AC4: exportable for audit — exactly the rows currently shown, in the exact words recorded (never the summarised sentence). */
function toCsv(items: readonly ActivityItem[]): string {
  const header = ["Date", "Person", "Outcome", "Question", "Answer", "Sources"];
  const rows = items.map((item) => [
    new Date(item.createdAt).toISOString(),
    plainAsker(item.askerRef, item.askerResolved),
    item.outcome,
    item.question,
    item.answerText,
    item.sources.map((source) => source.label).join("; "),
  ]);
  return [header, ...rows].map((row) => row.map(csvField).join(",")).join("\n");
}

function downloadCsv(items: readonly ActivityItem[]): void {
  const blob = new Blob([toCsv(items)], { type: "text/csv" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `duo-activity-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

/** "That was wrong" (#267 AC2/AC3): a correction is a new, visibly-linked entry and an immediate demotion — never an edit to what was said. */
function CorrectionForm({ api, entryId, onDone }: { api: DuoApiConfig; entryId: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const correct = useCorrectPublicAnswer(api);
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="activity-correction-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim().length > 0 && !correct.isPending) {
          correct.mutate({ entryId, correctedText: text.trim() }, { onSuccess: onDone });
        }
      }}
    >
      <label className="flex flex-col gap-1 type-provenance text-[var(--muted)]">
        What&apos;s actually true, in your words
        <textarea
          className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2 py-2 type-body"
          data-testid="activity-correction-text"
          onChange={(e) => setText(e.target.value)}
          rows={2}
          value={text}
        />
      </label>
      <div className="flex gap-2">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
          data-testid="activity-correction-send"
          disabled={text.trim().length === 0 || correct.isPending}
          type="submit"
        >
          {correct.isPending ? "Sending…" : "Send correction"}
        </button>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
          onClick={onDone}
          type="button"
        >
          Cancel
        </button>
      </div>
      <MutationError error={correct.error} />
    </form>
  );
}

/** What a sent correction actually did — posted (or not) and, when it moved a topic, said in the daemon's own words (already folded into `correction.text`). */
function CorrectionRecord({ correction }: { correction: PublicAnswerLogEntry }) {
  return (
    <div className="flex flex-col gap-2" data-testid="activity-correction-sent">
      <p className="type-provenance text-[var(--muted)]">You sent a correction, {relativeDay(correction.createdAt)}:</p>
      <DuoLine attributionTestId="activity-correction-attribution" label="Your duo" state="neutral" testId="activity-correction">
        {correction.text}
      </DuoLine>
    </div>
  );
}

/**
 * One exchange, people first: who, what became of it, when — the words an
 * owner would use ("Rae · answered for you · Tuesday"). The exact question and
 * answer, the exact time and the daemon's own asker reference are one tap
 * away, because the record must stay exact even where the summary is plain.
 * The asker wrote the question, not the owner: only the duo's answer is
 * behind the duo's line (AR-13 cuts both ways). A correctable entry (#267)
 * offers "That was wrong" inside the same disclosure, never its own row.
 */
function Exchange({ api, item, correcting, setCorrecting }: { api: DuoApiConfig; item: ActivityItem; correcting: boolean; setCorrecting: (id: string | null) => void }) {
  return (
    <li className="shape-entry flex flex-col gap-2 p-4" data-testid="activity-entry">
      <p className="type-body" data-testid="activity-summary">
        {plainAsker(item.askerRef, item.askerResolved)} · {OUTCOME_WORDS[item.outcome]} · {relativeDay(item.createdAt)}
      </p>
      <details>
        <summary className="cursor-pointer type-provenance text-[var(--muted)]">Details</summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="type-body" data-testid="activity-question">
            {item.question}
          </p>
          <DuoLine attributionTestId="activity-answer-attribution" label="Your duo" state={item.outcome === "refused" ? "refused" : "neutral"} testId="activity-answer">
            <span data-testid="audit-answer">{item.answerText}</span>
          </DuoLine>
          {item.sources.length > 0 && (
            <p className="type-provenance text-[var(--muted)]" data-testid="activity-sources">
              Drew on {item.sources.map((source) => source.label).join(", ")}
            </p>
          )}
          <p className="type-identifier text-[var(--faint)]" data-testid="activity-record">
            {new Date(item.createdAt).toLocaleString()} · {item.askerRef}
            {item.askerResolved ? "" : " · unresolved"}
          </p>
          {item.correction && <CorrectionRecord correction={item.correction} />}
          {item.correctable && !correcting && (
            <button
              className="inline-flex min-h-11 w-fit items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--muted)]"
              data-testid="activity-that-was-wrong"
              onClick={() => setCorrecting(item.id)}
              type="button"
            >
              That was wrong
            </button>
          )}
          {item.correctable && correcting && <CorrectionForm api={api} entryId={item.id} onDone={() => setCorrecting(null)} />}
        </div>
      </details>
    </li>
  );
}

/**
 * What your duo did, and where it runs out (the profile's Activity tab): the
 * people who asked it something through your links and what became of each
 * — newest first, in a person's terms, filterable by person, outcome and
 * date, and exportable as CSV (#267 AC1/AC4) — and, beneath it, the
 * questions it keeps having to ask you and how many were urgent: the
 * clearest signal of where its knowledge is thin.
 *
 * Reads two daemon logs as one list (`GET /audit`, the CLI per-asker
 * path, and `GET /mirror/public-answers`, the real ask-link path #43/#45
 * ship) — see `ActivityItem`'s doc comment. Mostly read-only (AR-18 is
 * about free-text authoring with no CLI equivalent; "That was wrong" has
 * one, `duo permissions correct`, so it is in scope here): nothing here
 * edits or redacts what was said. A correction is always a new, linked
 * entry, never a change to the original (#267 AC2/AC3).
 */
export function Activity({ api }: { api: DuoApiConfig }) {
  const audit = useAudit(api);
  const publicAnswers = usePublicAnswers(api);
  const [person, setPerson] = useState<string>("all");
  const [outcome, setOutcome] = useState<ActivityOutcome | "all">("all");
  const [date, setDate] = useState<DateFilter>("all");
  const [correctingId, setCorrectingId] = useState<string | null>(null);

  if (audit.isLoading || publicAnswers.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  const error = audit.error ?? publicAnswers.error;
  if (error) {
    return (
      <RouteError
        api={api}
        error={error}
        onRetry={() => {
          void audit.refetch();
          void publicAnswers.refetch();
        }}
      />
    );
  }

  const auditEntries = Array.isArray(audit.data) ? audit.data : [];
  const publicEntries = Array.isArray(publicAnswers.data) ? publicAnswers.data : [];
  const correctionsByOriginal = new Map(
    publicEntries.filter((entry) => entry.outcome === "corrected" && entry.correctsEntryId !== null).map((entry) => [entry.correctsEntryId as string, entry]),
  );
  const items: ActivityItem[] = [
    ...auditEntries.map(fromAudit),
    ...publicEntries.filter((entry) => entry.outcome !== "corrected").map((entry) => fromPublicAnswer(entry, correctionsByOriginal)),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const people = Array.from(new Set(items.map((item) => plainAsker(item.askerRef, item.askerResolved)))).sort();
  const now = new Date();
  const filtered = items.filter(
    (item) =>
      (person === "all" || plainAsker(item.askerRef, item.askerResolved) === person) &&
      (outcome === "all" || item.outcome === outcome) &&
      withinDateFilter(item.createdAt, date, now),
  );
  return (
    <div className="flex max-w-2xl flex-col gap-6 p-6" data-testid="activity-tab">
      <section className="flex flex-col gap-3" data-testid="activity-asked">
        <h2 className="type-heading">Asked through your links</h2>
        {items.length === 0 ? (
          <p className="type-body text-[var(--muted)]" data-testid="activity-empty">
            No one has asked your duo anything yet. When someone does — and it answers, passes it to you, or refuses — it shows here.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2" data-testid="activity-filters">
              <select
                aria-label="Filter by person"
                className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 type-provenance text-[var(--text)]"
                data-testid="activity-filter-person"
                onChange={(e) => setPerson(e.target.value)}
                value={person}
              >
                <option value="all">Anyone</option>
                {people.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by outcome"
                className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 type-provenance text-[var(--text)]"
                data-testid="activity-filter-outcome"
                onChange={(e) => setOutcome(e.target.value as ActivityOutcome | "all")}
                value={outcome}
              >
                {OUTCOME_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter by date"
                className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 type-provenance text-[var(--text)]"
                data-testid="activity-filter-date"
                onChange={(e) => setDate(e.target.value as DateFilter)}
                value={date}
              >
                {DATE_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                className="ml-auto inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance text-[var(--muted)]"
                data-testid="activity-export-csv"
                onClick={() => downloadCsv(filtered)}
                type="button"
              >
                Export CSV
              </button>
            </div>
            {filtered.length === 0 ? (
              <p className="type-body text-[var(--muted)]" data-testid="activity-filtered-empty">
                No answers match these filters.
              </p>
            ) : (
              <ul className="flex flex-col gap-3" data-testid="activity-list">
                {filtered.map((item) => (
                  <Exchange api={api} correcting={correctingId === item.id} item={item} key={item.id} setCorrecting={setCorrectingId} />
                ))}
              </ul>
            )}
          </>
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
