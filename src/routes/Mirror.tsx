import type { DuoApiConfig } from "../api/client.js";
import { useMirrorPortrait, useMirrorRules } from "../api/queries.js";
import { InterruptionPortraitView } from "../components/InterruptionPortraitView.js";
import { RuleCard, type RuleBucket } from "../components/RuleCard.js";
import type { Rule, RuleReviewListing } from "../api/types.js";

/**
 * The bucket order the Mirror shows: what needs a decision first, history
 * last. `approved`/`rejected` render collapsed — they are the record, not the
 * work, and AR-19's "a sleek shell around four rules reads as a demo" cuts
 * both ways: the history should be reachable, not loud.
 */
const BUCKETS: ReadonlyArray<{ key: RuleBucket; heading: string; empty: string; collapsible?: boolean }> = [
  { key: "awaitingApproval", heading: "Awaiting your approval", empty: "No rules waiting on you." },
  { key: "weakSignals", heading: "Weak signals", empty: "No weak signals yet." },
  { key: "inconsistent", heading: "Inconsistent", empty: "No inconsistent rules." },
  { key: "approved", heading: "Approved", empty: "Nothing approved yet.", collapsible: true },
  { key: "rejected", heading: "Rejected", empty: "Nothing rejected.", collapsible: true },
];

function RuleBucketSection({ api, listing, bucket }: { api: DuoApiConfig; listing: RuleReviewListing; bucket: (typeof BUCKETS)[number] }) {
  const rules: Rule[] = listing[bucket.key];
  const body =
    rules.length === 0 ? (
      <p className="text-xs text-[var(--faint)]">{bucket.empty}</p>
    ) : (
      <div className="flex flex-col gap-3">
        {rules.map((rule) => (
          <RuleCard key={rule.id} api={api} rule={rule} bucket={bucket.key} />
        ))}
      </div>
    );

  if (bucket.collapsible) {
    return (
      <details className="flex flex-col gap-2" data-testid={`bucket-${bucket.key}`}>
        <summary className="cursor-pointer text-sm font-medium">
          {bucket.heading} ({rules.length})
        </summary>
        <div className="mt-2 flex flex-col gap-2">{body}</div>
      </details>
    );
  }

  return (
    <section className="flex flex-col gap-2" data-testid={`bucket-${bucket.key}`}>
      <h3 className="text-sm font-medium">
        {bucket.heading} ({rules.length})
      </h3>
      {body}
    </section>
  );
}

/**
 * The Mirror browser (`client-tech-design.md` §1.4 / tech-design §3.1,
 * build step C6): what the duo has derived about its owner, and the owner's
 * say over it — the portrait, and rules to approve / reject / promote.
 * Deliberately no refusals tab yet: no daemon route lists them, and a surface
 * must not add a behaviour. Equally deliberately no authoring (AR-18) — rule
 * writing stays where the files are, in `duo/rules/*.md` on the Mac.
 */
export function Mirror({ api }: { api: DuoApiConfig }) {
  const portrait = useMirrorPortrait(api);
  const rules = useMirrorRules(api);

  return (
    <div className="flex flex-col gap-6 p-6" data-testid="mirror">
      <header className="flex flex-col gap-1">
        <h1 className="text-base font-medium">Mirror</h1>
        <p className="text-xs text-[var(--muted)]">
          What the duo has derived about how you work. Read it, disposition it — rule writing stays in duo/rules/*.md on your Mac.
        </p>
      </header>

      {portrait.isLoading && <div className="text-[var(--muted)]">Loading portrait…</div>}
      {portrait.error && <div className="text-[var(--refused)]">{(portrait.error as Error).message}</div>}
      {portrait.data && <InterruptionPortraitView portrait={portrait.data} />}

      {rules.isLoading && <div className="text-[var(--muted)]">Loading rules…</div>}
      {rules.error && <div className="text-[var(--refused)]">{(rules.error as Error).message}</div>}
      {rules.data && (
        <div className="flex flex-col gap-5">
          {BUCKETS.map((bucket) => (
            <RuleBucketSection key={bucket.key} api={api} listing={rules.data} bucket={bucket} />
          ))}
        </div>
      )}
    </div>
  );
}
