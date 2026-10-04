/**
 * #219: whether THIS member sees link preview cards at all. Same
 * local-storage shape as theme.ts and notificationPrefs.ts — a member's own
 * device rule, read fresh where it's needed, remembered across launches —
 * because generating a preview means the homeserver itself fetches the
 * linked page server-side (Synapse's `/preview_url`): every link anyone
 * posts, previews on, is a request the org's infrastructure makes, timed to
 * the message and visible to the link's host. That is metadata leakage this
 * app's gov member base cannot default into, and #219 leaves the policy call
 * open — so until a human answers it, this device asks the homeserver for a
 * link's preview only when the member sitting at it said yes, explicitly,
 * here. OFF, and nowhere else to turn it on: not per room, not an org-wide
 * switch — one member's own choice, on their own device.
 */

export const URL_PREVIEW_STORAGE_KEY = "duo.link-previews";

/** The remembered choice — unset or unreadable storage reads as OFF, never on by accident. */
export function readUrlPreviewPref(): boolean {
  try {
    return localStorage.getItem(URL_PREVIEW_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeUrlPreviewPref(enabled: boolean): void {
  try {
    localStorage.setItem(URL_PREVIEW_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Private window, blocked storage: the choice lasts this session only — and reads back OFF next launch, the safe side to fail on.
  }
}
