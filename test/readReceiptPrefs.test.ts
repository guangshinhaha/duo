import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRIVATE_READ_RECEIPTS_STORAGE_KEY, readPrivateReceiptsPref, writePrivateReceiptsPref } from "../src/readReceiptPrefs.js";

/*
 * #286: the member's own opt-in for private read receipts — off (the
 * ordinary, visible receipt this app always sent, #63) unless this device's
 * storage says otherwise, the same shape urlPreviewPrefs.ts/
 * factCheckPrefs.ts already use for a per-member, this-device-only choice.
 */
describe("#286 — private read receipts default off, and the choice is this member's own", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("reads off when nothing was ever chosen", () => {
    expect(readPrivateReceiptsPref()).toBe(false);
  });

  it("the choice round-trips this device's storage", () => {
    writePrivateReceiptsPref(true);
    expect(readPrivateReceiptsPref()).toBe(true);
    expect(localStorage.getItem(PRIVATE_READ_RECEIPTS_STORAGE_KEY)).toBe("on");
    writePrivateReceiptsPref(false);
    expect(readPrivateReceiptsPref()).toBe(false);
    expect(localStorage.getItem(PRIVATE_READ_RECEIPTS_STORAGE_KEY)).toBe("off");
  });

  it("stale or corrupt storage reads as off, never as a crash or an accidental on", () => {
    localStorage.setItem(PRIVATE_READ_RECEIPTS_STORAGE_KEY, "yes please");
    expect(readPrivateReceiptsPref()).toBe(false);
  });
});
