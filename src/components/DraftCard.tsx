import { useEffect, useRef, useState } from "react";
import type { DraftRecord } from "../api/types.js";
import { useAnswerEscalation, useRecordOutcome } from "../api/queries.js";
import type { DuoApiConfig } from "../api/client.js";
import { DuoMessage } from "./DuoMessage.js";
import { OwnerMessage } from "./OwnerMessage.js";
import { ConfidenceHairline } from "./ConfidenceHairline.js";
import { DeliveryStateLine } from "./DeliveryStateLine.js";
import { EditDiff } from "./EditDiff.js";
import { MutationError } from "./MutationError.js";
import { ProvenanceLine } from "./ProvenanceLine.js";
import { SourceList } from "./SourceList.js";
import { StructuredText } from "./StructuredText.js";
import { Timestamp } from "./Timestamp.js";
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
 * #24: how long a clicked Ignore is held client-side before it becomes
 * real. The daemon has no route to clear an outcome once written, so the
 * only honest undo is the one that happens before anything is sent — this
 * window is the entire recoverable surface, and undo inside it means the
 * discard never existed. Long enough to catch a mis-click, short enough
 * that "Ignore" still means a decision, not a maybe.
 */
export const IGNORE_UNDO_WINDOW_MS = 5_000;

/**
 * One item in the Review surface (`client-tech-design.md` §1.5 /
 * client-design.md §1.5): the question, the duo's draft or escalation,
 * the provenance rail, and Send / Edit / Ignore — the correction loop's
 * only input, so this is the component the whole product exists to serve.
 */
export function DraftCard({ api, draft }: { api: DuoApiConfig; draft: DraftRecord }) {
  const recordOutcome = useRecordOutcome(api);
  const answerEscalation = useAnswerEscalation(api);
  // #30: a draft whose provenance is the owner is an answer to a question
  // you asked yourself — nobody asked, so "Send" would promise a recipient
  // that does not exist. The words on the controls change; the outcomes
  // they post are the core's and stay byte-identical (the edit is still
  // the correction loop's input). Channel-borne drafts keep the reply
  // vocabulary, and so do legacy rows (`origin: "unknown"`) — they
  // predate provenance and today's wording is the only honest default
  // for history that may well be channel-borne.
  // The `?.` is not the wire being optional — the daemon always sends the
  // field — it is the persisted cache being older than the field: a
  // record rehydrated from duo-cache as written before #169 has no
  // `provenance` at all, renders BEFORE the refetch replaces it, and a
  // bare dereference would crash that first render with no boundary to
  // catch it (killing the very refetch that heals the data). An absent
  // field reads as not-owner, i.e. today's vocabulary — the same honest
  // default the daemon itself gives a legacy row.
  const selfAsked = draft.provenance?.origin === "owner";
  // AR-15 (§3.3): when the daemon is unreachable every mutation control is
  // disabled, not queued — a Send firing hours later against moved context
  // is worse than no Send. Editing the text stays possible (a local buffer);
  // only the *sending* of anything waits for the daemon to answer again.
  const { reachable } = useSyncStatus();
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(draft.draftText ?? "");
  const [answerText, setAnswerText] = useState("");
  // #36: Escape on the editor hands focus back to the Edit that opened
  // it. The flag is consumed by the effect below, which runs after the
  // action row has rendered back — the ref is null until then, so the
  // focus can't happen in the handler itself.
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusEditOnClose = useRef(false);
  useEffect(() => {
    if (!editing && focusEditOnClose.current) {
      focusEditOnClose.current = false;
      editButtonRef.current?.focus();
    }
  }, [editing]);
  const result = toDraftPipelineResult(draft);
  // #23: "nothing changed is nothing changed" — an edit that leaves the
  // duo's text as it was (whitespace included, since the send trims it) is
  // a plain Send. Posting "edited" with identical text would manufacture a
  // correction candidate out of a correction that never happened.
  const editChanged = editedText.trim() !== (draft.draftText ?? "").trim();
  // #24: the open undo window on a clicked Ignore. The timer is a ref, not
  // state — its firing must not re-render the card, and its cleanup must
  // not run on unmount: navigating away mid-window is not an undo, and
  // silently dropping the discard would leave the owner believing a
  // judgement was recorded that the daemon never received.
  const [ignoring, setIgnoring] = useState(false);
  const ignoreTimer = useRef<number | null>(null);
  const ignoreNow = () => {
    setIgnoring(false);
    ignoreTimer.current = null;
    recordOutcome.mutate({ draftId: draft.id, outcome: "discarded" });
  };
  const ignoreWithWindow = () => {
    setIgnoring(true);
    // The global timer, not `window.setTimeout`: in the shell they are the
    // same function, and staying on the global keeps the timer mockable
    // where `window`'s copy is not.
    ignoreTimer.current = setTimeout(ignoreNow, IGNORE_UNDO_WINDOW_MS);
  };
  const undoIgnore = () => {
    if (ignoreTimer.current !== null) {
      clearTimeout(ignoreTimer.current);
      ignoreTimer.current = null;
    }
    setIgnoring(false);
  };
  // #26: copy is the one route to reuse a draft's text, and it is entirely
  // local — no daemon round-trip, so it stays available no matter the
  // daemon's health. The control confirms which of the two outcomes
  // happened; it never claims a copy that failed.
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draft.draftText ?? "");
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

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
          <ProvenanceLine provenance={draft.provenance} />
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
              <div className="hidden gap-2 md:flex">
                <input
                  aria-label="Answer it yourself — becomes a standing-order candidate"
                  className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
                  placeholder="Answer it yourself — becomes a standing-order candidate"
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
        <ProvenanceLine provenance={draft.provenance} />
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
        {ignoring ? (
          // #24: the undo window. The discard has NOT been sent — the card
          // says so, because the difference between "held" and "sent" is
          // the whole point of the window. For a self-asked draft (#30)
          // nothing was ever being sent anywhere; "final" is the word
          // that carries the same warning.
          <div className="flex items-center gap-2" data-testid="ignore-window">
            <span className="type-provenance text-[var(--muted)]">{selfAsked ? "Ignoring — not final yet." : "Ignoring — not sent yet."}</span>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
              onClick={undoIgnore}
            >
              Undo
            </button>
          </div>
        ) : (
        <div className="flex gap-2">
          {editing ? (
            <>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
                disabled={!editedText.trim() || recordOutcome.isPending || !reachable}
                onClick={() =>
                  editChanged
                    ? recordOutcome.mutate({ draftId: draft.id, outcome: "edited", sentText: editedText.trim() })
                    : recordOutcome.mutate({ draftId: draft.id, outcome: "sent" })
                }
              >
                {/* The label tells the truth the payload encodes: a change
                    sends an edit, anything else is just a Send — and for a
                    self-asked draft, both are Keeps (#30): the answer
                    stands as yours, nobody receives it. */}
                {editChanged ? (selfAsked ? "Keep edited" : "Send edited") : selfAsked ? "Keep" : "Send"}
              </button>
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
                onClick={() => recordOutcome.mutate({ draftId: draft.id, outcome: "sent" })}
              >
                {selfAsked ? "Keep" : "Send"}
              </button>
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
                Ignore
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
      </div>
    </div>
  );
}
