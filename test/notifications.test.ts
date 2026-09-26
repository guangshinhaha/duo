import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SentNotification = { id?: number; title: string; body: string };
// The handler only reads the echoed id — the payload the shell sends back
// is the whole notification, but the contract under test is id→address.
type ActionCallback = (notification: { id?: number }) => void;

const plugin = {
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<string>>(),
  sendNotification: vi.fn<(options: SentNotification) => void>(),
  onAction: vi.fn<(cb: ActionCallback) => Promise<{ unregister: () => void }>>(),
};

vi.mock("@tauri-apps/plugin-notification", () => plugin);

describe("notifications — native draft-ready (C5), degrading to a no-op outside the Tauri shell", () => {
  beforeEach(async () => {
    vi.resetModules();
    plugin.isPermissionGranted.mockReset();
    plugin.requestPermission.mockReset();
    plugin.sendNotification.mockReset();
    plugin.onAction.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = "";
  });

  it("sends the draft-ready notification when permission is already granted", async () => {
    plugin.isPermissionGranted.mockResolvedValue(true);
    const { notifyDraftReady } = await import("../src/notifications.js");
    await notifyDraftReady("d1");
    expect(plugin.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Duo", body: "A new draft is waiting for your review." }),
    );
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it("asks once when not yet granted, and caches the answer", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    plugin.requestPermission.mockResolvedValue("granted");
    const { notifyDraftReady } = await import("../src/notifications.js");
    await notifyDraftReady("d1");
    await notifyDraftReady("d2");
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification).toHaveBeenCalledTimes(2);
  });

  it("never sends and never re-asks after a denial", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    plugin.requestPermission.mockResolvedValue("denied");
    const { notifyDraftReady } = await import("../src/notifications.js");
    await notifyDraftReady("d1");
    await notifyDraftReady("d2");
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("quietly no-ops in a plain browser, where the plugin calls reject", async () => {
    plugin.isPermissionGranted.mockRejectedValue(new Error("window.__TAURI_INTERNALS__ is undefined"));
    const { notifyDraftReady } = await import("../src/notifications.js");
    await expect(notifyDraftReady("d1")).resolves.toBeUndefined();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});

describe("#25 — a notification opens the draft it is about", () => {
  beforeEach(async () => {
    vi.resetModules();
    plugin.isPermissionGranted.mockReset();
    plugin.requestPermission.mockReset();
    plugin.sendNotification.mockReset();
    plugin.onAction.mockReset();
    plugin.isPermissionGranted.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = "";
  });

  it("each notification carries an id, and clicking it opens that draft's address", async () => {
    let onClick: ActionCallback | undefined;
    plugin.onAction.mockImplementation(async (cb: ActionCallback) => {
      onClick = cb;
      return { unregister: () => {} };
    });
    const { notifyDraftReady, wireNotificationClicks } = await import("../src/notifications.js");

    expect(await wireNotificationClicks()).not.toBeNull();
    expect(plugin.onAction).toHaveBeenCalledTimes(1);
    await notifyDraftReady("d9");

    const sent = plugin.sendNotification.mock.calls[0]![0];
    expect(sent.id).toBeDefined();
    onClick!({ id: sent.id });
    expect(window.location.hash).toBe("#draft/d9");
  });

  it("a click on a notification that is not ours changes nothing", async () => {
    let onClick: ActionCallback | undefined;
    plugin.onAction.mockImplementation(async (cb: ActionCallback) => {
      onClick = cb;
      return { unregister: () => {} };
    });
    const { notifyDraftReady, wireNotificationClicks } = await import("../src/notifications.js");
    await wireNotificationClicks();
    await notifyDraftReady("d9");

    onClick!({ id: 999999 });
    expect(window.location.hash).toBe("");
  });

  it("wiring degrades to null outside the shell, where onAction rejects", async () => {
    plugin.onAction.mockRejectedValue(new Error("window.__TAURI_INTERNALS__ is undefined"));
    const { wireNotificationClicks } = await import("../src/notifications.js");
    await expect(wireNotificationClicks()).resolves.toBeNull();
  });
});

/*
 * #69: the notification surface widens past drafts — a message, and the
 * owner's duo acting on the owner's behalf, notify too — under the same
 * shell adapter and the same degradation rule (#69 AC4): every call
 * feature-detects and quietly no-ops in a plain browser tab.
 */
describe("#69 — notifications beyond drafts, degrading the same way (AC4)", () => {
  beforeEach(async () => {
    vi.resetModules();
    plugin.isPermissionGranted.mockReset();
    plugin.requestPermission.mockReset();
    plugin.sendNotification.mockReset();
    plugin.onAction.mockReset();
    window.location.hash = "";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = "";
  });

  it("posts a message notification under the app's name, and a click opens its conversation", async () => {
    plugin.isPermissionGranted.mockResolvedValue(true);
    let onClick: ActionCallback | undefined;
    plugin.onAction.mockImplementation(async (cb: ActionCallback) => {
      onClick = cb;
      return { unregister: () => {} };
    });
    const { postNotification, wireNotificationClicks } = await import("../src/notifications.js");
    await wireNotificationClicks();

    await postNotification("Bose in project-x: ship it", "#room/%21project-x%3Aworkspace.example");
    expect(plugin.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Duo", body: "Bose in project-x: ship it" }),
    );

    const sent = plugin.sendNotification.mock.calls[0]![0];
    onClick!({ id: sent.id });
    expect(window.location.hash).toBe("#room/%21project-x%3Aworkspace.example");
  });

  it("quietly no-ops in a plain browser, where the plugin calls reject", async () => {
    plugin.isPermissionGranted.mockRejectedValue(new Error("window.__TAURI_INTERNALS__ is undefined"));
    const { postNotification } = await import("../src/notifications.js");
    await expect(postNotification("Bose in project-x: ship it", "#room/x")).resolves.toBeUndefined();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("never sends and never re-asks after a denial", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    plugin.requestPermission.mockResolvedValue("denied");
    const { postNotification } = await import("../src/notifications.js");
    await postNotification("Bose in project-x: ship it", "#room/x");
    await postNotification("Your duo escalated a question to you.", "#draft/d1");
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});

describe("#69 AC3 — the duo's own acts carry their own words", () => {
  it("an escalation and a refusal each say what happened, in words distinct from a draft's", async () => {
    vi.resetModules();
    const { draftArrivalBody } = await import("../src/notifications.js");
    expect(draftArrivalBody({ escalated: true, refused: false })).toBe("Your duo escalated a question to you.");
    expect(draftArrivalBody({ escalated: true, refused: true })).toBe("Your duo refused to answer for you.");
    // A plain draft is none of the duo's own acts — the caller keeps the
    // draft copy that already exists ("A new draft is waiting for your
    // review."), so the two categories can never blur.
    expect(draftArrivalBody({ escalated: false, refused: false })).toBeNull();
  });
});

describe("#52 — a confirmation is waiting: notified natively, and the click only navigates", () => {
  beforeEach(async () => {
    vi.resetModules();
    plugin.isPermissionGranted.mockReset();
    plugin.requestPermission.mockReset();
    plugin.sendNotification.mockReset();
    plugin.onAction.mockReset();
    plugin.isPermissionGranted.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.location.hash = "";
  });

  it("says that the duo needs a confirmation before it acts — and nothing about what it would do", async () => {
    const { notifyConfirmationWaiting } = await import("../src/notifications.js");
    await notifyConfirmationWaiting();
    expect(plugin.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Duo", body: "Your duo needs your confirmation before it acts." }),
    );
  });

  it("clicking it opens the confirmations surface, and draft notifications still open their draft", async () => {
    let onClick: ActionCallback | undefined;
    plugin.onAction.mockImplementation(async (cb: ActionCallback) => {
      onClick = cb;
      return { unregister: () => {} };
    });
    const { notifyConfirmationWaiting, notifyDraftReady, wireNotificationClicks } = await import("../src/notifications.js");
    await wireNotificationClicks();

    await notifyConfirmationWaiting();
    await notifyDraftReady("d9");
    const [confirmation, draft] = plugin.sendNotification.mock.calls.map((call) => call[0]);
    expect(confirmation!.id).not.toBe(draft!.id);

    onClick!({ id: confirmation!.id });
    expect(window.location.hash).toBe("#confirmations");
    onClick!({ id: draft!.id });
    expect(window.location.hash).toBe("#draft/d9");
  });

  it("do-not-disturb holds it like any of the duo's own acts — recorded for afterwards, pointing at the same surface", async () => {
    localStorage.setItem("duo.dnd", JSON.stringify({ manual: true, from: null, to: null }));
    localStorage.removeItem("duo.missed");
    const { notifyConfirmationWaiting } = await import("../src/notifications.js");
    await notifyConfirmationWaiting();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("duo.missed") ?? "[]")).toEqual([
      expect.objectContaining({ body: "Your duo needs your confirmation before it acts.", hash: "#confirmations" }),
    ]);
    localStorage.removeItem("duo.dnd");
    localStorage.removeItem("duo.missed");
  });

  it("degrades to a no-op in a plain browser", async () => {
    plugin.isPermissionGranted.mockRejectedValue(new Error("window.__TAURI_INTERNALS__ is undefined"));
    const { notifyConfirmationWaiting } = await import("../src/notifications.js");
    await expect(notifyConfirmationWaiting()).resolves.toBeUndefined();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});
