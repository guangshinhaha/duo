import type { DuoApiConfig } from "../api/client.js";
import { useMirrorPortrait, useMirrorRules } from "../api/queries.js";
import type { InterruptionPortrait } from "../api/types.js";
import { MeterBar } from "../components/MeterBar.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";

const times = (n: number): string => (n === 1 ? "once" : `${n} times`);
const formatDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString() : "—");

/**
 * The portrait's sentences, built from the daemon's own counts and nothing
 * else — every figure in them is a number the wire carried, and a proportion
 * is said in words ("most", "under half"), never as a percentage the data
 * cannot carry (§1.6). Exported so the wording is pinned once.
 */
export function portraitSentences(portrait: InterruptionPortrait): string[] {
  const [first, second, third] = portrait.topicBreakdown;
  const out: string[] = [];
  if (first) {
    out.push(`You were asked about ${first.label} ${times(first.count)}.`);
  }
  if (second) {
    out.push(third ? `Then ${second.label} (${second.count}) and ${third.label} (${third.count}).` : `Then ${second.label} (${second.count}).`);
  }
  if (portrait.topicBreakdown.length >= 5) {
    out.push(`Your top five topics cover ${portrait.topFiveShare >= 0.5 ? "most" : "under half"} of everything you're asked.`);
  }
  const busiest = portrait.busiestThreads[0];
  if (busiest) {
    out.push(`The busiest thread was ${busiest.threadId}, with ${busiest.count} question${busiest.count === 1 ? "" : "s"}.`);
  }
  return out;
}

/**
 * Who your duo thinks you are (the profile's Portrait tab): a few sentences
 * in the reflection face — the one place the product speaks *about you* —
 * with the numbers behind them one tap away. A thin history says so in
 * words instead of dressing four questions up as a personality (AR-19).
 */
export function Portrait({ api }: { api: DuoApiConfig }) {
  const portrait = useMirrorPortrait(api);
  const rules = useMirrorRules(api);
  if (portrait.isLoading) {
    return <RouteLoading />;
  }
  if (portrait.error) {
    return <RouteError api={api} error={portrait.error} onRetry={() => void portrait.refetch()} />;
  }
  const data = portrait.data;
  if (!data) {
    return <RouteLoading />;
  }
  const waiting = rules.data?.awaitingApproval?.length ?? 0;

  return (
    <div className="flex max-w-2xl flex-col gap-6 p-6" data-testid="portrait-tab">
      {data.tooThin ? (
        <p className="type-body text-[var(--muted)]" data-testid="portrait-thin">
          Not enough history yet. Your duo starts to get a picture of you at {data.minimumQuestionsToCharacterize} questions, and it has{" "}
          {data.totalQuestions}. It fills in as you work together.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-3" data-testid="portrait-sentences">
            {portraitSentences(data).map((sentence) => (
              <p className="type-reflection" key={sentence}>
                {sentence}
              </p>
            ))}
          </div>
          <p className="type-identifier text-[var(--faint)]" data-testid="portrait-source">
            {data.totalQuestions} question{data.totalQuestions === 1 ? "" : "s"} · {formatDate(data.periodStart)} – {formatDate(data.periodEnd)} ·
            worked out by your duo
          </p>
          <details className="shape-container p-4" data-testid="portrait-numbers">
            <summary className="cursor-pointer type-heading">The numbers</summary>
            <div className="mt-3 flex flex-col gap-3">
              {data.topicBreakdown.map((topic) => (
                <div className="flex flex-col gap-1" data-testid="portrait-topic" key={topic.topicId}>
                  <div className="flex justify-between type-provenance text-[var(--muted)]">
                    <span>{topic.label}</span>
                    <span>{topic.count}</span>
                  </div>
                  <MeterBar testId="portrait-topic-share" value={topic.share} />
                </div>
              ))}
              {data.busiestThreads.map((thread) => (
                <div className="flex flex-col gap-1" data-testid="portrait-thread" key={thread.threadId}>
                  <div className="flex justify-between type-provenance text-[var(--muted)]">
                    <span>{thread.threadId}</span>
                    <span>{thread.count}</span>
                  </div>
                  <MeterBar testId="portrait-thread-share" value={thread.share} />
                </div>
              ))}
            </div>
          </details>
        </>
      )}
      {waiting > 0 && (
        <p className="type-body" data-testid="portrait-rules-link">
          {waiting} {waiting === 1 ? "rule is" : "rules are"} waiting for you.{" "}
          <a className="underline" href="#duo/profile/rules">
            See them in Rules
          </a>
        </p>
      )}
    </div>
  );
}
