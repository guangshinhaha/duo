import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useAway, useDismissAwaySummary, useEndAway, useSetAway, useTopics } from "../api/queries.js";
import type { AwayPeriod, AwayScope, AwayState, AwaySummary } from "../api/types.js";
import { MutationError } from "../components/MutationError.js";

/** "Mon 12 Oct, 09:00" in this device's zone — when the owner's away period ends. */
export function awayUntilWords(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The daemon's AwayState only — anything else (an older daemon, an unexpected body) reads as nothing to show. */
function isAwayState(value: unknown): value is AwayState {
  return typeof value === "object" && value !== null && "active" in value && "summary" in value;
}

/** Tomorrow at 09:00 local, as a `datetime-local` value: the end time a "back tomorrow" away most often wants. */
function defaultUntilInput(now: Date = new Date()): string {
  const next = new Date(now);
  next.setDate(now.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
}

const SCOPE_WORDS: Record<AwayScope, string> = {
  may_do: "Only what May do already allows",
  may_do_and_topics: "May do, plus topics I pick for this time away",
};

/**
 * #270: the status line in your duo's chat while you're away — when you're
 * back, and exactly what colleagues are being told. Renders nothing when
 * you're in, or when the daemon can't say (an older daemon has no /away).
 */
export function AwayStatusLine({ api }: { api: DuoApiConfig }) {
  const away = useAway(api);
  if (!isAwayState(away.data) || !away.data.active) {
    return null;
  }
  return (
    <p className="type-provenance text-[var(--escalate)]" data-testid="away-status" role="status">
      You&apos;re away until {awayUntilWords(away.data.active.until)} — your duo is answering what it may.
      {away.data.statusLine ? <span className="text-[var(--muted)]"> Colleagues see: “{away.data.statusLine}”</span> : null}
    </p>
  );
}

function SummaryList({ title, testId, items }: { title: string; testId: string; items: { question: string; askerRef: string; draftId: string }[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <h3 className="type-heading">
        {title} ({items.length})
      </h3>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li className="type-provenance text-[var(--muted)]" data-testid={`${testId}-item`} key={item.draftId}>
            “{item.question}” — {item.askerRef}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What happened during an away period, by outcome, in words. */
export function AwaySummaryBody({ summary }: { summary: AwaySummary }) {
  const waiting = summary.passedOn.filter((item) => item.waiting);
  const handled = summary.passedOn.filter((item) => !item.waiting);
  const nothing = summary.answered.length === 0 && summary.passedOn.length === 0 && summary.declined.length === 0;
  if (nothing) {
    return (
      <p className="type-provenance text-[var(--muted)]" data-testid="away-summary-empty">
        Nobody asked your duo anything{summary.ended ? " while you were away" : " yet"}.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <SummaryList items={summary.answered} testId="away-answered" title="Answered by your duo" />
      <SummaryList items={waiting} testId="away-waiting" title="Passed to you — still waiting" />
      <SummaryList items={handled} testId="away-handled" title="Passed to you — since handled" />
      <SummaryList items={summary.declined} testId="away-declined" title="Touched a never-answer rule" />
    </div>
  );
}

/**
 * #270: the return summary — once an away period has ended (on its own at
 * its end time, or because you came back early), what your duo answered and
 * what is waiting on you, until you put it away.
 */
export function ReturnSummaryCard({ api }: { api: DuoApiConfig }) {
  const away = useAway(api);
  const dismiss = useDismissAwaySummary(api);
  if (!isAwayState(away.data) || !away.data.summary || !away.data.summary.ended) {
    return null;
  }
  const { summary, last } = away.data;
  return (
    <section className="shape-container mb-5 flex flex-col gap-3 p-4" data-testid="away-return-summary">
      <h2 className="type-heading">Welcome back</h2>
      <p className="type-provenance text-[var(--muted)]">
        While you were away{last ? ` (until ${awayUntilWords(last.endedAt ?? last.until)})` : ""}, here&apos;s what your duo did.
      </p>
      <AwaySummaryBody summary={summary} />
      <button
        className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
        data-testid="away-summary-dismiss"
        disabled={dismiss.isPending}
        onClick={() => dismiss.mutate()}
        type="button"
      >
        Done
      </button>
      <MutationError error={dismiss.error} />
    </section>
  );
}

function ActiveAway({ api, period, summary }: { api: DuoApiConfig; period: AwayPeriod; summary: AwaySummary | null }) {
  const end = useEndAway(api);
  return (
    <div className="flex flex-col gap-3" data-testid="away-active">
      <p className="type-body">
        You&apos;re away until <span data-testid="away-until">{awayUntilWords(period.until)}</span>. It ends on its own then.
      </p>
      <p className="type-provenance text-[var(--muted)]" data-testid="away-scope">
        Answering: {SCOPE_WORDS[period.scope]}
        {period.extraTopics.length > 0 ? ` — ${period.extraTopics.map((topic) => topic.label).join(", ")}` : ""}. Everything else is passed to you.
      </p>
      {summary && <AwaySummaryBody summary={summary} />}
      <button
        className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
        data-testid="away-end"
        disabled={end.isPending}
        onClick={() => end.mutate()}
        type="button"
      >
        {end.isPending ? "Ending…" : "I'm back"}
      </button>
      <MutationError error={end.error} />
    </div>
  );
}

function SetAway({ api, onCancel }: { api: DuoApiConfig; onCancel: () => void }) {
  const [until, setUntil] = useState(defaultUntilInput);
  const [scope, setScope] = useState<AwayScope>("may_do");
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const topics = useTopics(api, scope === "may_do_and_topics");
  const set = useSetAway(api);
  const topicList = Array.isArray(topics.data) ? topics.data : [];
  const ready = until.length > 0 && (scope === "may_do" || topicIds.length > 0);

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="away-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || set.isPending) {
          return;
        }
        set.mutate(
          { until: new Date(until).toISOString(), scope, ...(scope === "may_do_and_topics" ? { extraTopicIds: topicIds } : {}) },
          // The form closes; the active period shows in its place.
          { onSuccess: onCancel },
        );
      }}
    >
      <label className="flex flex-col gap-1 type-body">
        Away until
        <input
          className="min-h-11 self-start rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
          data-testid="away-until-input"
          onChange={(e) => setUntil(e.target.value)}
          type="datetime-local"
          value={until}
        />
      </label>
      <fieldset className="flex flex-col gap-1">
        <legend className="type-body">While you&apos;re away, your duo answers</legend>
        {(Object.keys(SCOPE_WORDS) as AwayScope[]).map((option) => (
          <label className="inline-flex min-h-11 items-center gap-2 type-body" key={option}>
            <input checked={scope === option} data-testid={`away-scope-${option}`} name="away-scope" onChange={() => setScope(option)} type="radio" value={option} />
            {SCOPE_WORDS[option]}
          </label>
        ))}
      </fieldset>
      {scope === "may_do_and_topics" && (
        <fieldset className="flex flex-col gap-1" data-testid="away-topics">
          <legend className="type-provenance text-[var(--muted)]">Topics to answer while you&apos;re away</legend>
          {topics.isLoading && <p className="type-provenance text-[var(--faint)]">Loading topics…</p>}
          {!topics.isLoading && topicList.length === 0 && (
            <p className="type-provenance text-[var(--faint)]" data-testid="away-topics-none">
              Your duo hasn&apos;t found any topics yet — it learns them from what it has read.
            </p>
          )}
          {topicList.map((topic) => (
            <label className="inline-flex min-h-11 items-center gap-2 type-body" key={topic.id}>
              <input
                checked={topicIds.includes(topic.id)}
                data-testid={`away-topic-${topic.id}`}
                onChange={(e) => setTopicIds((current) => (e.target.checked ? [...current, topic.id] : current.filter((id) => id !== topic.id)))}
                type="checkbox"
              />
              {topic.label}
            </label>
          ))}
        </fieldset>
      )}
      <p className="type-provenance text-[var(--muted)]">
        Anyone who messages you is told you&apos;re away and that your duo is answering. Never-answer rules and your ceiling still apply.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
          data-testid="away-start"
          disabled={!ready || set.isPending}
          type="submit"
        >
          {set.isPending ? "Saving…" : "Go away"}
        </button>
        <button className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
      <MutationError error={set.error} />
    </form>
  );
}

/**
 * #270: Away, in May do — one toggle to say you're out until a time, and
 * what your duo may answer meanwhile: what May do already allows, or that
 * plus topics picked for this time only. While away it shows when you're
 * back, what it answers, what has happened so far, and "I'm back".
 */
export function AwaySection({ api }: { api: DuoApiConfig }) {
  const away = useAway(api);
  const [setting, setSetting] = useState(false);
  const state = isAwayState(away.data) ? away.data : null;

  let body: React.ReactNode;
  if (away.isLoading) {
    body = <p className="type-provenance text-[var(--faint)]">Loading…</p>;
  } else if (away.error) {
    body = <p className="type-provenance text-[var(--refused)]">{(away.error as Error).message}</p>;
  } else if (state?.active) {
    body = <ActiveAway api={api} period={state.active} summary={state.summary && !state.summary.ended ? state.summary : null} />;
  } else if (setting) {
    body = <SetAway api={api} onCancel={() => setSetting(false)} />;
  } else {
    body = (
      <div className="flex flex-col gap-2">
        <p className="type-provenance text-[var(--muted)]">
          Going out? Your duo can answer what it&apos;s allowed to, tell colleagues you&apos;re away, and give you a summary when you&apos;re back.
        </p>
        <button
          aria-pressed={false}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
          data-testid="away-toggle"
          onClick={() => setSetting(true)}
          type="button"
        >
          I&apos;m away…
        </button>
      </div>
    );
  }

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="away">
      <h2 className="type-heading">Away</h2>
      {body}
    </section>
  );
}
