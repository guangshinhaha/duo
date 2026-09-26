import { useEffect, useId, useMemo, useState } from "react";
import { ApiRequestError, type DuoApiConfig } from "../api/client.js";
import { useDraft, useEscalationHistory, useEscalationRate } from "../api/queries.js";
import type { EscalationUrgencyRate, SentEscalationDigest } from "../api/types.js";
import { DraftCard } from "../components/DraftCard.js";
import { MeterBar } from "../components/MeterBar.js";
import { MutationError } from "../components/MutationError.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { escalationPattern, type EscalationGroup } from "../escalations/pattern.js";

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * The cache is a storage layer, not a promise: a rate payload that is not
 * the daemon's documented shape is not an answer, and the section must say
 * so rather than draw a bar from `undefined` (the Knowledge screen's own
 * braces-and-belt law).
 */
function isRateShape(value: unknown): value is EscalationUrgencyRate {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.total === "number" && typeof candidate.urgent === "number" && typeof candidate.rate === "number";
}

/**
 * The rate, honestly (#54 AC3, the Mirror's rule on precision — §1.6): the
 * daemon's own counts in words, its own `rate` drawn as a bar's width, and
 * no numeral for the proportion. `rate` is `urgent / total` over every
 * escalation the daemon has ever classified — urgent ones included, which
 * the digests below never carry — so it is read off the wire, not
 * recomputed from the digests, and with nothing classified there is no bar
 * at all: a zero would read as a measurement of "never urgent".
 */
function RateSection({ api }: { api: DuoApiConfig }) {
  const rate = useEscalationRate(api);
  let body;
  if (rate.isLoading) {
    body = (
      <p className="type-provenance text-[var(--muted)]" data-testid="escalation-rate-loading">
        Reading the rate…
      </p>
    );
  } else if (rate.error) {
    body = (
      <p className="type-provenance text-[var(--refused)]" data-testid="escalation-rate-error" role="status">
        {(rate.error as Error).message}
      </p>
    );
  } else if (!isRateShape(rate.data)) {
    body = (
      <p className="type-provenance text-[var(--refused)]" data-testid="escalation-rate-error" role="status">
        The daemon's rate wasn't in a shape this client reads.
      </p>
    );
  } else if (rate.data.total === 0) {
    body = (
      <p className="type-body text-[var(--muted)]" data-testid="escalation-rate">
        No escalations classified yet — there is no rate to show.
      </p>
    );
  } else {
    const { total, urgent } = rate.data;
    body = (
      <div className="flex flex-col gap-2" data-testid="escalation-rate">
        <p className="type-body">
          {urgent} of {total} {plural(total, "escalation was", "escalations were")} urgent
        </p>
        <MeterBar value={rate.data.rate} testId="escalation-rate" />
        <p className="type-provenance text-[var(--muted)]">
          Counted over every escalation your duo has raised, urgent ones included. Urgent ones interrupt live instead of waiting for a digest.
        </p>
      </div>
    );
  }
  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid="escalation-rate-section">
      <h2 className="type-heading">How many were urgent</h2>
      {body}
    </section>
  );
}

/** The opened escalation: the group's most recent draft, on the same card Review shows — its answer is `POST /drafts/:id/answer`, nothing new. */
function OpenedEscalation({ api, draftId }: { api: DuoApiConfig; draftId: string }) {
  const draft = useDraft(api, draftId);
  if (draft.isPending) {
    return <p className="type-provenance text-[var(--muted)]">Opening the draft…</p>;
  }
  if (draft.isError) {
    return draft.error instanceof ApiRequestError && draft.error.status === 404 ? (
      <p className="type-body">This draft is not on this duo.</p>
    ) : (
      <MutationError error={draft.error} />
    );
  }
  return <DraftCard api={api} draft={draft.data} />;
}

