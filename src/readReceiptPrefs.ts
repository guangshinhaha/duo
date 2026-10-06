/**
 * #286: whether THIS member's read receipts stay private — same
 * local-storage shape as urlPreviewPrefs.ts/notificationPrefs.ts, one
 * member's own device rule. Matrix already carries the distinction natively
 * (`m.read` vs `m.read.private`, MSC2285): a private receipt still moves
 * this account's own read position (unread counts, `m.fully_read`, every
 * device this member signs into) — the only thing it withholds is telling
 * OTHER members in the room that this account has read up to here. Off by
 * default: a member who has never visited this setting keeps sending the
 * ordinary, visible receipt this app always has (#63) — turning this on is
 * an explicit, opt-in step, never a silent change in what other members see.
 */

export const PRIVATE_READ_RECEIPTS_STORAGE_KEY = "duo.private-read-receipts";

/** The remembered choice — unset or unreadable storage reads as OFF (ordinary, visible receipts), the behavior this app always had. */
export function readPrivateReceiptsPref(): boolean {
  try {
    return localStorage.getItem(PRIVATE_READ_RECEIPTS_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writePrivateReceiptsPref(enabled: boolean): void {
  try {
    localStorage.setItem(PRIVATE_READ_RECEIPTS_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Private window, blocked storage: the choice lasts this session only — and reads back OFF next launch, the safe side to fail on.
  }
}
