import type { DuoApiConfig } from "../api/client.js";
import { useKnowledge } from "../api/queries.js";
import type { DuoKnowledge } from "../api/types.js";
import { MeterBar } from "../components/MeterBar.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

/**
 * #37: the import and corpus sentences, built once. Review's empty state
 * makes the same argument this screen makes, and it must make it with the
 * same words — both screens render the daemon's counts through these, so
 * the argument can only drift if the sentence itself does, in one place.
 */
export function lastImportSentence(lastImport: DuoKnowledge["lastImport"]): string {
  return lastImport
    ? `Last import ${formatDate(lastImport.runAt)}: ${lastImport.written} new, ${lastImport.alreadyPresent} already there, ${lastImport.skippedDmConversations} direct-message conversations left out.`
    : "No import yet — importing your history is what gives the duo something to answer from.";
}

/**
 * The corpus verdict in words (#37 shares it with Review's empty state):
 * thin in the portrait's own terms — the bar and what clears it — and past
 * the bar, the count with the action the facts support. No percentage, no
 * invented numeral (§1.6).
 */
export function corpusSentence(corpus: DuoKnowledge["corpus"]): string {
  if (corpus.tooThin) {
    return `Not enough history yet — your duo starts to get a picture of you at ${corpus.minimumQuestionsToCharacterize} questions, and it has ${corpus.totalQuestions}. Importing more of your messages is what thickens it.`;
  }
  return `${corpus.totalQuestions} question${corpus.totalQuestions === 1 ? "" : "s"} so far — asking it questions is what thickens it.`;
}

/**
 * AR-19 in one surface: "a sleek shell around four rules reads as a demo,
 * and the gap between how good it looks and how much it knows is itself a
 * trust problem." This screen exists to close that gap by naming it — the
 * corpus counts for what they are, thinness in the portrait's own words,
 * and no figure dressed in precision the data cannot carry (§1.6: counts
 * and bars, never invented numerals).
 */
function RecordsSection({ knowledge }: { knowledge: DuoKnowledge }) {
  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid="knowledge-records">
      <h2 className="type-heading">
        Records ({knowledge.records.total})
      </h2>
      {Object.entries(knowledge.records.bySource).map(([source, count]) => (
        // The source names are the daemon's own strings, verbatim — this
        // client keeps no registry of sources to translate them through.
        <div key={source} className="flex justify-between type-provenance text-[var(--muted)]" data-testid="record-source">
          <span>{source}</span>
          <span>{count}</span>
        </div>
      ))}
      <p className="type-provenance text-[var(--faint)]" data-testid="last-import">
        {lastImportSentence(knowledge.lastImport)}
      </p>
      {/* #49: the first run's address doubles as the way to add more — the same import, embed and derive steps. */}
      <a className="inline-flex min-h-11 items-center self-start underline" href="#onboarding">
        Import more history
      </a>
    </section>
  );
}

/**
 * The corpus verdict is the portrait's own (`tooThin`, same threshold,
 * same breakdown — #175 composes, it never recomputes), so it renders
 * under the portrait's contract too: thin is stated in words that name
 * the bar and what clears it, and a breakdown below the bar renders
 * nowhere — four questions spread over topics would be costume jewellery.
 */
