import { describe, expect, it } from "vitest";
import { CATCH_UP_CARD_AGE_THRESHOLD_MS, CATCH_UP_CARD_UNREAD_THRESHOLD, isCatchUpCardThresholdMet } from "../src/catchUpThresholds.js";

describe("duo#280 — isCatchUpCardThresholdMet", () => {
  const now = 1_000_000_000;

  it("is not met below both the count and the age thresholds", () => {
    expect(isCatchUpCardThresholdMet(CATCH_UP_CARD_UNREAD_THRESHOLD - 1, now - 1000, now)).toBe(false);
  });

  it("is met once the unread count reaches the threshold, regardless of age", () => {
    expect(isCatchUpCardThresholdMet(CATCH_UP_CARD_UNREAD_THRESHOLD, now - 1000, now)).toBe(true);
  });

  it("is met once the oldest unread message is old enough, regardless of count", () => {
    expect(isCatchUpCardThresholdMet(1, now - CATCH_UP_CARD_AGE_THRESHOLD_MS, now)).toBe(true);
  });

  it("is not met just under the age threshold with a low count", () => {
    expect(isCatchUpCardThresholdMet(1, now - CATCH_UP_CARD_AGE_THRESHOLD_MS + 1, now)).toBe(false);
  });
});
