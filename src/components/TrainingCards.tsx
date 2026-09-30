import { useState } from "react";
import type { ReactNode } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useAudit, useDecideCandidate, useDecidePromotion, useMirrorRules, useReview, useRuleAction, useTrustPromotions } from "../api/queries.js";
import type { AuditEntry, CorrectionCandidate, PromotionOffer, Rule } from "../api/types.js";
import { isSetAside, setAside } from "../cardPacing.js";
import { ConfirmationsPanel } from "../routes/Confirmations.js";
import { useSyncStatus } from "../sync.js";
import { DuoLine } from "./DuoLine.js";
import { MutationError } from "./MutationError.js";

/*
 * Training, in the background (docs/design-language.md §5.4, epic #138).
 * What your duo learns from you is not a set of screens you owe work to: it
 * arrives as a few cards in its own chat, batched and paced, and a card left
 * alone simply waits in the profile. Every card is the duo speaking, so every
 * one sits behind its line — in Signal, the colour that means "your decision
 * is wanted" — and every decision goes through the same one module path it
 * always did: approve or reject a correction or a rule, accept or decline an
 * offered promotion. Nothing here promotes anything by itself, and a
 * decision is never silent: it takes an explicit tap.
 */

/*
 * These cards read four different daemon routes, and a card built from a
 * payload that is not the documented shape would say something the daemon
 * never said. So each read is validated field by field before it becomes a
 * card — the same stance the rest of this client takes toward a cache that
 * may be older than the wire: a shape it does not recognise is nothing to show.
 */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isCandidate = (value: unknown): value is CorrectionCandidate =>
  isObject(value) && typeof value.id === "string" && (value.kind === "style" || value.kind === "substance") && typeof value.question === "string" && typeof value.draftText === "string" && typeof value.sentText === "string";
const isRule = (value: unknown): value is Rule => isObject(value) && typeof value.id === "string" && typeof value.text === "string" && typeof value.supportCount === "number";
const isOffer = (value: unknown): value is PromotionOffer =>
  isObject(value) && typeof value.topicId === "string" && typeof value.tier === "string" && typeof value.cleanStreak === "number" && typeof value.offeredLevel === "string";
const isAuditEntry = (value: unknown): value is AuditEntry =>
  isObject(value) && typeof value.createdAt === "string" && typeof value.declined === "boolean" && !Number.isNaN(new Date(value.createdAt as string).getTime());

const listOf = <T,>(value: unknown, is: (item: unknown) => item is T): T[] => (Array.isArray(value) ? value.filter(is) : []);

const clip = (text: string, length = 80): string => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);

const buttonBase =
  "inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body disabled:opacity-40";
const primary = "inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40";

