import type { MessageSearchHit } from "./matrix.js";

/**
 * duo#300: Slack-shaped filter chips on top of "search what was said"
 * (#70/#207) — `from:`, `in:`, `before:`, `after:`. Deliberately client-side
 * only, applied to the hits the homeserver's own membership-scoped search
 * already returned: `WorkspaceSearchSeam.test.ts` pins that `searchMessages`
 * asks the homeserver no question about which rooms to search ("a
 * client-chosen room list would be a second opinion about membership") —
 * these filters narrow what's already on screen, they never change what was
 * asked of the server. `before`/`after` are UTC day boundaries: the
 * homeserver's own `originServerTs` is a UTC epoch, and a client-local
 * boundary would make the same query match different messages depending on
 * the member's timezone.
 */
export interface SearchFilters {
  readonly from: string | null;
  readonly in: string | null;
  /** Epoch ms, exclusive upper bound (strictly before this instant). */
  readonly before: number | null;
  /** Epoch ms, inclusive lower bound. */
  readonly after: number | null;
}

export const EMPTY_SEARCH_FILTERS: SearchFilters = { from: null, in: null, before: null, after: null };

export interface ParsedSearchQuery {
  /** The free-text term, with every recognised `key:value` token removed — this is what rides the homeserver's own full-text search. */
  readonly term: string;
  readonly filters: SearchFilters;
  /** A `before:`/`after:` token whose value wasn't a valid `YYYY-MM-DD` date — kept so the UI can say which token it couldn't use, rather than silently dropping it. */
  readonly invalidDateTokens: readonly string[];
}

const TOKEN = /\b(from|in|before|after):("([^"]*)"|\S+)/gi;

/** `YYYY-MM-DD` only, parsed as a UTC day boundary — same discipline as `originServerTs`, below. `Date.UTC` rejects nothing by itself (it rolls over), so the three parts are range-checked by hand. */
function parseUtcDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const [, y, m, d] = match.map(Number);
  if (m! < 1 || m! > 12 || d! < 1 || d! > 31) {
    return null;
  }
  const ms = Date.UTC(y!, m! - 1, d!);
  // Date.UTC silently rolls an out-of-range day (e.g. 2026-02-30) into the
  // next month rather than refusing it — reading the date back off the
  // result and comparing catches that roll-over.
  const roundTrip = new Date(ms);
  if (roundTrip.getUTCFullYear() !== y || roundTrip.getUTCMonth() !== m! - 1 || roundTrip.getUTCDate() !== d) {
    return null;
  }
  return ms;
}

/**
 * Pulls every recognised `key:value` token out of `raw`, leaving the rest as
 * the free-text term. A value may be quoted (`in:"release planning"`) to
 * carry spaces; unquoted, it runs to the next whitespace. A key may appear
 * more than once — the last one wins, matching how a member re-typing a
 * chip's value would expect it to behave.
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  let from: string | null = null;
  let inValue: string | null = null;
  let before: number | null = null;
  let after: number | null = null;
  const invalidDateTokens: string[] = [];

  const term = raw
    .replace(TOKEN, (full, key: string, _rawValue: string, quoted: string | undefined) => {
      const value = (quoted ?? full.slice(key.length + 1)).trim();
      if (value === "") {
        return "";
      }
      switch (key.toLowerCase()) {
        case "from":
          from = value;
          break;
        case "in":
          inValue = value;
          break;
        case "before": {
          const parsed = parseUtcDate(value);
          if (parsed === null) {
            invalidDateTokens.push(full);
          } else {
            before = parsed;
          }
          break;
        }
        case "after": {
          const parsed = parseUtcDate(value);
          if (parsed === null) {
            invalidDateTokens.push(full);
          } else {
            // Inclusive of the named day: "after:2026-10-01" starts matching at that day's first instant.
            after = parsed;
          }
          break;
        }
      }
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();

  return { term, filters: { from, in: inValue, before, after }, invalidDateTokens };
}

/** Whether `filters` holds nothing — the common case, and the chip row's own cue to render nothing. */
export function hasActiveFilters(filters: SearchFilters): boolean {
  return filters.from !== null || filters.in !== null || filters.before !== null || filters.after !== null;
}

/**
 * Narrows already-fetched hits by `filters` — presentation only, never a
 * second request. `from`/`in` match as a case-insensitive substring of the
 * room's title or the sender's name: both are claims a room already shows
 * (#60's own "a name is a claim" discipline), not an id lookup, so a filter
 * never needs to resolve a person or a conversation before it can narrow
 * anything. `after:2026-10-01` includes that day (and everything later);
 * `before:2026-10-01` excludes it (up to, not through) — the two combine to
 * mean "on or after the first, up to but not including the second".
 */
export function matchesFilters(hit: MessageSearchHit, roomTitle: string, filters: SearchFilters): boolean {
  if (filters.from !== null && !hit.senderName.toLowerCase().includes(filters.from.toLowerCase())) {
    return false;
  }
  if (filters.in !== null && !roomTitle.toLowerCase().includes(filters.in.toLowerCase())) {
    return false;
  }
  if (filters.after !== null && hit.originServerTs < filters.after) {
    return false;
  }
  // before:D excludes D's own first instant and everything after — "up to, not through" that day.
  if (filters.before !== null && hit.originServerTs >= filters.before) {
    return false;
  }
  return true;
}

/** One removable chip, in display order — the row the search results render above themselves. */
export interface SearchFilterChip {
  readonly key: "from" | "in" | "before" | "after";
  readonly label: string;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function filterChips(filters: SearchFilters): readonly SearchFilterChip[] {
  const chips: SearchFilterChip[] = [];
  if (filters.from !== null) {
    chips.push({ key: "from", label: `from: ${filters.from}` });
  }
  if (filters.in !== null) {
    chips.push({ key: "in", label: `in: ${filters.in}` });
  }
  if (filters.after !== null) {
    chips.push({ key: "after", label: `after: ${isoDay(filters.after)}` });
  }
  if (filters.before !== null) {
    chips.push({ key: "before", label: `before: ${isoDay(filters.before)}` });
  }
  return chips;
}

/** Removing one chip — the rest of the filters, and the term, are untouched. */
export function withoutFilter(filters: SearchFilters, key: SearchFilterChip["key"]): SearchFilters {
  return { ...filters, [key]: null };
}
