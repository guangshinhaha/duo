import type { Rule } from "../api/types.js";
import type { DuoApiConfig } from "../api/client.js";
import { useRuleAction } from "../api/queries.js";
import { DuoMessage } from "./DuoMessage.js";
import { MutationError } from "./MutationError.js";
import { MeterBar } from "./MeterBar.js";
import { useSyncStatus } from "../sync.js";

/** Which `RuleReviewListing` bucket a rule came from — fixes the action set and the section it renders under. */
export type RuleBucket = "awaitingApproval" | "weakSignals" | "inconsistent" | "approved" | "rejected";

type RuleAction = "approve" | "reject" | "promote";

/**
 * The action set per bucket, transcribed from the daemon's own preconditions
 * (`digital-duo` `src/derivation/rule-review.ts`): approve requires derivation
 * status `confirmed`, promote requires `weak_signal`, reject works on
 * anything. Deriving the buttons from the same preconditions the core enforces
 * means the UI can never offer an action the daemon would refuse — the
 * client-side face of "a surface must not add a behaviour".
 */
const ACTIONS: Record<RuleBucket, readonly RuleAction[]> = {
  awaitingApproval: ["approve", "reject"],
  weakSignals: ["promote", "reject"],
  inconsistent: ["reject"],
  approved: [],
  rejected: [],
};

const ACTION_LABELS: Record<RuleAction, string> = {
  approve: "Approve",
  reject: "Reject",
  promote: "Promote",
};

/**
 * One derived rule and its disposition buttons. AR-18: read and disposition
 * only — there is no free-text editing here, because `duo/rules/*.md` on the
 * Mac is the source of truth and a client-side edit is a projection edit the
 * next sync would discard. The rule text is duo-derived output, so it renders
 * inside `<DuoMessage>` — labelled, never styled as the owner's own words.
 */
export function RuleCard({ api, rule, bucket }: { api: DuoApiConfig; rule: Rule; bucket: RuleBucket }) {
  const ruleAction = useRuleAction(api);
  const actions = ACTIONS[bucket];
  // AR-15, same as DraftCard: disposition waits for the daemon to answer —
  // a queued Approve firing against rules that moved is worse than none.
  const { reachable } = useSyncStatus();

  return (
    <div className="flex flex-col gap-2 rounded-[var(--r-lg)] border border-[var(--edge)] p-4" data-testid="rule-card">
      <DuoMessage>{rule.text}</DuoMessage>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--muted)]" data-testid="rule-meta">
        <span>{rule.origin === "owner_asserted" ? "you asserted" : "derived"}</span>
        <span>
          observed {rule.supportCount} time{rule.supportCount === 1 ? "" : "s"}
        </span>
        <span className="flex w-24 items-center gap-2">
          consistency
          <MeterBar value={rule.consistency} testId="rule-consistency" />
        </span>
        {rule.lastConfirmedAt && <span>last confirmed {new Date(rule.lastConfirmedAt).toLocaleDateString()}</span>}
      </div>
      {actions.length > 0 && (
        <div className="flex gap-2">
          {actions.map((action) => (
            <button
              key={action}
              data-testid={`${action}-rule`}
              className={
                action === "reject"
                  ? "rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-[var(--muted)] disabled:opacity-40"
                  : "rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1 text-white disabled:opacity-40"
              }
              disabled={ruleAction.isPending || !reachable}
              onClick={() => ruleAction.mutate({ ruleId: rule.id, action })}
            >
              {ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      )}
      <MutationError error={ruleAction.error} />
    </div>
  );
}
