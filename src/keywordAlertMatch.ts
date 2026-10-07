/**
 * #310: whether a live arrival's own words trip one of the member's keyword
 * alerts. The list of keywords itself lives server-side, as this account's
 * own Matrix content push rules (`workspace/matrix.ts`'s `keywordAlerts`) —
 * this module is only the client-side echo of that same decision, for the
 * one path (`dispatchArrival`, `App.tsx`) that decides whether THIS device
 * interrupts right now, the same local-evaluation shape `mentionsMe` and
 * every other arrival check already take.
 *
 * Whole-word, case-insensitive: "launch" matches "We launch Monday." but not
 * "launching" or "prelaunch" — the same "a word within the body" reading the
 * Matrix spec gives a content push rule's own pattern, kept simple here (no
 * glob wildcards) because Settings only ever lets the member type plain
 * words, never a pattern.
 */

/** Escapes a keyword for use inside a `RegExp`, so a member who types `.` or `(` gets a literal match, never a broken or surprising one. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `body` contains `keyword` as a whole word, case-insensitively. An empty keyword never matches anything (there is nothing to have typed). */
export function matchesKeyword(body: string, keyword: string): boolean {
  const trimmed = keyword.trim();
  if (trimmed === "") {
    return false;
  }
  try {
    return new RegExp(`\\b${escapeForRegExp(trimmed)}\\b`, "iu").test(body);
  } catch {
    // A pattern RegExp still can't parse (vanishingly unlikely once escaped)
    // reads as no match — never a crash over a notification check.
    return false;
  }
}

/** Whether `body` matches any of the member's own keyword alerts. */
export function matchesAnyKeyword(body: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => matchesKeyword(body, keyword));
}
