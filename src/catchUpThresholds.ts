/**
 * duo#280/#281: the thresholds past which a catch-up surface is worth
 * showing at all — both issues' own "How" names a number, so both live
 * here together rather than as a magic literal at each call site.
 */

/** #280 AC "Appears only past the threshold" — the issue's own example: "15+ unread or 2h". */
export const CATCH_UP_CARD_UNREAD_THRESHOLD = 15;
export const CATCH_UP_CARD_AGE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/** #281's own reference point: "Kakao's threshold avoids noise" — Kakao summarizes only past 5 unread. */
export const SIDEBAR_SUMMARY_UNREAD_THRESHOLD = 5;

/** #280: whether a room's unread window is busy enough for the catch-up card, given its count and the oldest unread message's age. */
export function isCatchUpCardThresholdMet(unreadCount: number, oldestUnreadAt: number, now: number): boolean {
  return unreadCount >= CATCH_UP_CARD_UNREAD_THRESHOLD || now - oldestUnreadAt >= CATCH_UP_CARD_AGE_THRESHOLD_MS;
}
