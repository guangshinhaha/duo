import { useEffect, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useWorkingHours } from "../api/queries.js";
import type { SendLater } from "../api/types.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./primitives/DropdownMenu.js";

/**
 * #260: the countdown on a held Send. The message has NOT been sent — the
 * line says so, because held vs. sent is the whole point of the window — and
 * Undo (or ⌘Z / Ctrl+Z, when nothing editable has focus) takes it back with
 * nothing ever reaching the room.
 */
export function SendWindow({ until, onUndo }: { until: number; onUndo: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        const target = e.target as Partial<HTMLElement> | null;
        if (target && typeof target.closest === "function" && target.closest("input, textarea, [contenteditable='true']")) {
          return;
        }
        e.preventDefault();
        onUndo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onUndo]);
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  return (
    <div className="flex items-center gap-2" data-testid="send-window" role="status">
      <span className="type-provenance text-[var(--muted)]" data-testid="send-countdown">
        Sending in {seconds}s — not sent yet.
      </span>
      <button
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
        onClick={onUndo}
        type="button"
      >
        Undo
      </button>
    </div>
  );
}

/** "Tomorrow 9:00", in this device's own zone. */
export function tomorrowAtNine(now: Date = new Date()): Date {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return at;
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** A `datetime-local` value (local wall clock, minutes) for `date`. */
function localInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * #261: the ▸ half of a split Send — "send it later". The daemon holds what
 * is picked here, so it goes out at its time even with this app closed.
 * Now stays the Send button itself; this offers Tomorrow 9:00, the start of
 * their working hours (the daemon's own setting, resolved there), or a time
 * the owner picks.
 */
export function SendLaterMenu({
  api,
  disabled,
  open,
  onOpenChange,
  onPick,
}: {
  api: DuoApiConfig;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (when: SendLater) => void;
}) {
  const workingHours = useWorkingHours(open ? api : null);
  const [custom, setCustom] = useState<string | null>(null);
  const customDate = custom ? new Date(custom) : null;
  const customValid = customDate !== null && !Number.isNaN(customDate.getTime()) && customDate.getTime() > Date.now();

  return (
    <>
      <DropdownMenu onOpenChange={onOpenChange} open={open}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            aria-label="Send later"
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 disabled:opacity-40"
            data-testid="send-later"
            type="button"
          >
            ▸
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label="Send later">
          <DropdownMenuItem onSelect={() => onPick({ sendAt: tomorrowAtNine().toISOString() })}>Tomorrow 9:00</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPick({ at: "working-hours" })}>
            Start of their working hours
            {workingHours.data?.nextStart && <span className="type-provenance text-[var(--muted)]">{shortTime(workingHours.data.nextStart)}</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCustom(localInputValue(tomorrowAtNine()))}>Pick a time…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {custom !== null && (
        <div className="flex basis-full flex-wrap items-center gap-2" data-testid="send-later-custom">
          <input
            aria-label="Send at"
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
            onChange={(e) => setCustom(e.target.value)}
            type="datetime-local"
            value={custom}
          />
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
            disabled={!customValid || disabled}
            onClick={() => {
              if (customDate && customValid) {
                onPick({ sendAt: customDate.toISOString() });
                setCustom(null);
              }
            }}
            type="button"
          >
            Schedule
          </button>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
            onClick={() => setCustom(null)}
            type="button"
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

/** "Scheduled for Tue 09:00." — what a held send says once the daemon has it. */
export function scheduledWords(sendAt: string): string {
  return `Scheduled for ${new Date(sendAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`;
}
