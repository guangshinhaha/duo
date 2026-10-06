import { getPlatform } from "./platform/index.js";

/**
 * The app-icon badge (#22 / §3.1): the same pending-draft count the sidebar
 * shows, mirrored out of the window so the owner can leave the app closed
 * until something needs them — the macOS dock in the Mac app, an installed
 * PWA's icon where the browser supports it, nothing elsewhere (#320: the
 * platform adapter decides). Zero clears it.
 */
export async function setDockBadgeCount(count: number): Promise<void> {
  await getPlatform().setBadge(count);
}
