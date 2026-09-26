import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

/*
 * The seams between the web client and the Mac shell (#151), all in one
 * place and all feature-detecting: in a plain browser tab every one of them
 * quietly does the web thing or nothing, so the client never depends on the
 * shell (the same law dockBadge.ts, tray.ts and notifications.ts keep).
 */

/** Whether this webview is the menu-bar mini tray rather than the app. `#tray` is the address the shell opens it at; the window's own label is the fallback if a build drops the fragment. */
export function isTrayWindow(): boolean {
  if (window.location.hash === "#tray") {
    return true;
  }
  try {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } }).__TAURI_INTERNALS__;
    return internals?.metadata?.currentWindow?.label === "tray";
  } catch {
    return false;
  }
}

/**
 * Opens the app at an address: the shell brings the main window forward and
 * tells it where to go; in a plain tab it is just navigation. Used by the mini
 * tray for everything that is not a confident draft.
 */
export async function openInApp(hash: string): Promise<void> {
  try {
    await invoke("open_in_app", { hash });
  } catch {
    window.location.hash = hash;
  }
}

/** Hides the mini tray (after its work is done, or when the owner has opened the app instead). */
export async function hideTray(): Promise<void> {
  try {
    await invoke("hide_tray");
  } catch {
    // no shell, no popover to hide
  }
}

const DRAFTS_CHANGED = "duo-drafts-changed";

/** Tells the other window a decision was made here, so its lists and counts stop waiting for their next poll. */
export async function announceDraftsChanged(): Promise<void> {
  try {
    await emit(DRAFTS_CHANGED);
  } catch {
    // no other window in a plain tab
  }
}

/** Listens for `announceDraftsChanged` from the other window; returns the unwire function, or null outside the shell. */
export async function onDraftsChanged(handler: () => void): Promise<(() => void) | null> {
  try {
    const unlisten = await listen(DRAFTS_CHANGED, handler);
    return () => void unlisten();
  } catch {
    return null;
  }
}

/** Where the shell sends the app when the owner picks something in the mini tray. */
export async function wireOpenHash(): Promise<(() => void) | null> {
  try {
    const unlisten = await listen<string>("open-hash", (event) => {
      if (typeof event.payload === "string" && event.payload.startsWith("#")) {
        window.location.hash = event.payload;
      }
    });
    return () => void unlisten();
  } catch {
    return null;
  }
}

/**
 * The native menu's actions. A menu accelerator on the Mac takes the key
 * before the page sees it, so each menu item re-issues the very key the page
 * already handles — one handler per shortcut, in the browser and in the shell.
 */
const MENU_KEYS: Readonly<Record<string, string>> = {
  search: "k",
  inspector: "i",
  "chat-1": "1",
  "chat-2": "2",
  "chat-3": "3",
  "chat-4": "4",
  "chat-5": "5",
  "chat-6": "6",
  "chat-7": "7",
  "chat-8": "8",
  "chat-9": "9",
};

export async function wireMenu(): Promise<(() => void) | null> {
  try {
    const unlisten = await listen<string>("menu-action", (event) => {
      const id = event.payload;
      if (id === "settings") {
        window.location.hash = "#settings";
      } else if (id === "waiting") {
        window.location.hash = "#waiting";
      } else if (id === "chats") {
        window.location.hash = "#chats";
      } else if (MENU_KEYS[id] !== undefined) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: MENU_KEYS[id], metaKey: true, bubbles: true }));
      }
    });
    return () => void unlisten();
  } catch {
    return null;
  }
}
