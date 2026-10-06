import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, onAction, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { readTouchPrimary, webStorage } from "./shared.js";
import type { Platform } from "./types.js";

/*
 * #320: the Mac app's adapter — what notifications.ts (C5/#25/#69) and
 * dockBadge.ts (#22) used to do inline, behind the shared interface. Storage
 * and the touch rule are the webview's own, the same as the browser's, until
 * a native backend has a reason to differ (#288).
 */

/** The Tauri calls this adapter makes, injectable so a test hands it a fake (test/platformFakes.ts). */
export interface TauriHost {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  sendNotification(options: { id: number; title: string; body: string }): void;
  /** Subscribes to notification clicks; the callback gets the clicked notification's own options back. */
  onAction(callback: (notification: { id?: number }) => void): Promise<{ unregister(): void }>;
  /** `undefined` clears the badge. */
  setBadgeCount(count: number | undefined): Promise<void>;
  /** Shows the main window — the close button hides rather than quits (#42). */
  showWindow(): Promise<void>;
  /** Goes to an app address inside the webview. */
  navigate(hash: string): void;
  storageArea(): Storage | undefined;
  matchMedia: ((query: string) => { matches: boolean }) | undefined;
}

export function tauriHost(): TauriHost {
  return {
    isPermissionGranted,
    requestPermission: () => requestPermission(),
    sendNotification: (options) => sendNotification(options),
    onAction: (callback) => onAction(callback),
    // getCurrentWindow throws synchronously outside the shell; async here turns that into a rejection.
    setBadgeCount: async (count) => getCurrentWindow().setBadgeCount(count),
    showWindow: async () => getCurrentWindow().show(),
    navigate: (hash) => {
      window.location.hash = hash;
    },
    storageArea: () => localStorage,
    get matchMedia() {
      return typeof window !== "undefined" && typeof window.matchMedia === "function" ? (query: string) => window.matchMedia(query) : undefined;
    },
  };
}

/** Both Tauri targets share this body; the mobile adapter only renames it for now (tauriMobile.ts). */
export function createTauriPlatform(kind: "tauri-desktop" | "tauri-mobile", host: TauriHost): Platform {
  /*
   * Permission is cached rather than asked for on every message: macOS
   * prompts once per app, and re-asking after a denial is both useless and
   * hostile. A plugin call that rejects reads as a denial.
   */
  let permission: "unknown" | "granted" | "denied" = "unknown";
  async function ensurePermission(): Promise<boolean> {
    if (permission !== "unknown") {
      return permission === "granted";
    }
    try {
      const granted = (await host.isPermissionGranted()) || (await host.requestPermission()) === "granted";
      permission = granted ? "granted" : "denied";
    } catch {
      permission = "denied";
    }
    return permission === "granted";
  }

  /*
   * #25: a notification opens what it is about. The plugin's click callback
   * echoes only the notification's options, whose one caller-controllable
   * field is a 32-bit integer `id` — so each notification takes the next
   * integer and this map keeps the integer→address half. Bounded: a click on
   * a long-gone notification finds no entry and is ignored.
   */
  let nextId = 1;
  const hashById = new Map<number, string | undefined>();

  return {
    kind,

    async notify(title, body, options) {
      if (!(await ensurePermission())) {
        return;
      }
      try {
        const id = nextId++;
        hashById.set(id, options?.hash);
        if (hashById.size > 100) {
          const oldest = hashById.keys().next();
          if (!oldest.done) {
            hashById.delete(oldest.value);
          }
        }
        host.sendNotification({ id, title, body });
      } catch {
        // A failed notification must never break the surface that triggered it.
      }
    },

    async wireNotificationClicks() {
      try {
        const listener = await host.onAction((notification) => {
          if (notification.id === undefined || !hashById.has(notification.id)) {
            return; // not ours
          }
          // #42: the window may be hidden; bring it up before navigating, or
          // the navigation lands where nobody sees it. A failed reveal is not
          // a failed click.
          void host.showWindow().catch(() => {});
          const hash = hashById.get(notification.id);
          if (hash !== undefined) {
            host.navigate(hash);
          }
        });
        return () => void listener.unregister();
      } catch {
        return null;
      }
    },

    async setBadge(count) {
      try {
        // `undefined` clears: zero is "nothing waiting", not "zero waiting".
        await host.setBadgeCount(count > 0 ? count : undefined);
      } catch {
        // No dock to badge is not an error.
      }
    },

    storage: webStorage(() => host.storageArea()),

    // #321 wires the Tauri deep-link plugin here; until then no link reaches the app from outside.
    async onDeepLink() {
      return null;
    },

    // No motor on a Mac. The mobile adapter wires the haptics plugin when there is a phone build.
    async haptic() {},

    // No share sheet from the webview yet; a native share command lands here when one exists.
    async share() {
      return false;
    },

    isTouchPrimary: () => readTouchPrimary(host.matchMedia),
  };
}

export function createTauriDesktopPlatform(host: TauriHost = tauriHost()): Platform {
  return createTauriPlatform("tauri-desktop", host);
}
