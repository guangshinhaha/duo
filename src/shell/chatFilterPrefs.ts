/**
 * #298: the quick filter chips above the chat list — Unread, Mentions and
 * Duos narrow the room sections to a question of one fact each; All clears
 * it. Remembered on this device (same local-storage shape as `theme.ts` and
 * `notificationPrefs.ts`) so the list opens on the owner's last choice
 * rather than resetting to All every launch — the issue's own acceptance
 * criterion.
 *
 * "Waiting on you" and "Confirmations" stay their own addresses (`#waiting`,
 * `#confirmations`) and `ChatShell.tsx`'s own sticky mechanism — queues of
 * drafts and staged actions across kinds a room section can't hold (a
 * standalone draft, a bridged asker), not a question a `RoomSummary` can
 * answer by itself the way Unread, Mentions and Duos can.
 */

export type ChatSectionFilter = "all" | "unread" | "mentions" | "duos";

export const CHAT_SECTION_FILTERS: readonly ChatSectionFilter[] = ["all", "unread", "mentions", "duos"];

export const CHAT_FILTER_STORAGE_KEY = "duo.chat-filter";

/** The remembered filter, or "all" for nothing (or something stale) remembered. */
export function readChatSectionFilter(): ChatSectionFilter {
  try {
    const raw = localStorage.getItem(CHAT_FILTER_STORAGE_KEY);
    return (CHAT_SECTION_FILTERS as readonly string[]).includes(raw ?? "") ? (raw as ChatSectionFilter) : "all";
  } catch {
    return "all";
  }
}

/** Remembers the choice — a private window or blocked storage just means it lasts this session only. */
export function writeChatSectionFilter(filter: ChatSectionFilter): void {
  try {
    localStorage.setItem(CHAT_FILTER_STORAGE_KEY, filter);
  } catch {
    // not remembered: it simply follows this session
  }
}