function GroupRow({ api, group, total }: { api: DuoApiConfig; group: EscalationGroup; total: number }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <li className="shape-entry flex flex-col gap-2 p-4" data-testid="escalation-group">
      <div className="flex items-start justify-between gap-3">
        <p className="type-body min-w-0 break-words">{group.question}</p>
        <p className="shrink-0 type-body" data-testid="escalation-group-count">
          <span aria-hidden="true">{group.count}×</span>
          <span className="sr-only">
            escalated {group.count} {plural(group.count, "time", "times")}
          </span>
        </p>
      </div>
      <MeterBar value={group.count / total} testId="escalation-group-share" />
      {group.escalationReason && (
        <p className="type-provenance text-[var(--muted)]" data-testid="escalation-group-reason">
          {group.escalationReason}
        </p>
      )}
      <button
        aria-controls={panelId}
        aria-expanded={open}
        className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {open ? "Close" : "Open"}
      </button>
      <div id={panelId} hidden={!open}>
        {open && <OpenedEscalation api={api} draftId={group.draftIds[0]!} />}
      </div>
    </li>
  );
}

/** Every page, or an honest note that some are missing — a count over half the history must never pass as the whole. */
function PatternSection({ api }: { api: DuoApiConfig }) {
  const history = useEscalationHistory(api);
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = history;

  // The pattern counts across every digest, so page through the daemon's
  // whole history before drawing anything. An error stops the walk (the
  // note below offers the retry) instead of looping on it.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  const digests: SentEscalationDigest[] = useMemo(
    () => (Array.isArray(history.data?.pages) ? history.data.pages.flatMap((page) => (Array.isArray(page) ? page : [])) : []),
    [history.data],
  );
  const pattern = useMemo(() => escalationPattern(digests), [digests]);

  let body;
  if (history.isError && !history.data) {
    body = <RouteError api={api} error={history.error} onRetry={() => void history.refetch()} />;
  } else if (history.isLoading || (hasNextPage && !isError)) {
    body = <RouteLoading variant="rows" />;
  } else if (pattern.totalEscalations === 0) {
    body = (
      <p className="type-body text-[var(--muted)]" data-testid="escalations-empty">
        No escalations have been batched into a digest yet, so there is no pattern to show.
      </p>
    );
  } else {
    body = (
      <>
        <p className="type-provenance text-[var(--muted)]" data-testid="escalation-scope">
          {pattern.totalEscalations} {plural(pattern.totalEscalations, "escalation", "escalations")} across {pattern.digestCount}{" "}
          {plural(pattern.digestCount, "digest", "digests")} · {formatDate(pattern.periodStart)} – {formatDate(pattern.periodEnd)}. Grouped by
          identical question wording. Urgent escalations interrupt live instead of waiting for a digest, so they are not counted here.
        </p>
        {history.isError && (
          <div className="flex flex-col items-start gap-2" data-testid="escalations-incomplete" role="status">
            <p className="type-provenance text-[var(--refused)]">
              Some digests could not be loaded, so these counts are incomplete. {(history.error as Error).message}
            </p>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
              onClick={() => void fetchNextPage()}
            >
              Try again
            </button>
          </div>
        )}
        <ul className="flex flex-col gap-3">
          {pattern.groups.map((group) => (
            <GroupRow key={group.draftIds[0]} api={api} group={group} total={pattern.totalEscalations} />
          ))}
        </ul>
      </>
    );
  }
  return (
    <section className="flex flex-col gap-3" data-testid="escalation-pattern">
      <h2 className="type-heading">What it escalates most</h2>
      {body}
    </section>
  );
}

/**
 * What the duo keeps having to ask about (#54): the pattern across its
 * escalations, where individual ones only ever showed in Review — the
 * clearest signal of where the corpus is thin and which standing orders are
 * missing. Read-only by construction: it reads digital-duo #178's history
 * and rate, and never the digest POST, because assembling a digest is the
 * send (it writes the append-only row and marks its items), and opening a
 * screen must not send anything. The fix is the existing one — open a group
 * and answer its latest escalation, which queues a standing-order candidate
 * for approval in Corrections. Escalation thresholds are not this screen's
 * to change.
 */
export function Escalations({ api }: { api: DuoApiConfig }) {
  return (
    <div className="flex flex-col gap-6 p-6" data-testid="escalations">
      <header className="flex flex-col gap-1">
        <h1 className="type-heading">Escalations</h1>
        <p className="type-provenance text-[var(--muted)]">
          What your duo keeps having to ask you about — where its knowledge runs out. Answering one queues a standing-order candidate.
        </p>
      </header>
      <RateSection api={api} />
      <PatternSection api={api} />
    </div>
  );
}
