import { useState } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";

/** The least this product will call a poll — one question, at least two things to pick between. */
export const POLL_MIN_OPTIONS = 2;
/** The most options this composer offers — enough for a real decision, not a survey. */
export const POLL_MAX_OPTIONS = 10;

/**
 * duo#293: composes a poll — question, options, Start. One dialog, opened
 * either blank (the typeahead's own "/poll" pick, or the attach-row button)
 * or pre-filled from "/poll <question> | <option> | <option>" (#301's own
 * pipe-separated shorthand, parsed by `Room.tsx`'s `runSlashCommand` before
 * this ever opens) — this component only ever reads `initialQuestion`/
 * `initialOptions` once, at open, the same "takes a starting point, owns it
 * from there" shape `SaveToLaterDialog` already uses for `preview`.
 */
export function PollComposeDialog({
  open,
  onOpenChange,
  initialQuestion = "",
  initialOptions = ["", ""],
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialQuestion?: string;
  initialOptions?: readonly string[];
  onStart: (question: string, options: readonly string[]) => Promise<void>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {open && (
        <DialogContent data-testid="poll-compose-dialog">
          <PollComposeBody
            initialOptions={initialOptions}
            initialQuestion={initialQuestion}
            onDone={() => onOpenChange(false)}
            onStart={onStart}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function PollComposeBody({
  initialQuestion,
  initialOptions,
  onStart,
  onDone,
}: {
  initialQuestion: string;
  initialOptions: readonly string[];
  onStart: (question: string, options: readonly string[]) => Promise<void>;
  onDone: () => void;
}) {
  const [question, setQuestion] = useState(initialQuestion);
  const [options, setOptions] = useState<string[]>(
    initialOptions.length >= POLL_MIN_OPTIONS ? [...initialOptions] : [...initialOptions, ...Array(POLL_MIN_OPTIONS - initialOptions.length).fill("")],
  );
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filledOptions = options.map((option) => option.trim()).filter((option) => option.length > 0);
  const canStart = question.trim().length > 0 && filledOptions.length >= POLL_MIN_OPTIONS;

  const submit = (): void => {
    if (!canStart || starting) {
      return;
    }
    setStarting(true);
    setError(null);
    onStart(question.trim(), filledOptions)
      .then(() => onDone())
      .catch(() => setError("The workspace didn't take that — try again."))
      .finally(() => setStarting(false));
  };

  return (
    <>
      <DialogTitle>Run a poll</DialogTitle>
      <DialogDescription>Everyone here sees results as votes come in.</DialogDescription>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="type-provenance text-[var(--muted)]">Question</span>
          <input
            autoFocus
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
            data-testid="poll-compose-question"
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What are we deciding?"
            value={question}
          />
        </label>
        <div className="flex flex-col gap-2">
          <span className="type-provenance text-[var(--muted)]">Options</span>
          {options.map((option, index) => (
            <div className="flex items-center gap-2" key={index}>
              <input
                aria-label={`Option ${index + 1}`}
                className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
                data-testid={`poll-compose-option-${index}`}
                onChange={(e) => setOptions((current) => current.map((value, at) => (at === index ? e.target.value : value)))}
                placeholder={`Option ${index + 1}`}
                value={option}
              />
              {options.length > POLL_MIN_OPTIONS && (
                <button
                  aria-label={`Remove option ${index + 1}`}
                  className="inline-flex min-h-11 items-center px-2 type-provenance text-[var(--muted)] underline"
                  onClick={() => setOptions((current) => current.filter((_, at) => at !== index))}
                  type="button"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {options.length < POLL_MAX_OPTIONS && (
            <button
              className="inline-flex min-h-11 items-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance text-[var(--text)]"
              data-testid="poll-compose-add-option"
              onClick={() => setOptions((current) => [...current, ""])}
              type="button"
            >
              Add option
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="poll-compose-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
          data-testid="poll-compose-start"
          disabled={!canStart || starting}
          onClick={submit}
          type="button"
        >
          {starting ? "Starting…" : "Start poll"}
        </button>
        <DialogClose asChild>
          <button className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" disabled={starting}>
            Cancel
          </button>
        </DialogClose>
      </div>
    </>
  );
}
