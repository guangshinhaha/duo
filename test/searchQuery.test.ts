import { describe, expect, it } from "vitest";
import {
  EMPTY_SEARCH_FILTERS,
  filterChips,
  hasActiveFilters,
  matchesFilters,
  parseSearchQuery,
  withoutFilter,
  type SearchFilters,
} from "../src/workspace/searchQuery.js";
import type { MessageSearchHit } from "../src/workspace/matrix.js";

function hit(over: Partial<MessageSearchHit> = {}): MessageSearchHit {
  return {
    eventId: "$e",
    roomId: "!r:example",
    senderId: "@bose:example",
    senderName: "Bose",
    body: "refund policy",
    originServerTs: Date.UTC(2026, 9, 15), // 2026-10-15
    threadRootEventId: null,
    context: { before: [], after: [] },
    ...over,
  };
}

describe("duo#300 — parseSearchQuery", () => {
  it("is the whole string as the term, with no filters, when there are no tokens", () => {
    expect(parseSearchQuery("refund policy")).toEqual({ term: "refund policy", filters: EMPTY_SEARCH_FILTERS, invalidDateTokens: [] });
  });

  it("pulls from: and in: out of the term, unquoted", () => {
    const { term, filters } = parseSearchQuery("from:aisha in:release refund policy");
    expect(term).toBe("refund policy");
    expect(filters).toMatchObject({ from: "aisha", in: "release" });
  });

  it("a quoted value carries spaces", () => {
    const { term, filters } = parseSearchQuery('in:"release planning" budget');
    expect(term).toBe("budget");
    expect(filters.in).toBe("release planning");
  });

  it("before:/after: parse YYYY-MM-DD into UTC day boundaries", () => {
    const { term, filters } = parseSearchQuery("after:2026-09-01 before:2026-10-01 refund");
    expect(term).toBe("refund");
    expect(filters.after).toBe(Date.UTC(2026, 8, 1));
    expect(filters.before).toBe(Date.UTC(2026, 9, 1));
  });

  it("is case-insensitive on the key", () => {
    expect(parseSearchQuery("FROM:aisha refund").filters.from).toBe("aisha");
  });

  it("the last of a repeated key wins", () => {
    expect(parseSearchQuery("from:aisha from:bose refund").filters.from).toBe("bose");
  });

  it("collapses the whitespace a removed token leaves behind", () => {
    expect(parseSearchQuery("from:aisha   refund   policy").term).toBe("refund policy");
  });

  it("an invalid date is kept off the filter and named back, rather than silently dropped", () => {
    const { filters, invalidDateTokens } = parseSearchQuery("before:not-a-date refund");
    expect(filters.before).toBeNull();
    expect(invalidDateTokens).toEqual(["before:not-a-date"]);
  });

  it("refuses a calendar date that doesn't exist, rather than letting it roll into the next month", () => {
    const { filters, invalidDateTokens } = parseSearchQuery("before:2026-02-30 refund");
    expect(filters.before).toBeNull();
    expect(invalidDateTokens).toEqual(["before:2026-02-30"]);
  });

  it("a token with no value after the colon is dropped, not treated as empty-string from:", () => {
    expect(parseSearchQuery("from: refund").filters.from).toBeNull();
  });

  it("a query with only filter tokens leaves an empty term", () => {
    expect(parseSearchQuery("from:aisha in:release").term).toBe("");
  });
});

describe("duo#300 — matchesFilters", () => {
  it("matches everything against EMPTY_SEARCH_FILTERS", () => {
    expect(matchesFilters(hit(), "Release", EMPTY_SEARCH_FILTERS)).toBe(true);
  });

  it("from: matches the sender's name as a case-insensitive substring", () => {
    const filters: SearchFilters = { ...EMPTY_SEARCH_FILTERS, from: "bos" };
    expect(matchesFilters(hit({ senderName: "Bose" }), "Release", filters)).toBe(true);
    expect(matchesFilters(hit({ senderName: "Aisha" }), "Release", filters)).toBe(false);
  });

  it("in: matches the room's title the same way", () => {
    const filters: SearchFilters = { ...EMPTY_SEARCH_FILTERS, in: "release" };
    expect(matchesFilters(hit(), "Release planning", filters)).toBe(true);
    expect(matchesFilters(hit(), "General", filters)).toBe(false);
  });

  it("after: includes the named day and everything later", () => {
    const filters: SearchFilters = { ...EMPTY_SEARCH_FILTERS, after: Date.UTC(2026, 9, 15) };
    expect(matchesFilters(hit({ originServerTs: Date.UTC(2026, 9, 15) }), "x", filters)).toBe(true);
    expect(matchesFilters(hit({ originServerTs: Date.UTC(2026, 9, 14, 23, 59) }), "x", filters)).toBe(false);
  });

  it("before: excludes the named day and everything later", () => {
    const filters: SearchFilters = { ...EMPTY_SEARCH_FILTERS, before: Date.UTC(2026, 9, 15) };
    expect(matchesFilters(hit({ originServerTs: Date.UTC(2026, 9, 14, 23, 59) }), "x", filters)).toBe(true);
    expect(matchesFilters(hit({ originServerTs: Date.UTC(2026, 9, 15) }), "x", filters)).toBe(false);
  });

  it("after and before combine to a half-open range", () => {
    const filters: SearchFilters = { ...EMPTY_SEARCH_FILTERS, after: Date.UTC(2026, 9, 1), before: Date.UTC(2026, 9, 15) };
    expect(matchesFilters(hit({ originServerTs: Date.UTC(2026, 9, 10) }), "x", filters)).toBe(true);
    expect(matchesFilters(hit({ originServerTs: Date.UTC(2026, 8, 30) }), "x", filters)).toBe(false);
    expect(matchesFilters(hit({ originServerTs: Date.UTC(2026, 9, 20) }), "x", filters)).toBe(false);
  });
});

describe("duo#300 — hasActiveFilters / filterChips / withoutFilter", () => {
  it("hasActiveFilters is false for the empty filters and true for any one", () => {
    expect(hasActiveFilters(EMPTY_SEARCH_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_SEARCH_FILTERS, from: "bose" })).toBe(true);
  });

  it("filterChips renders one labelled chip per active filter, in a fixed order", () => {
    const filters: SearchFilters = { from: "bose", in: "release", after: Date.UTC(2026, 8, 1), before: Date.UTC(2026, 9, 1) };
    expect(filterChips(filters)).toEqual([
      { key: "from", label: "from: bose" },
      { key: "in", label: "in: release" },
      { key: "after", label: "after: 2026-09-01" },
      { key: "before", label: "before: 2026-10-01" },
    ]);
  });

  it("filterChips is empty for the empty filters", () => {
    expect(filterChips(EMPTY_SEARCH_FILTERS)).toEqual([]);
  });

  it("withoutFilter clears only the named key", () => {
    const filters: SearchFilters = { from: "bose", in: "release", after: null, before: null };
    expect(withoutFilter(filters, "from")).toEqual({ from: null, in: "release", after: null, before: null });
  });
});
