import type { DuoApiConfig } from "../api/client.js";
import { useMirrorRules, useReview } from "../api/queries.js";
import type { CorrectionCandidate, Rule, RuleReviewListing } from "../api/types.js";
import { Collapse, useLeaving } from "../components/Collapse.js";
import { RuleCard, type RuleBucket } from "../components/RuleCard.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { CandidateCard } from "./CandidateCard.js";
import { RefusalsSection } from "./Refusals.js";

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
      <RefusalsSection api={api} />
    </div>
  );
}
