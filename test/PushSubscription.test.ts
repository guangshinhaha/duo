import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import {
  PushPermissionDeniedError,
  PushUnsupportedError,
  pushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  wirePushNavigationMessages,
} from "../src/push.js";

/*
 * #308: the client half of digital-duo#251's web push. These tests exercise
 * `src/push.ts` against stand-ins for the browser APIs happy-dom doesn't
 * implement (`ServiceWorkerRegistration`, `PushManager`, `Notification`) —
 * real browser behavior, mocked at the lowest layer this module actually
 * calls, never a re-implementation of what the browser itself guarantees.
 */

const api: DuoApiConfig = { baseUrl: "http://100.64.1.5:7717", token: "the-device-token" };

function definePushGlobals(overrides: { permission?: NotificationPermission; requestPermission?: () => Promise<NotificationPermission> } = {}) {
  Object.defineProperty(window, "PushManager", { value: class FakePushManager {}, configurable: true });
  vi.stubGlobal("Notification", {
    permission: overrides.permission ?? "default",
    requestPermission: overrides.requestPermission ?? vi.fn(async () => "granted" as NotificationPermission),
  });
}

function fakeSubscription(overrides: Partial<ReturnType<typeof baseSubscriptionJson>> = {}) {
  const json = { ...baseSubscriptionJson(), ...overrides };
  return {
    toJSON: () => json,
    unsubscribe: vi.fn(async () => true),
  };
}

function baseSubscriptionJson() {
  return { endpoint: "https://push.example/abc123", keys: { p256dh: "p256dh-value", auth: "auth-value" } };
}

