import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useAutonomyGrants, useAutonomyOffers, useGrantAutonomy, useRevokeAutonomyGrant, useTrustGrid, useTrustPromotions } from "../api/queries.js";
import type { AutonomyGrant, AutonomyOffer, GrantOutcome, GridRow, PromotionOffer, TrustTier } from "../api/types.js";
import { MutationError } from "../components/MutationError.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { Swap } from "../components/Swap.js";
import { AutonomyOfferCard, OfferCard } from "../components/TrainingCards.js";
import { useSyncStatus } from "../sync.js";
import { GRANTABLE, LEVEL_WORDS, TIER_WORDS } from "./words.js";

/** One topic and what your duo does about it on its own — in words, with the daemon's codes kept for the detail. */
function Row({ row }: { row: GridRow }) {
  return (
    <div className="shape-entry flex flex-col gap-1 px-4 py-3" data-testid="may-row">
      <div className="flex items-baseline justify-between gap-4">
        <span className="min-w-0 truncate type-body" data-testid="may-topic">
          {row.topicLabel ?? row.topicId}
        </span>
        <span className="shrink-0 type-body" data-testid="may-level">
          <Swap value={row.level}>{LEVEL_WORDS[row.level] ?? row.level}</Swap>
        </span>
      </div>
      <p className="type-provenance text-[var(--muted)]" data-testid="may-detail">
        For {TIER_WORDS[row.tier] ?? row.tier} · {row.source === "granted" ? "you granted this" : "it earned this"}
        {row.stale ? " · not seen lately" : ""}
      </p>
    </div>
  );
}

/** The daemon's `GrantOutcome` in words — "ambiguous" is rendered by the picker, not here. */
function grantSentence(outcome: GrantOutcome, tierLabel: string): string | null {
  switch (outcome.status) {
    case "applied":
      return `Done: your duo may now ${tierLabel} on "${outcome.topicLabel}".`;
    case "no_match":
      return "No topic matches that description. Try the words your duo's topics use — they're listed above.";
    case "topic_not_found":
      return `That topic (${outcome.topicId}) no longer exists.`;
    case "refused":
      return `Refused — it conflicts with something you told your duo to refuse: ${outcome.refusal.heading}. ${outcome.refusal.reason}`;
    case "ambiguous":
      return null;
  }
}

/**
 * Telling your duo what it may handle, in plain words — the same
 * `POST /trust/grant` path `duo trust grant` takes. Deliberate by design
 * (trust-surface.md requirement 4): an ambiguous description comes back with
 * its candidates and the owner picks one — this never best-guesses — and a
 * conflict with a refusal refuses. The kind of thing is chosen with radios in
 * the words a person would use; there is no dropdown to change a level with,
 * and no fifth choice, because what is external or irreversible is not a
 * thing anyone can grant (AR-17).
 */
