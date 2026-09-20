import { useMemo, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { usePendingDrafts } from "../api/queries.js";
import type { DraftRecord } from "../api/types.js";
import { DraftCard } from "../components/DraftCard.js";

/**
 * #50's three queue states, straight off the record's own fields: a draft
 * is anything not escalated; an escalation the pipeline raised for
 * judgement (`escalated` without `refused`); a refusal the pipeline
 * declined outright (`refused` rides only on escalations). Nothing here
 * judges anything — the record says which it is.
 */
type StateFilter = "all" | "drafts" | "escalations" | "refusals";

const STATE_MATCH: Record<Exclude<StateFilter, "all">, "draft" | "escalation" | "refusal"> = {
  drafts: "draft",
  escalations: "escalation",
  refusals: "refusal",
};

function stateOf(draft: DraftRecord): "draft" | "escalation" | "refusal" {
  if (!draft.escalated) {
    return "draft";
  }
  return draft.refused ? "refusal" : "escalation";
}

/**
 * The default surface (`client-tech-design.md` §3.1) — the Send / Edit /
 * Ignore queue, badge count = pending drafts. This is the thing the app
 * exists to open, so it sits above the duo list rather than behind it
 * (client-design.md §1.5).
 *
 * #50: once drafts arrive from more than one channel and escalations mix
 * with refusals, a flat list stops being a queue — so the view narrows by
 * state and by origin. Filtering is presentation only: the daemon's
 * pending list is fetched once and sliced in state, the option lists are
 * the queue's own vocabulary (every channel and asker actually on the
 * wire — no registry, #43's discipline), and the sidebar badge keeps
 * counting everything, because it reads its own query, not this view.
 */
export function Review({ api }: { api: DuoApiConfig }) {
  const { data: drafts, isLoading, error } = usePendingDrafts(api);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [askerFilter, setAskerFilter] = useState("all");

  const channels = useMemo(() => {
    const kinds = new Set(
      (drafts ?? [])
        .filter((d) => d.provenance?.origin === "channel")
        .map((d) => (d.provenance as { channelKind: string }).channelKind),
    );
    return [...kinds];
  }, [drafts]);
  const askers = useMemo(() => {
    const refs = new Set(
      (drafts ?? [])
        .filter((d) => d.provenance?.origin === "channel")
        .map((d) => (d.provenance as { askerRef: string }).askerRef),
    );
    return [...refs];
  }, [drafts]);

  const pending = drafts ?? [];
  const visible = pending.filter((draft) => {
    if (stateFilter !== "all" && STATE_MATCH[stateFilter] !== stateOf(draft)) {
      return false;
    }
    if (draft.provenance?.origin === "channel") {
      const provenance = draft.provenance as { channelKind: string; askerRef: string };
      if (channelFilter !== "all" && provenance.channelKind !== channelFilter) {
        return false;
      }
      if (askerFilter !== "all" && provenance.askerRef !== askerFilter) {
        return false;
      }
    } else if (channelFilter !== "all" || askerFilter !== "all") {
      // An owner or unknown-origin draft matches no channel and no asker.
      return false;
    }
    return true;
  });
  const hidden = pending.length - visible.length;
  const filtered = stateFilter !== "all" || channelFilter !== "all" || askerFilter !== "all";
  const clearFilters = () => {
    setStateFilter("all");
    setChannelFilter("all");
    setAskerFilter("all");
  };

  if (isLoading) {
    return <div className="p-6 text-[var(--muted)]">Loading…</div>;
  }
  if (error) {
    return <div className="p-6 text-[var(--refused)]">{(error as Error).message}</div>;
  }
  if (pending.length === 0) {
    return <div className="p-6 text-[var(--muted)]">Nothing waiting on you.</div>;
  }

  return (
    <div className="flex flex-col gap-4 p-6" data-testid="review-list">
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
        <label className="flex items-center gap-1">
          State
          <select
            aria-label="State"
            className="rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-1 py-0.5 text-[var(--text)]"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as StateFilter)}
          >
            <option value="all">All</option>
            <option value="drafts">Drafts</option>
            <option value="escalations">Escalations</option>
            <option value="refusals">Refusals</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          Channel
          <select
            aria-label="Channel"
            className="rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-1 py-0.5 text-[var(--text)]"
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
          >
            <option value="all">All</option>
            {channels.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          Asker
          <select
            aria-label="Asker"
            className="rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-1 py-0.5 text-[var(--text)]"
            value={askerFilter}
            onChange={(e) => setAskerFilter(e.target.value)}
          >
            <option value="all">All</option>
            {askers.map((ref) => (
              <option key={ref} value={ref}>
                {ref}
              </option>
            ))}
          </select>
        </label>
        {filtered && (
          <span className="flex items-center gap-2">
            <span className="text-[var(--faint)]" data-testid="filter-status">
              Filtered — {hidden} hidden
            </span>
            <button className="rounded-[var(--r-sm)] border border-[var(--edge)] px-2 py-0.5" data-testid="filter-clear" onClick={clearFilters}>
              Clear
            </button>
          </span>
        )}
      </div>
      {visible.length === 0 ? (
        <div className="text-[var(--muted)]" data-testid="filter-empty">
          Nothing in this slice — {hidden} hidden by the filter.
        </div>
      ) : (
        visible.map((draft) => <DraftCard key={draft.id} api={api} draft={draft} />)
      )}
    </div>
  );
}
