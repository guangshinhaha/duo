import type { DuoApiConfig } from "../api/client.js";
import { useDecideCandidate } from "../api/queries.js";
import type { CorrectionCandidate } from "../api/types.js";
import { DuoMessage } from "../components/DuoMessage.js";
import { EditDiff } from "../components/EditDiff.js";
import { MutationError } from "../components/MutationError.js";
import { OwnerMessage } from "../components/OwnerMessage.js";
import { Timestamp } from "../components/Timestamp.js";
import { useSyncStatus } from "../sync.js";

/**
 * #44: one correction candidate — the record of an edit, waiting for its
 * verdict. What the candidate IS, is the difference between what the duo
 * drafted and what was actually sent, so that difference is the body: the
 * same diff grammar the edit itself used (#23), the duo's original struck
 * and the owner's replacement marked, reading in place inside the duo's
 * labelled bubble. The verdict (Approve / Reject) is the only control —
 * editing a candidate's text is out of scope by design: the candidate is
 * evidence of a correction that already happened, not a draft to rewrite.
 */
export function CandidateCard({ api, candidate }: { api: DuoApiConfig; candidate: CorrectionCandidate }) {
  const decide = useDecideCandidate(api);
  // AR-15 (§3.3): unreachable daemon means the controls are disabled, never
  // queued — a verdict firing hours later against a queue that moved on is
  // worse than a button that waits.
  const { reachable } = useSyncStatus();
  // Once the daemon has taken the verdict the card says so and settles back (docs/motion-plan.md C2).
  const decided = decide.isSuccess
    ? decide.variables.action === "approve"
      ? "Approved. Your duo will learn from this edit."
      : "Rejected. It won't learn from this edit."
    : null;

  return (
    <div className={`flex flex-row gap-3 shape-entry p-4 motion-settle ${decided !== null ? "is-decided" : ""}`} data-testid="candidate">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {/* The kind is the daemon's own string, verbatim — style and
            substance mean different things downstream (a voice correction
            vs a rule), and this client re-words neither. */}
        <div className="flex items-baseline gap-2 type-provenance text-[var(--faint)]">
          <span data-testid="candidate-kind">{candidate.kind}</span>
          <span>correction</span>
          <Timestamp iso={candidate.createdAt} />
        </div>
        <OwnerMessage>{candidate.question}</OwnerMessage>
        <DuoMessage>
          <EditDiff original={candidate.draftText} edited={candidate.sentText} />
        </DuoMessage>
        {decided !== null && (
          <p className="motion-rise type-provenance text-[var(--muted)]" data-testid="candidate-decided" role="status">
            {decided}
          </p>
        )}
        {decided === null && (
        <div className="flex gap-2">
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
            disabled={decide.isPending || !reachable}
            onClick={() => decide.mutate({ candidateId: candidate.id, action: "approve" })}
          >
            Approve
          </button>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)] disabled:opacity-40"
            disabled={decide.isPending || !reachable}
            onClick={() => decide.mutate({ candidateId: candidate.id, action: "reject" })}
          >
            Reject
          </button>
        </div>
        )}
        <MutationError error={decide.error} />
      </div>
    </div>
  );
}
