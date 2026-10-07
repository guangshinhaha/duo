import { useEffect, useRef, useState } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";

type ExplainState =
  | { status: "loading" }
  | { status: "done"; explanation: string; sources: readonly string[] }
  | { status: "error"; message: string };

/**
 * duo#283: "Explain this message, privately" — the message action
 * available on ANY message in the room (unlike `PinAnswerDialog`, which
 * only ever pins the owner's own), opening a card visible to the owner
 * alone. It fires the moment it opens — there's nothing to fill in, the
 * one decision (what to explain) was already made by picking the
 * message — and it never posts anything to the room: `onExplain` is a
 * plain daemon round-trip (`App.tsx`'s own doc comment on
 * `SurfaceContext.onExplain`), scoped to the owner's own corpus before
 * this component ever sees a result (AC1/AC3).
 *
 * `sources` is already flattened to plain label strings by the time it
 * reaches here (same flattening `onFactCheck`'s `sourceLabel` already
 * does) — empty means the daemon drew on nothing from the corpus,
 * stated plainly rather than omitted, so AC2 ("it cites what it drew
 * on") holds even when there's nothing to cite.
 */
export function ExplainDialog({
  open,
  onOpenChange,
  messageText,
  threadContext,
  onExplain,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageText: string;
  threadContext: string | null;
  onExplain: (text: string, threadContext: string | null) => Promise<{ explanation: string; sources: readonly string[] }>;
}) {
  const [state, setState] = useState<ExplainState>({ status: "loading" });
  // Guards against re-asking on every render while the dialog is open
  // (`onExplain` is a fresh closure each render, same as `onRewrite`/
  // `onFactCheck`) — only a genuinely different message, or a reopen
  // after close, asks again.
  const askedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      askedFor.current = null;
      return;
    }
    if (askedFor.current === messageText) {
      return;
    }
    askedFor.current = messageText;
    setState({ status: "loading" });
    onExplain(messageText, threadContext).then(
      (result) => setState({ status: "done", explanation: result.explanation, sources: result.sources }),
      (error: unknown) =>
        setState({ status: "error", message: error instanceof Error ? error.message : "Your duo couldn't explain that — try again." }),
    );
  }, [open, messageText, threadContext, onExplain]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent data-testid="explain-dialog">
        <DialogTitle>Explain, privately</DialogTitle>
        <DialogDescription>Only you can see this — your duo's explanation is never posted to the room.</DialogDescription>
        {state.status === "loading" && (
          <p aria-live="polite" className="type-body text-[var(--muted)]" data-testid="explain-loading">
            Asking your duo…
          </p>
        )}
        {state.status === "error" && (
          <p className="type-body text-[var(--refused)]" data-testid="explain-error" role="status">
            {state.message}
          </p>
        )}
        {state.status === "done" && (
          <>
            <p className="type-body whitespace-pre-wrap text-[var(--text)]" data-testid="explain-text">
              {state.explanation}
            </p>
            <p className="type-provenance text-[var(--muted)]" data-testid="explain-sources">
              {state.sources.length > 0
                ? `Drew on ${state.sources.length} source${state.sources.length === 1 ? "" : "s"}: ${state.sources.join("; ")}`
                : "Drew on general knowledge, not anything your duo knows."}
            </p>
          </>
        )}
        <DialogClose asChild>
          <button
            className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
            data-testid="explain-done"
          >
            Done
          </button>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
