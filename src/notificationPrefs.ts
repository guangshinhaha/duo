/**
 * #69: the member's own rule for what may interrupt THIS device. Two
 * things live here, both deliberately local — unlike the per-conversation
 * mode (homeserver state, the same on every device), do-not-disturb is
 * the member standing at THIS machine saying "leave me alone here", and
 * the record of what it held back is this device's own memory of it.
 *
 * Quiet hours are a daily window; `from` past midnight wraps (`22:00` to
 * `07:00` holds 22:00–24:00 and 00:00–07:00). A half-set window is no
 * window — both ends or none, the same stance a half-typed form takes.
 */

export interface DndPrefs {
  /** Manual do-not-disturb: on until the member turns it off. */
  readonly manual: boolean;
  /** "HH:MM" or null — a daily window's start. */
  readonly from: string | null;
  /** "HH:MM" or null — a daily window's end, exclusive. */
  readonly to: string | null;
}

export const DND_STORAGE_KEY = "duo.dnd";
export const MISSED_STORAGE_KEY = "duo.missed";

/** What do-not-disturb held back: the words it would have said, and where they pointed. */
export interface MissedArrival {
  readonly at: number;
  readonly body: string;
  readonly hash: string;
}

/** The log is bounded the notification id map is: a long disturbance cannot grow without limit. */
const MISSED_CAP = 50;

const OFF: DndPrefs = { manual: false, from: null, to: null };

/** The remembered rule — corrupt or stale storage reads as off, never as a crash. */
export function readDndPrefs(): DndPrefs {
  try {
    const raw = localStorage.getItem(DND_STORAGE_KEY);
    if (!raw) {
      return OFF;
    }
    const parsed = JSON.parse(raw) as Partial<DndPrefs>;
    return {
      manual: parsed.manual === true,
      from: typeof parsed.from === "string" ? parsed.from : null,
      to: typeof parsed.to === "string" ? parsed.to : null,
    };
  } catch {
    return OFF;
  }
}

export function writeDndPrefs(prefs: DndPrefs): void {
  try {
    localStorage.setItem(DND_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private window, blocked storage: the rule lasts this session only.
  }
}

function minutesOfDay(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":");
  return Number(hours ?? "0") * 60 + Number(minutes ?? "0");
}

/** Whether the rule holds right now — `now` injected so the window is testable at any clock. */
export function isDndActive(prefs: DndPrefs, now: Date): boolean {
  if (prefs.manual) {
    return true;
  }
  if (prefs.from === null || prefs.to === null) {
    return false;
  }
  const minute = now.getHours() * 60 + now.getMinutes();
  const from = minutesOfDay(prefs.from);
  const to = minutesOfDay(prefs.to);
  // A window that wraps midnight holds its start's evening and its end's
  // morning; any other window holds what falls between its ends.
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** The held-back log, oldest first — corrupt storage reads as nothing missed. */
export function readMissed(): readonly MissedArrival[] {
  try {
    const raw = localStorage.getItem(MISSED_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as MissedArrival[]) : [];
  } catch {
    return [];
  }
}

export function recordMissed(arrival: MissedArrival): void {
  const next = [...readMissed(), arrival].slice(-MISSED_CAP);
  try {
    localStorage.setItem(MISSED_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Blocked storage: this disturbance's record is the price, never the flow.
  }
}

export function clearMissed(): void {
  try {
    localStorage.setItem(MISSED_STORAGE_KEY, "[]");
  } catch {
    // Nothing to clear is not a failure.
  }
}
