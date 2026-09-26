import type { DuoApiConfig } from "../api/client.js";
import { useMirrorPortrait, useMirrorRefusals, useMirrorRules } from "../api/queries.js";
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
      <p className="type-provenance text-[var(--faint)]">{bucket.empty}</p>
    ) : (
      <div className="flex flex-col gap-3">
        {rules.map((rule) => (
          <RuleCard key={rule.id} api={api} rule={rule} bucket={bucket.key} />
        ))}
      </div>
    );

  if (bucket.collapsible) {
    return (
      <details className="shape-container flex flex-col gap-2 p-4" data-testid={`bucket-${bucket.key}`}>
        <summary className="cursor-pointer type-heading">
          {bucket.heading} ({rules.length})
        </summary>
        <div className="mt-2 flex flex-col gap-2">{body}</div>
      </details>
    );
  }

  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid={`bucket-${bucket.key}`}>
      {/* #39: h2, not h3 — a bucket sits directly under the page's h1,
          and skipping a level is a heading-order break. */}
      <h2 className="type-heading">
        {bucket.heading} ({rules.length})
      </h2>
      {body}
    </section>
  );
}

/**
 * What the owner has told the duo it must never speak for them on, and the
 * reason they gave (#53) — `GET /mirror/refusals`, `duo/refusals.md` verbatim.
 * The daemon's `decided` flag is what tells "never asked" from "asked, and
 * the owner recorded none": an empty list alone cannot. Recording a refusal
 * stays at the terminal (AR-18), so the empty states point there rather than
 * offering a control the daemon has no route for.
 */
function RefusalsSection({ api }: { api: DuoApiConfig }) {
  const refusals = useMirrorRefusals(api);

  let body: React.ReactNode = null;
  if (refusals.isLoading) {
    body = <div className="text-[var(--muted)]">Loading refusals…</div>;
  } else if (refusals.error) {
    body = <div className="text-[var(--refused)]">{(refusals.error as Error).message}</div>;
  } else if (refusals.data) {
    const { decided, refusals: list } = refusals.data;
    if (!decided) {
      body = (
        <p className="type-provenance text-[var(--faint)]" data-testid="refusals-undecided">
          What your duo must refuse hasn&apos;t been asked yet. Record refusals in the terminal on your Mac — duo mirror refusals add, or
          duo mirror refusals confirm-none.
        </p>
      );
    } else if (list.length === 0) {
      body = (
        <p className="type-provenance text-[var(--faint)]" data-testid="refusals-none">
          You reviewed this and recorded none — your duo has no standing refusals.
        </p>
      );
    } else {
      body = (
        <div className="flex flex-col gap-3">
          {list.map((refusal) => (
            <div key={refusal.heading} className="flex flex-col gap-1 shape-entry p-4" data-testid="refusal">
              <h3 className="type-heading" data-testid="refusal-heading">
                {refusal.heading}
              </h3>
              {refusal.reason.length > 0 ? (
                <p className="type-body whitespace-pre-wrap text-[var(--muted)]" data-testid="refusal-reason">
                  {refusal.reason}
                </p>
              ) : (
                <p className="type-provenance text-[var(--faint)]">No reason written.</p>
              )}
            </div>
          ))}
        </div>
      );
    }
  }

  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid="refusals">
      <h2 className="type-heading">Refusals{refusals.data && refusals.data.decided ? ` (${refusals.data.refusals.length})` : ""}</h2>
      {body}
    </section>
  );
}

/**
 * The Mirror browser (`client-tech-design.md` §1.4 / tech-design §3.1,
 * build step C6): what the duo has derived about its owner, and the owner's
 * say over it — the portrait, rules to approve / reject / promote (each
 * opening onto the evidence behind it, #53), and the refusals the owner
 * wrote. Deliberately no authoring (AR-18) — rule and refusal writing stay
 * where the files are, in `duo/` on the Mac.
 */
export function Mirror({ api }: { api: DuoApiConfig }) {
  const portrait = useMirrorPortrait(api);
  const rules = useMirrorRules(api);

  return (
    <div className="flex flex-col gap-6 p-6" data-testid="mirror">
      <header className="flex flex-col gap-1">
        <h1 className="type-heading">Mirror</h1>
        <p className="type-provenance text-[var(--muted)]">
          What the duo has derived about how you work, and what you told it to refuse. Read it, disposition it — rule and refusal writing
          stay in duo/ on your Mac.
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

      <RefusalsSection api={api} />
    </div>
  );
}
