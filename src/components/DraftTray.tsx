import { useEffect } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { DISMISS_REASONS, type DismissReason, type DraftRecord } from "../api/types.js";
import { useArrival } from "../arrivals.js";
import { toDraftPipelineResult } from "./DraftCard.js";
import { hairlineState, type HairlineState } from "./ConfidenceHairline.js";
import { DuoLine } from "./DuoLine.js";
import { EditDiff } from "./EditDiff.js";
import { MutationError } from "./MutationError.js";
import { StructuredText } from "./StructuredText.js";
import { Timestamp } from "./Timestamp.js";
import { useDraftDecision } from "./useDraftDecision.js";
import { WhyButton } from "./WhyButton.js";

/** What the attribution line says the draft is doing, in the vocabulary's words. */
function stateWords(state: HairlineState): string {
  switch (state) {
    case "confident":
      return "draft";
    case "hedged":
      return "draft · hedging";
    case "escalated":
      return "passed to you";
    case "refused":
      return "refused";
  }
}

/** guangshinhaha/duo#259: what each dismiss reason chip says, in the owner's own words — the daemon's wire value is a slug, not copy. */
const DISMISS_REASON_WORDS: Record<DismissReason, string> = {
  wrong_facts: "Wrong facts",
  wrong_tone: "Wrong tone",
  shouldnt_answer: "Shouldn't answer this",
  will_handle_myself: "I'll handle it myself",
};

function isInteractive(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  return !!el && typeof el.closest === "function" && !!el.closest("input, textarea, select, button, a, [contenteditable=''], [contenteditable='true'], [role='dialog']");
}

/**
 * Your duo's draft, in the chat it answers (#182, #183; docs/design-language.md,
 * the unsent-draft decision #181). It sits at the end of the owner's own view
 * of the transcript, on the owner's side, visibly unsent: behind the duo's
 * line (AR-13), dashed while it is a reply nobody has received, saying only
 * you can see it — and nothing reaches the conversation until Send, when the
 * daemon delivers it and the owner's real message arrives in its place.
 * Same decision logic as ever (`useDraftDecision`): Send waits for the daemon
 * rather than queueing (AR-15), an edit that changes nothing is a plain
 * Send, Dismiss is held for the undo window, and answering a passed-on
 * question is a standing-order candidate. In Your duo (a question you asked
 * yourself) it is an answer, not an outgoing message: no dashes, and Keep.
 *
 * Why? opens beside it, only when asked (#185). A passed-on question or a
 * refusal says what happened in plain words; the daemon's own reasoning is
 * behind Why?.
 *
 * `keyboard` makes it answer to ⏎ (send), E (edit) and X (dismiss) when
 * nothing editable has focus — only ever the oldest draft in a chat.
 */
