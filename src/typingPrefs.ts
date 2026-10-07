/**
 * #285: whether THIS member sends typing notifications at all — "sending
 * typing can be turned off" (#285 AC2). Same local-storage shape as
 * `urlPreviewPrefs.ts`/`factCheckPrefs.ts`/`notificationPrefs.ts` — a
 * member's own device choice, read fresh where it's needed, remembered
 * across launches, never a workspace- or account-level setting. Unlike
 * those two (which default closed because they cost something — a
 * server-side fetch, a quiet corpus check), typing is the ordinary
 * messenger behaviour every member already expects from every other chat
 * app, so this one defaults OPEN: unset or unreadable storage reads as ON,
 * and the member turns it off in Settings if they'd rather not announce
 * it. Turning it off only ever stops SENDING this member's own typing —
 * it never hides anyone else's, which has no setting at all (#285 AC1).
 */

export const TYPING_STORAGE_KEY = "duo.send-typing";

export function readTypingPref(): boolean {
  try {
    const stored = localStorage.getItem(TYPING_STORAGE_KEY);
    return stored === null || stored === "on";
  } catch {
    return true;
  }
}

export function writeTypingPref(enabled: boolean): void {
  try {
    localStorage.setItem(TYPING_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Private window, blocked storage: the choice lasts this session only — and reads back ON next launch, same default as never having chosen at all.
  }
}
