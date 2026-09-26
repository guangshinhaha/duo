import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, onAction, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

/**
 * Native notifications — build step C5 (`client-tech-design.md` §1.7 /
 * tech-design C5), widened past drafts by #69: a message, and the owner's
 * duo acting on the owner's behalf, notify too, each in its own words.
 * Only meaningful inside the Tauri shell: in a plain browser tab the
 * plugin's calls reject, so every entry point here feature-detects and
 * quietly degrades instead of making the web client depend on the shell
 * (#69 AC4). C7's WebSocket draft-ready channel and the workspace's live
 * arrivals are the callers — a notification fires on the arrival itself,
 * never on a poll, because a notification the owner already saw in the
 * open window is noise.
 *
 * Permission is cached in a module-level variable rather than asked for on
 * every message: macOS prompts once per app, and re-requesting after a
 * denial is both useless and hostile.
 */
let permission: "unknown" | "granted" | "denied" = "unknown";

/*
 * #25: a notification opens what it is about. The plugin's action callback
 * echoes the notification's own options, and its only caller-controllable
 * field is a 32-bit integer `id` — so each notification carries the next
 * integer and this map carries the integer→address half the wire cannot
 * (#69: any address, not only a draft's). Bounded: a click arriving on a
 * long-gone notification finds no entry, which the handler treats as
 * "not ours" and ignores.
 */
let nextNotificationId = 1;
const hashByNotificationId = new Map<number, string>();

function boundNotificationIds(): void {
  if (hashByNotificationId.size > 100) {
    const oldest = hashByNotificationId.keys().next();
    if (!oldest.done) {
      hashByNotificationId.delete(oldest.value);
    }
  }
}

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

/** Posts one notification under the app's name, opening `hash` when clicked. */
export async function postNotification(body: string, hash: string): Promise<void> {
  if (!(await ensureNotificationPermission())) {
    return;
  }
  try {
    const id = nextNotificationId++;
    hashByNotificationId.set(id, hash);
    boundNotificationIds();
    sendNotification({ id, title: "Duo", body });
  } catch {
    // A failed notification must never break the surface that triggered it —
    // the message is still in the conversation either way.
  }
}

export async function notifyDraftReady(draftId: string): Promise<void> {
  await postNotification("A new draft is waiting for your review.", `#draft/${encodeURIComponent(draftId)}`);
}

/**
 * #69 AC3: the duo's own acts carry their own words. An escalation and a
 * refusal each say what happened, in a category no message or draft copy
 * occupies; a plain draft is none of the duo's own acts — null, so the
 * caller keeps the draft copy that already exists and the two categories
 * can never blur.
 */
export function draftArrivalBody(record: { escalated: boolean; refused: boolean }): string | null {
  if (!record.escalated) {
    return null;
  }
  return record.refused ? "Your duo refused to answer for you." : "Your duo escalated a question to you.";
}

/**
 * Subscribes, once per app, to notification clicks and routes them to the
 * address each notification is about. Returns the unwire function (the
 * caller owns the subscription's lifetime) or null outside the shell — a
 * plain browser tab has no notifications to click, which is not an error
 * anywhere the UI needs to show.
 */
export async function wireNotificationClicks(): Promise<(() => void) | null> {
  try {
    const listener = await onAction((notification) => {
      const hash = notification.id !== undefined ? hashByNotificationId.get(notification.id) : undefined;
      if (hash !== undefined) {
        // #42: the click arrived from outside the app (the notification
        // centre), and the shell's close button hides rather than quits —
        // so the window may be hidden. Bring it up before navigating, or
        // the navigation lands where nobody sees it. getCurrentWindow
        // throws synchronously outside the shell, and show() itself can
        // reject; a failed reveal is not a failed click, so both are
        // swallowed and the navigation below still runs.
        try {
          void getCurrentWindow().show().catch(() => {});
        } catch {
          // Plain browser tab: there is no window to reveal.
        }
        window.location.hash = hash;
      }
    });
    return () => void listener.unregister();
  } catch {
    return null;
  }
}