function defineServiceWorker(registration: unknown) {
  Object.defineProperty(navigator, "serviceWorker", {
    value: {
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    configurable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { PushManager?: unknown }).PushManager;
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  localStorage.clear();
});

describe("pushSupported (#308)", () => {
  it("is false when the browser has none of the required APIs", () => {
    expect(pushSupported()).toBe(false);
  });

  it("is true once serviceWorker, PushManager and Notification are all present", () => {
    definePushGlobals();
    defineServiceWorker({});
    expect(pushSupported()).toBe(true);
  });

  it("is false inside the Tauri shell even with every API present — the native path already covers it", () => {
    definePushGlobals();
    defineServiceWorker({});
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(pushSupported()).toBe(false);
  });
});

describe("subscribeToPush (#308) — registers with the daemon's actual routes (src/serve/owner-routes.ts)", () => {
  it("fetches the VAPID public key, subscribes, and posts the daemon's exact shape", async () => {
    definePushGlobals();
    const subscription = fakeSubscription();
    const registration = {
      pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => subscription) },
    };
    defineServiceWorker(registration);

    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/push/vapid-public-key")) {
          return new Response(JSON.stringify({ publicKey: "QUJD" }), { status: 200 });
        }
        if (String(url).endsWith("/push/subscriptions")) {
          return new Response(JSON.stringify({ deviceId: "device-1", endpoint: "https://push.example/abc123", quietHours: {} }), {
            status: 200,
          });
        }
        throw new Error(`unexpected fetch: ${String(url)}`);
      }),
    );

    await subscribeToPush(api);

    expect(calls[0]!.url).toBe("http://100.64.1.5:7717/push/vapid-public-key");
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }),
    );

    const registerCall = calls[1]!;
    expect(registerCall.url).toBe("http://100.64.1.5:7717/push/subscriptions");
    expect(registerCall.init?.method).toBe("POST");
    const body = JSON.parse(registerCall.init!.body as string) as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      quietHours: { manual: boolean; from: string | null; to: string | null; timezone: string };
    };
    expect(body.endpoint).toBe("https://push.example/abc123");
    expect(body.keys).toEqual({ p256dh: "p256dh-value", auth: "auth-value" });
    // #69: this device's own do-not-disturb rule, never touched here — off by default.
    expect(body.quietHours.manual).toBe(false);
    expect(body.quietHours.from).toBeNull();
    expect(body.quietHours.to).toBeNull();
    expect(typeof body.quietHours.timezone).toBe("string");
    expect(registerCall.init?.headers).toMatchObject({ Authorization: "Bearer the-device-token" });
  });

  it("reuses an existing browser subscription instead of subscribing twice", async () => {
    definePushGlobals();
    const subscription = fakeSubscription();
    const registration = {
      pushManager: { getSubscription: vi.fn(async () => subscription), subscribe: vi.fn(async () => subscription) },
    };
    defineServiceWorker(registration);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/push/vapid-public-key")
          ? new Response(JSON.stringify({ publicKey: "QUJD" }), { status: 200 })
          : new Response(JSON.stringify({}), { status: 200 }),
      ),
    );

    await subscribeToPush(api);
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("asks for permission lazily and refuses when it's denied", async () => {
    definePushGlobals({ permission: "default", requestPermission: vi.fn(async () => "denied" as NotificationPermission) });
    defineServiceWorker({ pushManager: { getSubscription: vi.fn(), subscribe: vi.fn() } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(subscribeToPush(api)).rejects.toBeInstanceOf(PushPermissionDeniedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never re-asks once the browser's own denial already stands", async () => {
    definePushGlobals({ permission: "denied" });
    defineServiceWorker({ pushManager: { getSubscription: vi.fn(), subscribe: vi.fn() } });
    await expect(subscribeToPush(api)).rejects.toBeInstanceOf(PushPermissionDeniedError);
  });

  it("refuses on a browser with none of the required APIs", async () => {
    await expect(subscribeToPush(api)).rejects.toBeInstanceOf(PushUnsupportedError);
  });
});

describe("unsubscribeFromPush (#308) — the sign-out / settings-off path", () => {
  it("unsubscribes the live browser subscription and tells the daemon", async () => {
    definePushGlobals();
    const subscription = fakeSubscription();
    defineServiceWorker({ pushManager: { getSubscription: vi.fn(async () => subscription) } });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await unsubscribeFromPush(api);

    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://100.64.1.5:7717/push/subscriptions",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("still tells the daemon to forget this device even with no live local subscription — the daemon's own row may outlive a browser that already dropped its side", async () => {
    definePushGlobals();
    defineServiceWorker({ pushManager: { getSubscription: vi.fn(async () => null) } });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(unsubscribeFromPush(api)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://100.64.1.5:7717/push/subscriptions",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("never calls the daemon or throws when this browser can't do push at all (no serviceWorker/PushManager)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(unsubscribeFromPush(api)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never calls the daemon when api is null (already signed out of the pairing)", async () => {
    definePushGlobals();
    const subscription = fakeSubscription();
    defineServiceWorker({ pushManager: { getSubscription: vi.fn(async () => subscription) } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await unsubscribeFromPush(null);

    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws — a dead token or an unreachable daemon must not block a sign-out already in progress", async () => {
    definePushGlobals();
    const subscription = fakeSubscription();
    defineServiceWorker({ pushManager: { getSubscription: vi.fn(async () => subscription) } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "nope" } }), { status: 401 })),
    );

    await expect(unsubscribeFromPush(api)).resolves.toBeUndefined();
  });
});

describe("wirePushNavigationMessages (#308) — a notification click, routed once the app is open again", () => {
  it("sets the hash from a service-worker message and unwires cleanly", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", { value: { addEventListener, removeEventListener }, configurable: true });

    window.location.hash = "";
    const unwire = wirePushNavigationMessages();
    expect(unwire).not.toBeNull();
    const [eventName, handler] = addEventListener.mock.calls[0]!;
    expect(eventName).toBe("message");

    handler({ data: { type: "duo-notification-click", hash: "#draft/abc" } });
    expect(window.location.hash).toBe("#draft/abc");

    unwire!();
    expect(removeEventListener).toHaveBeenCalledWith("message", handler);
  });

  it("ignores a message that isn't its own", () => {
    const addEventListener = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", { value: { addEventListener, removeEventListener: vi.fn() }, configurable: true });
    window.location.hash = "#chats";
    wirePushNavigationMessages();
    const handler = addEventListener.mock.calls[0]![1];
    handler({ data: { type: "something-else" } });
    expect(window.location.hash).toBe("#chats");
  });

  it("returns null where there is no service worker to ever hear from", () => {
    expect(wirePushNavigationMessages()).toBeNull();
  });
});
