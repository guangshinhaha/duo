import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/*
 * #42: the menu-bar half of the shell. The pending count lives in exactly
 * one place client-side (ReviewLink's query), and this seam carries it to
 * the Rust tray the same way dockBadge.ts carries it to the dock — a
 * feature-detecting call that quietly no-ops in a plain browser tab, so
 * the web client never depends on the shell.
 */

/**
 * Sets the number the menu bar shows next to the tray icon. Zero is sent
 * as zero — "nothing waiting" is a state the menu bar should drop, and
 * the Rust half renders it by clearing the title, the same way the dock
 * seam renders zero as `undefined`.
 */
export async function setTrayPendingCount(count: number): Promise<void> {
  try {
    await invoke("set_pending_count", { count });
  } catch {
    // Not in the Tauri shell: there is no menu bar here to update, and
    // that is not an error anywhere the UI needs to show.
  }
}

/**
 * Subscribes, once per app, to the tray's Review item — the one-click
 * answer to "is anything waiting?". The Rust half shows and focuses the
 * window; the navigation is the client's half, exactly as a notification
 * click's is. Returns the unwire function (the caller owns the
 * subscription's lifetime) or null outside the shell.
 */
export async function wireTrayReview(): Promise<(() => void) | null> {
  try {
    const unlisten = await listen("tray-open-review", () => {
      window.location.hash = "#waiting";
    });
    return () => void unlisten();
  } catch {
    return null;
  }
}
