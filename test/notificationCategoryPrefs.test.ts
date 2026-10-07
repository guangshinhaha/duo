import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NOTIFICATION_CATEGORY_STORAGE_KEY,
  readNotificationCategoryPrefs,
  readNotificationCategorySetting,
  writeNotificationCategoryPrefs,
  type NotificationCategoryPrefs,
} from "../src/notificationCategoryPrefs.js";

describe("#309 — notification categories, each with its own immediate/batched/off setting", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults every category to immediate — a new setting never silently changes what already ships", () => {
    expect(readNotificationCategoryPrefs()).toEqual({
      draftsReady: "immediate",
      passedOn: "immediate",
      mentions: "immediate",
      directMessages: "immediate",
    });
    expect(readNotificationCategorySetting("mentions")).toBe("immediate");
  });

  it("round-trips a member's choice through this device's storage", () => {
    const next: NotificationCategoryPrefs = { draftsReady: "batched", passedOn: "off", mentions: "immediate", directMessages: "batched" };
    writeNotificationCategoryPrefs(next);
    expect(readNotificationCategoryPrefs()).toEqual(next);
    expect(readNotificationCategorySetting("passedOn")).toBe("off");
  });

  it("corrupt storage reads as every category's default, never as a crash", () => {
    localStorage.setItem(NOTIFICATION_CATEGORY_STORAGE_KEY, "{not json");
    expect(readNotificationCategoryPrefs()).toEqual({
      draftsReady: "immediate",
      passedOn: "immediate",
      mentions: "immediate",
      directMessages: "immediate",
    });
  });

  it("a partial or garbled record keeps its untouched categories at their default, instead of discarding the whole thing", () => {
    localStorage.setItem(NOTIFICATION_CATEGORY_STORAGE_KEY, JSON.stringify({ mentions: "off", draftsReady: "not-a-real-setting" }));
    expect(readNotificationCategoryPrefs()).toEqual({
      draftsReady: "immediate",
      passedOn: "immediate",
      mentions: "off",
      directMessages: "immediate",
    });
  });
});
