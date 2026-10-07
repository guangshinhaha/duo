/**
 * duo#302: "Recent actions are remembered" — this device's own list of
 * which palette actions were run last, most-recent-first, same local-storage
 * shape and stance as `catchUpPrefs.ts`/`chatFilterPrefs.ts`: read fresh
 * where it's needed, remembered across launches, never synced to the
 * account (an action is a device habit, not workspace state).
 */

const RECENT_ACTIONS_KEY = "duo.command-palette.recent-actions";
const MAX_REMEMBERED = 6;

function readStored(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_ACTIONS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Most-recently-run action id first — whatever the palette hasn't run yet is simply absent. */
export function readRecentActionIds(): readonly string[] {
  return readStored();
}

/** Moves (or adds) `id` to the front, capped at `MAX_REMEMBERED` — an action run again is "more recent", not a duplicate entry. */
export function recordRecentAction(id: string): void {
  const next = [id, ...readStored().filter((existing) => existing !== id)].slice(0, MAX_REMEMBERED);
  try {
    localStorage.setItem(RECENT_ACTIONS_KEY, JSON.stringify(next));
  } catch {
    // Private window, blocked storage: the palette just stops remembering for this session — never a crash over a lost preference.
  }
}
