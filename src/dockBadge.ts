import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The macOS dock badge (#22 / §3.1): the same pending-draft count the
 * sidebar shows, mirrored into the shell so the owner can leave the app
 * closed until something needs them. Only meaningful inside the Tauri
 * shell — in a plain browser tab the invoke rejects, so this
 * feature-detects by trying and quietly degrades, exactly as
 * `src/notifications.ts` does. No permission prompt is involved, so unlike
 * notifications there is no cached state to manage: every call just tries.
 */
export async function setDockBadgeCount(count: number): Promise<void> {
  try {
    // `undefined` clears the badge; a count of zero is exactly "nothing
    // waiting", not "zero waiting".
    await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
  } catch {
    // Not in the Tauri shell: there is no dock here to badge, and that is
    // not an error anywhere the UI needs to show.
  }
}
