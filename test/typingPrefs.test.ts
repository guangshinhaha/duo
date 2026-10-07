import { describe, expect, it } from "vitest";
import { readTypingPref, writeTypingPref } from "../src/typingPrefs.js";

describe("#285 — typingPrefs", () => {
  it("defaults to on when nothing has been stored — unlike link previews and fact-check, typing costs nothing to send", () => {
    localStorage.clear();
    expect(readTypingPref()).toBe(true);
  });

  it("remembers off and on across reads", () => {
    writeTypingPref(false);
    expect(readTypingPref()).toBe(false);
    writeTypingPref(true);
    expect(readTypingPref()).toBe(true);
  });
});
