import { useEffect, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useAutonomySettings, useSaveAutonomySettings, useSaveWorkingHours, useWorkingHours } from "../api/queries.js";
import { readUndoSendSeconds, UNDO_SEND_CHOICES, writeUndoSendSeconds, type UndoSendSeconds } from "../undoSendPrefs.js";
import { MutationError } from "./MutationError.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Settings → Sending: #260's undo window (this device's own rule, kept on
 * this device) and #261's working hours (the duo's, kept by the daemon,
 * because the daemon is what resolves "start of their working hours" when
 * it holds a send). Working hours are one setting for the duo — the org's
 * default day — not a per-colleague profile; see the daemon's
 * scheduled-sends.ts for that simplification.
 */
export function SendingSettings({ api }: { api: DuoApiConfig | null }) {
  const [undoSeconds, setUndoSeconds] = useState<UndoSendSeconds>(readUndoSendSeconds);
  return (
    <>
      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-undo-send">
        <h2 className="type-heading">Undo send</h2>
        <p className="type-provenance text-[var(--muted)]">
          After you tap Send, your reply waits this long before it goes, so you can take it back. Nothing reaches the conversation until
          then.
        </p>
        <label className="type-provenance text-[var(--muted)]" htmlFor="settings-undo-send-input">
          Time to undo
        </label>
        <select
          aria-label="Time to undo"
          className="min-h-11 self-start rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
          data-testid="settings-undo-send-select"
          id="settings-undo-send-input"
          onChange={(e) => {
            const next = Number(e.target.value) as UndoSendSeconds;
            writeUndoSendSeconds(next);
            setUndoSeconds(next);
          }}
          value={undoSeconds}
        >
          {UNDO_SEND_CHOICES.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds === 0 ? "Off — send straight away" : `${seconds} seconds`}
            </option>
          ))}
        </select>
      </section>
      {api && <AutonomyHoldSection api={api} />}
      {api && <WorkingHoursSection api={api} />}
    </>
  );
}

/** #268: the undo-window choices for what your duo sends by itself. 0 is offered, but only behind its own confirmation. */
export const AUTONOMY_HOLD_CHOICES = [10, 15, 30, 60, 120, 300] as const;

/**
 * #268: how long a reply your duo sends by itself (under autonomy you granted,
 * #266) waits for Stop or Edit. Kept by the daemon, unlike Undo send above —
 * the daemon is what holds these replies, whether or not this app is open.
 * Turning it off is possible but never a single slip: choosing "Off" asks
 * first, and the daemon refuses a 0 that doesn't carry that confirmation.
 */
function AutonomyHoldSection({ api }: { api: DuoApiConfig }) {
  const settings = useAutonomySettings(api);
  const save = useSaveAutonomySettings(api);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const current = typeof settings.data?.holdSeconds === "number" ? settings.data.holdSeconds : 30;
  const choices: number[] = (AUTONOMY_HOLD_CHOICES as readonly number[]).includes(current) || current === 0 ? [...AUTONOMY_HOLD_CHOICES] : [...AUTONOMY_HOLD_CHOICES, current].sort((a, b) => a - b);
  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-autonomy-hold">
      <h2 className="type-heading">When your duo answers by itself</h2>
      <p className="type-provenance text-[var(--muted)]">
        For people you&rsquo;ve let it answer, each reply waits this long first, so you can stop or edit it — from Waiting on you or a
        notification.
      </p>
      <select
        aria-label="Time to stop it"
        className="min-h-11 self-start rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
        data-testid="settings-autonomy-hold-select"
        disabled={save.isPending}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (next === 0) {
            setConfirmingOff(true);
            return;
          }
          setConfirmingOff(false);
          save.mutate({ holdSeconds: next });
        }}
        value={confirmingOff ? 0 : current}
      >
        {choices.map((seconds) => (
          <option key={seconds} value={seconds}>
            {seconds >= 60 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} seconds`}
          </option>
        ))}
        <option value={0}>Off — send straight away</option>
      </select>
      {confirmingOff && (
        <div className="flex flex-col gap-2" data-testid="settings-autonomy-hold-confirm" role="alertdialog" aria-label="Turn off the wait?">
          <p className="type-body">With no wait, your duo&rsquo;s replies go out the moment they&rsquo;re written — there is no chance to stop one.</p>
          <div className="flex flex-wrap gap-2">
            <button
              autoFocus
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
              data-testid="settings-autonomy-hold-keep"
              onClick={() => setConfirmingOff(false)}
              type="button"
            >
              Keep the wait
            </button>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--refused)]"
              data-testid="settings-autonomy-hold-off"
              onClick={() => {
                setConfirmingOff(false);
                save.mutate({ holdSeconds: 0, confirmNoHold: true });
              }}
              type="button"
            >
              Turn it off
            </button>
          </div>
        </div>
      )}
      <MutationError error={save.error} />
    </section>
  );
}

function WorkingHoursSection({ api }: { api: DuoApiConfig }) {
  const hours = useWorkingHours(api);
  const save = useSaveWorkingHours(api);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [timezone, setTimezone] = useState("UTC");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  useEffect(() => {
    // Only a whole answer replaces the defaults — a daemon that predates #261 has no such route, and an odd body must not crash Settings.
    const data = hours.data;
    if (data && typeof data.start === "string" && typeof data.end === "string" && typeof data.timezone === "string" && Array.isArray(data.days)) {
      setStart(data.start);
      setEnd(data.end);
      setTimezone(data.timezone);
      setDays(data.days);
    }
  }, [hours.data]);
  const deviceZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })();

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-working-hours">
      <h2 className="type-heading">Working hours</h2>
      <p className="type-provenance text-[var(--muted)]">
        &ldquo;Start of their working hours&rdquo; under Send later means the next time these hours begin. One setting for your duo, for
        everyone you reply to.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Working hours start"
          className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
          onChange={(e) => setStart(e.target.value)}
          type="time"
          value={start}
        />
        <span className="type-provenance text-[var(--muted)]">to</span>
        <input
          aria-label="Working hours end"
          className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
          onChange={(e) => setEnd(e.target.value)}
          type="time"
          value={end}
        />
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Working days">
        {DAY_NAMES.map((name, day) => (
          <button
            aria-pressed={days.includes(day)}
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 aria-pressed:bg-[var(--surface-2)]"
            key={name}
            onClick={() => setDays(days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b))}
            type="button"
          >
            {name}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Time zone"
          className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
          onChange={(e) => setTimezone(e.target.value)}
          value={timezone}
        />
        {timezone !== deviceZone && (
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
            onClick={() => setTimezone(deviceZone)}
            type="button"
          >
            Use {deviceZone}
          </button>
        )}
      </div>
      <button
        className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
        disabled={save.isPending || days.length === 0}
        onClick={() => save.mutate({ start, end, timezone: timezone.trim(), days })}
        type="button"
      >
        Save working hours
      </button>
      {save.isSuccess && <p className="type-provenance text-[var(--confident)]">Saved.</p>}
      <MutationError error={save.error} />
    </section>
  );
}
