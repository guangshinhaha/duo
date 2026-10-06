/**
 * #291: "recently used" for the full emoji picker — same local-storage shape
 * as `urlPreviewPrefs.ts`/`factCheckPrefs.ts`, a member's own device memory,
 * read fresh where it's needed. It remembers *which emoji this member
 * reaches for*, not which room or message — reactions are a personal habit,
 * not room state, and the homeserver already holds the room's own truth
 * (the `m.reaction` events themselves). Unreadable or empty storage reads
 * back as no recents, never a stale or invented list.
 */

export const REACTION_RECENTS_STORAGE_KEY = "duo.reaction-recents";

/** How many recents are worth showing — a picker's top row, not a history. */
const MAX_RECENTS = 24;

/** Most-recent-first, de-duplicated. Corrupt or missing storage reads as empty. */
export function readReactionRecents(): readonly string[] {
  try {
    const raw = localStorage.getItem(REACTION_RECENTS_STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string").slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/** Moves `emoji` to the front, dropping any earlier occurrence, capped at `MAX_RECENTS`. */
export function recordReactionRecent(emoji: string): void {
  try {
    const next = [emoji, ...readReactionRecents().filter((entry) => entry !== emoji)].slice(0, MAX_RECENTS);
    localStorage.setItem(REACTION_RECENTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private window, blocked storage: this pick just isn't remembered for next time.
  }
}
