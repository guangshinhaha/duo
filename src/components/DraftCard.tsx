import { useState } from "react";
import type { DraftRecord } from "../api/types.js";
import type { DuoApiConfig } from "../api/client.js";
import { DuoMessage } from "./DuoMessage.js";
import { OwnerMessage } from "./OwnerMessage.js";
import { ConfidenceHairline } from "./ConfidenceHairline.js";
import { DeliveryStateLine } from "./DeliveryStateLine.js";
import { EditDiff } from "./EditDiff.js";
import { MutationError } from "./MutationError.js";
import { ProvenanceLine } from "./ProvenanceLine.js";
import { SendLaterMenu, SendWindow, scheduledWords } from "./SendControls.js";
import { SourceList } from "./SourceList.js";
import { StructuredText } from "./StructuredText.js";
import { Timestamp } from "./Timestamp.js";
import { useDraftDecision } from "./useDraftDecision.js";
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

// The undo window lives with the decision logic; re-exported for the surfaces and tests that name it here.
export { IGNORE_UNDO_WINDOW_MS } from "./useDraftDecision.js";

/**
 * One item in the Review surface (`client-tech-design.md` §1.5 /
 * client-design.md §1.5): the question, the duo's draft or escalation,
 * the provenance rail, and Send / Edit / Ignore — the correction loop's
 * only input, so this is the component the whole product exists to serve.
 */
