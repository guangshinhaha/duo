import type { DuoApiConfig } from "../api/client.js";
import { useKnowledgeCoverage } from "../api/queries.js";
import type { TopicCoverageEntry, TopicCoverageReport } from "../api/types.js";
import { writeComposerBuffer } from "../composerBuffer.js";
import { MeterBar } from "../components/MeterBar.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { coverageThinSentence, isTopicCoverageShape } from "./knowledgeWords.js";

/**
 * duo#277: opens Your duo with a prompt already in the composer, naming
 * the gap by its own label — the one-tap "Teach" path AC2 asks for. Reuses
 * the composer's own survives-navigation buffer (`src/composerBuffer.ts`,
 * #27) rather than inventing a second prefill channel: the Duo route reads
 * it once on mount, same as a half-typed question would.
 */
function teachTopic(label: string): void {
  writeComposerBuffer(`Teach your duo about "${label}": `);
  window.location.hash = "#duo";
}

/** One gap: how often it's asked, its share of the whole, and the one-tap way to teach it (duo#277 AC2). */
function CoverageGapRow({ gap }: { gap: TopicCoverageEntry }) {
  return (
    <li className="flex flex-col gap-1" data-testid="coverage-gap">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate type-body">{gap.label}</span>
        <span className="shrink-0 type-provenance text-[var(--muted)]">
          {gap.questionCount}×
        </span>
      </div>
      <MeterBar testId="coverage-gap-share" value={gap.share} />
      <button
        className="inline-flex min-h-9 items-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance"
        data-testid="coverage-gap-teach"
        onClick={() => teachTopic(gap.label)}
        type="button"
      >
        Teach
      </button>
    </li>
  );
}

/**
 * duo#277: what your duo can and can't confidently answer yet, from the
 * owner's own question history — covered (an approved standing order backs
 * it) against every topic still thin, ranked by how often it actually
 * comes up so the owner teaches what matters most first (AC1).
 */
function CoverageBody({ coverage }: { coverage: TopicCoverageReport }) {
  if (coverage.tooThin) {
    return (
      <p className="type-body text-[var(--muted)]" data-testid="coverage-thin">
        {coverageThinSentence(coverage)}
      </p>
    );
  }
  const coveredQuestions = coverage.topics.filter((topic) => topic.covered).reduce((sum, topic) => sum + topic.questionCount, 0);
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="type-provenance text-[var(--muted)]" data-testid="coverage-summary">
          {coveredQuestions} of {coverage.totalQuestions} question{coverage.totalQuestions === 1 ? "" : "s"} it's commonly asked have an approved
          answer behind them.
        </p>
        <MeterBar testId="coverage-share" value={coverage.coveredShare} />
      </div>
      {coverage.gaps.length === 0 ? (
        <p className="type-body text-[var(--muted)]" data-testid="coverage-empty">
          Nothing thin right now — every topic it's been asked about has an approved answer behind it.
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="coverage-gap-list">
          {coverage.gaps.map((gap) => (
            <CoverageGapRow gap={gap} key={gap.topicId} />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The coverage report (`GET /knowledge/coverage`, duo#277), shared by the
 * Knows tab ("What it can't answer yet") and the first-run flow's close
 * (duo#317 AC2: "a visible coverage number") — one read, one set of words,
 * so the two surfaces can never say a different thing about the same
 * corpus.
 */
export function CoverageSummary({ api }: { api: DuoApiConfig }) {
  const coverage = useKnowledgeCoverage(api);
  if (coverage.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (coverage.error) {
    return <RouteError api={api} error={coverage.error} onRetry={() => void coverage.refetch()} />;
  }
  return coverage.data && isTopicCoverageShape(coverage.data) ? <CoverageBody coverage={coverage.data} /> : <RouteLoading variant="rows" />;
}
