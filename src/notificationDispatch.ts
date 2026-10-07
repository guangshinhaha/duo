import { postNotification } from "./notifications.js";
import { isDndActive, readDndPrefs, recordMissed } from "./notificationPrefs.js";
import { NOTIFICATION_CATEGORIES, readNotificationCategorySetting, type NotificationCategory } from "./notificationCategoryPrefs.js";

/**
 * #309: "batched" assembly — a category set to batch holds what arrives
 * for it in memory and shows it as one summary every few minutes, rather
 * than one notification per arrival. In-memory and per-tab on purpose: it
 * is the same lifetime every other live notification path already has
 * (the socket, the open-tab Web Notification path) — nothing here is a
 * delivery guarantee, and a batch that was mid-window when the tab closed
 * is simply not shown, the same as any other live arrival this app never
 * queues for later (AR-15's stance applied to notifications, not just sends).
 */

const BATCH_WINDOW_MS = 5 * 60 * 1000;

interface QueuedArrival {
  readonly body: string;
  readonly hash: string;
}

const queues = new Map<NotificationCategory, QueuedArrival[]>();
const timers = new Map<NotificationCategory, ReturnType<typeof setTimeout>>();

function labelOf(category: NotificationCategory): string {
  return NOTIFICATION_CATEGORIES.find((entry) => entry.id === category)?.label ?? category;
}

/** One line for the window's whole queue — the single arrival's own words when there was only one, a count otherwise. */
function summarize(category: NotificationCategory, items: readonly QueuedArrival[]): QueuedArrival {
  const last = items[items.length - 1]!;
  if (items.length === 1) {
    return last;
  }
  return { body: `${items.length} ${labelOf(category).toLowerCase()}, waiting on you.`, hash: last.hash };
}

function flush(category: NotificationCategory): void {
  const items = queues.get(category) ?? [];
  queues.delete(category);
  timers.delete(category);
  if (items.length === 0) {
    return;
  }
  const { body, hash } = summarize(category, items);
  if (isDndActive(readDndPrefs(), new Date())) {
    recordMissed({ at: Date.now(), body, hash });
    return;
  }
  void postNotification(body, hash);
}

/**
 * Queues one arrival for `category`'s batch window, starting the window's
 * timer on its first arrival and leaving it running for any that follow —
 * one flush per window, never one timer per arrival. `windowMs` is
 * injectable so a test can observe a short window without faking the
 * module's own clock.
 */
export function queueForBatch(category: NotificationCategory, body: string, hash: string, windowMs: number = BATCH_WINDOW_MS): void {
  const list = queues.get(category) ?? [];
  list.push({ body, hash });
  queues.set(category, list);
  if (timers.has(category)) {
    return; // a flush is already scheduled for this window — this arrival joins it
  }
  timers.set(
    category,
    setTimeout(() => flush(category), windowMs),
  );
}

/** Test/lifecycle seam: flushes a category's queue right now, bypassing its timer (nothing live needs this outside tests today). */
export function flushNotificationBatchNow(category: NotificationCategory): void {
  const timer = timers.get(category);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  flush(category);
}

/** Test seam: drops every pending queue and timer, so one test's batch never leaks into the next. */
export function resetNotificationBatches(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
  queues.clear();
}

/**
 * #309: the one new choke point every category-gated firing site calls
 * instead of `postNotification` directly — additive beside the sites'
 * existing DND handling, never a restructuring of it. Off skips entirely
 * (the member's own choice, not a disturbance DND held back, so it is
 * never recorded as missed); batched joins this window's queue; immediate
 * falls through to exactly the DND check every one of those sites already
 * made before this existed.
 */
export async function notifyCategory(category: NotificationCategory, body: string, hash: string): Promise<void> {
  const setting = readNotificationCategorySetting(category);
  if (setting === "off") {
    return;
  }
  if (setting === "batched") {
    queueForBatch(category, body, hash);
    return;
  }
  if (isDndActive(readDndPrefs(), new Date())) {
    recordMissed({ at: Date.now(), body, hash });
    return;
  }
  await postNotification(body, hash);
}
