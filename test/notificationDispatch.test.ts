import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePlatform } from "./platformFakes.js";
import { setPlatformForTesting } from "../src/platform/index.js";
import { writeNotificationCategoryPrefs } from "../src/notificationCategoryPrefs.js";
import { notifyCategory, queueForBatch, resetNotificationBatches } from "../src/notificationDispatch.js";

const ALL_IMMEDIATE = { draftsReady: "immediate", passedOn: "immediate", mentions: "immediate", directMessages: "immediate" } as const;

describe("#309 — notifyCategory, the one choke point every category-gated firing site shares", () => {
  let fake: ReturnType<typeof fakePlatform>;

  beforeEach(() => {
    localStorage.clear();
    fake = fakePlatform();
    setPlatformForTesting(fake.platform);
  });
  afterEach(() => {
    localStorage.clear();
    setPlatformForTesting(null);
    resetNotificationBatches();
  });

  it("immediate (the default) posts right away, exactly as before this setting existed", async () => {
    await notifyCategory("draftsReady", "A new draft is waiting for your review.", "#draft/d1");
    expect(fake.calls.notify).toEqual([{ title: "Duo", body: "A new draft is waiting for your review.", hash: "#draft/d1" }]);
  });

  it("off never posts, and is not recorded as something do-not-disturb held back", async () => {
    writeNotificationCategoryPrefs({ ...ALL_IMMEDIATE, mentions: "off" });
    await notifyCategory("mentions", "Bob in project-x: ship it", "#room/x");
    expect(fake.calls.notify).toEqual([]);
    expect(JSON.parse(localStorage.getItem("duo.missed") ?? "[]")).toEqual([]);
  });

  it("do-not-disturb still holds an immediate category's notification, recorded for afterwards", async () => {
    localStorage.setItem("duo.dnd", JSON.stringify({ manual: true, from: null, to: null }));
    await notifyCategory("passedOn", "Your duo escalated a question to you.", "#draft/d2");
    expect(fake.calls.notify).toEqual([]);
    expect(JSON.parse(localStorage.getItem("duo.missed") ?? "[]")).toEqual([
      expect.objectContaining({ body: "Your duo escalated a question to you.", hash: "#draft/d2" }),
    ]);
  });

  it("batched queues instead of posting immediately", async () => {
    writeNotificationCategoryPrefs({ ...ALL_IMMEDIATE, directMessages: "batched" });
    await notifyCategory("directMessages", "Alice: hey", "#room/dm1");
    expect(fake.calls.notify).toEqual([]);
  });
});

describe("#309 — batched assembly: one summary per window, not one notification per arrival", () => {
  let fake: ReturnType<typeof fakePlatform>;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    fake = fakePlatform();
    setPlatformForTesting(fake.platform);
  });
  afterEach(() => {
    resetNotificationBatches();
    localStorage.clear();
    setPlatformForTesting(null);
    vi.useRealTimers();
  });

  it("a single arrival in the window posts its own words, once the window closes", () => {
    queueForBatch("mentions", "Bob mentioned you in project-x", "#room/x", 1000);
    expect(fake.calls.notify).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(fake.calls.notify).toEqual([{ title: "Duo", body: "Bob mentioned you in project-x", hash: "#room/x" }]);
  });

  it("several arrivals in the same window collapse into one summary, addressed at the most recent", () => {
    queueForBatch("directMessages", "Alice: hey", "#room/dm1", 1000);
    queueForBatch("directMessages", "Carol: you there?", "#room/dm2", 1000);
    queueForBatch("directMessages", "Dan: ping", "#room/dm3", 1000);
    vi.advanceTimersByTime(1000);
    expect(fake.calls.notify).toEqual([{ title: "Duo", body: "3 direct messages, waiting on you.", hash: "#room/dm3" }]);
  });

  it("a second window, after the first flushed, starts its own fresh queue", () => {
    queueForBatch("mentions", "first", "#a", 1000);
    vi.advanceTimersByTime(1000);
    queueForBatch("mentions", "second", "#b", 1000);
    vi.advanceTimersByTime(1000);
    expect(fake.calls.notify).toEqual([
      { title: "Duo", body: "first", hash: "#a" },
      { title: "Duo", body: "second", hash: "#b" },
    ]);
  });

  it("different categories batch independently — one category's window never holds another's", () => {
    queueForBatch("mentions", "m1", "#m", 1000);
    queueForBatch("draftsReady", "d1", "#d", 500);
    vi.advanceTimersByTime(500);
    expect(fake.calls.notify).toEqual([{ title: "Duo", body: "d1", hash: "#d" }]);
    vi.advanceTimersByTime(500);
    expect(fake.calls.notify).toEqual([
      { title: "Duo", body: "d1", hash: "#d" },
      { title: "Duo", body: "m1", hash: "#m" },
    ]);
  });

  it("do-not-disturb holds a flushed batch too, recorded like any other held notification", () => {
    localStorage.setItem("duo.dnd", JSON.stringify({ manual: true, from: null, to: null }));
    queueForBatch("mentions", "Bob mentioned you", "#room/x", 1000);
    vi.advanceTimersByTime(1000);
    expect(fake.calls.notify).toEqual([]);
    expect(JSON.parse(localStorage.getItem("duo.missed") ?? "[]")).toEqual([
      expect.objectContaining({ body: "Bob mentioned you", hash: "#room/x" }),
    ]);
  });
});
