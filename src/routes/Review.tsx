import { useMemo, useRef, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useKnowledge, usePendingDrafts } from "../api/queries.js";
import type { DraftRecord } from "../api/types.js";
import { DraftCard } from "../components/DraftCard.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { corpusSentence, lastImportSentence } from "./Knowledge.js";

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
  const { data: drafts, isLoading, error, refetch } = usePendingDrafts(api);
  // #37: the empty queue's second read — what the duo knows so far, from
  // the same knowledge key the Knowledge screen and search use (deduped,
  // cached). It enriches the empty state only, so it is gated to fire only
  // once the queue is known empty — never beside a loaded queue, and never
  // while the queue itself is still loading, when there is nothing to
  // enrich yet and the read would only compete with the queue for the
  // wire. A failed read must never blank the queue it is decorating.
  const knowledge = useKnowledge(api, { enabled: !isLoading && (drafts ?? []).length === 0 });
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [askerFilter, setAskerFilter] = useState("all");
  // #36: roving tabindex — the queue is ONE tab stop, not one per draft.
  // The entry holding it walks entry by entry with the arrows, and Tab
  // from a focused entry walks into its actions, which are real buttons
  // inside it. The tab stop follows real focus, so clicking or tabbing
  // into an entry makes that entry the queue's stop.
  const [focusIndex, setFocusIndex] = useState(0);
  const entryRefs = useRef<(HTMLDivElement | null)[]>([]);

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
    return <RouteLoading />;
  }
  if (error) {
    return <RouteError api={api} error={error} onRetry={() => void refetch()} />;
  }
  if (pending.length === 0) {
    const known = knowledge.data;
    return (
      <div className="p-6" data-testid="review-empty">
        {/* AR-19: an empty Review is this app's opening screen for weeks —
            so it makes the product's argument, not an apology. The headline
            stays the headline; beneath it, what the duo knows so far and the
            one thing that would teach it more, every count the daemon's own
            (#45's read) and every sentence the one Knowledge ships. */}
        <h1 className="type-heading">Nothing waiting on you.</h1>
        <div className="shape-container mt-4 flex max-w-xl flex-col gap-2 p-4" data-testid="review-empty-knowledge">
          {known?.records && known.corpus ? (
            <>
              <p className="type-body text-[var(--text)]">
                {known.records.total} record{known.records.total === 1 ? "" : "s"} so far · {lastImportSentence(known.lastImport)}
              </p>
              <p className="type-body text-[var(--text)]">{corpusSentence(known.corpus)}</p>
            </>
          ) : knowledge.isLoading ? (
            // The read is on its way — a quiet shape, not a word.
            <div className="shape-entry-quiet animate-pulse p-4" />
          ) : null}
          <p className="type-provenance text-[var(--muted)]">⌘K searches what your duo knows.</p>
        </div>
      </div>
    );
  }

  return (
    // #33: the queue is one panel (the container shape) and each draft a
    // thing on it (the entry shape) — the ground/thing distinction the
    // flat triple erased.
    <div className="p-6">
      {/* #39: the page's own h1 — the queue's heading is the route, not
          any one draft; the empty state below carries its visible h1
          instead. */}
      <h1 className="type-heading sr-only">Review</h1>
      <div className="shape-container flex flex-col gap-4 p-4" data-testid="review-list">
        <div className="flex flex-wrap items-center gap-2 type-provenance text-[var(--muted)]">
          <label className="flex items-center gap-1">
            State
            <select
              aria-label="State"
              className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
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
              className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
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
              className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
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
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2"
                data-testid="filter-clear"
                onClick={clearFilters}
              >
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
          visible.map((draft, index) => (
            <div
              key={draft.id}
              aria-label={`Review entry ${index + 1} of ${visible.length}`}
              data-testid="review-entry"
              ref={(element) => {
                entryRefs.current[index] = element;
              }}
              role="group"
              // The clamped stop: a disposition can shrink the queue out
              // from under the remembered index, and exactly one entry
              // must still hold the stop.
              tabIndex={index === Math.min(focusIndex, visible.length - 1) ? 0 : -1}
              onFocus={() => setFocusIndex(index)}
              onKeyDown={(event) => {
                // Arrows inside a text field are the caret's, not the queue's.
                const target = event.target as HTMLElement;
                if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") {
                  return;
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = index + (event.key === "ArrowDown" ? 1 : -1);
                  const clamped = Math.max(0, Math.min(visible.length - 1, next));
                  setFocusIndex(clamped);
                  entryRefs.current[clamped]?.focus();
                }
              }}
            >
              <DraftCard api={api} draft={draft} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
