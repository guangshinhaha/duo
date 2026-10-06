/*
 * #320: the one seam between duo's features and the thing they run inside —
 * a browser tab, the Mac app (Tauri desktop), or later the phone app (Tauri
 * mobile). A feature asks `getPlatform()` (./index.ts) for this interface and
 * never branches on Tauri itself; each adapter decides what a call means where
 * it runs, and quietly does nothing where a capability doesn't exist. No call
 * here ever throws to its caller: a missing notification, badge or share is
 * never an error anywhere the UI needs to show.
 */

export type PlatformKind = "web" | "tauri-desktop" | "tauri-mobile";

/** Undoes a subscription. */
export type Unwire = () => void;

export interface NotifyOptions {
  /** The app address a click opens, e.g. `#chat/%21room%3Aserver`. Omitted: a click just brings the app forward. */
  readonly hash?: string;
}

/**
 * Small string key-value storage, async so a native (SQLite) or IndexedDB
 * backend can stand behind the same calls (#288). Values are strings —
 * callers JSON-encode — so every backend stores the same thing.
 */
export interface PlatformStorage {
  /** The stored value, or null for nothing stored (or storage unavailable). */
  get(key: string): Promise<string | null>;
  /** Stores a value. Blocked storage (a private window) is swallowed: the value lasts this session at most. */
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every stored key starting with `prefix` (all keys for none) — what a sign-out wipe walks (#288). */
  keys(prefix?: string): Promise<string[]>;
}

/** The shapes every phone haptics API offers (impact weights, outcomes, a selection tick). */
export type HapticKind = "selection" | "light" | "medium" | "heavy" | "success" | "warning" | "error";

export interface ShareData {
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
}

export interface Platform {
  readonly kind: PlatformKind;

  /**
   * Shows a system notification. Asks permission lazily, at the moment a
   * notification would otherwise have been shown, and never again after a
   * denial. The web adapter stays silent while the tab is visible and
   * focused — the open window already said it.
   */
  notify(title: string, body: string, options?: NotifyOptions): Promise<void>;

  /**
   * Subscribes, once per app, to notification clicks that arrive from
   * outside the page (the macOS notification centre, or — #308 — a
   * service worker's `notificationclick`, relayed here by `public/sw.js`
   * posting `{ type: "duo-notification-click", hash }` to this page) and
   * routes each to its `hash`. Null where no such channel exists.
   */
  wireNotificationClicks(): Promise<Unwire | null>;

  /** The app-icon badge (dock, home screen, installed PWA). Zero clears it. */
  setBadge(count: number): Promise<void>;

  readonly storage: PlatformStorage;

  /**
   * Registers the handler for links that open the app from outside it
   * (`duo://…`, claimed `matrix.to` links — #321), including the one it was
   * cold-started with. Null where the platform delivers none: on the web a
   * link is just a URL the hash router already reads.
   */
  onDeepLink(handler: (url: string) => void): Promise<Unwire | null>;

  /** A haptic tap. Does nothing where there is no motor (web, Mac). */
  haptic(kind: HapticKind): Promise<void>;

  /** Opens the system share sheet. Resolves false where unsupported or dismissed, true once shared. */
  share(data: ShareData): Promise<boolean>;

  /** Whether the primary input is touch (no hover, a coarse pointer) — read now, not live. */
  isTouchPrimary(): boolean;
}
