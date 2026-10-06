import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPlatformKind, getPlatform, setPlatformForTesting, type Platform } from "../src/platform/index.js";
import { createTauriDesktopPlatform } from "../src/platform/tauriDesktop.js";
import { createTauriMobilePlatform } from "../src/platform/tauriMobile.js";
import { createWebPlatform } from "../src/platform/web.js";
import { fakeNotificationApi, fakePlatform, fakeTauriHost, fakeWebHost, inTauriShell, leaveTauriShell } from "./platformFakes.js";

/*
 * #320: one platform interface, three adapters, each tested against a fake
 * host (test/platformFakes.ts) — no module mocks, no stubbed globals.
 */

const MEMBERS: ReadonlyArray<keyof Platform> = [
  "kind",
  "notify",
  "wireNotificationClicks",
  "setBadge",
  "storage",
  "onDeepLink",
  "haptic",
  "share",
  "isTouchPrimary",
];

const adapters: Array<[string, () => Platform]> = [
  ["web", () => createWebPlatform(fakeWebHost().host)],
  ["tauri-desktop", () => createTauriDesktopPlatform(fakeTauriHost().host)],
  ["tauri-mobile", () => createTauriMobilePlatform(fakeTauriHost().host)],
];

describe.each(adapters)("the %s adapter implements the whole interface", (kind, make) => {
  it("names its kind and has every member", () => {
    const platform = make();
    expect(platform.kind).toBe(kind);
    for (const member of MEMBERS) {
      expect(platform[member], member).toBeDefined();
    }
    for (const method of ["get", "set", "remove", "keys"] as const) {
      expect(typeof platform.storage[method]).toBe("function");
    }
  });

  it("storage round-trips, lists by prefix, and removes", async () => {
    const { storage } = make();
    expect(await storage.get("duo.k")).toBeNull();
    await storage.set("duo.k", "v1");
    await storage.set("duo.other", "v2");
    await storage.set("elsewhere", "v3");
    expect(await storage.get("duo.k")).toBe("v1");
    expect((await storage.keys("duo.")).sort()).toEqual(["duo.k", "duo.other"]);
    await storage.remove("duo.k");
    expect(await storage.get("duo.k")).toBeNull();
  });

  it("the capabilities this host lacks resolve quietly instead of throwing", async () => {
    const platform = make();
    await expect(platform.haptic("success")).resolves.toBeUndefined();
    await expect(platform.onDeepLink(() => {})).resolves.toBeNull();
    expect(platform.isTouchPrimary()).toBe(false);
  });
});