function CorpusSection({ knowledge }: { knowledge: DuoKnowledge }) {
  const corpus = knowledge.corpus;
  if (corpus.tooThin) {
    return (
      <div
        className="rounded-[var(--r-md)] border border-dashed border-[var(--edge)] p-4 type-body text-[var(--muted)]"
        data-testid="corpus-thin"
      >
        {corpusSentence(corpus)}
      </div>
    );
  }
  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid="corpus">
      <div>
        <h2 className="type-heading">Corpus</h2>
        <p className="type-provenance text-[var(--muted)]">
          {corpus.totalQuestions} question{corpus.totalQuestions === 1 ? "" : "s"} · {formatDate(corpus.periodStart)} –{" "}
          {formatDate(corpus.periodEnd)}
        </p>
      </div>
      {corpus.topicBreakdown.length > 0 && (
        <div className="flex flex-col gap-2">
          {corpus.topicBreakdown.map((topic) => (
            <div key={topic.topicId} className="flex flex-col gap-1" data-testid="knowledge-topic">
              <div className="flex justify-between type-provenance text-[var(--muted)]">
                <span>{topic.label}</span>
                <span>{topic.count}</span>
              </div>
              <MeterBar value={topic.share} testId="knowledge-topic-share" />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function KnowledgeScreen({ knowledge }: { knowledge: DuoKnowledge }) {
  const usage = knowledge.sharedUsage;
  return (
    <div className="flex flex-col gap-6 p-6" data-testid="knowledge">
      <header className="flex flex-col gap-1">
        <h1 className="type-heading">Knowledge</h1>
        <p className="type-provenance text-[var(--muted)]">
          What this duo actually knows, so its answers can be trusted in proportion to what is behind them.
        </p>
      </header>

      <RecordsSection knowledge={knowledge} />
      <CorpusSection knowledge={knowledge} />

      <section className="shape-container flex flex-col gap-2 p-4" data-testid="knowledge-rules">
        <h2 className="type-heading">Derived rules</h2>
        {/* Every status key the daemon sends, count beside it — zero
            included, because "no superseded rules" is a fact worth seeing,
            not an absence worth hiding. */}
        <p className="type-provenance text-[var(--muted)]" data-testid="rule-counts">
          {Object.entries(knowledge.rules.byReviewStatus)
            .map(([status, count]) => `${status} ${count}`)
            .join(" · ")}
        </p>
      </section>

      <section className="shape-container flex flex-col gap-2 p-4" data-testid="knowledge-providers">
        <h2 className="type-heading">Providers</h2>
        <p className="type-provenance text-[var(--muted)]" data-testid="inference-provider">
          {knowledge.providers.inference
            ? `Answering with ${knowledge.providers.inference}.`
            : "No inference provider configured — nothing is answering."}
        </p>
        <p className="type-provenance text-[var(--muted)]" data-testid="embedding-provider">
          {knowledge.providers.embedding
            ? `Embedding with ${knowledge.providers.embedding.name} (${knowledge.providers.embedding.model}).`
            : "No embedding provider configured."}
        </p>
      </section>

      <section className="shape-container flex flex-col gap-2 p-4" data-testid="shared-usage">
        <h2 className="type-heading">Shared usage</h2>
        {/* The daemon's own sentence, verbatim — it is the one place the
            report's honest verdict ("not being used", in those words) is
            guaranteed (#71 AC4); re-wording it here would soften it. */}
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
          {/* The rate arrives as a fraction off the wire; it renders as a
              bar with its counts beside it — formatted, never recomputed,
              never a percentage numeral (§1.6). */}
          <MeterBar value={usage.answerRate} testId="answer-rate" />
        </div>
        {usage.gaps.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="type-provenance uppercase text-[var(--faint)]">Asked for and missing</p>
            {usage.gaps.map((gap) => (
              <div key={gap.question} className="flex justify-between type-provenance text-[var(--muted)]" data-testid="usage-gap">
                <span>{gap.question}</span>
                <span>{gap.count}×</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * The cached payload is typed as `DuoKnowledge`, but the cache is a
 * storage layer, not a promise — it can hold a shape the daemon never
 * sent (an array where the object should be, say, written under the same
 * CACHE_BUSTER by an older build). A payload that is not the daemon's
 * documented shape is not an answer, and the screen must read it as
 * "still asking", never crash on it — the same braces-and-belt law App.tsx
 * states for the persisted cache as a whole.
 */
export function isDuoKnowledgeShape(value: unknown): value is DuoKnowledge {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as DuoKnowledge;
  return [candidate.records, candidate.corpus, candidate.rules, candidate.providers, candidate.sharedUsage].every(
    (section) => section !== null && typeof section === "object",
  );
}

/**
 * The knowledge screen (#45) — what the duo knows, where it came from,
 * what is running, and how much it has been used. Read-only by design
 * (the issue's own out-of-scope: configuration changes from here are not
 * this screen's to make), and honest by the same law: a thin corpus reads
 * as thin here, in words, before any number gets a chance to dress it up.
 */
export function Knowledge({ api }: { api: DuoApiConfig }) {
  const knowledge = useKnowledge(api);
  if (knowledge.isLoading) {
    return <RouteLoading variant="panels" />;
  }
  if (knowledge.error) {
    return <RouteError api={api} error={knowledge.error} onRetry={() => void knowledge.refetch()} />;
  }
  if (knowledge.data && isDuoKnowledgeShape(knowledge.data)) {
    return <KnowledgeScreen knowledge={knowledge.data} />;
  }
  // A cached payload that failed the shape check renders as waiting, not
  // as a crash: the mount's staleness refetch is already re-asking the
  // daemon, and what comes back is what the screen renders.
  return <RouteLoading variant="panels" />;
}
