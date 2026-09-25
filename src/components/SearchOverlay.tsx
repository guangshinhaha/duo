import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useCorpusSearch, useKnowledge } from "../api/queries.js";
import type { CorpusRecord } from "../api/types.js";
import { Dialog, DialogContent } from "./primitives/Dialog.js";
import { Timestamp } from "./Timestamp.js";

/** Mechanical preview truncation — presentation only. The full text is one click away (#46 AC2); the summary never edits it. */
const SNIPPET_LENGTH = 140;

function snippet(text: string): string {
  return text.length <= SNIPPET_LENGTH ? text : `${text.slice(0, SNIPPET_LENGTH)}…`;
}

/**
 * One search result. The row leads with enough context to recognise the
 * record (#46 AC1) — a preview of the text, where it came from, when — and
 * opens to the whole record with its origin stated exactly (#46 AC2):
 * source and sourceRef both, because "it came from Slack" and "it came
 * from *this* Slack message" are different facts.
 */
function SearchResultRow({ record }: { record: CorpusRecord }) {
  return (
    <details className="shape-entry p-3" data-testid="search-result">
      <summary className="cursor-pointer type-body text-[var(--text)]" data-testid="search-result-summary">
        {snippet(record.text)}
      </summary>
      <div className="mt-2 flex flex-col gap-1">
        <p className="whitespace-pre-wrap type-body text-[var(--text)]" data-testid="search-result-full">
          {record.text}
        </p>
        <p className="type-provenance text-[var(--faint)]" data-testid="search-result-origin">
          from {record.source}
          {record.sourceRef ? ` · ${record.sourceRef}` : ""}
        </p>
      </div>
    </details>
  );
}

/**
 * The corpus search overlay (#46) — ⌘K from anywhere, over whatever is on
 * screen, closing back onto it untouched. "What do I already know about
 * this" is a question about the corpus, not a draft request, so it never
 * touches the drafting pipeline: every result, its rank, and the
 * degraded-retrieval warning are the daemon's own, rendered verbatim.
 *
 * #34: the overlay is the dialog primitive — the portal, focus trap and
 * Escape handling are Radix's now, not this file's hand-rolled `onKeyDown`
 * on a raw `<dialog>`; only the search itself is this surface's. The
 * backdrop press now closes too, which is the primitive's own semantics
 * rather than something added here.
 */
export function SearchOverlay({ api, onClose }: { api: DuoApiConfig; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const search = useCorpusSearch(api, submitted);
  // #45's query key, so this is the same read the Knowledge screen makes —
  // cached, deduped, and the only honest way to tell "nothing matched"
  // from "there is nothing to match against" (AC4).
  const knowledge = useKnowledge(api);
  const pages = search.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.results);
  const warning = pages.length > 0 ? pages[pages.length - 1]!.warning : undefined;

  return (
    // The route underneath stays mounted — search opens *over* a screen,
    // never *instead of* one (AC3): App keeps the surface rendered and
    // this dialog portals above it.
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="w-[calc(100vw-3rem)] max-w-2xl" data-testid="search-overlay">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <input
            aria-label="Search what your duo knows"
            autoFocus
            className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 text-[var(--text)]"
            placeholder="Search what your duo knows"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)]">
            Search
          </button>
          <button type="button" className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3" onClick={onClose}>
            Close
          </button>
        </form>

        {/* The daemon's own degraded-retrieval sentence, verbatim — the
            client neither paraphrases it nor hides it: results found by
            full-text alone are still results, with their caveat attached. */}
        {warning && (
          <p className="type-provenance text-[var(--muted)]" data-testid="search-warning">
            {warning}
          </p>
        )}

        {search.isLoading && <div className="type-body text-[var(--muted)]">Searching…</div>}
        {search.error && <div className="type-body text-[var(--refused)]">{(search.error as Error).message}</div>}

        {submitted && !search.isLoading && !search.error && rows.length === 0 && (
          <div className="type-body text-[var(--muted)]" data-testid="search-empty">
            {/* Two different zero-result truths (AC4): a corpus with
                records in it and no match is about the query; a corpus
                with nothing in it is about the corpus. The knowledge read
                is what tells them apart — never a guess. */}
            {knowledge.data?.records.total === 0
              ? "The corpus is empty — nothing has been imported yet, so there is nothing to search."
              : "Nothing matched."}
          </div>
        )}

        {rows.length > 0 && (
          <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
            {rows.map(({ record, rank }) => (
              <div key={`${rank}-${record.id}`} className="flex flex-col">
                <SearchResultRow record={record} />
                <div className="flex items-baseline justify-between px-1">
                  <span className="type-provenance text-[var(--faint)]" data-testid="search-result-source">
                    {record.source}
                  </span>
                  <Timestamp iso={record.timestamp} />
                </div>
              </div>
            ))}
            {search.hasNextPage && (
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance text-[var(--muted)] disabled:opacity-40"
                disabled={search.isFetchingNextPage}
                onClick={() => void search.fetchNextPage()}
                data-testid="search-load-more"
              >
                {search.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
