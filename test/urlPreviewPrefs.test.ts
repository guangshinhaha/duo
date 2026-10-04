import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUrlPreviewPref, URL_PREVIEW_STORAGE_KEY, writeUrlPreviewPref } from "../src/urlPreviewPrefs.js";

/*
 * #219: the member's own opt-in for link preview cards — off unless this
 * device's storage says otherwise, which is the safe side to fail on. Pure
 * logic plus localStorage, the same shape theme.ts and notificationPrefs.ts
 * already use for a per-member, this-device-only choice.
 */
describe("#219 — link previews default off, and the choice is this member's own", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("reads off when nothing was ever chosen", () => {
    expect(readUrlPreviewPref()).toBe(false);
  });

  it("the choice round-trips this device's storage", () => {
    writeUrlPreviewPref(true);
    expect(readUrlPreviewPref()).toBe(true);
    expect(localStorage.getItem(URL_PREVIEW_STORAGE_KEY)).toBe("on");
    writeUrlPreviewPref(false);
    expect(readUrlPreviewPref()).toBe(false);
    expect(localStorage.getItem(URL_PREVIEW_STORAGE_KEY)).toBe("off");
  });

  it("stale or corrupt storage reads as off, never as a crash or an accidental on", () => {
    localStorage.setItem(URL_PREVIEW_STORAGE_KEY, "yes please");
    expect(readUrlPreviewPref()).toBe(false);
  });
});
