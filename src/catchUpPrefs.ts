/**
 * duo#280/#281 (epic #279): the member's own device rule for catch-up
 * summaries — same local-storage shape as `notificationCategoryPrefs.ts`,
 * `urlPreviewPrefs.ts` and `factCheckPrefs.ts` (read fresh where it's
 * needed, remembered across launches, never synced to the account). One
 * global "Summaries" setting covers both surfaces that share this
 * mechanism — the busy-room catch-up card (#280) and the sidebar's
 * one-line gist (#281) — because turning off "summaries" should mean
 * summaries, not one of the two places they show up; #280 additionally
 * offers a per-room off (its own AC), which #281 has no equivalent of
 * (its AC asks only for the global switch).
 */

export const CATCH_UP_STORAGE_KEY = "duo.catch-up-summaries";

interface StoredCatchUpPrefs {
  readonly enabled: boolean;
  readonly roomsOff: readonly string[];
}

const DEFAULT_PREFS: StoredCatchUpPrefs = { enabled: true, roomsOff: [] };

function readStored(): StoredCatchUpPrefs {
  try {
    const raw = localStorage.getItem(CATCH_UP_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_PREFS;
    }
    const parsed = JSON.parse(raw) as Partial<StoredCatchUpPrefs>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_PREFS.enabled,
      roomsOff: Array.isArray(parsed.roomsOff) ? parsed.roomsOff.filter((id): id is string => typeof id === "string") : DEFAULT_PREFS.roomsOff,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writeStored(prefs: StoredCatchUpPrefs): void {
  try {
    localStorage.setItem(CATCH_UP_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private window, blocked storage: the choice lasts this session only.
  }
}

/** The global switch — Settings' "Summaries" toggle, read fresh. On by default: a new setting must never silently turn off something that otherwise matches its threshold. */
export function readCatchUpEnabled(): boolean {
  return readStored().enabled;
}

export function writeCatchUpEnabled(enabled: boolean): void {
  writeStored({ ...readStored(), enabled });
}

/** #280's per-room off — the catch-up card's own "turn it off for this conversation" control. Never consulted by #281's sidebar line, which has no per-room setting of its own. */
export function isCatchUpOffForRoom(roomId: string): boolean {
  return readStored().roomsOff.includes(roomId);
}

export function setCatchUpOffForRoom(roomId: string, off: boolean): void {
  const current = readStored();
  const roomsOff = off ? [...new Set([...current.roomsOff, roomId])] : current.roomsOff.filter((id) => id !== roomId);
  writeStored({ ...current, roomsOff });
}

/** Whether the catch-up card may show in this room at all — the global switch and the per-room off, combined once so every call site asks the same question the same way. */
export function catchUpAllowedForRoom(roomId: string): boolean {
  const prefs = readStored();
  return prefs.enabled && !prefs.roomsOff.includes(roomId);
}
