import { createTauriDesktopPlatform } from "./tauriDesktop.js";
import { createTauriMobilePlatform } from "./tauriMobile.js";
import type { Platform, PlatformKind } from "./types.js";
import { createWebPlatform } from "./web.js";

export type { HapticKind, NotifyOptions, Platform, PlatformKind, PlatformStorage, ShareData, Unwire } from "./types.js";

/*
 * #320: the single entry point. Features call `getPlatform()` and use what it
 * returns; nothing outside src/platform/ checks for Tauri (src/shell/native.ts
 * keeps the Mac-only window plumbing — tray, menu, cross-window events — that
 * has no meaning on any other platform).
 */

/**
 * Which host this webview is: every Tauri webview injects
 * `__TAURI_INTERNALS__`; a Tauri webview on iOS/Android is the phone app.
 */
export function detectPlatformKind(): PlatformKind {
  try {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      return "web";
    }
    const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
    return /Android|iPhone|iPad|iPod/i.test(ua) ? "tauri-mobile" : "tauri-desktop";
  } catch {
    return "web";
  }
}

const adapters = new Map<PlatformKind, Platform>();
let override: Platform | null = null;

const factories: Record<PlatformKind, () => Platform> = {
  web: () => createWebPlatform(),
  "tauri-desktop": () => createTauriDesktopPlatform(),
  "tauri-mobile": () => createTauriMobilePlatform(),
};

/**
 * The adapter for where this app is running. Each adapter is built once and
 * kept (it holds state such as the notification permission it was given);
 * the host check itself is a property lookup, re-read per call so a test can
 * switch hosts between cases without reloading modules.
 */
export function getPlatform(): Platform {
  if (override !== null) {
    return override;
  }
  const kind = detectPlatformKind();
  let adapter = adapters.get(kind);
  if (adapter === undefined) {
    adapter = factories[kind]();
    adapters.set(kind, adapter);
  }
  return adapter;
}

/**
 * Tests only: makes `getPlatform()` return `platform` (a fake from
 * test/platformFakes.ts, or an adapter built over a fake host) until called
 * again with null, which also drops every cached adapter.
 */
export function setPlatformForTesting(platform: Platform | null): void {
  override = platform;
  if (platform === null) {
    adapters.clear();
  }
}