export function DraftTray({
  api,
  draft,
  keyboard = false,
}: {
  api: DuoApiConfig;
  draft: DraftRecord;
  keyboard?: boolean;
}) {
  const d = useDraftDecision(api, draft);
  const arrived = useArrival(draft.id);
  const state = hairlineState(toDraftPipelineResult(draft));
  const passedOn = draft.escalated && !draft.refused;
  const rules = draft.sources.filter((source) => source.kind === "rule");
  const others = draft.sources.length - rules.length;

  useEffect(() => {
    if (!keyboard || draft.refused) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || d.editing || d.ignoring) {
        return;
      }
      if (e.key === "Enter" && !passedOn) {
        if (isInteractive(e.target) || !d.reachable || d.recordOutcome.isPending) {
          return;
        }
        e.preventDefault();
        d.recordOutcome.mutate({ draftId: draft.id, outcome: "sent" });
        return;
      }
      if (isInteractive(e.target)) {
        return;
      }
      if (e.key === "e" && !passedOn) {
        e.preventDefault();
        d.setEditing(true);
      } else if (e.key === "x" && !passedOn && d.reachable && !d.recordOutcome.isPending) {
        e.preventDefault();
        d.ignoreWithWindow();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const words = draft.refused
    ? "This is something you told me not to answer for you."
    : passedOn
      ? "I don't have enough on this to answer it well, so I'm passing it to you."
      : null;
  const unsent = !d.selfAsked && !draft.refused && !passedOn;

  return (
    <section
      aria-label="Your duo's draft"
      className={`flex w-full max-w-[90%] flex-col gap-2 ${d.selfAsked ? "self-start" : "self-end"}`}
      data-testid="draft-tray"
      data-unsent={unsent ? "true" : undefined}
    >
      <div className={unsent ? "rounded-[var(--r-md)] border border-dashed border-[var(--edge)] p-1" : ""}>
      <DuoLine
        arrived={arrived}
        aside={unsent ? "only you can see this · not sent" : "only you can see this"}
        attributionTestId="draft-tray-attribution"
        label="Your duo"
        meta={
          <>
            {stateWords(state)} · <Timestamp iso={draft.createdAt} />
          </>
        }
        state={state}
        testId="draft-tray-line"
      >
        {words !== null ? (
          <p className="type-body" data-testid="draft-tray-words">
            {words}
          </p>
        ) : d.editing ? (
          <div className="flex w-full flex-col gap-2">
            {/* #23: the change itself, live — the duo's original with the owner's removals struck and additions marked. */}
            <EditDiff original={draft.draftText ?? ""} edited={d.editedText} />
            <textarea
              aria-label="Edit your duo's draft"
              className="min-h-11 w-full rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] p-2 text-[var(--text)]"
              // Focus follows the owner's own Edit.
              autoFocus
              onChange={(e) => d.setEditedText(e.target.value)}
              onKeyDown={(e) => {
                // #36: Escape is Cancel, with focus handed back to the Edit that opened it.
                if (e.key === "Escape") {
                  d.focusEditOnClose.current = true;
                  d.setEditedText(draft.draftText ?? "");
                  d.setEditing(false);
                }
              }}
              rows={4}
              value={d.editedText}
            />
          </div>
        ) : (
          <StructuredText text={draft.draftText ?? ""} />
        )}
      </DuoLine>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 type-provenance text-[var(--muted)]" data-testid="draft-tray-why">
        {(rules.length > 0 || others > 0) && (
          <span>
            {rules.length > 0 && <>Standing order: {rules.map((rule) => rule.label).join(" · ")}</>}
            {rules.length > 0 && others > 0 && " · "}
            {others > 0 && <>Drew on {others} source{others === 1 ? "" : "s"}</>}
          </span>
        )}
        <WhyButton draft={draft} />
      </div>

      {!draft.refused && !d.reachable && (
        <p className="type-provenance text-[var(--escalate)]" data-testid="draft-tray-offline" role="status">
          Your duo is unreachable, so nothing can be decided right now.
        </p>
      )}

      {draft.refused ? null : passedOn ? (
        d.answerEscalation.isSuccess ? (
          <p className="type-provenance text-[var(--confident)]" data-testid="answer-confirmation">
            Queued as a standing-order candidate.
          </p>
        ) : (
          // AR-18: answering a passed-on question is free text that authors a standing order — desktop only.
          <>
          <div className="hidden gap-2 md:flex">
            <input
              aria-label="Answer it yourself"
              className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
              onChange={(e) => d.setAnswerText(e.target.value)}
              placeholder="Answer it yourself"
              value={d.answerText}
            />
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
              disabled={!d.answerText.trim() || d.answerEscalation.isPending || !d.reachable}
              onClick={() => d.answerEscalation.mutate({ draftId: draft.id, answer: d.answerText.trim() })}
              type="button"
            >
              Answer it
            </button>
          </div>
          <p className="hidden type-provenance text-[var(--faint)] md:block" data-testid="answer-hint">
            Your answer is saved as a standing order for you to approve.
          </p>
          </>
        )
      ) : d.ignoring ? (
        // #24: the undo window. The dismissal has NOT been recorded — the tray says so, because held vs. sent is the whole point of the window.
        // guangshinhaha/duo#259: the same window also carries an optional,
        // skippable "why" — picking one records it in the same call that
        // settles the dismissal (see useDraftDecision's chooseDismissReason),
        // and ends the window immediately rather than waiting out the rest
        // of it.
        <div className="flex flex-col gap-2" data-testid="ignore-window">
          <div className="flex items-center gap-2">
            <span className="type-provenance text-[var(--muted)]">{d.selfAsked ? "Dismissing — not final yet." : "Dismissing — not sent yet."}</span>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
              onClick={d.undoIgnore}
              type="button"
            >
              Undo
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2" data-testid="dismiss-reason-row">
            <span className="type-provenance text-[var(--faint)]">Why? (optional)</span>
            {DISMISS_REASONS.map((reason) => (
              <button
                className="inline-flex min-h-8 items-center justify-center rounded-full border border-[var(--edge)] px-3 type-provenance text-[var(--muted)]"
                data-testid={`dismiss-reason-${reason}`}
                key={reason}
                onClick={() => d.chooseDismissReason(reason)}
                type="button"
              >
                {DISMISS_REASON_WORDS[reason]}
              </button>
            ))}
          </div>
        </div>
      ) : d.neverAnswerOffer !== "hidden" ? (
        // guangshinhaha/duo#259 → #269 (the trust epic's never-answer rule
        // store, not yet built): an honest offer, not a fabricated one — see
        // requestNeverAnswerRule's own doc comment for why tapping "Add rule"
        // cannot yet say a rule was created.
        <div className="flex flex-wrap items-center gap-2" data-testid="never-answer-offer">
          {d.neverAnswerOffer === "pending" ? (
            <>
              <span className="type-provenance text-[var(--muted)]">Add a never-answer rule for this?</span>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
                data-testid="never-answer-confirm"
                onClick={d.confirmNeverAnswerRule}
                type="button"
              >
                Add rule
              </button>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
                data-testid="never-answer-skip"
                onClick={d.skipNeverAnswerOffer}
                type="button"
              >
                No thanks
              </button>
            </>
          ) : (
            <span className="type-provenance text-[var(--faint)]" data-testid="never-answer-noted">
              Never-answer rules aren&apos;t available yet — this is saved as a signal for when they are.
            </span>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {d.editing ? (
            <>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
                disabled={!d.editedText.trim() || d.recordOutcome.isPending || !d.reachable}
                onClick={() =>
                  d.editChanged
                    ? d.recordOutcome.mutate({ draftId: draft.id, outcome: "edited", sentText: d.editedText.trim() })
                    : d.recordOutcome.mutate({ draftId: draft.id, outcome: "sent" })
                }
                type="button"
              >
                {d.editChanged ? (d.selfAsked ? "Keep edited" : "Send edited") : d.selfAsked ? "Keep" : "Send"}
              </button>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
                onClick={() => {
                  d.setEditedText(draft.draftText ?? "");
                  d.setEditing(false);
                }}
                type="button"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
                disabled={d.recordOutcome.isPending || !d.reachable}
                onClick={() => d.recordOutcome.mutate({ draftId: draft.id, outcome: "sent" })}
                type="button"
              >
                {d.selfAsked ? "Keep" : "Send"}
                {keyboard && <kbd aria-hidden="true" className="hidden type-identifier opacity-70 md:inline">⏎</kbd>}
              </button>
              <button
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
                onClick={() => d.setEditing(true)}
                ref={d.editButtonRef}
                type="button"
              >
                Edit
                {keyboard && <kbd aria-hidden="true" className="hidden type-identifier text-[var(--faint)] md:inline">E</kbd>}
              </button>
              <button
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)] disabled:opacity-40"
                disabled={d.recordOutcome.isPending || !d.reachable}
                onClick={d.ignoreWithWindow}
                type="button"
              >
                Dismiss
                {keyboard && <kbd aria-hidden="true" className="hidden type-identifier text-[var(--faint)] md:inline">X</kbd>}
              </button>
            </>
          )}
        </div>
      )}
      <MutationError error={d.recordOutcome.error} />
      <MutationError error={d.answerEscalation.error} />
    </section>
  );
}
