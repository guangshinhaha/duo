import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SentNotification = { id?: number; title: string; body: string };
// The handler only reads the echoed id — the payload the shell sends back
// is the whole notification, but the contract under test is id→draft.
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
    const { notifyDraftReady, wireDraftNotificationClicks } = await import("../src/notifications.js");

    expect(await wireDraftNotificationClicks()).not.toBeNull();
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
    const { notifyDraftReady, wireDraftNotificationClicks } = await import("../src/notifications.js");
    await wireDraftNotificationClicks();
    await notifyDraftReady("d9");

    onClick!({ id: 999999 });
    expect(window.location.hash).toBe("");
  });

  it("wiring degrades to null outside the shell, where onAction rejects", async () => {
    plugin.onAction.mockRejectedValue(new Error("window.__TAURI_INTERNALS__ is undefined"));
    const { wireDraftNotificationClicks } = await import("../src/notifications.js");
    await expect(wireDraftNotificationClicks()).resolves.toBeNull();
  });
});
