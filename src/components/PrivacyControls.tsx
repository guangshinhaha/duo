import type { DuoApiConfig } from "../api/client.js";
import { useExcludeSource, useKnowledge, useRestoreSource, useSourceControls } from "../api/queries.js";
import type { SourceControl } from "../api/types.js";
import { MutationError } from "./MutationError.js";
import { RouteError } from "./RouteError.js";
import { RouteLoading } from "./RouteLoading.js";

/**
 * duo#278: "Where it's processed", in the same words the Knows tab already
 * uses (`inference-provider`/`embedding-provider`, vocabulary.md's
 * "canonical phrasings already in the product") — reused rather than
 * reworded, so the two screens can never drift into saying two different
 * things about the same configuration. Pulled live from `GET /knowledge`,
 * never hardcoded: the statement is exactly the daemon's own report, which
 * is what keeps it true of whatever is actually deployed.
 */
function WhereItRuns({ api }: { api: DuoApiConfig }) {
  const knowledge = useKnowledge(api);
  if (knowledge.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (knowledge.error) {
    return <RouteError api={api} error={knowledge.error} onRetry={() => void knowledge.refetch()} />;
  }
  const providers = knowledge.data?.providers;
  return (
    <>
      <p className="type-provenance text-[var(--muted)]" data-testid="privacy-inference-provider">
        {providers?.inference ? `Drafts are written by ${providers.inference}.` : "Nothing is set up to write answers, so nothing is answering."}
      </p>
      <p className="type-provenance text-[var(--muted)]" data-testid="privacy-embedding-provider">
        {providers?.embedding
          ? `Searching your history runs on ${providers.embedding.name} (${providers.embedding.model}).`
          : "Nothing is set up to search your history."}
      </p>
    </>
  );
}

/** One source's switch: name, record count, and Exclude/Restore — same reversible shape as the Knows tab's "Removed from citation" row. */
function SourceRow({ api, control }: { api: DuoApiConfig; control: SourceControl }) {
  const exclude = useExcludeSource(api);
  const restore = useRestoreSource(api);
  const pending = exclude.isPending || restore.isPending;
  return (
    <li className="flex flex-col gap-1" data-testid="privacy-source-row">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          {/* The source name is the daemon's own string, verbatim — this client keeps no registry of sources to translate it through. */}
          <span className="type-body text-[var(--text)]" data-testid="privacy-source-name">
            {control.source}
          </span>
          <span className="type-provenance text-[var(--muted)]">
            {control.recordCount} message{control.recordCount === 1 ? "" : "s"} and note{control.recordCount === 1 ? "" : "s"}
            {control.excluded ? " — excluded from drafts" : ""}
          </span>
        </div>
        <button
          className="min-h-9 shrink-0 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance text-[var(--text)] disabled:opacity-40"
          data-testid="privacy-source-toggle"
          disabled={pending}
          onClick={() =>
            control.excluded ? restore.mutate({ source: control.source }) : exclude.mutate({ source: control.source })
          }
          type="button"
        >
          {control.excluded ? "Turn back on" : "Turn off"}
        </button>
      </div>
      <MutationError error={exclude.error ?? restore.error} />
    </li>
  );
}

/**
 * duo#278's per-source list — every source the corpus has records under,
 * each with a switch. Turning a source off stops it being cited in any
 * future draft (the daemon's own gatherDraftContext admissibility filter)
 * without deleting a single record: the same soft, reviewable shape as
 * #272's evidence exclusions and #274's off-the-record marker, never a
 * hard delete. "Turn back on" undoes it from this same row.
 */
function SourceList({ api }: { api: DuoApiConfig }) {
  const sources = useSourceControls(api);
  if (sources.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (sources.error) {
    return <RouteError api={api} error={sources.error} onRetry={() => void sources.refetch()} />;
  }
  const rows = sources.data?.sources ?? [];
  if (rows.length === 0) {
    return (
      <p className="type-provenance text-[var(--faint)]" data-testid="privacy-sources-empty">
        Nothing imported yet. A source appears here once you import a Claude export, paste a transcript, or save something from a
        connector.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3" data-testid="privacy-sources-list">
      {rows.map((control) => (
        <SourceRow api={api} control={control} key={control.source} />
      ))}
    </ul>
  );
}

function Section({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid={testId}>
      <h2 className="type-heading">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Settings → Privacy & data (duo#278): where your data goes, in plain
 * words, and a switch per source. Three honest claims, each one checkable
 * against what the daemon actually reports rather than asserted from this
 * client's own copy:
 *
 * - **Where it's processed** — the configured inference/embedding
 *   providers, read live from `GET /knowledge` (`WhereItRuns`, above), so
 *   this page can never say something the deployed daemon isn't actually
 *   doing.
 * - **What's stored** — the corpus lives in this duo's own encrypted
 *   store, never shared with another duo's.
 * - **Retention** — nothing expires on its own; a record stays until its
 *   source is turned off here, or the duo itself is ended (Settings →
 *   End this duo).
 *
 * What this page does not claim: a blanket "never used to train
 * third-party models" promise. Which inference provider may process this
 * corpus, and under what guarantee, is a standing policy question
 * (digital-duo#14) — stating a guarantee this client cannot verify would
 * be exactly the kind of claim that stops matching the deployed
 * configuration the moment that policy is decided. Until then, this page
 * says only what the live configuration actually is.
 */
export function PrivacyControls({ api }: { api: DuoApiConfig }) {
  return (
    <>
      <Section testId="privacy-where" title="Where it's processed">
        <WhereItRuns api={api} />
        <p className="type-provenance text-[var(--muted)]">
          Everything you import is stored encrypted, on this duo's own machine — never in a database shared with another duo.
        </p>
      </Section>

      <Section testId="privacy-retention" title="Retention">
        <p className="type-provenance text-[var(--muted)]">
          Nothing is deleted on its own. A record stays until you turn off its source below, or until you end this duo in Settings —
          which deletes everything it learned.
        </p>
      </Section>

      <Section testId="privacy-sources" title="Your sources">
        <p className="type-provenance text-[var(--muted)]">
          Turning a source off stops your duo citing it in any future draft. Nothing is deleted, and you can turn a source back on any
          time.
        </p>
        <SourceList api={api} />
      </Section>
    </>
  );
}