function Tell({ api }: { api: DuoApiConfig }) {
  const [scopeText, setScopeText] = useState("");
  const [tier, setTier] = useState<TrustTier>("T1");
  const grant = useGrantAutonomy(api);
  const outcome = grant.data;
  const label = GRANTABLE.find((option) => option.tier === tier)?.label ?? "handle";

  function submit(topicId?: string): void {
    const text = scopeText.trim();
    if (text && !grant.isPending) {
      grant.mutate({ scopeText: text, tier, ...(topicId ? { topicId } : {}) });
    }
  }

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="may-tell">
      <h2 className="type-heading">Tell your duo what it may handle</h2>
      <p className="type-provenance text-[var(--muted)]">
        Say it in your words. Anyone you've sent an ask link gets real answers on topics you allow; everything else is passed on to you.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1 type-body">
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
        <fieldset className="flex flex-col gap-1">
          <legend className="type-body">On its own, it may</legend>
          <div className="flex flex-wrap gap-2">
            {GRANTABLE.map((option) => (
              <label className="inline-flex min-h-11 items-center gap-2 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" key={option.tier}>
                <input checked={tier === option.tier} name="grant-kind" onChange={() => setTier(option.tier)} type="radio" value={option.tier} />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
        <button
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
          disabled={grant.isPending || scopeText.trim().length === 0}
          type="submit"
        >
          {grant.isPending ? "Saving…" : "Allow"}
        </button>
      </form>
      {outcome?.status === "ambiguous" && (
        <div className="flex flex-col gap-2" data-testid="grant-candidates">
          <p className="type-body">That could mean more than one topic. Which one?</p>
          <div className="flex flex-wrap gap-2">
            {outcome.candidates.map((candidate) => (
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
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
      {outcome && grantSentence(outcome, label) && (
        <p className={`type-body ${outcome.status === "applied" ? "" : "text-[var(--refused)]"}`} data-testid="grant-outcome" role="status">
          {grantSentence(outcome, label)}
        </p>
      )}
      <MutationError error={grant.error} />
    </section>
  );
}

const isGrant = (value: unknown): value is AutonomyGrant =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AutonomyGrant).recipientKey === "string" &&
  typeof (value as AutonomyGrant).grantedAt === "string" &&
  typeof (value as AutonomyGrant).evidence === "object" &&
  (value as AutonomyGrant).evidence !== null;

const isAutonomyOffer = (value: unknown): value is AutonomyOffer =>
  typeof value === "object" && value !== null && typeof (value as AutonomyOffer).recipientKey === "string" && typeof (value as AutonomyOffer).evidence === "string";

function grantedOn(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * #266: the people your duo answers by itself — each one granted by you from
 * an offer it earned, with the record it earned it on and one way to take it
 * back. Revoking is immediate and also stops a reply to them still inside its
 * undo window (the daemon does both in one call); after it, replies to them
 * wait on you again, and your duo won't ask again for a while.
 */
function AnswersByItself({ api }: { api: DuoApiConfig }) {
  const grants = useAutonomyGrants(api);
  const revoke = useRevokeAutonomyGrant(api);
  const { reachable } = useSyncStatus();
  const rows = Array.isArray(grants.data) ? grants.data.filter(isGrant) : [];
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid="may-autonomy">
      <h2 className="type-heading">Answers by itself</h2>
      <p className="type-provenance text-[var(--muted)]">
        Your duo replies to these people on its own, holding each reply for your undo window first. Anything it isn't sure of still comes to
        you.
      </p>
      {rows.map((grant) => (
        <div className="shape-entry flex flex-col gap-1 px-4 py-3" data-testid="may-autonomy-row" key={grant.recipientKey}>
          <div className="flex items-baseline justify-between gap-4">
            <span className="min-w-0 truncate type-body">{grant.recipientName ?? grant.recipientKey}</span>
            <button
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body disabled:opacity-40"
              data-testid="may-autonomy-revoke"
              disabled={!reachable || revoke.isPending}
              onClick={() => revoke.mutate(grant.recipientKey)}
              type="button"
            >
              Take back
            </button>
          </div>
          <p className="type-provenance text-[var(--muted)]">
            You allowed this {grantedOn(grant.grantedAt)} after sending {grant.evidence.sentUnedited} of its last {grant.evidence.considered}{" "}
            replies unedited.
          </p>
        </div>
      ))}
      <MutationError error={revoke.error} />
    </section>
  );
}

const isOffer = (value: unknown): value is PromotionOffer =>
  typeof value === "object" && value !== null && typeof (value as PromotionOffer).topicId === "string" && typeof (value as PromotionOffer).cleanStreak === "number";

/**
 * What your duo may do on its own (the profile's May do tab): each topic and
 * how far it goes, in plain levels — "Answers on its own", "Drafts for you",
 * "Always asks you" — with anything external or irreversible shown as the
 * hatched, controlless row it is (AR-17). It is a read: a level changes when
 * you accept an offer (they wait here if you set them aside) or when you tell
 * your duo in words, never by a switch on this list.
 */
export function MayDo({ api }: { api: DuoApiConfig }) {
  const grid = useTrustGrid(api);
  const promotions = useTrustPromotions(api);
  const autonomy = useAutonomyOffers(api);
  if (grid.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (grid.error) {
    return <RouteError api={api} error={grid.error} onRetry={() => void grid.refetch()} />;
  }
  const rows = Array.isArray(grid.data) ? grid.data : [];
  const offers = Array.isArray(promotions.data) ? promotions.data.filter(isOffer) : [];
  const autonomyOffers = Array.isArray(autonomy.data) ? autonomy.data.filter(isAutonomyOffer) : [];
  return (
    <div className="flex max-w-2xl flex-col gap-4 p-6" data-testid="may-tab">
      {(offers.length > 0 || autonomyOffers.length > 0) && (
        <div className="flex flex-col gap-3" data-testid="may-offers">
          {offers.map((offer) => (
            <OfferCard api={api} key={`${offer.topicId}/${offer.tier}`} offer={offer} />
          ))}
          {autonomyOffers.map((offer) => (
            <AutonomyOfferCard api={api} key={offer.recipientKey} offer={offer} />
          ))}
        </div>
      )}
      <AnswersByItself api={api} />
      {rows.length === 0 ? (
        <p className="type-body text-[var(--muted)]" data-testid="may-empty">
          Nothing earned yet. As your duo answers and you correct it, topics it handles well will show up here.
        </p>
      ) : (
        <div className="shape-container flex flex-col gap-2 p-4" data-testid="may-list">
          {rows.map((row) => (
            <Row key={`${row.topicId}/${row.tier}`} row={row} />
          ))}
        </div>
      )}
      <p
        className="rounded-[var(--r-sm)] px-3 py-2 type-provenance italic text-[var(--faint)]"
        data-testid="may-never"
        style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--edge) 0 1px, transparent 1px 8px)" }}
      >
        Anything external or irreversible: never on its own. You confirm each one.
      </p>
      <Tell api={api} />
    </div>
  );
}
