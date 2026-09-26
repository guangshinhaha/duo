import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useDecidePromotion, useGrantAutonomy, useTrustGrid, useTrustPromotions } from "../api/queries.js";
import type { GrantOutcome, GridRow, PromotionOffer, TrustTier } from "../api/types.js";
import { MutationError } from "../components/MutationError.js";
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

const controlButton = "inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3";

/**
 * The tiers a grant may name. T4 is absent — not a disabled fifth option
 * (AR-17 / trust-surface.md requirement 5): no client path can write a cell
 * the CLI could not, and the store's CHECK constraint refuses it anyway.
 */
const GRANTABLE_TIERS: readonly TrustTier[] = ["T0", "T1", "T2", "T3"];

/**
 * Promotion offers (`GET /trust/promotions`, #54): cells whose clean streak
 * earned an offer. Nothing promotes until the owner accepts, one cell at a
 * time — batched into one list, never individual pings.
 */
function Promotions({ api }: { api: DuoApiConfig }) {
  const { data: offers } = useTrustPromotions(api);
  const decide = useDecidePromotion(api);
  if (!Array.isArray(offers) || offers.length === 0) {
    return null;
  }
  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid="trust-promotions">
      <h2 className="type-heading">Offered promotions</h2>
      <p className="type-provenance text-[var(--muted)]">Your duo has handled these cleanly. Nothing changes until you accept.</p>
      <ul className="flex flex-col gap-2">
        {offers.map((offer: PromotionOffer) => (
          <li className="shape-entry flex flex-col gap-2 px-4 py-3" data-testid="promotion-offer" key={`${offer.topicId}/${offer.tier}`}>
            <div className="type-body">{offer.topicLabel ?? offer.topicId}</div>
            <div className="type-provenance text-[var(--muted)]">
              <span className="type-identifier text-[var(--text)]">{offer.tier}</span> · {offer.currentLevel} → {offer.offeredLevel} ·{" "}
              {offer.cleanStreak} clean in a row
            </div>
            <div className="flex gap-2">
              <button
                className={`${controlButton} bg-[var(--accent)] text-[var(--bg)]`}
                data-testid="promotion-accept"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ topicId: offer.topicId, tier: offer.tier, decision: "accept" })}
                type="button"
              >
                Accept
              </button>
              <button
                className={`${controlButton} text-[var(--muted)]`}
                data-testid="promotion-decline"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ topicId: offer.topicId, tier: offer.tier, decision: "decline" })}
                type="button"
              >
                Decline
              </button>
            </div>
          </li>
        ))}
      </ul>
      <MutationError error={decide.error} />
    </section>
  );
}

/** The daemon's `GrantOutcome` in words — "ambiguous" is rendered by the picker, not here. */
function grantSentence(outcome: GrantOutcome): string | null {
  switch (outcome.status) {
    case "applied":
      return `Granted ${outcome.tier} on "${outcome.topicLabel}".`;
    case "no_match":
      return "No topic matches that description. Try the words your duo's topics use — they're listed in the grid.";
    case "topic_not_found":
      return `That topic (${outcome.topicId}) no longer exists.`;
    case "refused":
      return `Refused — it conflicts with something you told your duo to refuse: ${outcome.refusal.heading}. ${outcome.refusal.reason}`;
    case "ambiguous":
      return null;
  }
}

/**
 * Granting autonomy in plain words (`POST /trust/grant`, the core's
 * `grantAutonomy` — the same path `duo trust grant` takes). Deliberate by
 * design (trust-surface.md requirement 4): an ambiguous description comes
 * back with its candidates and the owner picks one — this form never
 * best-guesses — and a refusal conflict refuses.
 */
function GrantForm({ api }: { api: DuoApiConfig }) {
  const [scopeText, setScopeText] = useState("");
  const [tier, setTier] = useState<TrustTier>("T1");
  const grant = useGrantAutonomy(api);
  const outcome = grant.data;

  function submit(topicId?: string): void {
    const text = scopeText.trim();
    if (text && !grant.isPending) {
      grant.mutate({ scopeText: text, tier, ...(topicId ? { topicId } : {}) });
    }
  }

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="trust-grant">
      <h2 className="type-heading">Grant autonomy</h2>
      <p className="type-provenance text-[var(--muted)]">
        Describe what your duo may handle on its own, in your words. Anyone you&apos;ve sent an ask link gets real answers on granted topics;
        everything else is passed on to you.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex min-w-60 flex-1 flex-col gap-1 type-body">
          What it may handle
          <input
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
            onChange={(e) => {
              setScopeText(e.target.value);
              grant.reset();
            }}
            placeholder="questions about deploy access"
            value={scopeText}
          />
        </label>
        <label className="flex flex-col gap-1 type-body">
          Tier
          <select
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
            data-testid="grant-tier"
            onChange={(e) => setTier(e.target.value as TrustTier)}
            value={tier}
          >
            {GRANTABLE_TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`${controlButton} bg-[var(--accent)] text-[var(--bg)] disabled:opacity-40`}
          disabled={grant.isPending || scopeText.trim().length === 0}
          type="submit"
        >
          {grant.isPending ? "Granting…" : "Grant"}
        </button>
      </form>
      {outcome?.status === "ambiguous" && (
        <div className="flex flex-col gap-2" data-testid="grant-candidates">
          <p className="type-body">That could mean more than one topic. Which one?</p>
          <div className="flex flex-wrap gap-2">
            {outcome.candidates.map((candidate) => (
              <button
                className={`${controlButton} text-[var(--text)]`}
                data-testid="grant-candidate"
                key={candidate.topicId}
                onClick={() => submit(candidate.topicId)}
                type="button"
              >
                {candidate.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {outcome && grantSentence(outcome) && (
        <p
          className={`type-body ${outcome.status === "applied" ? "" : "text-[var(--refused)]"}`}
          data-testid="grant-outcome"
          role="status"
        >
          {grantSentence(outcome)}
        </p>
      )}
      <MutationError error={grant.error} />
    </section>
  );
}

/**
 * The trust grid (`client-tech-design.md` §3.1, `GET /trust/grid`): per
 * topic, what the duo may do without asking — tier, autonomy level, and
 * whether it earned that or was granted it. The grid itself stays a read;
 * the writes are the two deliberate acts the core exposes through its one
 * shared module path (trust-surface.md, #179): accepting an offered
 * promotion, and a plain-words grant. T4 never appears as an option.
 */
export function Trust({ api }: { api: DuoApiConfig }) {
  const { data: rows, isLoading, error, refetch } = useTrustGrid(api);

  if (isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (error) {
    return <RouteError api={api} error={error} onRetry={() => void refetch()} />;
  }

  return (
    // #33: the grid is one panel, like every other list of decisionable things.
    <div className="flex flex-col gap-4 p-6">
      <h1 className="type-heading sr-only">Trust</h1>
      <Promotions api={api} />
      {!rows || rows.length === 0 ? (
        <div className="text-[var(--muted)]" data-testid="trust-empty">
          Nothing earned yet. As your duo answers and you correct it, topics it handles well will show up here.
        </div>
      ) : (
        <div className="shape-container flex flex-col gap-2 p-4" data-testid="trust-grid">
          {rows.map((row) => (
            <TrustRow key={row.topicId} row={row} />
          ))}
        </div>
      )}
      <GrantForm api={api} />
    </div>
  );
}
