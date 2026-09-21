import type { DuoApiConfig } from "../api/client.js";
import { useTrustGrid } from "../api/queries.js";
import type { GridRow } from "../api/types.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";

/** The daemon's own trust vocabulary renders verbatim (tier, level, source) — a paraphrase here would be a second vocabulary to keep in sync with the core. */
function TrustRow({ row }: { row: GridRow }) {
  return (
    <div
      className="shape-entry flex items-center justify-between gap-4 px-4 py-3"
      data-testid="trust-row"
    >
      <div className="min-w-0 flex-1 truncate type-body" data-testid="trust-topic">
        {row.topicLabel ?? row.topicId}
      </div>
      <div className="flex shrink-0 items-center gap-3 type-provenance text-[var(--muted)]">
        {row.stale && (
          <span className="rounded-[var(--r-sm)] border border-dashed border-[var(--edge)] px-2 py-0" data-testid="trust-stale">
            stale
          </span>
        )}
        <span className="type-identifier text-[var(--text)]" data-testid="trust-tier">
          {row.tier}
        </span>
        <span data-testid="trust-level">{row.level}</span>
        <span data-testid="trust-source">{row.source}</span>
      </div>
    </div>
  );
}

/**
 * The trust grid (`client-tech-design.md` §3.1, `GET /trust/grid`): per
 * topic, what the duo may do without asking — tier, autonomy level, and
 * whether it earned that or was granted it. Read-only everywhere, not only
 * on mobile (AR-17): the daemon has no route to change a tier or level, so
 * a control here would be a promise the core would refuse.
 */
export function Trust({ api }: { api: DuoApiConfig }) {
  const { data: rows, isLoading, error, refetch } = useTrustGrid(api);

  if (isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (error) {
    return <RouteError api={api} error={error} onRetry={() => void refetch()} />;
  }
  if (!rows || rows.length === 0) {
    return (
      <div className="p-6 text-[var(--muted)]" data-testid="trust-empty">
        Nothing earned yet. As your duo answers and you correct it, topics it handles well will show up here.
      </div>
    );
  }

  return (
    // #33: the grid is one panel, like every other list of decisionable things.
    <div className="p-6">
      <div className="shape-container flex flex-col gap-2 p-4" data-testid="trust-grid">
        {rows.map((row) => (
          <TrustRow key={row.topicId} row={row} />
        ))}
      </div>
    </div>
  );
}
