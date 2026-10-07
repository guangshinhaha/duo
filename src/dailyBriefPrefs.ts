/**
 * duo#282 (epic #279): the daily brief's own device rule — same
 * local-storage shape as `catchUpPrefs.ts`/`notificationCategoryPrefs.ts`.
 * "Delivered at the owner's chosen time" (AC) is this app's own read of a
 * chosen hour against the clock, since there is no server-side scheduler
 * or push infrastructure wired for this surface yet (`Duo.tsx`'s card is
 * the shipped half of the AC; the Mac tray and phone push half #282 also
 * names are explicitly out of scope here — see the PR description).
 */

const STORAGE_KEY = "duo.daily-brief";

interface StoredDailyBriefPrefs {
  readonly enabled: boolean;
  /** Local hour (0-23) past which the brief is "due" for today. */
  readonly hour: number;
  /** The last calendar date (YYYY-MM-DD, local) the brief was shown/dismissed — null before ever shown. */
  readonly lastShownDate: string | null;
}

const DEFAULT_PREFS: StoredDailyBriefPrefs = { enabled: true, hour: 8, lastShownDate: null };

function readStored(): StoredDailyBriefPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_PREFS;
    }
    const parsed = JSON.parse(raw) as Partial<StoredDailyBriefPrefs>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_PREFS.enabled,
      hour: typeof parsed.hour === "number" && parsed.hour >= 0 && parsed.hour <= 23 ? parsed.hour : DEFAULT_PREFS.hour,
      lastShownDate: typeof parsed.lastShownDate === "string" ? parsed.lastShownDate : null,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writeStored(prefs: StoredDailyBriefPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private window, blocked storage: the choice lasts this session only.
  }
}

export function readDailyBriefEnabled(): boolean {
  return readStored().enabled;
}

export function writeDailyBriefEnabled(enabled: boolean): void {
  writeStored({ ...readStored(), enabled });
}

export function readDailyBriefHour(): number {
  return readStored().hour;
}

export function writeDailyBriefHour(hour: number): void {
  writeStored({ ...readStored(), hour: Math.min(23, Math.max(0, Math.round(hour))) });
}

function localDateString(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Whether the brief is due: enabled, past the chosen hour today, and not already shown today. */
export function isDailyBriefDue(now: Date = new Date()): boolean {
  const prefs = readStored();
  return prefs.enabled && now.getHours() >= prefs.hour && prefs.lastShownDate !== localDateString(now);
}

/** The ISO timestamp the brief's own `since` should ask for: the last time it was shown, so a day with the card left open doesn't re-count what it already said. Null (the daemon's own 24h default) before ever shown. */
export function dailyBriefSince(): string | null {
  const prefs = readStored();
  return prefs.lastShownDate ? new Date(`${prefs.lastShownDate}T00:00:00`).toISOString() : null;
}

export function markDailyBriefShown(now: Date = new Date()): void {
  writeStored({ ...readStored(), lastShownDate: localDateString(now) });
}
