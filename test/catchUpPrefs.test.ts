import { describe, expect, it } from "vitest";
import { catchUpAllowedForRoom, isCatchUpOffForRoom, readCatchUpEnabled, setCatchUpOffForRoom, writeCatchUpEnabled } from "../src/catchUpPrefs.js";

describe("duo#280/#281 — catchUpPrefs", () => {
  it("defaults to on when nothing has been stored", () => {
    localStorage.clear();
    expect(readCatchUpEnabled()).toBe(true);
    expect(isCatchUpOffForRoom("!room:example.org")).toBe(false);
    expect(catchUpAllowedForRoom("!room:example.org")).toBe(true);
  });

  it("remembers the global switch across reads", () => {
    localStorage.clear();
    writeCatchUpEnabled(false);
    expect(readCatchUpEnabled()).toBe(false);
    writeCatchUpEnabled(true);
    expect(readCatchUpEnabled()).toBe(true);
  });

  it("turns a specific room off without affecting others", () => {
    localStorage.clear();
    setCatchUpOffForRoom("!a:example.org", true);
    expect(isCatchUpOffForRoom("!a:example.org")).toBe(true);
    expect(isCatchUpOffForRoom("!b:example.org")).toBe(false);
    expect(catchUpAllowedForRoom("!a:example.org")).toBe(false);
    expect(catchUpAllowedForRoom("!b:example.org")).toBe(true);
  });

  it("turning a room back on restores it", () => {
    localStorage.clear();
    setCatchUpOffForRoom("!a:example.org", true);
    setCatchUpOffForRoom("!a:example.org", false);
    expect(isCatchUpOffForRoom("!a:example.org")).toBe(false);
  });

  it("the global switch off overrides a room that is otherwise on", () => {
    localStorage.clear();
    writeCatchUpEnabled(false);
    expect(catchUpAllowedForRoom("!a:example.org")).toBe(false);
  });
});
