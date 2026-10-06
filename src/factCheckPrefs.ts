/**
 * #264: whether THIS member's composer quietly checks their own typed
 * text against the corpus before they send. Same local-storage shape as
 * `urlPreviewPrefs.ts` (and `theme.ts`, `notificationPrefs.ts`) — a
 * member's own device choice, read fresh where it's needed, remembered
 * across launches. Off by default per the issue's own acceptance
 * criteria: unset or unreadable storage reads as OFF, never on by
 * accident, same as link previews' own default-closed stance.
 */

export const FACT_CHECK_STORAGE_KEY = "duo.fact-check";

export function readFactCheckPref(): boolean {
  try {
    return localStorage.getItem(FACT_CHECK_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeFactCheckPref(enabled: boolean): void {
  try {
    localStorage.setItem(FACT_CHECK_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Private window, blocked storage: the choice lasts this session only — and reads back OFF next launch, the safe side to fail on.
  }
}
