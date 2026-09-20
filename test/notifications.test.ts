import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = {
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<string>>(),
  sendNotification: vi.fn<() => void>(),
};

vi.mock("@tauri-apps/plugin-notification", () => plugin);

describe("notifications — native draft-ready (C5), degrading to a no-op outside the Tauri shell", () => {
  beforeEach(async () => {
    vi.resetModules();
    plugin.isPermissionGranted.mockReset();
    plugin.requestPermission.mockReset();
    plugin.sendNotification.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the draft-ready notification when permission is already granted", async () => {
    plugin.isPermissionGranted.mockResolvedValue(true);
    const { notifyDraftReady } = await import("../src/notifications.js");
    await notifyDraftReady();
    expect(plugin.sendNotification).toHaveBeenCalledWith({
      title: "Duo",
      body: "A new draft is waiting for your review.",
    });
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it("asks once when not yet granted, and caches the answer", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    plugin.requestPermission.mockResolvedValue("granted");
    const { notifyDraftReady } = await import("../src/notifications.js");
    await notifyDraftReady();
    await notifyDraftReady();
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification).toHaveBeenCalledTimes(2);
  });

  it("never sends and never re-asks after a denial", async () => {
    plugin.isPermissionGranted.mockResolvedValue(false);
    plugin.requestPermission.mockResolvedValue("denied");
    const { notifyDraftReady } = await import("../src/notifications.js");
    await notifyDraftReady();
    await notifyDraftReady();
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("quietly no-ops in a plain browser, where the plugin calls reject", async () => {
    plugin.isPermissionGranted.mockRejectedValue(new Error("window.__TAURI_INTERNALS__ is undefined"));
    const { notifyDraftReady } = await import("../src/notifications.js");
    await expect(notifyDraftReady()).resolves.toBeUndefined();
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });
});
