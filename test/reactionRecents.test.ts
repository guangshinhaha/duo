import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readReactionRecents, recordReactionRecent, REACTION_RECENTS_STORAGE_KEY } from "../src/reactionRecents.js";

/*
 * #291: the full emoji picker's "recently used" row — a member's own device
 * memory, same local-storage shape as `urlPreviewPrefs.ts`. Empty until
 * something is picked, most-recent-first, de-duplicated, capped, and never
 * a crash on storage it doesn't recognise.
 */
describe("#291 — reactionRecents", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("starts empty", () => {
    expect(readReactionRecents()).toEqual([]);
  });

  it("remembers a pick, most recent first", () => {
    recordReactionRecent("👍");
    recordReactionRecent("🔥");
    expect(readReactionRecents()).toEqual(["🔥", "👍"]);
  });

  it("re-picking an existing recent moves it to the front instead of duplicating it", () => {
    recordReactionRecent("👍");
    recordReactionRecent("🔥");
    recordReactionRecent("👍");
    expect(readReactionRecents()).toEqual(["👍", "🔥"]);
  });

  it("caps the list rather than growing it forever", () => {
    for (let i = 0; i < 30; i += 1) {
      recordReactionRecent(`emoji-${i}`);
    }
    const recents = readReactionRecents();
    expect(recents.length).toBeLessThanOrEqual(24);
    // The latest pick leads.
    expect(recents[0]).toBe("emoji-29");
  });

  it("corrupt storage reads as empty, never a crash", () => {
    localStorage.setItem(REACTION_RECENTS_STORAGE_KEY, "{not json");
    expect(readReactionRecents()).toEqual([]);

    localStorage.setItem(REACTION_RECENTS_STORAGE_KEY, JSON.stringify({ not: "an array" }));
    expect(readReactionRecents()).toEqual([]);
  });
});
