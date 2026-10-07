import type { DuoApiConfig } from "../api/client.js";
import { useChannels, useExcludedEvidence, useKnowledge, useKnowledgeCoverage, useRestoreEvidence } from "../api/queries.js";
import type { DuoKnowledge, TopicCoverageEntry, TopicCoverageReport } from "../api/types.js";
import { writeComposerBuffer } from "../composerBuffer.js";
import { MeterBar } from "../components/MeterBar.js";
import { MutationError } from "../components/MutationError.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { ChannelList, isChannelList } from "./ChannelList.js";
import { corpusSentence, coverageThinSentence, isDuoKnowledgeShape, isTopicCoverageShape, lastImportSentence } from "./knowledgeWords.js";

const formatDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString() : "—");

function Section({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid={testId}>
      <h2 className="type-heading">{title}</h2>
      {children}
    </section>
  );
}

/**
 * duo#272 (digital-duo#288): what the owner has removed from citation —
 * the reversible half of the draft's inline Remove. Every excluded past
 * exchange, newest first, with its own label (or an honest "no longer
 * exists" once the record itself is gone) and a Restore undoing it through
 * the same idempotent route the daemon exposes.
 */
function RemovedFromCitation({ api }: { api: DuoApiConfig }) {
  const excluded = useExcludedEvidence(api);
  const restore = useRestoreEvidence(api);
  if (excluded.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (excluded.error) {
    return <RouteError api={api} error={excluded.error} onRetry={() => void excluded.refetch()} />;
  }
  const rows = excluded.data?.excluded ?? [];
  return (
    <>
      {rows.length === 0 ? (
        <p className="type-provenance text-[var(--faint)]" data-testid="knows-removed-empty">
          Nothing removed. A past exchange you remove inline on a draft shows up here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="knows-removed-list">
          {rows.map((row) => (
            <li className="flex items-center justify-between gap-2" data-testid="knows-removed-row" key={row.recordId}>
              <span className="min-w-0 truncate type-body text-[var(--muted)]">{row.label ?? "This record no longer exists."}</span>
              <button
                className="min-h-9 shrink-0 type-provenance text-[var(--muted)] underline disabled:opacity-40"
                data-testid="knows-removed-restore"
                disabled={restore.isPending && restore.variables?.recordId === row.recordId}
                onClick={() => restore.mutate({ recordId: row.recordId })}
                type="button"
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      <MutationError error={restore.error} />
    </>
  );
}

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

function CoverageSection({ api }: { api: DuoApiConfig }) {
  const coverage = useKnowledgeCoverage(api);
  if (coverage.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (coverage.error) {
    return <RouteError api={api} error={coverage.error} onRetry={() => void coverage.refetch()} />;
  }
  return coverage.data && isTopicCoverageShape(coverage.data) ? <CoverageBody coverage={coverage.data} /> : <RouteLoading variant="rows" />;
}

function KnowsBody({ api, knowledge }: { api: DuoApiConfig; knowledge: DuoKnowledge }) {
  const channels = useChannels(api);
  const usage = knowledge.sharedUsage;
  return (
    <div className="flex max-w-2xl flex-col gap-4 p-6" data-testid="knows-tab">
      <Section testId="knows-read" title="What it has read">
        <p className="type-body">
          It has read {knowledge.records.total} of your messages and notes.
        </p>
        {Object.entries(knowledge.records.bySource).map(([source, count]) => (
          // The source names are the daemon's own strings, verbatim — this client keeps no registry of sources to translate them through.
          <div className="flex justify-between type-provenance text-[var(--muted)]" data-testid="record-source" key={source}>
            <span>{source}</span>
            <span>{count}</span>
          </div>
        ))}
        <p className="type-provenance text-[var(--faint)]" data-testid="last-import">
          {lastImportSentence(knowledge.lastImport)}
        </p>
        <a className="inline-flex min-h-11 items-center self-start underline" href="#onboarding">
          Import more history
        </a>
      </Section>

      <Section testId="knows-removed" title="Removed from citation">
        <RemovedFromCitation api={api} />
      </Section>

      <Section testId="knows-asked" title="What people ask you">
        {knowledge.corpus.tooThin ? (
          <p className="type-body text-[var(--muted)]" data-testid="corpus-thin">
            {corpusSentence(knowledge.corpus)}
          </p>
        ) : (
          <>
            <p className="type-provenance text-[var(--muted)]">
              {knowledge.corpus.totalQuestions} question{knowledge.corpus.totalQuestions === 1 ? "" : "s"} · {formatDate(knowledge.corpus.periodStart)} –{" "}
              {formatDate(knowledge.corpus.periodEnd)}
            </p>
            {knowledge.corpus.topicBreakdown.map((topic) => (
              <div className="flex flex-col gap-1" data-testid="knowledge-topic" key={topic.topicId}>
                <div className="flex justify-between type-provenance text-[var(--muted)]">
                  <span>{topic.label}</span>
                  <span>{topic.count}</span>
                </div>
                <MeterBar testId="knowledge-topic-share" value={topic.share} />
              </div>
            ))}
          </>
        )}
      </Section>

      <Section testId="knows-coverage" title="What it can't answer yet">
        <CoverageSection api={api} />
      </Section>

      <Section testId="knows-connected" title="Where it listens">
        {channels.isLoading ? (
          <RouteLoading variant="rows" />
        ) : channels.error ? (
          <RouteError api={api} error={channels.error} onRetry={() => void channels.refetch()} />
        ) : isChannelList(channels.data) ? (
          <ChannelList api={api} channels={channels.data} />
        ) : null}
      </Section>

      <Section testId="knows-runs-on" title="What it runs on">
        <p className="type-provenance text-[var(--muted)]" data-testid="inference-provider">
          {knowledge.providers.inference ? `Answering with ${knowledge.providers.inference}.` : "Nothing is set up to write answers, so nothing is answering."}
        </p>
        <p className="type-provenance text-[var(--muted)]" data-testid="embedding-provider">
          {knowledge.providers.embedding
            ? `Searching your history with ${knowledge.providers.embedding.name} (${knowledge.providers.embedding.model}).`
            : "Nothing is set up to search your history."}
        </p>
      </Section>

      <Section testId="knows-others" title="When others ask it">
        {/* The daemon's own sentence, verbatim — the one place the report's honest verdict is guaranteed (#71 AC4). */}
        <p className="type-provenance text-[var(--muted)]" data-testid="shared-usage-summary">
          {usage.summary}
        </p>
        <div className="flex flex-col gap-1">
          <div className="flex justify-between type-provenance text-[var(--muted)]">
            <span>
              answered — asked by {usage.distinctAskers} {usage.distinctAskers === 1 ? "person" : "people"}
            </span>
            <span>
              {usage.answeredCount} of {usage.totalQuestions}
            </span>
          </div>
          <MeterBar testId="answer-rate" value={usage.answerRate} />
        </div>
        {usage.gaps.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="type-provenance uppercase text-[var(--faint)]">Asked for and missing</p>
            {usage.gaps.map((gap) => (
              <div className="flex justify-between type-provenance text-[var(--muted)]" data-testid="usage-gap" key={gap.question}>
                <span>{gap.question}</span>
                <span>{gap.count}×</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/**
 * What your duo has read and where it listens (the profile's Knows tab) —
 * the old Knowledge and Channels screens in one place, in an owner's words:
 * what it has read, what people ask you, where it listens, what it runs on,
 * and how it has done when others asked. A thin history reads as thin, in
 * words, before any number gets to dress it up (AR-19).
 */
export function Knows({ api }: { api: DuoApiConfig }) {
  const knowledge = useKnowledge(api);
  if (knowledge.isLoading) {
    return <RouteLoading variant="panels" />;
  }
  if (knowledge.error) {
    return <RouteError api={api} error={knowledge.error} onRetry={() => void knowledge.refetch()} />;
  }
  // The cache is a storage layer, not a promise: a payload that is not the daemon's documented shape reads as still asking.
  return knowledge.data && isDuoKnowledgeShape(knowledge.data) ? <KnowsBody api={api} knowledge={knowledge.data} /> : <RouteLoading variant="panels" />;
}
