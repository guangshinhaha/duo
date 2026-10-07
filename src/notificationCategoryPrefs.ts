/**
 * #309: a category on every notification, each with its own setting — the
 * member's own device rule, same local-storage shape as
 * `notificationPrefs.ts`, `urlPreviewPrefs.ts` and `factCheckPrefs.ts` (read
 * fresh where it's needed, remembered across launches). Four categories,
 * matching what the daemon's own notification sites already distinguish:
 *
 * - **draftsReady**: a plain draft is waiting (`notifyDraftReady`/the
 *   non-escalated half of a draft-ready push).
 * - **passedOn**: the duo's own act — it escalated a question to the owner,
 *   or refused one outright (the escalated half of a draft-ready push,
 *   `draftArrivalBody`). Grouped together because both arrive on the same
 *   wire event and both are the duo speaking about its own act, not a
 *   message anyone sent.
 * - **mentions**: a live arrival that names the member (`LiveArrival.mentionsMe`).
 * - **directMessages**: a live arrival in a direct conversation (`RoomSummary.kind === "direct"`)
 *   that isn't already a mention (mentions take the more specific category).
 * - **keywordAlerts** (#310): a live arrival matching one of the member's own
 *   keyword alerts (`App.tsx`'s `dispatchArrival`, `keywordAlertMatch.ts`) —
 *   the one category that also bypasses a room's own mute or mentions-only
 *   mode, because that is the whole point of a standing keyword alert
 *   ("I catch topics I own" regardless of what else is quiet). This
 *   setting still governs immediate/batched/off exactly like the other
 *   four; only the per-room mode is what it overrides.
 *
 * Each category is **immediate** (today's behaviour, and the default — a
 * new setting must never silently change what already ships), **batched**
 * (assembled into one summary every few minutes, `notificationBatch.ts`),
 * or **off**. This module holds only the setting; `notifications.ts`'s
 * `notifyCategory` is what reads it and decides what a firing site does.
 */

export type NotificationCategory = "draftsReady" | "passedOn" | "mentions" | "directMessages" | "keywordAlerts";

export type CategorySetting = "immediate" | "batched" | "off";

export type NotificationCategoryPrefs = Readonly<Record<NotificationCategory, CategorySetting>>;

export const NOTIFICATION_CATEGORY_STORAGE_KEY = "duo.notification-categories";

/** Display order and label, the same on the Settings screen and in a batch summary's words. */
export const NOTIFICATION_CATEGORIES: readonly { readonly id: NotificationCategory; readonly label: string }[] = [
  { id: "draftsReady", label: "Drafts ready" },
  { id: "mentions", label: "Mentions" },
  { id: "passedOn", label: "Passed-on questions" },
  { id: "directMessages", label: "Direct messages" },
  { id: "keywordAlerts", label: "Keyword alerts" },
];

/** Immediate everywhere — a new setting must never change what already ships until the member turns something off or batches it. */
const DEFAULT_PREFS: NotificationCategoryPrefs = {
  draftsReady: "immediate",
  passedOn: "immediate",
  mentions: "immediate",
  directMessages: "immediate",
  keywordAlerts: "immediate",
};

function isCategorySetting(value: unknown): value is CategorySetting {
  return value === "immediate" || value === "batched" || value === "off";
}

/** The remembered settings — corrupt, stale or partial storage reads back as the untouched categories' default, never as a crash. */
export function readNotificationCategoryPrefs(): NotificationCategoryPrefs {
  try {
    const raw = localStorage.getItem(NOTIFICATION_CATEGORY_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_PREFS;
    }
    const parsed = JSON.parse(raw) as Partial<Record<NotificationCategory, unknown>>;
    return {
      draftsReady: isCategorySetting(parsed.draftsReady) ? parsed.draftsReady : DEFAULT_PREFS.draftsReady,
      passedOn: isCategorySetting(parsed.passedOn) ? parsed.passedOn : DEFAULT_PREFS.passedOn,
      mentions: isCategorySetting(parsed.mentions) ? parsed.mentions : DEFAULT_PREFS.mentions,
      directMessages: isCategorySetting(parsed.directMessages) ? parsed.directMessages : DEFAULT_PREFS.directMessages,
      keywordAlerts: isCategorySetting(parsed.keywordAlerts) ? parsed.keywordAlerts : DEFAULT_PREFS.keywordAlerts,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeNotificationCategoryPrefs(prefs: NotificationCategoryPrefs): void {
  try {
    localStorage.setItem(NOTIFICATION_CATEGORY_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private window, blocked storage: the choice lasts this session only.
  }
}

/** One category's setting, read fresh — the shape every firing site actually wants. */
export function readNotificationCategorySetting(category: NotificationCategory): CategorySetting {
  return readNotificationCategoryPrefs()[category];
}
