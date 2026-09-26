import { useEffect, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import type { DraftRecord } from "../api/types.js";
import { toDraftPipelineResult } from "./DraftCard.js";
import { hairlineState, type HairlineState } from "./ConfidenceHairline.js";
import { DuoLine } from "./DuoLine.js";
import { EditDiff } from "./EditDiff.js";
import { MutationError } from "./MutationError.js";
import { StructuredText } from "./StructuredText.js";
import { Timestamp } from "./Timestamp.js";
import { useDraftDecision } from "./useDraftDecision.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import { WhyPanel } from "../shell/Inspector.js";
import { useInspectorVisible } from "../shell/InspectorContext.js";

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

function isInteractive(target: EventTarget | null): boolean {
  const el = target as Partial<HTMLElement> | null;
  return !!el && typeof el.closest === "function" && !!el.closest("input, textarea, select, button, a, [contenteditable=''], [contenteditable='true'], [role='dialog']");
}

/**
 * The draft tray (docs/design-language.md §4.2, epic #138): your duo's draft
 * for the conversation it answers, docked above the composer of that chat
 * and never in the transcript. It is the Review card made compact and
 * moved next to its context — same decision logic (`useDraftDecision`), so
 * Send, Edit and Dismiss behave exactly as they did in Review: Send waits
 * for the daemon rather than queueing (AR-15), an edit that changes nothing
 * is a plain Send, Dismiss is held for the undo window, and answering a
 * passed-on question is a standing-order candidate.
 *
 * Only the draft's words are the duo's, so only they sit behind the duo's
 * line (`DuoLine`); the why (rule and sources) and the actions are the
 * owner's controls beside it. A refusal has no actions: the system worked.
 *
 * `keyboard` makes it answer to ⏎ (send), E (edit, or answer a passed-on
 * question) and X (dismiss) when nothing editable has focus — one tray at a
 * time, so it is only ever the first one in a stack.
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
  // With the inspector beside the chat the why is already on screen; without it (a phone, a narrow window) it is one tap.
  const inspectorVisible = useInspectorVisible();
  const [whyOpen, setWhyOpen] = useState(false);
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
    ? "Your duo refused this one."
    : passedOn
      ? "Your duo escalated a question to you."
      : null;

  return (
    <section aria-label="Your duo's draft" className="flex flex-col gap-2 border-t border-[var(--edge)] px-4 py-3" data-testid="draft-tray">
      <DuoLine
        aside="only you can see this"
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
          <div className="flex flex-col gap-1">
            <p className="type-body">{words}</p>
            <p className="type-body text-[var(--muted)]" data-testid="escalation-reason">
              {draft.escalationReason}
            </p>
          </div>
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

      {(rules.length > 0 || others > 0 || !inspectorVisible) && (
        <p className="flex flex-wrap items-center gap-x-2 type-provenance text-[var(--muted)]" data-testid="draft-tray-why">
          <span>
            {rules.length > 0 && <>Standing order: {rules.map((rule) => rule.label).join(" · ")}</>}
            {rules.length > 0 && others > 0 && " · "}
            {others > 0 && <>Drew on {others} source{others === 1 ? "" : "s"}</>}
          </span>
          {!inspectorVisible && (
            <button className="inline-flex min-h-11 items-center underline" data-testid="tray-why" onClick={() => setWhyOpen(true)} type="button">
              Why?
            </button>
          )}
        </p>
      )}
      <Dialog onOpenChange={setWhyOpen} open={whyOpen}>
        <DialogContent className="top-auto! bottom-0 max-h-[85dvh] overflow-y-auto" data-testid="why-sheet">
          <DialogTitle className="sr-only">Why your duo drafted this</DialogTitle>
          <DialogDescription className="sr-only">How sure your duo is, the standing order and sources it used, and who asked.</DialogDescription>
          <WhyPanel draft={draft} />
          <DialogClose className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" data-testid="why-close">
            Close
          </DialogClose>
        </DialogContent>
      </Dialog>

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
          <div className="hidden gap-2 md:flex">
            <input
              aria-label="Answer it yourself — becomes a standing-order candidate"
              className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
              onChange={(e) => d.setAnswerText(e.target.value)}
              placeholder="Answer it yourself — becomes a standing-order candidate"
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
        )
      ) : d.ignoring ? (
        // #24: the undo window. The dismissal has NOT been recorded — the tray says so, because held vs. sent is the whole point of the window.
        <div className="flex items-center gap-2" data-testid="ignore-window">
          <span className="type-provenance text-[var(--muted)]">{d.selfAsked ? "Dismissing — not final yet." : "Dismissing — not sent yet."}</span>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
            onClick={d.undoIgnore}
            type="button"
          >
            Undo
          </button>
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
