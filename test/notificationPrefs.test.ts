import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * #69: what interrupts the member is a setting, not a constant. Two halves
 * live here: when do-not-disturb is active (a manual toggle, or the daily
 * quiet-hours window — the member's own device rule, kept on this device),
 * and the record of what DND held back ("what was missed is visible
 * afterwards"). Pure logic plus localStorage — the per-conversation half of
 * the issue is server-side state and is pinned in Workspace's tests.
 */
import {
  clearMissed,
  DND_STORAGE_KEY,
  isDndActive,
  MISSED_STORAGE_KEY,
  readDndPrefs,
  readMissed,
  recordMissed,
  writeDndPrefs,
  type DndPrefs,
} from "../src/notificationPrefs.js";

const noon = new Date("2026-09-21T12:30:00");
const at = (hhmm: string, day = "2026-09-21"): Date => new Date(`${day}T${hhmm}:00`);

function seedPrefs(prefs: DndPrefs): void {
  localStorage.setItem(DND_STORAGE_KEY, JSON.stringify(prefs));
}

describe("#69 AC2 — do not disturb, manual and scheduled", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("manual do-not-disturb is active whatever the clock says", () => {
    expect(isDndActive({ manual: true, from: null, to: null }, noon)).toBe(true);
  });

  it("quiet hours hold inside their window, including a window that spans midnight", () => {
    const lunch = { manual: false, from: "12:00", to: "13:00" } satisfies DndPrefs;
    expect(isDndActive(lunch, at("12:30"))).toBe(true);
    expect(isDndActive(lunch, at("13:00"))).toBe(false); // the boundary is the end, held exclusive
    expect(isDndActive(lunch, at("11:59"))).toBe(false);

    const night = { manual: false, from: "22:00", to: "07:00" } satisfies DndPrefs;
    expect(isDndActive(night, at("23:00"))).toBe(true);
    expect(isDndActive(night, at("06:00"), "2026-09-22")).toBe(true); // the far side of midnight
    expect(isDndActive(night, at("08:00"), "2026-09-22")).toBe(false);
  });

  it("no schedule and no manual toggle interrupt nothing", () => {
    expect(isDndActive({ manual: false, from: null, to: null }, noon)).toBe(false);
    // A half-set window is no window: both ends or none.
    expect(isDndActive({ manual: false, from: "22:00", to: null }, at("23:00"))).toBe(false);
  });

  it("the preference round-trips this device's storage", () => {
    seedPrefs({ manual: false, from: "22:00", to: "07:00" });
    expect(readDndPrefs()).toEqual({ manual: false, from: "22:00", to: "07:00" });
    writeDndPrefs({ manual: true, from: null, to: null });
    expect(readDndPrefs()).toEqual({ manual: true, from: null, to: null });
    // Stale or corrupt storage reads as "off", never as a crash.
    localStorage.setItem(DND_STORAGE_KEY, "{not json");
    expect(readDndPrefs()).toEqual({ manual: false, from: null, to: null });
  });
});

describe("#69 AC2 — what was missed stays visible afterwards", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("records what DND held back, newest last, and clear empties it", () => {
    recordMissed({ at: 1_700_000_000_000, body: "Bose in project-x: ship it", hash: "#room/%21project-x%3Aworkspace.example" });
    recordMissed({ at: 1_700_000_100_000, body: "Your duo answered on your behalf in project-x.", hash: "#room/%21project-x%3Aworkspace.example" });
    expect(readMissed().map((entry) => entry.body)).toEqual([
      "Bose in project-x: ship it",
      "Your duo answered on your behalf in project-x.",
    ]);
    clearMissed();
    expect(readMissed()).toEqual([]);
  });

  it("the log is bounded — the oldest falls off the end, so a long disturbance cannot grow without limit", () => {
    for (let i = 0; i < 60; i += 1) {
      recordMissed({ at: i, body: `held ${i}`, hash: "#room/x" });
    }
    const held = readMissed();
    expect(held).toHaveLength(50);
    expect(held[0]!.body).toBe("held 10");
    expect(held[49]!.body).toBe("held 59");
  });

  it("corrupt storage reads as nothing missed, never as a crash", () => {
    localStorage.setItem(MISSED_STORAGE_KEY, "{not json");
    expect(readMissed()).toEqual([]);
  });
});
