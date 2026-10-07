/**
 * duo#305: the member's own device rule for suggestion chips — starters
 * on an empty Your duo, and up to three follow-ups after an answer. Same
 * local-storage shape as `dailyBriefPrefs.ts`/`catchUpPrefs.ts`: read
 * fresh where it's needed, remembered across launches, never synced to
 * the account. On by default, same reasoning as those: a new setting
 * must never silently turn off something that otherwise matches its
 * threshold. One switch for both surfaces (AC3, "chips can be turned
 * off") — they're the same affordance, offered at two moments.
 */

const STORAGE_KEY = "duo.suggestion-chips";

export function readSuggestionChipsEnabled(): boolean {
  try {
    // On by default: anything but an explicit "off" (unset, corrupt,
    // anything else written under this key) reads as on — the safe side
    // to fail on for a setting that starts enabled, same reasoning
    // dailyBriefPrefs.ts/catchUpPrefs.ts apply to their own malformed
    // JSON (a bad field falls back to their default, never to off).
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeSuggestionChipsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Private window, blocked storage: the choice lasts this session only.
  }
}
