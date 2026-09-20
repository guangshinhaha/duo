import { isPermissionGranted, onAction, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

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

/*
 * #25: a notification opens the draft it is about. The plugin's action
 * callback echoes the notification's own options, and its only
 * caller-controllable field is a 32-bit integer `id` — so each
 * draft-ready notification carries the next integer and this map carries
 * the integer→draft-id half the wire cannot. Bounded: a click arriving on
 * a long-gone notification finds no entry, which the handler treats as
 * "not ours" and ignores.
 */
let nextNotificationId = 1;
const draftIdByNotificationId = new Map<number, string>();

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

export async function notifyDraftReady(draftId: string): Promise<void> {
  if (!(await ensureNotificationPermission())) {
    return;
  }
  try {
    const id = nextNotificationId++;
    draftIdByNotificationId.set(id, draftId);
    if (draftIdByNotificationId.size > 100) {
      const oldest = draftIdByNotificationId.keys().next();
      if (!oldest.done) {
        draftIdByNotificationId.delete(oldest.value);
      }
    }
    sendNotification({ id, title: "Duo", body: "A new draft is waiting for your review." });
  } catch {
    // A failed notification must never break the surface that triggered it —
    // the draft is still in the Review list either way.
  }
}

/**
 * Subscribes, once per app, to notification clicks and routes them to the
 * clicked draft's own address. Returns the unwire function (the caller owns
 * the subscription's lifetime) or null outside the shell — a plain browser
 * tab has no notifications to click, which is not an error anywhere the UI
 * needs to show.
 */
export async function wireDraftNotificationClicks(): Promise<(() => void) | null> {
  try {
    const listener = await onAction((notification) => {
      const draftId = notification.id !== undefined ? draftIdByNotificationId.get(notification.id) : undefined;
      if (draftId !== undefined) {
        window.location.hash = `#draft/${draftId}`;
      }
    });
    return () => void listener.unregister();
  } catch {
    return null;
  }
}
