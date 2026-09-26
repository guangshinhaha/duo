import type { InterruptionPortrait, ThreadShare, TopicShare } from "../api/types.js";
import { MeterBar } from "./MeterBar.js";

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

function TopicRow({ topic }: { topic: TopicShare }) {
  return (
    <div className="flex flex-col gap-1" data-testid="portrait-topic">
      <div className="flex justify-between type-provenance text-[var(--muted)]">
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
      <div className="flex justify-between type-provenance text-[var(--muted)]">
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
 * mirror must not be dressed up as more than it is, so `tooThin` renders an
 * explicit thin-data state rather than zeros that look like measurements —
 * and the daemon surfaces `minimumQuestionsToCharacterize` precisely so the
 * message can name the bar instead of hinting at one.
 */
export function InterruptionPortraitView({ portrait }: { portrait: InterruptionPortrait }) {
  if (portrait.tooThin) {
    return (
      <div className="rounded-[var(--r-md)] border border-dashed border-[var(--edge)] p-4 type-body text-[var(--muted)]" data-testid="portrait-thin">
        Not enough history yet — the portrait starts to mean something at {portrait.minimumQuestionsToCharacterize} questions, and this duo
        has {portrait.totalQuestions}. It fills in as you work together.
      </div>
    );
  }

  return (
    <div className="shape-entry flex flex-col gap-3 p-4" data-testid="portrait">
      <div>
        <h2 className="type-heading">Interruption portrait</h2>
        <p className="type-provenance text-[var(--muted)]">
          {portrait.totalQuestions} question{portrait.totalQuestions === 1 ? "" : "s"} · {formatDate(portrait.periodStart)} –{" "}
          {formatDate(portrait.periodEnd)} · worked out by your duo
        </p>
      </div>
      <div className="flex flex-col gap-1" data-testid="portrait-top-five">
        <div className="flex justify-between type-provenance text-[var(--muted)]">
          <span>share of questions in your top five topics</span>
        </div>
        <MeterBar value={portrait.topFiveShare} testId="portrait-top-five-share" />
      </div>
      {portrait.topicBreakdown.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="type-provenance uppercase text-[var(--faint)]">Topics</p>
          {portrait.topicBreakdown.map((topic) => (
            <TopicRow key={topic.topicId} topic={topic} />
          ))}
        </div>
      )}
      {portrait.busiestThreads.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="type-provenance uppercase text-[var(--faint)]">Busiest threads</p>
          {portrait.busiestThreads.map((thread) => (
            <ThreadRow key={thread.threadId} thread={thread} />
          ))}
        </div>
      )}
    </div>
  );
}