describe("web adapter", () => {
  it("storage reads as empty and writes are swallowed when the browser blocks storage", async () => {
    const { host } = fakeWebHost({
      storageArea: () => {
        throw new Error("SecurityError");
      },
    });
    const { storage } = createWebPlatform(host);
    await expect(storage.set("k", "v")).resolves.toBeUndefined();
    expect(await storage.get("k")).toBeNull();
    expect(await storage.keys()).toEqual([]);
  });

  it("shows nothing and asks nothing while the member is looking at the tab", async () => {
    const fake = fakeWebHost({ attended: () => true });
    await createWebPlatform(fake.host).notify("Duo", "hi", { hash: "#chat/x" });
    expect(fake.notifications.requestPermission).not.toHaveBeenCalled();
    expect(fake.notifications.shown).toHaveLength(0);
  });

  it("asks once, then shows the notification through the Web Notification API; a click opens its address", async () => {
    const fake = fakeWebHost();
    await createWebPlatform(fake.host).notify("Duo", "Bob: ship it", { hash: "#chat/x" });
    expect(fake.notifications.requestPermission).toHaveBeenCalledTimes(1);
    const [shown] = fake.notifications.shown;
    expect(shown).toMatchObject({ title: "Duo", body: "Bob: ship it" });
    shown!.onclick?.();
    expect(fake.opened).toEqual(["#chat/x"]);
    expect(shown!.close).toHaveBeenCalled();
  });

  it("never asks again, and never shows, after the browser's denial", async () => {
    const notifications = fakeNotificationApi("denied");
    const fake = fakeWebHost({ notificationApi: () => notifications.api });
    await createWebPlatform(fake.host).notify("Duo", "one");
    expect(notifications.requestPermission).not.toHaveBeenCalled();
    expect(notifications.shown).toHaveLength(0);
  });

  it("does nothing where there is no Notification API", async () => {
    const fake = fakeWebHost({ notificationApi: () => undefined });
    await expect(createWebPlatform(fake.host).notify("Duo", "one")).resolves.toBeUndefined();
  });

  it("badges through the Badging API where it exists, clearing at zero, and is silent where it doesn't", async () => {
    const fake = fakeWebHost();
    fake.navigator.setAppBadge = vi.fn(async () => {});
    fake.navigator.clearAppBadge = vi.fn(async () => {});
    const platform = createWebPlatform(fake.host);
    await platform.setBadge(3);
    await platform.setBadge(0);
    expect(fake.navigator.setAppBadge).toHaveBeenCalledWith(3);
    expect(fake.navigator.clearAppBadge).toHaveBeenCalledTimes(1);
    await expect(createWebPlatform(fakeWebHost().host).setBadge(2)).resolves.toBeUndefined();
  });

  it("shares through the Web Share API, and reports false where it is missing or dismissed", async () => {
    const fake = fakeWebHost();
    expect(await createWebPlatform(fake.host).share({ url: "https://x" })).toBe(false);
    fake.navigator.share = vi.fn(async () => {});
    expect(await createWebPlatform(fake.host).share({ url: "https://x" })).toBe(true);
    expect(fake.navigator.share).toHaveBeenCalledWith({ url: "https://x" });
    fake.navigator.share = vi.fn(async () => {
      throw new DOMException("dismissed", "AbortError");
    });
    expect(await createWebPlatform(fake.host).share({ text: "t" })).toBe(false);
  });

  it("is touch-primary only for no hover and a coarse pointer, never for a stub that says yes to everything", () => {
    const phone = (query: string) => ({ matches: query !== "(pointer: fine)" });
    expect(createWebPlatform(fakeWebHost({ matchMedia: phone }).host).isTouchPrimary()).toBe(true);
    expect(createWebPlatform(fakeWebHost({ matchMedia: () => ({ matches: true }) }).host).isTouchPrimary()).toBe(false);
  });

  // #308: a push notification's click arrives as a message from
  // `public/sw.js`, not as a live `Notification.onclick` — this is the seam
  // `wireNotificationClicks`'s own doc comment (src/platform/types.ts) names.
  it("routes a service worker's notification-click message to its hash, and unwires cleanly", async () => {
    const fake = fakeWebHost();
    const platform = createWebPlatform(fake.host);
    const unwire = await platform.wireNotificationClicks();
    expect(unwire).not.toBeNull();
    expect(fake.serviceWorker.listenerCount()).toBe(1);

    fake.serviceWorker.postMessage({ type: "duo-notification-click", hash: "#draft/abc" });
    expect(fake.opened).toEqual(["#draft/abc"]);

    unwire!();
    expect(fake.serviceWorker.listenerCount()).toBe(0);
  });

  it("ignores a message that isn't its own", async () => {
    const fake = fakeWebHost();
    await createWebPlatform(fake.host).wireNotificationClicks();
    fake.serviceWorker.postMessage({ type: "something-else" });
    fake.serviceWorker.postMessage("not even an object");
    expect(fake.opened).toEqual([]);
  });

  it("has no outside channel, and says so, where this browser has no service worker container at all", async () => {
    const fake = fakeWebHost({ serviceWorker: () => undefined });
    expect(await createWebPlatform(fake.host).wireNotificationClicks()).toBeNull();
  });
});

