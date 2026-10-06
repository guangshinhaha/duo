import type { DuoApiConfig } from "../api/client.js";
import { useMirrorPinnedAnswers, useMirrorRules, useReview } from "../api/queries.js";
import type { CorrectionCandidate, PinnedAnswer, Rule, RuleReviewListing } from "../api/types.js";
import { Collapse, useLeaving } from "../components/Collapse.js";
import { PinnedAnswerCard } from "../components/PinnedAnswerCard.js";
import { RuleCard, type RuleBucket } from "../components/RuleCard.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { CandidateCard } from "./CandidateCard.js";

/** The buckets in the order an owner meets them — what needs a decision first, the record last. */
const BUCKETS: ReadonlyArray<{ key: RuleBucket; heading: string; empty: string; collapsed?: boolean }> = [
  { key: "awaitingApproval", heading: "Waiting for you", empty: "Nothing to confirm." },
  { key: "weakSignals", heading: "Not sure yet", empty: "Nothing it is unsure about." },
  { key: "inconsistent", heading: "Contradicting each other", empty: "No contradictions." },
  { key: "approved", heading: "In use", empty: "Nothing in use yet.", collapsed: true },
  { key: "rejected", heading: "Set aside", empty: "Nothing set aside.", collapsed: true },
];

/** How long a decided card stays as it is before it folds away. */
const HOLD_DECIDED_MS = 400;

function Bucket({ api, listing, bucket }: { api: DuoApiConfig; listing: RuleReviewListing; bucket: (typeof BUCKETS)[number] }) {
  const rules: Rule[] = Array.isArray(listing[bucket.key]) ? listing[bucket.key] : [];
  // A decided rule is seen to be decided, then folds out of the list (motion-plan C2).
  const rows = useLeaving(rules, (rule) => rule.id, HOLD_DECIDED_MS);
  const body =
    rows.length === 0 ? (
      <p className="type-provenance text-[var(--faint)]">{bucket.empty}</p>
    ) : (
      <div className="flex flex-col gap-3">
        {rows.map(({ item: rule, leaving }) => (
          <Collapse key={rule.id} leaving={leaving}>
            <RuleCard api={api} bucket={bucket.key} rule={rule} />
          </Collapse>
        ))}
      </div>
    );
  return bucket.collapsed ? (
    <details className="shape-container flex flex-col gap-2 p-4" data-testid={`bucket-${bucket.key}`}>
      <summary className="cursor-pointer type-heading">
        {bucket.heading} ({rules.length})
      </summary>
      <div className="mt-2">{body}</div>
    </details>
  ) : (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid={`bucket-${bucket.key}`}>
      <h2 className="type-heading">
        {bucket.heading} ({rules.length})
      </h2>
      {body}
    </section>
  );
}

/**
 * duo#275: "pin exact wording — always answer this way." A pinned answer
 * outranks every standing order below, so it reads first in the tab — the
 * owner's own explicit override, not one more derived rule in the pile.
 * Creating one lives on the message itself ("Duo: always answer this way",
 * `Room.tsx`'s own action); this section is where it's reviewed, edited
 * and removed, same as every other rule here.
 */
function PinnedAnswersSection({ api, pinnedAnswers }: { api: DuoApiConfig; pinnedAnswers: PinnedAnswer[] }) {
  const rows = useLeaving(pinnedAnswers, (pinned) => pinned.id, HOLD_DECIDED_MS);
  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid="bucket-pinnedAnswers">
      <h2 className="type-heading">Pinned answers ({pinnedAnswers.length})</h2>
      <p className="type-provenance text-[var(--muted)]">
        Exact wording you've pinned to a question — your duo quotes it word for word, before anything else it knows.
      </p>
      {rows.length === 0 ? (
        <p className="type-provenance text-[var(--faint)]">Nothing pinned yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map(({ item: pinned, leaving }) => (
            <Collapse key={pinned.id} leaving={leaving}>
              <PinnedAnswerCard api={api} pinned={pinned} />
            </Collapse>
          ))}
        </div>
      )}
    </section>
  );
}

const isCandidate = (value: unknown): value is CorrectionCandidate =>
  typeof value === "object" && value !== null && typeof (value as CorrectionCandidate).id === "string" && typeof (value as CorrectionCandidate).sentText === "string";

/**
 * Your standing orders (the profile's Rules tab): what your duo does because
 * you said so — the ones waiting for you first, with the threads each came
 * from, then what it is unsure of, what contradicts itself, what is in use,
 * and what you set aside — plus the edits you made to its drafts that are
 * waiting to be confirmed, and what you told it never to speak for you on.
 * Approve, reject and promote are the daemon's own routes; there is no
 * free-text editing here, because `duo/rules/*.md` on the Mac is the source
 * of truth (AR-18).
 */
export function Rules({ api }: { api: DuoApiConfig }) {
  const rules = useMirrorRules(api);
  const review = useReview(api);
  const pinnedAnswers = useMirrorPinnedAnswers(api);
  const candidatesNow = Array.isArray(review.data) ? review.data.filter(isCandidate) : [];
  const candidates = useLeaving(candidatesNow, (candidate) => candidate.id, HOLD_DECIDED_MS);
  if (rules.isLoading) {
    return <RouteLoading variant="panels" />;
  }
  if (rules.error) {
    return <RouteError api={api} error={rules.error} onRetry={() => void rules.refetch()} />;
  }
  const listing = rules.data;
  return (
    <div className="flex max-w-2xl flex-col gap-5 p-6" data-testid="rules-tab">
      {listing && (
        <p className="type-provenance text-[var(--muted)]" data-testid="rules-counts">
          {listing.approved?.length ?? 0} in use · {listing.awaitingApproval?.length ?? 0} waiting for you · {listing.rejected?.length ?? 0} set aside
        </p>
      )}
      {/* duo#275: the owner's own overrides read first — ahead of standing
          orders and edits, because a pinned answer outranks both. Loads
          independently of `rules` and degrades to nothing rather than
          blocking the rest of the tab on a second request. */}
      {Array.isArray(pinnedAnswers.data?.pinnedAnswers) && <PinnedAnswersSection api={api} pinnedAnswers={pinnedAnswers.data!.pinnedAnswers} />}
      {candidates.length > 0 && (
        <section className="shape-container flex flex-col gap-3 p-4" data-testid="rules-from-edits">
          <h2 className="type-heading">From your edits ({candidates.length})</h2>
          <p className="type-provenance text-[var(--muted)]">What you changed in its drafts. It only learns from one once you say so.</p>
          {candidates.map(({ item: candidate, leaving }) => (
            <Collapse key={candidate.id} leaving={leaving}>
              <CandidateCard api={api} candidate={candidate} />
            </Collapse>
          ))}
        </section>
      )}
      {listing && BUCKETS.map((bucket) => <Bucket api={api} bucket={bucket} key={bucket.key} listing={listing} />)}
      {/* #269: never-answer rules are limits, not standing orders — they live with the other limits now. */}
      <p className="type-provenance text-[var(--faint)]" data-testid="rules-never-answer-pointer">
        What your duo must never answer, and the classification it may draw on, are in <a className="underline" href="#duo/profile/may">May do</a>.
      </p>
    </div>
  );
}
