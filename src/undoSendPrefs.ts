/**
 * #260: how long a tapped Send is held on this device before it is really
 * sent — Gmail's undo send. Held here, client-side, on purpose: nothing is
 * posted to the daemon until the countdown ends, so an Undo inside it means
 * nothing ever reached the room and the draft simply stays waiting on you.
 *
 * Same local-storage shape as urlPreviewPrefs.ts: this member's own rule for
 * their own taps, remembered across launches. Unset or unreadable storage
 * reads as the default (10s) — the safe side, a moment to take it back.
 */

export const UNDO_SEND_STORAGE_KEY = "duo.undo-send";

/** The choices the setting offers, in seconds; 0 is off. */
export const UNDO_SEND_CHOICES = [0, 5, 10, 20] as const;
export type UndoSendSeconds = (typeof UNDO_SEND_CHOICES)[number];

export const DEFAULT_UNDO_SEND_SECONDS: UndoSendSeconds = 10;

export function readUndoSendSeconds(): UndoSendSeconds {
  try {
    const raw = localStorage.getItem(UNDO_SEND_STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return (UNDO_SEND_CHOICES as readonly number[]).includes(parsed) ? (parsed as UndoSendSeconds) : DEFAULT_UNDO_SEND_SECONDS;
  } catch {
    return DEFAULT_UNDO_SEND_SECONDS;
  }
}

export function writeUndoSendSeconds(seconds: UndoSendSeconds): void {
  try {
    localStorage.setItem(UNDO_SEND_STORAGE_KEY, String(seconds));
  } catch {
    // Blocked storage: the choice lasts this session only, and reads back as the default next launch.
  }
}
