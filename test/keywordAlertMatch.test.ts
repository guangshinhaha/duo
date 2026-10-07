import { describe, expect, it } from "vitest";
import { matchesAnyKeyword, matchesKeyword } from "../src/keywordAlertMatch.js";

describe("#310 — keyword alert matching", () => {
  it("matches a whole word, case-insensitively", () => {
    expect(matchesKeyword("We Launch Monday.", "launch")).toBe(true);
    expect(matchesKeyword("we launch monday.", "LAUNCH")).toBe(true);
  });

  it("does not match a word that merely contains the keyword", () => {
    expect(matchesKeyword("the prelaunching checklist", "launch")).toBe(false);
    expect(matchesKeyword("launched already", "launch")).toBe(false);
  });

  it("an empty or blank keyword never matches", () => {
    expect(matchesKeyword("anything at all", "")).toBe(false);
    expect(matchesKeyword("anything at all", "   ")).toBe(false);
  });

  it("treats regex-special characters in a keyword as literal text", () => {
    expect(matchesKeyword("v2.0 is out", "v2.0")).toBe(true);
    expect(matchesKeyword("v2x0 is out", "v2.0")).toBe(false);
  });

  it("matchesAnyKeyword is true when any one keyword matches", () => {
    expect(matchesAnyKeyword("the launch is Monday", ["budget", "launch", "retro"])).toBe(true);
    expect(matchesAnyKeyword("the launch is Monday", ["budget", "retro"])).toBe(false);
  });

  it("an empty keyword list never matches anything", () => {
    expect(matchesAnyKeyword("the launch is Monday", [])).toBe(false);
  });
});
