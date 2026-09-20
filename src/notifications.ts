import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

/**
 * Native "a new draft is waiting" notifications — build step C5
 * (`client-tech-design.md` §1.7 / tech-design C5). Only meaningful inside
 * the Tauri shell: in a plain browser tab the plugin's calls reject, so
 * every entry point here feature-detects and quietly degrades instead of
 * making the web client depend on the shell. C7's WebSocket draft-ready
 * channel is the caller — notifications fire on the push message, never on
 * a poll, because a notification the owner already saw in the open window
 * is noise.
 *
 * Permission is cached in a module-level variable rather than asked for on
 * every message: macOS prompts once per app, and re-requesting after a
 * denial is both useless and hostile.
 */
let permission: "unknown" | "granted" | "denied" = "unknown";

export async function ensureNotificationPermission(): Promise<boolean> {
  if (permission === "granted") {
    return true;
  }
  if (permission === "denied") {
    return false;
  }
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    permission = granted ? "granted" : "denied";
    return granted;
  } catch {
    // Not in the Tauri shell (plain browser): notifications simply don't
    // exist here, and that is not an error anywhere the UI needs to show.
    permission = "denied";
    return false;
  }
}

export async function notifyDraftReady(): Promise<void> {
  if (!(await ensureNotificationPermission())) {
    return;
  }
  try {
    sendNotification({ title: "Duo", body: "A new draft is waiting for your review." });
  } catch {
    // A failed notification must never break the surface that triggered it —
    // the draft is still in the Review list either way.
  }
}
