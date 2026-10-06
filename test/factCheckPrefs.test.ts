import { describe, expect, it } from "vitest";
import { readFactCheckPref, writeFactCheckPref } from "../src/factCheckPrefs.js";

describe("#264 — factCheckPrefs", () => {
  it("defaults to off when nothing has been stored", () => {
    localStorage.clear();
    expect(readFactCheckPref()).toBe(false);
  });

  it("remembers on and off across reads", () => {
    writeFactCheckPref(true);
    expect(readFactCheckPref()).toBe(true);
    writeFactCheckPref(false);
    expect(readFactCheckPref()).toBe(false);
  });
});