export function DraftCard({
  api,
  draft,
  conversationHref,
}: {
  api: DuoApiConfig;
  draft: DraftRecord;
  /** #68: the in-app conversation this draft's message arrived in — passed by a surface showing the card away from it. */
  conversationHref?: string;
}) {
  const {
    recordOutcome,
    answerEscalation,
    reachable,
    selfAsked,
    editing,
    setEditing,
    editedText,
    setEditedText,
    answerText,
    setAnswerText,
    editButtonRef,
    focusEditOnClose,
    editChanged,
    ignoring,
    ignoreWithWindow,
    undoIgnore,
    copyState,
    copyDraft,
    send,
    sendingUntil,
    undoSend,
    scheduleSend,
    sendLater,
  } = useDraftDecision(api, draft);
  const result = toDraftPipelineResult(draft);
  // #261: Send later, for a reply — a self-asked draft's Keep reaches nobody, so there is nothing to time.
  const [laterOpen, setLaterOpen] = useState(false);

  if (draft.escalated) {
    return (
      // flex-row so the hairline can lead the card (#32: Part 4's leading
      // edge), with the card's own stack inside the column beside it.
      <div className="flex flex-row gap-3 shape-entry p-4" data-testid="draft-card">
        <ConfidenceHairline result={result} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <OwnerMessage>{draft.question}</OwnerMessage>
          {/* #20: a channel-borne question carries its asker even when it
              escalated — judging the escalation still means judging who asked. */}
          <ProvenanceLine provenance={draft.provenance} conversationHref={conversationHref} />
          <div className="rounded-[var(--r-md)] border border-dashed border-[var(--edge)] px-4 py-3 type-body text-[var(--muted)]" data-testid="escalation-reason">
            {draft.escalationReason}
          </div>
          <SourceList sources={draft.sources} />
          {!draft.refused &&
            (answerEscalation.isSuccess ? (
              <p className="type-provenance text-[var(--confident)]" data-testid="answer-confirmation">
                Queued as a standing-order candidate.
              </p>
            ) : (
              // AR-18: answering an escalation is free text that authors a
              // standing-order — the one affordance this is. Rule writing
              // stays where the files are: below the desktop width the
              // affordance is simply not offered, and a phone reads the
              // escalation, defers to the Mac, or works the queues.
              <>
          <div className="hidden gap-2 md:flex">
                <input
                  aria-label="Answer it yourself"
                  className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
                  placeholder="Answer it yourself"
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                />
                <button
                  className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
                  disabled={!answerText.trim() || answerEscalation.isPending || !reachable}
                  onClick={() => answerEscalation.mutate({ draftId: draft.id, answer: answerText.trim() })}
                >
                  Answer
                </button>
              </div>
          <p className="hidden type-provenance text-[var(--faint)] md:block" data-testid="answer-hint">
            Your answer is saved as a standing order for you to approve.
          </p>
          </>
            ))}
          <MutationError error={answerEscalation.error} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-row gap-3 shape-entry p-4" data-testid="draft-card">
      <ConfidenceHairline result={result} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <OwnerMessage>{draft.question}</OwnerMessage>
        {/* #20: who asked, when the asker was a channel rather than you. */}
        <ProvenanceLine provenance={draft.provenance} conversationHref={conversationHref} />
        <DuoMessage>
          {editing ? (
            <div className="flex w-full flex-col gap-2">
              {/* #23: the change itself, live — the duo's original with the
                  owner's removals struck and additions marked, not just a
                  textarea that hides what the correction loop feeds on. */}
              <EditDiff original={draft.draftText ?? ""} edited={editedText} />
              <textarea
                className="min-h-11 w-full rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] p-2 text-[var(--text)]"
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                onKeyDown={(e) => {
                  // #36: Escape is Cancel — the same discard the button
                  // makes and nothing more, with focus returned to the
                  // control that opened the editor.
                  if (e.key === "Escape") {
                    focusEditOnClose.current = true;
                    setEditedText(draft.draftText ?? "");
                    setEditing(false);
                  }
                }}
                rows={4}
              />
            </div>
          ) : (
            <StructuredText text={draft.draftText ?? ""} />
          )}
        </DuoMessage>
        <div className="type-provenance text-[var(--faint)]">
          <Timestamp iso={draft.createdAt} />
        </div>
        {/* #21: the single-draft address renders cards Review has passed by —
            a sent draft's delivery state reads here too. Escalations never
            deliver, so the escalated branch has no line to show. */}
        <DeliveryStateLine delivery={draft.delivery} />
        <SourceList sources={draft.sources} />
        {sendingUntil !== null ? (
          // #260: the held Send — nothing posted until the countdown ends.
          <SendWindow onUndo={undoSend} until={sendingUntil} />
        ) : scheduleSend.isSuccess ? (
          <p className="type-provenance text-[var(--muted)]" data-testid="scheduled-confirmation">
            {scheduledWords(scheduleSend.data.sendAt)} Your duo sends it then, even if this app is closed.
          </p>
        ) : ignoring ? (
          // #24: the undo window. The discard has NOT been sent — the card
          // says so, because the difference between "held" and "sent" is
          // the whole point of the window. For a self-asked draft (#30)
          // nothing was ever being sent anywhere; "final" is the word
          // that carries the same warning.
          <div className="flex items-center gap-2" data-testid="ignore-window">
            <span className="type-provenance text-[var(--muted)]">{selfAsked ? "Dismissing — not final yet." : "Dismissing — not sent yet."}</span>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
              onClick={undoIgnore}
            >
              Undo
            </button>
          </div>
        ) : (
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
                disabled={!editedText.trim() || recordOutcome.isPending || !reachable}
                onClick={() => (editChanged ? send({ draftId: draft.id, outcome: "edited", sentText: editedText.trim() }) : send({ draftId: draft.id, outcome: "sent" }))}
              >
                {/* The label tells the truth the payload encodes: a change
                    sends an edit, anything else is just a Send — and for a
                    self-asked draft, both are Keeps (#30): the answer
                    stands as yours, nobody receives it. */}
                {editChanged ? (selfAsked ? "Keep edited" : "Send edited") : selfAsked ? "Keep" : "Send"}
              </button>
              {!selfAsked && (
                <SendLaterMenu
                  api={api}
                  disabled={!editedText.trim() || recordOutcome.isPending || scheduleSend.isPending || !reachable}
                  onOpenChange={setLaterOpen}
                  onPick={sendLater}
                  open={laterOpen}
                />
              )}
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
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
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
                disabled={recordOutcome.isPending || !reachable}
                onClick={() => send({ draftId: draft.id, outcome: "sent" })}
              >
                {selfAsked ? "Keep" : "Send"}
              </button>
              {!selfAsked && (
                <SendLaterMenu
                  api={api}
                  disabled={recordOutcome.isPending || scheduleSend.isPending || !reachable}
                  onOpenChange={setLaterOpen}
                  onPick={sendLater}
                  open={laterOpen}
                />
              )}
              <button
                ref={editButtonRef}
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)] disabled:opacity-40"
                disabled={recordOutcome.isPending || !reachable}
                onClick={ignoreWithWindow}
              >
                Dismiss
              </button>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
                data-testid="copy-draft"
                onClick={() => void copyDraft()}
              >
                {copyState === "idle" ? "Copy" : copyState === "copied" ? "Copied." : "Couldn't copy."}
              </button>
            </>
          )}
        </div>
        )}
        <MutationError error={recordOutcome.error} />
        <MutationError error={scheduleSend.error} />
      </div>
    </div>
  );
}
