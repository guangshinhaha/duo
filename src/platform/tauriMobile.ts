import { createTauriPlatform, tauriHost, type TauriHost } from "./tauriDesktop.js";
import type { Platform } from "./types.js";

/*
 * #320: the phone app's adapter. There is no Tauri mobile build yet, so this
 * is the desktop body under its own name: the seam exists, getPlatform()
 * already routes a Tauri webview on iOS/Android here, and the phone-only
 * pieces (the haptics plugin, a native share sheet, push via #154) replace
 * the desktop no-ops in this file when that build exists — no caller changes.
 */
export function createTauriMobilePlatform(host: TauriHost = tauriHost()): Platform {
  return createTauriPlatform("tauri-mobile", host);
}
