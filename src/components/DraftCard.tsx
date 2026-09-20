import { useState } from "react";
import type { DraftRecord } from "../api/types.js";
import { useAnswerEscalation, useRecordOutcome } from "../api/queries.js";
import type { DuoApiConfig } from "../api/client.js";
import { DuoMessage } from "./DuoMessage.js";
import { OwnerMessage } from "./OwnerMessage.js";
import { ConfidenceHairline } from "./ConfidenceHairline.js";
import { EditDiff } from "./EditDiff.js";
import { MutationError } from "./MutationError.js";
import { SourceList } from "./SourceList.js";
import { useSyncStatus } from "../sync.js";
import type { DraftPipelineResult } from "../api/types.js";

/**
 * Adapts a `DraftRecord` (the list shape) into the discriminated union
 * `ConfidenceHairline` expects — a draft record is always one or the
 * other by construction (`draftText === null` iff escalated), so this
 * narrowing can't fail on real data. Uses `draft.refused` and
 * `draft.escalationThreshold` directly rather than guessing at either:
 * an earlier version pattern-matched `refused` out of `escalationReason`'s
 * human-readable text and hardcoded the threshold, both of which drift
 * the moment the server-side wording or a configured threshold changes.
 * Exported because the Duo thread view renders the same hairline per
 * entry (`src/routes/Duo.tsx`) — one adapter, no second copy to drift.
 */
export function toDraftPipelineResult(draft: DraftRecord): DraftPipelineResult {
  if (draft.escalated) {
    return {
      kind: "escalation",
      draftId: draft.id,
      reason: draft.escalationReason ?? "",
      refused: draft.refused,
      confidence: undefined,
    };
  }
  return {
    kind: "draft",
    draftId: draft.id,
    text: draft.draftText ?? "",
    sources: draft.sources,
    confidence: { score: draft.confidenceScore, passesThreshold: true, threshold: draft.escalationThreshold },
  };
}

/**
 * One item in the Review surface (`client-tech-design.md` §1.5 /
 * client-design.md §1.5): the question, the duo's draft or escalation,
 * the provenance rail, and Send / Edit / Ignore — the correction loop's
 * only input, so this is the component the whole product exists to serve.
 */
export function DraftCard({ api, draft }: { api: DuoApiConfig; draft: DraftRecord }) {
  const recordOutcome = useRecordOutcome(api);
  const answerEscalation = useAnswerEscalation(api);
  // AR-15 (§3.3): when the daemon is unreachable every mutation control is
  // disabled, not queued — a Send firing hours later against moved context
  // is worse than no Send. Editing the text stays possible (a local buffer);
  // only the *sending* of anything waits for the daemon to answer again.
  const { reachable } = useSyncStatus();
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(draft.draftText ?? "");
  const [answerText, setAnswerText] = useState("");
  const result = toDraftPipelineResult(draft);
  // #23: "nothing changed is nothing changed" — an edit that leaves the
  // duo's text as it was (whitespace included, since the send trims it) is
  // a plain Send. Posting "edited" with identical text would manufacture a
  // correction candidate out of a correction that never happened.
  const editChanged = editedText.trim() !== (draft.draftText ?? "").trim();

  if (draft.escalated) {
    return (
      // flex-row so the hairline can lead the card (#32: Part 4's leading
      // edge), with the card's own stack inside the column beside it.
      <div className="flex flex-row gap-3 rounded-[var(--r-lg)] border border-[var(--edge)] p-4" data-testid="draft-card">
        <ConfidenceHairline result={result} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <OwnerMessage>{draft.question}</OwnerMessage>
          <div className="rounded-[var(--r-lg)] border border-dashed border-[var(--edge)] px-4 py-3 text-[var(--muted)]" data-testid="escalation-reason">
            {draft.escalationReason}
          </div>
          <SourceList sources={draft.sources} />
          {!draft.refused &&
            (answerEscalation.isSuccess ? (
              <p className="text-xs text-[var(--confident)]" data-testid="answer-confirmation">
                Queued as a standing-order candidate.
              </p>
            ) : (
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-1 text-[var(--text)]"
                  placeholder="Answer it yourself — becomes a standing-order candidate"
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                />
                <button
                  className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1 text-[var(--bg)] disabled:opacity-40"
                  disabled={!answerText.trim() || answerEscalation.isPending || !reachable}
                  onClick={() => answerEscalation.mutate({ draftId: draft.id, answer: answerText.trim() })}
                >
                  Answer
                </button>
              </div>
            ))}
          <MutationError error={answerEscalation.error} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-row gap-3 rounded-[var(--r-lg)] border border-[var(--edge)] p-4" data-testid="draft-card">
      <ConfidenceHairline result={result} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <OwnerMessage>{draft.question}</OwnerMessage>
        <DuoMessage>
          {editing ? (
            <div className="flex w-full flex-col gap-2">
              {/* #23: the change itself, live — the duo's original with the
                  owner's removals struck and additions marked, not just a
                  textarea that hides what the correction loop feeds on. */}
              <EditDiff original={draft.draftText ?? ""} edited={editedText} />
              <textarea
                className="w-full rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] p-2 text-[var(--text)]"
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                rows={4}
              />
            </div>
          ) : (
            draft.draftText
          )}
        </DuoMessage>
        <SourceList sources={draft.sources} />
        <div className="flex gap-2">
          {editing ? (
            <>
              <button
                className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1 text-[var(--bg)] disabled:opacity-40"
                disabled={!editedText.trim() || recordOutcome.isPending || !reachable}
                onClick={() =>
                  editChanged
                    ? recordOutcome.mutate({ draftId: draft.id, outcome: "edited", sentText: editedText.trim() })
                    : recordOutcome.mutate({ draftId: draft.id, outcome: "sent" })
                }
              >
                {/* The label tells the truth the payload encodes: a change
                    sends an edit, anything else is just a Send. */}
                {editChanged ? "Send edited" : "Send"}
              </button>
              <button
                className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1"
                onClick={() => {
                  // Discards the edit, not just the editing view — without
                  // resetting editedText, the abandoned text would silently
                  // reappear the next time Edit is clicked on this card.
                  setEditedText(draft.draftText ?? "");
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1 text-[var(--bg)] disabled:opacity-40"
                disabled={recordOutcome.isPending || !reachable}
                onClick={() => recordOutcome.mutate({ draftId: draft.id, outcome: "sent" })}
              >
                Send
              </button>
              <button className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button
                className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-[var(--muted)] disabled:opacity-40"
                disabled={recordOutcome.isPending || !reachable}
                onClick={() => recordOutcome.mutate({ draftId: draft.id, outcome: "discarded" })}
              >
                Ignore
              </button>
            </>
          )}
        </div>
        <MutationError error={recordOutcome.error} />
      </div>
    </div>
  );
}
