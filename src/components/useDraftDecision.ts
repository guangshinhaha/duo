import { useEffect, useRef, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useAnswerEscalation, useRecordOutcome } from "../api/queries.js";
import type { DraftRecord } from "../api/types.js";
import { useSyncStatus } from "../sync.js";

/**
 * #24: how long a clicked Ignore (now Dismiss) is held client-side before it
 * becomes real. The daemon has no route to clear an outcome once written, so
 * the only honest undo is the one that happens before anything is sent —
 * this window is the entire recoverable surface, and undo inside it means the
 * discard never existed. Long enough to catch a mis-click, short enough that
 * dismissing still means a decision, not a maybe.
 */
export const IGNORE_UNDO_WINDOW_MS = 5_000;

/**
 * Everything a surface needs to decide one draft — send, edit, dismiss (with
 * its undo window), answer an escalation, copy — and none of how it looks.
 * The Review card and the chat's draft tray both render from this, so the
 * two can never disagree about a rule: Send disabled (not queued) while the
 * daemon is unreachable (AR-15), an edit that changes nothing is a plain
 * Send (#23), a self-asked draft's verbs are Keeps (#30), and a dismissal is
 * held for the undo window before it is written (#24).
 */
export function useDraftDecision(api: DuoApiConfig, draft: DraftRecord) {
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

  return {
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
  };
}
