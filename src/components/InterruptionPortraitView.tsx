import type { InterruptionPortrait, ThreadShare, TopicShare } from "../api/types.js";
import { MeterBar } from "./MeterBar.js";

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

function TopicRow({ topic }: { topic: TopicShare }) {
  return (
    <div className="flex flex-col gap-1" data-testid="portrait-topic">
      <div className="flex justify-between text-xs text-[var(--muted)]">
        <span>{topic.label}</span>
        <span>{topic.count}</span>
      </div>
      <MeterBar value={topic.share} testId="portrait-topic-share" />
    </div>
  );
}

function ThreadRow({ thread }: { thread: ThreadShare }) {
  return (
    <div className="flex flex-col gap-1" data-testid="portrait-thread">
      <div className="flex justify-between text-xs text-[var(--muted)]">
        <span>{thread.threadId}</span>
        <span>{thread.count}</span>
      </div>
      <MeterBar value={thread.share} testId="portrait-thread-share" />
    </div>
  );
}

/**
 * The interruption portrait (`client-tech-design.md` §1.4,
 * `GET /mirror/portrait`): what the duo observed about how its owner is
 * actually interrupted — questions per topic, per thread. AR-19 says a thin
 * mirror must not be dressed up as more than it is, so
 * `insufficientHistory` renders an explicit thin-data state rather than
 * zeros that look like measurements.
 */
export function InterruptionPortraitView({ portrait }: { portrait: InterruptionPortrait }) {
  if (portrait.insufficientHistory) {
    return (
      <div className="rounded-[var(--r-lg)] border border-dashed border-[var(--edge)] p-4 text-[var(--muted)]" data-testid="portrait-thin">
        Not enough history yet — the portrait fills in as you work with the duo.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--edge)] p-4" data-testid="portrait">
      <div>
        <h2 className="text-sm font-medium">Interruption portrait</h2>
        <p className="text-xs text-[var(--muted)]">
          {portrait.totalQuestions} question{portrait.totalQuestions === 1 ? "" : "s"} · {formatDate(portrait.periodStart)} –{" "}
          {formatDate(portrait.periodEnd)} · derived by your duo
        </p>
      </div>
      <div className="flex flex-col gap-1" data-testid="portrait-top-five">
        <div className="flex justify-between text-xs text-[var(--muted)]">
          <span>share of questions in your top five topics</span>
        </div>
        <MeterBar value={portrait.topFiveShare} testId="portrait-top-five-share" />
      </div>
      {portrait.topicBreakdown.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--faint)]">Topics</h3>
          {portrait.topicBreakdown.map((topic) => (
            <TopicRow key={topic.topicId} topic={topic} />
          ))}
        </div>
      )}
      {portrait.busiestThreads.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--faint)]">Busiest threads</h3>
          {portrait.busiestThreads.map((thread) => (
            <ThreadRow key={thread.threadId} thread={thread} />
          ))}
        </div>
      )}
    </div>
  );
}
