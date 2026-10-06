import { useEffect, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useShapeDraft, useUndoShape } from "../api/queries.js";
import { DISMISS_REASONS, type DismissReason, type DraftRecord, type SettableDraftOutcome } from "../api/types.js";
import { useArrival } from "../arrivals.js";
import { toDraftPipelineResult } from "./DraftCard.js";
import { hairlineState, type HairlineState } from "./ConfidenceHairline.js";
import { AlternativeStepper, ShapeChips, standingShape, useFlipSwipe } from "./DraftVersions.js";
import { DuoLine } from "./DuoLine.js";
import { EditDiff } from "./EditDiff.js";
import { MutationError } from "./MutationError.js";
import { NeverAnswerOffer } from "./NeverAnswerOffer.js";
import { SendLaterMenu, SendWindow, scheduledWords } from "./SendControls.js";
import { StructuredText } from "./StructuredText.js";
import { Timestamp } from "./Timestamp.js";
import { useDraftDecision } from "./useDraftDecision.js";
import { WhyButton } from "./WhyButton.js";
import { useLongPress } from "../shell/useLongPress.js";

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

/** A field where ←/→ move a caret, so the arrows are not ours to take. */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  return !!el && typeof el.closest === "function" && !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

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
 *
 * A hedged draft can come with alternatives (#257): "1 of 3", paged by ‹ ›,
 * by ←/→ while the tray has focus, and by a sideways swipe inside the card;
 * Send records which one was on screen. Under every pending draft, the shape
 * chips (#258) ask the daemon to rewrite the version on screen — Undo puts
 * the previous words back.
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
  // #257: a hedged draft can come with alternatives, paged "1 of 3". Every
  // version-aware read below goes through `shown` — the candidate on screen
  // as a draft record of its own (its text, its confidence, its sources) —
  // so the decision logic, Why? and the sources line all speak about the
  // words the owner is actually looking at.
  const alternatives = draft.alternatives ?? [];
  const multiple = alternatives.length > 1;
  const [picked, setPicked] = useState(0);
  const index = multiple ? Math.min(picked, alternatives.length - 1) : 0;
  const candidate = multiple ? alternatives[index] : undefined;
  const shown: DraftRecord = candidate
    ? { ...draft, draftText: candidate.text, confidenceScore: candidate.confidenceScore, sources: candidate.sources }
    : draft;
  const d = useDraftDecision(api, shown);
  const shape = useShapeDraft(api);
  const undoShape = useUndoShape(api);
  const arrived = useArrival(draft.id);
  const state = hairlineState(toDraftPipelineResult(shown));
  const passedOn = draft.escalated && !draft.refused;
  const rules = shown.sources.filter((source) => source.kind === "rule");
  const others = shown.sources.length - rules.length;
  const busy = shape.isPending || undoShape.isPending;
  // Which alternative was on screen is what Send records (#257); a single
  // draft names none, so its outcome body is exactly what it always was.
  // #260: through the undo window — nothing is posted until it ends.
  const decide = (outcome: SettableDraftOutcome, sentText?: string) =>
    d.send({ draftId: draft.id, outcome, ...(sentText !== undefined ? { sentText } : {}), ...(multiple ? { alternative: index } : {}) });
  // #261: the Send-later menu — opened from its ▸, by ⌘⇧⏎, or by a long press on Send (phone). Not offered for a
  // draft with alternatives yet: a held send carries no alternative, so the daemon could only send the first.
  const [laterOpen, setLaterOpen] = useState(false);
  const canSendLater = !d.selfAsked && !passedOn && !draft.refused && !multiple;
  const longPress = useLongPress(() => setLaterOpen(true), canSendLater && d.reachable);
  const flip = (direction: 1 | -1) => {
    if (!multiple || d.editing || busy) {
      return;
    }
    setPicked(Math.max(0, Math.min(alternatives.length - 1, index + direction)));
  };
  const swipe = useFlipSwipe(multiple && !d.editing && !busy, flip);

  useEffect(() => {
    if (!keyboard || draft.refused) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      // #261: ⌘⇧⏎ (Ctrl+Shift+Enter) opens Send later.
      if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey) && canSendLater && d.reachable && d.sendingUntil === null) {
        e.preventDefault();
        setLaterOpen(true);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || d.editing || d.ignoring || d.sendingUntil !== null) {
        return;
      }
      if (e.key === "Enter" && !passedOn) {
        if (isInteractive(e.target) || !d.reachable || d.recordOutcome.isPending || busy) {
          return;
        }
        e.preventDefault();
        decide("sent");
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
  // #258: shaping is for a draft still waiting on the owner, with words on it.
  const shapeable = !draft.refused && !passedOn && draft.outcome === null && !d.editing && !d.ignoring && d.sendingUntil === null;
  const undoable = standingShape(draft.shapes, index);

  return (
    <section
      aria-label="Your duo's draft"
      className={`flex w-full max-w-[90%] flex-col gap-2 ${d.selfAsked ? "self-start" : "self-end"}`}
      data-testid="draft-tray"
      data-unsent={unsent ? "true" : undefined}
      // #257: ←/→ page the alternatives while the draft has focus — the
      // tray itself or anything in it but a text field, where the arrows
      // move the caret. Focusable only when there is something to page.
      onKeyDown={
        multiple
          ? (e) => {
              if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.metaKey || e.ctrlKey || e.altKey || isTextEntry(e.target)) {
                return;
              }
              e.preventDefault();
              flip(e.key === "ArrowRight" ? 1 : -1);
            }
          : undefined
      }
      tabIndex={multiple ? 0 : undefined}
    >
      {multiple && (
        <AlternativeStepper count={alternatives.length} disabled={d.editing || busy} flip={flip} index={index} instruction={candidate?.instruction ?? null} />
      )}
      <div
        aria-busy={busy ? true : undefined}
        className={`${unsent ? "rounded-[var(--r-md)] border border-dashed border-[var(--edge)] p-1" : ""} ${busy ? "opacity-60" : ""} ${multiple ? "touch-pan-y" : ""}`}
        data-testid="draft-tray-body"
        {...swipe}
      >
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
            <EditDiff original={shown.draftText ?? ""} edited={d.editedText} />
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
                  d.setEditedText(shown.draftText ?? "");
                  d.setEditing(false);
                }
              }}
              readOnly={d.sendingUntil !== null}
              rows={4}
              value={d.editedText}
            />
          </div>
        ) : (
          <StructuredText text={shown.draftText ?? ""} />
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
        <WhyButton draft={shown} />
      </div>

      {shapeable && (
        <ShapeChips
          disabled={!d.reachable || d.recordOutcome.isPending}
          onShape={(instruction) => shape.mutate({ draftId: draft.id, instruction, alternative: index })}
          onUndo={() => undoShape.mutate({ draftId: draft.id, alternative: index })}
          pendingInstruction={shape.isPending ? shape.variables?.instruction : undefined}
          shaping={shape.isPending}
          undoable={undoable}
          undoing={undoShape.isPending}
        />
      )}

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
      ) : d.sendingUntil !== null ? (
        <SendWindow onUndo={d.undoSend} until={d.sendingUntil} />
      ) : d.scheduleSend.isSuccess ? (
        <p className="type-provenance text-[var(--muted)]" data-testid="scheduled-confirmation">
          {scheduledWords(d.scheduleSend.data.sendAt)} Your duo sends it then, even if this app is closed.
        </p>
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
        // guangshinhaha/duo#259 → #269: the dismissal's "shouldn't answer
        // this" offered as a standing never-answer rule, in words the owner
        // approves before anything is saved.
        <NeverAnswerOffer api={api} draftId={draft.id} onSkip={d.skipNeverAnswerOffer} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {d.editing ? (
            <>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
                disabled={!d.editedText.trim() || d.recordOutcome.isPending || !d.reachable}
                onClick={() => (d.editChanged ? decide("edited", d.editedText.trim()) : decide("sent"))}
                type="button"
                {...longPress}
              >
                {d.editChanged ? (d.selfAsked ? "Keep edited" : "Send edited") : d.selfAsked ? "Keep" : "Send"}
              </button>
              {canSendLater && (
                <SendLaterMenu
                  api={api}
                  disabled={!d.editedText.trim() || d.recordOutcome.isPending || d.scheduleSend.isPending || !d.reachable}
                  onOpenChange={setLaterOpen}
                  onPick={d.sendLater}
                  open={laterOpen}
                />
              )}
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
                onClick={() => {
                  d.setEditedText(shown.draftText ?? "");
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
                disabled={d.recordOutcome.isPending || !d.reachable || busy}
                onClick={() => decide("sent")}
                type="button"
                {...longPress}
              >
                {d.selfAsked ? "Keep" : "Send"}
                {keyboard && <kbd aria-hidden="true" className="hidden type-identifier opacity-70 md:inline">⏎</kbd>}
              </button>
              {canSendLater && (
                <SendLaterMenu
                  api={api}
                  disabled={d.recordOutcome.isPending || d.scheduleSend.isPending || !d.reachable || busy}
                  onOpenChange={setLaterOpen}
                  onPick={d.sendLater}
                  open={laterOpen}
                />
              )}
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
      <MutationError error={d.scheduleSend.error} />
      <MutationError error={shape.error} />
      <MutationError error={undoShape.error} />
    </section>
  );
}
