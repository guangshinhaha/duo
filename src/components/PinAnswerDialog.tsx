import { useId, useState, type FormEvent } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";

/**
 * duo#275: "Duo: always answer this way" — the message action on the
 * owner's own message. The wording being pinned is exactly what they
 * already sent (never editable here — the whole point is pinning the
 * words as sent, not drafting new ones), so the only decision this dialog
 * asks for is the question/topic the owner wants it pinned to.
 *
 * A plain callback, not the daemon client itself: this component is used
 * from `Room.tsx`, which sits on the share path and may never import
 * `src/api/*` (`test/WorkspaceMatrixSeam.test.ts`'s structural pin, the
 * same reasoning `onRewrite`/`onFactCheck` already follow) — `App.tsx`
 * binds `onPin` to the daemon's `useCreatePinnedAnswer` mutation.
 */
export function PinAnswerDialog({
  open,
  onOpenChange,
  answerText,
  defaultPattern,
  onPin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  answerText: string;
  /** Prefilled from the question this message replied to, when there was one — otherwise blank, and the owner types it. */
  defaultPattern: string;
  onPin: (pattern: string, answerText: string) => Promise<unknown>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent data-testid="pin-answer-dialog">
        <PinAnswerBody answerText={answerText} defaultPattern={defaultPattern} onClose={() => onOpenChange(false)} onPin={onPin} />
      </DialogContent>
    </Dialog>
  );
}

function PinAnswerBody({
  answerText,
  defaultPattern,
  onPin,
  onClose,
}: {
  answerText: string;
  defaultPattern: string;
  onPin: (pattern: string, answerText: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [pattern, setPattern] = useState(defaultPattern);
  const [pinning, setPinning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const patternId = useId();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = pattern.trim();
    if (trimmed.length === 0 || pinning) {
      return;
    }
    setPinning(true);
    setError(null);
    onPin(trimmed, answerText)
      .then(() => setPinned(true))
      .catch(() => setError("The daemon didn't take that — try again."))
      .finally(() => setPinning(false));
  };

  if (pinned) {
    return (
      <>
        <DialogTitle>Pinned</DialogTitle>
        <DialogDescription>
          Your duo will quote this word for word whenever it's asked something like &quot;{pattern.trim()}&quot; — see it any time in your
          profile&apos;s Rules tab.
        </DialogDescription>
        <DialogClose asChild>
          <button
            className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
            data-testid="pin-answer-done"
          >
            Done
          </button>
        </DialogClose>
      </>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <DialogTitle>Duo: always answer this way</DialogTitle>
      <DialogDescription>
        Your duo will quote this exact message, word for word, whenever it's asked something matching the question below — before any
        standing order or anything else it knows.
      </DialogDescription>
      <blockquote className="type-body whitespace-pre-wrap border-l-2 border-[var(--edge)] pl-3 text-[var(--text)]" data-testid="pin-answer-text">
        {answerText}
      </blockquote>
      <label className="flex flex-col gap-1 type-provenance text-[var(--muted)]" htmlFor={patternId}>
        What question or topic should this always answer?
        <input
          autoFocus
          className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 type-body text-[var(--text)]"
          data-testid="pin-answer-pattern-input"
          id={patternId}
          onChange={(event) => setPattern(event.target.value)}
          placeholder="e.g. vacation leave policy"
          value={pattern}
        />
      </label>
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="pin-answer-error" role="status">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
          data-testid="pin-answer-submit"
          disabled={pinning || pattern.trim().length === 0}
          type="submit"
        >
          {pinning ? "Pinning…" : "Pin this answer"}
        </button>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
          onClick={onClose}
          type="button"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
