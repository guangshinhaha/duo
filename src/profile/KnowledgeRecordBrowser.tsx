import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useKnowledgeRecords } from "../api/queries.js";
import type { KnowledgeRecord } from "../api/types.js";
import { KnowledgeRecordCard } from "../components/KnowledgeRecordCard.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";

/**
 * The cache (and, in tests, a fetch stub that predates this route) is a
 * storage layer, not a promise — the same "braces and belt" law
 * `knowledgeWords.ts#isDuoKnowledgeShape` already states for `GET
 * /knowledge`'s own cache entry. A page that isn't the daemon's documented
 * `{ records: [...] }` shape (a stale build's cache, or a test double that
 * has never heard of this route and falls back to `[]` or the unrelated
 * `DuoKnowledge` object) contributes no rows rather than throwing — the
 * list reads as merely empty, never crashes the whole tab.
 */
function recordsOf(page: unknown): readonly KnowledgeRecord[] {
  return page !== null && typeof page === "object" && Array.isArray((page as { records?: unknown }).records)
    ? ((page as { records: KnowledgeRecord[] }).records)
    : [];
}

/**
 * duo#273 (digital-duo#286): "a plain list of facts … my duo holds,
 * editable and deletable" — the record browser half of the Knows tab's
 * "What it has read" section. `GET /knowledge` already gives the counts
 * by source; this is where an owner opens one of those counts and reads,
 * edits or removes the records themselves, searching across them (AC4)
 * the same way `/search` already searches the corpus, scoped here to
 * browsing rather than relevance-ranking.
 *
 * A single scrolling list with inline edit, not the two-pane list/detail
 * the issue's "How" section sketches: Knows is already a single-column,
 * section-based tab (`Section`, `RemovedFromCitation`, `ChannelList`), and
 * a second navigation paradigm bolted onto one tab is a cost this PR's
 * scope doesn't buy back. Noted as a deliberate scope choice, not an
 * oversight — a two-pane browser can follow if the list grows unwieldy.
 */
export function KnowledgeRecordBrowser({ api, sources }: { api: DuoApiConfig; sources: readonly string[] }) {
  const [q, setQ] = useState("");
  const [source, setSource] = useState<string | undefined>(undefined);
  const page = useKnowledgeRecords(api, { source, q: q.trim().length > 0 ? q.trim() : undefined });
  const records = (page.data?.pages ?? []).flatMap(recordsOf);

  return (
    <div className="flex flex-col gap-3" data-testid="knowledge-record-browser">
      <div className="flex flex-wrap gap-2">
        <input
          className="min-w-0 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 py-2 type-body text-[var(--text)]"
          data-testid="knowledge-record-search"
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search what it has read…"
          type="search"
          value={q}
        />
        <select
          className="rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-2 type-provenance text-[var(--muted)]"
          data-testid="knowledge-record-source-filter"
          onChange={(event) => setSource(event.target.value === "" ? undefined : event.target.value)}
          value={source ?? ""}
        >
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {page.isLoading ? (
        <RouteLoading variant="rows" />
      ) : page.error ? (
        <RouteError api={api} error={page.error} onRetry={() => void page.refetch()} />
      ) : records.length === 0 ? (
        <p className="type-provenance text-[var(--faint)]" data-testid="knowledge-record-empty">
          {q.trim().length > 0 || source ? "Nothing matches." : "Nothing imported yet."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="knowledge-record-list">
          {records.map((record) => (
            <li key={record.id}>
              <KnowledgeRecordCard api={api} record={record} />
            </li>
          ))}
        </ul>
      )}

      {page.hasNextPage && (
        <button
          className="min-h-9 self-start type-provenance text-[var(--muted)] underline disabled:opacity-40"
          data-testid="knowledge-record-load-more"
          disabled={page.isFetchingNextPage}
          onClick={() => void page.fetchNextPage()}
          type="button"
        >
          {page.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
