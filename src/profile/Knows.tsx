import type { DuoApiConfig } from "../api/client.js";
import { useChannels, useKnowledge } from "../api/queries.js";
import type { DuoKnowledge } from "../api/types.js";
import { MeterBar } from "../components/MeterBar.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { ChannelList, isChannelList } from "./ChannelList.js";
import { corpusSentence, isDuoKnowledgeShape, lastImportSentence } from "./knowledgeWords.js";

const formatDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString() : "—");

function Section({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid={testId}>
      <h2 className="type-heading">{title}</h2>
      {children}
    </section>
  );
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
