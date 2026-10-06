import { readTouchPrimary, webStorage } from "./shared.js";
import type { Platform, ShareData } from "./types.js";

/*
 * #320: the browser adapter — standard web APIs only, each feature-detected.
 * The notification half is #221's browser path moved here unchanged: Cinny's
 * `SystemNotification.tsx` (AGPL-3.0) was read for the approach only — ask at
 * the moment a notification would otherwise be silent, show while the tab
 * can't be seen, route a click to what it was about — and nothing from it is
 * copied. `Notification.permission` is the permission cache; a denial is the
 * browser's own standing answer and is never re-asked.
 */

/** The slice of the Web Notification API this adapter uses. */
export interface WebNotificationApi {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (title: string, options?: { body?: string }): { onclick: (() => void) | null; close(): void };
}

/** The slice of `navigator` this adapter uses: the Badging and Web Share APIs. */
export interface WebNavigator {
  setAppBadge?(count?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
  share?(data: ShareData): Promise<void>;
}

/**
 * Everything the web adapter touches in the browser, injectable so a test
 * hands it a fake (test/platformFakes.ts) instead of stubbing globals.
 */
export interface WebHost {
  notificationApi(): WebNotificationApi | undefined;
  /** Whether the member is looking at this tab right now (visible and focused). */
  attended(): boolean;
  /** Brings the tab forward and, given one, goes to an address. */
  open(hash: string | undefined): void;
  storageArea(): Storage | undefined;
  navigator(): WebNavigator | undefined;
  matchMedia: ((query: string) => { matches: boolean }) | undefined;
}

export function browserHost(): WebHost {
  return {
    notificationApi: () => (typeof Notification === "undefined" ? undefined : (Notification as unknown as WebNotificationApi)),
    attended: () => typeof document === "undefined" || (!document.hidden && document.hasFocus()),
    open: (hash) => {
      window.focus();
      if (hash !== undefined) {
        window.location.hash = hash;
      }
    },
    storageArea: () => localStorage,
    navigator: () => (typeof navigator === "undefined" ? undefined : (navigator as unknown as WebNavigator)),
    get matchMedia() {
      return typeof window !== "undefined" && typeof window.matchMedia === "function" ? (query: string) => window.matchMedia(query) : undefined;
    },
  };
}

export function createWebPlatform(host: WebHost = browserHost()): Platform {
  return {
    kind: "web",

    async notify(title, body, options) {
      const api = host.notificationApi();
      if (api === undefined || host.attended()) {
        // No API here, or the tab is right in front of the member: nothing to catch their eye for.
        return;
      }
      try {
        if (api.permission === "denied") {
          return;
        }
        const granted = api.permission === "granted" ? true : (await api.requestPermission()) === "granted";
        if (!granted) {
          return;
        }
        const notification = new api(title, { body });
        notification.onclick = () => {
          host.open(options?.hash);
          notification.close();
        };
      } catch {
        // A failed notification must never break the arrival that triggered it.
      }
    },

    // Each web notification carries its own onclick above; there is no
    // outside channel yet. #308's service worker adds one here.
    async wireNotificationClicks() {
      return null;
    },

    async setBadge(count) {
      // The Badging API exists only for an installed PWA on some browsers; elsewhere this is nothing.
      const nav = host.navigator();
      try {
        if (count > 0) {
          await nav?.setAppBadge?.(count);
        } else {
          await nav?.clearAppBadge?.();
        }
      } catch {
        // No badge to set is not an error.
      }
    },

    storage: webStorage(() => host.storageArea()),

    async onDeepLink() {
      return null;
    },

    async haptic() {},

    async share(data) {
      const nav = host.navigator();
      if (typeof nav?.share !== "function") {
        return false;
      }
      try {
        await nav.share(data);
        return true;
      } catch {
        // Dismissed, or not allowed without a user gesture.
        return false;
      }
    },

    isTouchPrimary: () => readTouchPrimary(host.matchMedia),
  };
}
