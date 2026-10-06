import { vi } from "vitest";
import type { Platform, PlatformKind, ShareData } from "../src/platform/index.js";
import type { TauriHost } from "../src/platform/tauriDesktop.js";
import type { WebHost, WebNavigator, WebNotificationApi } from "../src/platform/web.js";

/*
 * #320: the fake-host pattern for anything behind src/platform/. Three tools,
 * from narrowest to widest:
 *
 * - `fakeWebHost()` / `fakeTauriHost()` — hand one to `createWebPlatform` /
 *   `createTauriDesktopPlatform` to test an adapter against recorded calls,
 *   with no module mocks and no stubbed globals.
 * - `fakePlatform()` — an in-memory Platform that records every call; pass it
 *   to `setPlatformForTesting` to test a feature that uses the platform
 *   without caring which adapter is underneath (call
 *   `setPlatformForTesting(null)` in afterEach).
 * - `inTauriShell()` / `leaveTauriShell()` — mark this test DOM as a Tauri
 *   webview, so `getPlatform()` picks the Tauri adapter over whatever
 *   `@tauri-apps/*` module mocks the test file installed.
 */

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

export function inTauriShell(): void {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
}

export function leaveTauriShell(): void {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
}

/** A Map-backed Web Storage object. */
export function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

export interface FakeNotification {
  readonly title: string;
  readonly body: string;
  onclick: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
}

/** A Web Notification API whose permission and answer a test sets, recording every notification shown. */
export function fakeNotificationApi(permission: NotificationPermission = "default", answer: NotificationPermission = "granted") {
  const shown: FakeNotification[] = [];
  const requestPermission = vi.fn(async () => answer);
  const api = class {
    static permission = permission;
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(
      readonly title: string,
      options?: { body?: string },
    ) {
      this.body = options?.body ?? "";
      shown.push(this as unknown as FakeNotification);
    }
    readonly body: string;
  };
  return { api: api as unknown as WebNotificationApi & { permission: NotificationPermission }, shown, requestPermission };
}

export function fakeWebHost(overrides: Partial<WebHost> = {}) {
  const notifications = fakeNotificationApi();
  const storage = memoryStorage();
  const opened: Array<string | undefined> = [];
  const navigator: WebNavigator = {};
  const host: WebHost = {
    notificationApi: () => notifications.api,
    attended: () => false,
    open: (hash) => void opened.push(hash),
    storageArea: () => storage,
    navigator: () => navigator,
    matchMedia: undefined,
    ...overrides,
  };
  return { host, notifications, storage, opened, navigator };
}

export function fakeTauriHost(overrides: Partial<TauriHost> = {}) {
  let clickHandler: ((notification: { id?: number }) => void) | undefined;
  const storage = memoryStorage();
  const navigated: string[] = [];
  const defaults = {
    isPermissionGranted: vi.fn(async () => true),
    requestPermission: vi.fn(async () => "granted"),
    sendNotification: vi.fn<(options: { id: number; title: string; body: string }) => void>(),
    onAction: vi.fn(async (callback: (notification: { id?: number }) => void) => {
      clickHandler = callback;
      return { unregister: vi.fn() };
    }),
    setBadgeCount: vi.fn<(count: number | undefined) => Promise<void>>(async () => {}),
    showWindow: vi.fn(async () => {}),
    navigate: (hash: string) => void navigated.push(hash),
    storageArea: () => storage,
    matchMedia: undefined as TauriHost["matchMedia"],
  };
  // Overrides are expected to be vi.fn()s too, so the mock typings stay honest for a test's assertions.
  const host = { ...defaults, ...overrides } as typeof defaults;
  /** Simulates the member clicking a notification in the notification centre. */
  const click = (id: number | undefined): void => clickHandler?.({ id });
  return { host, storage, navigated, click };
}

export interface FakePlatformCalls {
  notify: Array<{ title: string; body: string; hash?: string }>;
  badge: number[];
  haptic: string[];
  share: ShareData[];
}

/** An in-memory Platform recording what a feature asked of it. */
export function fakePlatform(kind: PlatformKind = "web", options: { touchPrimary?: boolean; shareResult?: boolean } = {}) {
  const calls: FakePlatformCalls = { notify: [], badge: [], haptic: [], share: [] };
  const items = new Map<string, string>();
  const deepLinkHandlers = new Set<(url: string) => void>();
  const platform: Platform = {
    kind,
    notify: async (title, body, notifyOptions) => void calls.notify.push({ title, body, hash: notifyOptions?.hash }),
    wireNotificationClicks: async () => () => {},
    setBadge: async (count) => void calls.badge.push(count),
    storage: {
      get: async (key) => items.get(key) ?? null,
      set: async (key, value) => void items.set(key, value),
      remove: async (key) => void items.delete(key),
      keys: async (prefix = "") => [...items.keys()].filter((key) => key.startsWith(prefix)),
    },
    onDeepLink: async (handler) => {
      deepLinkHandlers.add(handler);
      return () => void deepLinkHandlers.delete(handler);
    },
    haptic: async (hapticKind) => void calls.haptic.push(hapticKind),
    share: async (data) => {
      calls.share.push(data);
      return options.shareResult ?? true;
    },
    isTouchPrimary: () => options.touchPrimary ?? false,
  };
  /** Delivers a link as if the OS had opened the app with it. */
  const openLink = (url: string): void => deepLinkHandlers.forEach((handler) => handler(url));
  return { platform, calls, items, openLink };
}
