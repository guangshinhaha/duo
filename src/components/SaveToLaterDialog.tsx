import { useState } from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";

/** "In 1 hour", from now. */
function inOneHour(now: Date = new Date()): Date {
  return new Date(now.getTime() + 60 * 60 * 1000);
}

/** "Tomorrow 9:00", in this device's own zone — the same shape `SendControls.tsx`'s `tomorrowAtNine` already takes for "send it later", reread here rather than imported: this dialog has no reason to depend on the composer's own module, and the rule is three lines. */
function tomorrowAtNine(now: Date = new Date()): Date {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return at;
}

/** A `datetime-local` value (local wall clock, minutes) for `date` — `SendControls.tsx`'s own `localInputValue`, same reasoning as `tomorrowAtNine` above for not importing it. */
function localInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * duo#299: saving a message, or the words left in the composer, to Later
 * with an optional reminder. One dialog for both callers (`RoomEntry`'s
 * "Save to Later" action and `RoomComposer`'s own button) — neither knows
 * or cares what it's saving, only that `onSave` takes the reminder picked
 * (or null for "just save it") and does the write.
 */
export function SaveToLaterDialog({
  open,
  onOpenChange,
  preview,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What this will save — shown so the owner can see exactly what they're about to keep. */
  preview: string;
  onSave: (remindAt: string | null) => Promise<void>;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {open && (
        <DialogContent data-testid="save-later-dialog">
          <SaveToLaterBody preview={preview} onDone={() => onOpenChange(false)} onSave={onSave} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function SaveToLaterBody({
  preview,
  onSave,
  onDone,
}: {
  preview: string;
  onSave: (remindAt: string | null) => Promise<void>;
  onDone: () => void;
}) {
  const [custom, setCustom] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const customDate = custom ? new Date(custom) : null;
  const customValid = customDate !== null && !Number.isNaN(customDate.getTime()) && customDate.getTime() > Date.now();

  const submit = (remindAt: string | null): void => {
    if (saving) {
      return;
    }
    setSaving(true);
    setError(null);
    onSave(remindAt)
      .then(() => onDone())
      .catch(() => setError("The workspace didn't take that — try again."))
      .finally(() => setSaving(false));
  };

  return (
    <>
      <DialogTitle>Save to Later</DialogTitle>
      <DialogDescription>
        <span className="block type-provenance text-[var(--muted)]">What you're saving</span>
        <span className="block type-body text-[var(--text)]">{preview}</span>
      </DialogDescription>
      <div className="flex flex-col gap-2">
        <p className="type-provenance text-[var(--muted)]">Remind me</p>
        <div className="flex flex-wrap gap-2">
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--text)] disabled:opacity-40"
            data-testid="save-later-no-reminder"
            disabled={saving}
            onClick={() => submit(null)}
            type="button"
          >
            No reminder
          </button>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--text)] disabled:opacity-40"
            data-testid="save-later-in-1h"
            disabled={saving}
            onClick={() => submit(inOneHour().toISOString())}
            type="button"
          >
            In 1 hour
          </button>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--text)] disabled:opacity-40"
            data-testid="save-later-tomorrow"
            disabled={saving}
            onClick={() => submit(tomorrowAtNine().toISOString())}
            type="button"
          >
            Tomorrow 9:00
          </button>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--text)] disabled:opacity-40"
            data-testid="save-later-pick"
            disabled={saving}
            onClick={() => setCustom(localInputValue(tomorrowAtNine()))}
            type="button"
          >
            Pick a time…
          </button>
        </div>
        {custom !== null && (
          <div className="flex flex-wrap items-center gap-2" data-testid="save-later-custom">
            <input
              aria-label="Remind me at"
              className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
              onChange={(e) => setCustom(e.target.value)}
              type="datetime-local"
              value={custom}
            />
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
              disabled={!customValid || saving}
              onClick={() => {
                if (customDate && customValid) {
                  submit(customDate.toISOString());
                }
              }}
              type="button"
            >
              Save
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="save-later-error">
          {error}
        </p>
      )}
      <DialogClose asChild>
        <button className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" disabled={saving}>
          Cancel
        </button>
      </DialogClose>
    </>
  );
}