describe.each([
  ["tauri-desktop", createTauriDesktopPlatform],
  ["tauri-mobile", createTauriMobilePlatform],
] as const)("%s adapter", (_kind, create) => {
  it("sends through the notification plugin, asking permission once and caching the answer", async () => {
    const fake = fakeTauriHost({ isPermissionGranted: vi.fn(async () => false) });
    const platform = create(fake.host);
    await platform.notify("Duo", "one", { hash: "#draft/d1" });
    await platform.notify("Duo", "two");
    expect(fake.host.requestPermission).toHaveBeenCalledTimes(1);
    expect(fake.host.sendNotification).toHaveBeenCalledTimes(2);
    expect(fake.host.sendNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "Duo", body: "one" }));
  });

  it("never sends, and never re-asks, after a denial — and a rejecting plugin reads as one", async () => {
    const denied = fakeTauriHost({ isPermissionGranted: vi.fn(async () => false), requestPermission: vi.fn(async () => "denied") });
    const platform = create(denied.host);
    await platform.notify("Duo", "one");
    await platform.notify("Duo", "two");
    expect(denied.host.requestPermission).toHaveBeenCalledTimes(1);
    expect(denied.host.sendNotification).not.toHaveBeenCalled();

    const broken = fakeTauriHost({ isPermissionGranted: vi.fn(async () => Promise.reject(new Error("no IPC"))) });
    await expect(create(broken.host).notify("Duo", "one")).resolves.toBeUndefined();
    expect(broken.host.sendNotification).not.toHaveBeenCalled();
  });

  it("a notification-centre click reveals the window and opens that notification's address; a stranger's click does nothing", async () => {
    const fake = fakeTauriHost();
    const platform = create(fake.host);
    expect(await platform.wireNotificationClicks()).not.toBeNull();
    await platform.notify("Duo", "one", { hash: "#draft/d9" });
    const { id } = fake.host.sendNotification.mock.calls[0]![0];

    fake.click(999999);
    expect(fake.navigated).toEqual([]);
    expect(fake.host.showWindow).not.toHaveBeenCalled();

    fake.click(id);
    expect(fake.host.showWindow).toHaveBeenCalled();
    expect(fake.navigated).toEqual(["#draft/d9"]);
  });

  it("a failed reveal is not a failed click, and wiring degrades to null where the plugin rejects", async () => {
    const fake = fakeTauriHost({ showWindow: vi.fn(async () => Promise.reject(new Error("no window"))) });
    const platform = create(fake.host);
    await platform.wireNotificationClicks();
    await platform.notify("Duo", "one", { hash: "#confirmations" });
    fake.click(fake.host.sendNotification.mock.calls[0]![0].id);
    expect(fake.navigated).toEqual(["#confirmations"]);

    const offline = fakeTauriHost({ onAction: vi.fn(async () => Promise.reject(new Error("no IPC"))) });
    expect(await create(offline.host).wireNotificationClicks()).toBeNull();
  });

  it("badges the app icon, clearing with undefined at zero, and swallows a rejecting shell", async () => {
    const fake = fakeTauriHost();
    const platform = create(fake.host);
    await platform.setBadge(4);
    await platform.setBadge(0);
    expect(fake.host.setBadgeCount.mock.calls).toEqual([[4], [undefined]]);
    fake.host.setBadgeCount.mockRejectedValueOnce(new Error("no dock"));
    await expect(platform.setBadge(1)).resolves.toBeUndefined();
  });

  it("has no share sheet yet, and says so", async () => {
    expect(await create(fakeTauriHost().host).share({ url: "https://x" })).toBe(false);
  });
});

describe("getPlatform — one adapter, picked by the host", () => {
  afterEach(() => {
    leaveTauriShell();
    vi.unstubAllGlobals();
    setPlatformForTesting(null);
  });

  it("a plain tab is the web", () => {
    expect(detectPlatformKind()).toBe("web");
    expect(getPlatform().kind).toBe("web");
  });

  it("a Tauri webview is the Mac app, and the same adapter every call", () => {
    inTauriShell();
    expect(getPlatform().kind).toBe("tauri-desktop");
    expect(getPlatform()).toBe(getPlatform());
  });

  it("a Tauri webview on a phone is the phone app", () => {
    inTauriShell();
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" });
    expect(getPlatform().kind).toBe("tauri-mobile");
  });

  it("a test can stand a fake platform in, and a feature's calls land on it", async () => {
    const fake = fakePlatform("tauri-desktop");
    setPlatformForTesting(fake.platform);
    const { postNotification } = await import("../src/notifications.js");
    const { setDockBadgeCount } = await import("../src/dockBadge.js");
    await postNotification("Bob: hi", "#chat/x");
    await setDockBadgeCount(2);
    expect(fake.calls.notify).toEqual([{ title: "Duo", body: "Bob: hi", hash: "#chat/x" }]);
    expect(fake.calls.badge).toEqual([2]);
  });
});
