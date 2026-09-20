import type { DuoApiConfig } from "../api/client.js";
import { useDecideCandidate, useReview } from "../api/queries.js";
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
function CandidateCard({ api, candidate }: { api: DuoApiConfig; candidate: CorrectionCandidate }) {
  const decide = useDecideCandidate(api);
  // AR-15 (§3.3): unreachable daemon means the controls are disabled, never
  // queued — a verdict firing hours later against a queue that moved on is
  // worse than a button that waits.
  const { reachable } = useSyncStatus();

  return (
    <div className="flex flex-row gap-3 rounded-[var(--r-lg)] border border-[var(--edge)] p-4" data-testid="candidate">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {/* The kind is the daemon's own string, verbatim — style and
            substance mean different things downstream (a voice correction
            vs a rule), and this client re-words neither. */}
        <div className="flex items-baseline gap-2 text-xs text-[var(--faint)]">
          <span data-testid="candidate-kind">{candidate.kind}</span>
          <span>correction</span>
          <Timestamp iso={candidate.createdAt} />
        </div>
        <OwnerMessage>{candidate.question}</OwnerMessage>
        <DuoMessage>
          <EditDiff original={candidate.draftText} edited={candidate.sentText} />
        </DuoMessage>
        <div className="flex gap-2">
          <button
            className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1 text-[var(--bg)] disabled:opacity-40"
            disabled={decide.isPending || !reachable}
            onClick={() => decide.mutate({ candidateId: candidate.id, action: "approve" })}
          >
            Approve
          </button>
          <button
            className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-[var(--muted)] disabled:opacity-40"
            disabled={decide.isPending || !reachable}
            onClick={() => decide.mutate({ candidateId: candidate.id, action: "reject" })}
          >
            Reject
          </button>
        </div>
        <MutationError error={decide.error} />
      </div>
    </div>
  );
}

/**
 * The correction queue (#44) — AR-14's second half. Review gave the draft
 * loop its own surface because "the draft loop drowns in a chat
 * transcript"; the training signal drowns the same way, so confirming it
 * gets a screen of its own beside Review, not a section under something
 * else. This is where "the thing my duo learns from me is something I
 * actually confirmed" happens: nothing here auto-writes (the daemon's
 * `corrections/queue.ts` never does), every learning is one explicit
 * Approve away.
 */
export function Corrections({ api }: { api: DuoApiConfig }) {
  const { data: candidates, isLoading, error } = useReview(api);

  if (isLoading) {
    return <div className="p-6 text-[var(--muted)]">Loading…</div>;
  }
  if (error) {
    return <div className="p-6 text-[var(--refused)]">{(error as Error).message}</div>;
  }
  if (!candidates || candidates.length === 0) {
    return (
      <div className="p-6 text-[var(--muted)]" data-testid="corrections-empty">
        Nothing to confirm yet. Editing a draft before you send it is what puts a correction here.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6" data-testid="corrections-list">
      {candidates.map((candidate) => (
        <CandidateCard key={candidate.id} api={api} candidate={candidate} />
      ))}
    </div>
  );
}
