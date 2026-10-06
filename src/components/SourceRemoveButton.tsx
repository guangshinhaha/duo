import type { DuoApiConfig } from "../api/client.js";
import { useExcludeEvidence, useRuleAction } from "../api/queries.js";
import type { DraftSource } from "../api/types.js";
import { MutationError } from "./MutationError.js";

/**
 * duo#272 (digital-duo#288): the inline Remove beside one source a draft or
 * sent answer used — wherever `SourceList` or `WhyPanel` render one. A
 * `"rule"` source is rejected through the same `POST /mirror/rules/:id/reject`
 * the Rules tab's own Reject button calls (`useRuleAction`); an `"evidence"`
 * source is excluded through the daemon's `POST
 * /knowledge/evidence/:recordId/exclude` (`useExcludeEvidence`). Either way
 * the removal only ever stops the item being cited in a FUTURE draft — this
 * is a historical record of what WAS used, so the row stays and only its
 * action settles into a plain confirmation, never a disappearing item.
 * Reversing the decision lives in Rules ("Set aside") and the Knows tab's
 * "Removed from citation" — AC3's "visible and reversible" is those two
 * tabs, not a second undo bolted onto every draft that ever cited it.
 *
 * Renders nothing for an `"attachment"` source: it names no persisted rule
 * or record this route can act on.
 */
export function SourceRemoveButton({ api, source }: { api: DuoApiConfig; source: DraftSource }) {
  const ruleAction = useRuleAction(api);
  const excludeEvidence = useExcludeEvidence(api);
  if (source.kind === "attachment") {
    return null;
  }
  const isRule = source.kind === "rule";
  const pending = isRule ? ruleAction.isPending : excludeEvidence.isPending;
  const done = isRule ? ruleAction.isSuccess : excludeEvidence.isSuccess;
  const error = isRule ? ruleAction.error : excludeEvidence.error;

  if (done) {
    return (
      <span className="shrink-0 type-provenance text-[var(--muted)]" data-testid="source-removed">
        Removed. Won't be used again.
      </span>
    );
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <button
        className="min-h-9 type-provenance text-[var(--muted)] underline disabled:opacity-40"
        data-testid="source-remove"
        disabled={pending}
        onClick={() => (isRule ? ruleAction.mutate({ ruleId: source.id, action: "reject" }) : excludeEvidence.mutate({ recordId: source.id }))}
        type="button"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      <MutationError error={error} />
    </span>
  );
}
