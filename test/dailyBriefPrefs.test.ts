import { describe, expect, it } from "vitest";
import {
  dailyBriefSince,
  isDailyBriefDue,
  markDailyBriefShown,
  readDailyBriefEnabled,
  readDailyBriefHour,
  writeDailyBriefEnabled,
  writeDailyBriefHour,
} from "../src/dailyBriefPrefs.js";

describe("duo#282 — dailyBriefPrefs", () => {
  it("defaults to on, hour 8, and never shown", () => {
    localStorage.clear();
    expect(readDailyBriefEnabled()).toBe(true);
    expect(readDailyBriefHour()).toBe(8);
    expect(dailyBriefSince()).toBeNull();
  });

  it("is due once past the chosen hour and never shown today", () => {
    localStorage.clear();
    writeDailyBriefHour(8);
    expect(isDailyBriefDue(new Date("2026-06-15T07:59:00"))).toBe(false);
    expect(isDailyBriefDue(new Date("2026-06-15T08:00:00"))).toBe(true);
  });

  it("is not due again the same day after being shown", () => {
    localStorage.clear();
    writeDailyBriefHour(8);
    const now = new Date("2026-06-15T09:00:00");
    expect(isDailyBriefDue(now)).toBe(true);
    markDailyBriefShown(now);
    expect(isDailyBriefDue(now)).toBe(false);
  });

  it("is due again the next day after being shown", () => {
    localStorage.clear();
    writeDailyBriefHour(8);
    markDailyBriefShown(new Date("2026-06-15T09:00:00"));
    expect(isDailyBriefDue(new Date("2026-06-16T09:00:00"))).toBe(true);
  });

  it("is never due when turned off, however late in the day", () => {
    localStorage.clear();
    writeDailyBriefEnabled(false);
    expect(isDailyBriefDue(new Date("2026-06-15T23:00:00"))).toBe(false);
  });

  it("dailyBriefSince reflects the last shown date at local midnight", () => {
    localStorage.clear();
    markDailyBriefShown(new Date("2026-06-15T09:30:00"));
    expect(dailyBriefSince()).toBe(new Date("2026-06-15T00:00:00").toISOString());
  });
});
