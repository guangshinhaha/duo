import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSuggestionChipsEnabled, writeSuggestionChipsEnabled } from "../src/suggestionsPrefs.js";

/*
 * duo#305 AC3: "chips can be turned off" — one switch for both starters and
 * follow-ups, on by default (same shape as dailyBriefPrefs.ts/catchUpPrefs.ts:
 * a new setting must never silently turn off something that otherwise
 * matches its threshold).
 */
describe("duo#305 — suggestion chips default on, and the choice is this member's own", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("reads on when nothing was ever chosen", () => {
    expect(readSuggestionChipsEnabled()).toBe(true);
  });

  it("the choice round-trips this device's storage", () => {
    writeSuggestionChipsEnabled(false);
    expect(readSuggestionChipsEnabled()).toBe(false);
    writeSuggestionChipsEnabled(true);
    expect(readSuggestionChipsEnabled()).toBe(true);
  });

  it("stale or corrupt storage reads as on, never as a crash or an accidental off", () => {
    localStorage.setItem("duo.suggestion-chips", "whatever");
    expect(readSuggestionChipsEnabled()).toBe(true);
  });
});