/** One card: the duo's own words behind its line in Signal, and the owner's controls beneath, outside it. */
function Card({
  testId,
  title,
  body,
  children,
}: {
  testId: string;
  title: string;
  body?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex max-w-[90%] flex-col gap-2" data-testid={testId}>
      <DuoLine attributionTestId={`${testId}-attribution`} label="Your duo" state="signal" testId={`${testId}-line`}>
        <div className="flex flex-col gap-2">
          <p className="type-body">{title}</p>
          {body}
        </div>
      </DuoLine>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/** What each thing waiting for confirmation reads as: the owner's own words, whichever kind it is. */
type Item = { key: string; text: string; evidence: string } & ({ kind: "candidate"; id: string } | { kind: "rule"; id: string });

function itemsOf(candidates: readonly CorrectionCandidate[], rules: readonly Rule[]): Item[] {
  return [
    ...candidates.map(
      (candidate): Item => ({
        kind: "candidate",
        id: candidate.id,
        key: `c:${candidate.id}`,
        text: `When you're asked "${clip(candidate.question, 60)}", answer the way you did.`,
        evidence: `You changed "${clip(candidate.draftText, 40)}" to "${clip(candidate.sentText, 40)}".`,
      }),
    ),
    ...rules.map(
      (rule): Item => ({
        kind: "rule",
        id: rule.id,
        key: `r:${rule.id}`,
        text: rule.text,
        evidence: `From ${rule.supportCount} time${rule.supportCount === 1 ? "" : "s"} you answered this way.`,
      }),
    ),
  ];
}

/**
 * Corrections and derived rules waiting for the owner's yes, as one batched
 * card — "I've got N things to check with you" — never one ping each. Approve
 * takes them all in one explicit tap; "Not now" sets the card aside for the
 * day; "Review one by one" opens the profile's Rules, which is where each one
 * shows the threads it came from and can be rejected on its own.
 */
export function RulesCard({ api }: { api: DuoApiConfig }) {
  const review = useReview(api);
  const rules = useMirrorRules(api);
  const decideCandidate = useDecideCandidate(api);
  const ruleAction = useRuleAction(api);
  const { reachable } = useSyncStatus();
  const [aside, setAsideNow] = useState(() => isSetAside("rules"));
  const [error, setError] = useState<Error | null>(null);

  const items = itemsOf(listOf(review.data, isCandidate), listOf(rules.data?.awaitingApproval, isRule));
  if (items.length === 0 || aside) {
    return null;
  }
  const busy = decideCandidate.isPending || ruleAction.isPending;
  const approveAll = async (): Promise<void> => {
    setError(null);
    try {
      await Promise.all(
        items.map((item) =>
          item.kind === "candidate"
            ? decideCandidate.mutateAsync({ candidateId: item.id, action: "approve" })
            : ruleAction.mutateAsync({ ruleId: item.id, action: "approve" }),
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("The daemon didn't take that — try again."));
    }
  };
  return (
    <Card
      body={
        <ul className="flex flex-col gap-2" data-testid="rules-card-items">
          {items.slice(0, 3).map((item) => (
            <li className="flex flex-col" key={item.key}>
              <span className="type-body">{item.text}</span>
              <span className="type-provenance text-[var(--muted)]">{item.evidence}</span>
            </li>
          ))}
          {items.length > 3 && <li className="type-provenance text-[var(--muted)]">and {items.length - 3} more</li>}
        </ul>
      }
      testId="rules-card"
      title={`I've got ${items.length} ${items.length === 1 ? "thing" : "things"} to check with you`}
    >
      <button className={primary} data-testid="rules-approve" disabled={busy || !reachable} onClick={() => void approveAll()} type="button">
        {items.length === 1 ? "Approve" : "Approve all"}
      </button>
      <button
        className={buttonBase}
        data-testid="rules-not-now"
        onClick={() => {
          setAside("rules", "day");
          setAsideNow(true);
        }}
        type="button"
      >
        Not now
      </button>
      <a className={buttonBase} data-testid="rules-review" href="#duo/profile/rules">
        Review one by one
      </a>
      <MutationError error={error} />
    </Card>
  );
}

/** The offer's words: what your duo proposes to do on its own, in the levels' plain names. */
export function offerSentence(offer: Pick<PromotionOffer, "topicLabel" | "topicId" | "cleanStreak" | "offeredLevel">): { title: string; body: string } {
  const topic = offer.topicLabel ?? offer.topicId;
  const streak = `You've sent my last ${offer.cleanStreak} ${topic} draft${offer.cleanStreak === 1 ? "" : "s"} without an edit.`;
  return offer.offeredLevel === "auto"
    ? { title: streak, body: "Let me answer these on my own? I'll tell you each time, and go back to asking the moment you correct me." }
    : { title: streak, body: "Let me draft these for you without checking first? You still decide every one, and I go back to asking the moment you correct me." };
}

/**
 * A trust offer (§5.4): earned, so it arrives as a question in the chat and
 * changes nothing until the owner taps. Two answers, both explicit — "Let it
 * answer" accepts the promotion, "Keep asking me" declines it — and both are
 * the daemon's own promotion routes, never a client-side flag.
 */
export function OfferCard({ api, offer }: { api: DuoApiConfig; offer: PromotionOffer }) {
  const decide = useDecidePromotion(api);
  const { reachable } = useSyncStatus();
  const words = offerSentence(offer);
  const key = { topicId: offer.topicId, tier: offer.tier };
  return (
    <Card body={<p className="type-provenance text-[var(--muted)]">{words.body}</p>} testId="offer-card" title={words.title}>
      <button
        className={primary}
        data-testid="offer-accept"
        disabled={decide.isPending || !reachable}
        onClick={() => decide.mutate({ ...key, decision: "accept" })}
        type="button"
      >
        {offer.offeredLevel === "auto" ? "Let it answer" : "Let it draft"}
      </button>
      <button
        className={buttonBase}
        data-testid="offer-decline"
        disabled={decide.isPending || !reachable}
        onClick={() => decide.mutate({ ...key, decision: "decline" })}
        type="button"
      >
        Keep asking me
      </button>
      <MutationError error={decide.error} />
    </Card>
  );
}

/** A demotion, said out loud: the owner corrected the duo, and it went back to asking. There are no buttons — nothing was decided by anyone but the correction. */
export interface TrustNotice {
  readonly id: string;
  readonly text: string;
}

/**
 * A plain sentence from your duo with nothing to press: "I got that wrong, so
 * I've gone back to asking you first." Losing trust is fast and announced,
 * never a modal. (Where the notices come from is the daemon's to say; until it
 * exposes demotions there are none to show.)
 */
export function NoticeCard({ notice }: { notice: TrustNotice }) {
  return (
    <div className="max-w-[90%] motion-rise" data-testid="notice-card">
      <DuoLine attributionTestId="notice-card-attribution" label="Your duo" state="neutral" testId="notice-card-line">
        <p className="type-body">{notice.text}</p>
      </DuoLine>
    </div>
  );
}

/** How the digest counts a week: who asked your duo through your links, and what became of it. */
export function digestOf(entries: readonly AuditEntry[], now: Date = new Date()): { total: number; answered: number; declined: number } {
  const since = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const recent = entries.filter((entry) => new Date(entry.createdAt).getTime() >= since);
  const declined = recent.filter((entry) => entry.declined).length;
  return { total: recent.length, answered: recent.length - declined, declined };
}

/**
 * The weekly digest: what your duo did for other people while you were away —
 * one batched card, and once you've dismissed it, gone until the next week.
 */
export function DigestCard({ api }: { api: DuoApiConfig }) {
  const audit = useAudit(api);
  const [aside, setAsideNow] = useState(() => isSetAside("digest"));
  const digest = digestOf(listOf(audit.data, isAuditEntry));
  if (digest.total === 0 || aside) {
    return null;
  }
  return (
    <Card
      body={
        <p className="type-provenance text-[var(--muted)]" data-testid="digest-counts">
          I answered {digest.answered} and declined {digest.declined} — declined means a boundary you set.
        </p>
      }
      testId="digest-card"
      title={`${digest.total} ${digest.total === 1 ? "person" : "people"} asked your duo through your links this week`}
    >
      <a className={buttonBase} data-testid="digest-activity" href="#duo/profile/activity">
        See activity
      </a>
      <button
        className={buttonBase}
        data-testid="digest-dismiss"
        onClick={() => {
          setAside("digest", "week");
          setAsideNow(true);
        }}
        type="button"
      >
        Dismiss
      </button>
    </Card>
  );
}

/**
 * Everything your duo has to say about training, in the order that matters:
 * an action waiting on an explicit yes first (same two-step confirm as ever,
 * Cancel focused, never queued), then what it wants confirmed, then offers,
 * then notices, then the digest. It renders nothing at all on a day with
 * nothing to learn.
 */
export function TrainingCards({ api, notices = [] }: { api: DuoApiConfig; notices?: readonly TrustNotice[] }) {
  const promotions = useTrustPromotions(api);
  const offers = listOf(promotions.data, isOffer);
  return (
    <div className="flex flex-col gap-5" data-testid="training-cards">
      <ConfirmationsPanel api={api} quietWhenEmpty />
      <RulesCard api={api} />
      {offers.map((offer) => (
        <OfferCard api={api} key={`${offer.topicId}/${offer.tier}`} offer={offer} />
      ))}
      {notices.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} />
      ))}
      <DigestCard api={api} />
    </div>
  );
}

/** How many things training has to show right now — what the chat list's row says about your duo. */
export function useTrainingCount(api: DuoApiConfig): number {
  const review = useReview(api);
  const rules = useMirrorRules(api);
  const promotions = useTrustPromotions(api);
  const items = itemsOf(listOf(review.data, isCandidate), listOf(rules.data?.awaitingApproval, isRule));
  return (isSetAside("rules") ? 0 : items.length) + listOf(promotions.data, isOffer).length;
}
