import { getPlatform } from "./platform/index.js";
import { isDndActive, readDndPrefs, recordMissed } from "./notificationPrefs.js";

/**
 * Native notifications — build step C5 (`client-tech-design.md` §1.7 /
 * tech-design C5), widened past drafts by #69: a message, and the owner's
 * duo acting on the owner's behalf, notify too, each in its own words.
 * C7's WebSocket draft-ready channel and the workspace's live arrivals are
 * the callers — a notification fires on the arrival itself, never on a
 * poll, because a notification the owner already saw in the open window is
 * noise.
 *
 * #320: how a notification is shown — the Mac app's native one (C5/#25),
 * the browser's Web Notification API (#221), permission and click routing —
 * is the platform adapter's (src/platform/). This module only decides what
 * to say and where a click goes, and works unchanged wherever the app runs.
 */

/** Posts one notification under the app's name, opening `hash` when clicked. */
export async function postNotification(body: string, hash: string): Promise<void> {
  await getPlatform().notify("Duo", body, { hash });
}

export async function notifyDraftReady(draftId: string): Promise<void> {
  await postNotification("A new draft is waiting for your review.", `#draft/${encodeURIComponent(draftId)}`);
}

/**
 * #52: "the duo needs you to confirm before it acts". Deliberately says
 * nothing about WHAT — the words of a consequence belong on the surface that
 * can state all of it, where the owner reads them before any control; a
 * notification banner is the wrong place to summarise an irreversible step.
 * The click opens the confirmations surface and does nothing else: no
 * notification is ever a way to confirm.
 *
 * The duo's own acts are governed by no conversation's setting, but they
 * are the owner's to quiet on this device like any other (#69): while
 * do-not-disturb holds, the words go to the record Settings shows instead,
 * pointing at the same surface — the request itself stays visible in the
 * app either way, this only decides whether the shell speaks.
 */
export async function notifyConfirmationWaiting(): Promise<void> {
  const body = "Your duo needs your confirmation before it acts.";
  const hash = "#confirmations";
  if (isDndActive(readDndPrefs(), new Date())) {
    recordMissed({ at: Date.now(), body, hash });
    return;
  }
  await postNotification(body, hash);
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
 * Subscribes, once per app, to notification clicks arriving from outside the
 * page and routes them to the address each notification is about. Returns
 * the unwire function (the caller owns the subscription's lifetime) or null
 * where the platform has no such channel — not an error anywhere the UI
 * needs to show.
 */
export async function wireNotificationClicks(): Promise<(() => void) | null> {
  return getPlatform().wireNotificationClicks();
}
