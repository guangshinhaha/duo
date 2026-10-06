import type { PlatformStorage } from "./types.js";

/*
 * #320: the parts every adapter shares today. Both Tauri adapters run the
 * same webview as the browser, so for now they keep the browser's storage and
 * touch rule; a native backend replaces only the adapter that needs it.
 */

/**
 * `PlatformStorage` over a Web Storage object (localStorage). The getter is
 * read per call — a private window or a sandboxed frame can throw on the
 * very property access — and every failure reads as "nothing stored" or is
 * swallowed, never thrown.
 */
export function webStorage(area: () => Storage | undefined): PlatformStorage {
  const safe = (): Storage | undefined => {
    try {
      return area();
    } catch {
      return undefined;
    }
  };
  return {
    async get(key) {
      try {
        return safe()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        safe()?.setItem(key, value);
      } catch {
        // Quota or blocked storage: the value lasts this session at most.
      }
    },
    async remove(key) {
      try {
        safe()?.removeItem(key);
      } catch {
        // Nothing to remove is not a failure.
      }
    },
    async keys(prefix = "") {
      const store = safe();
      if (!store) {
        return [];
      }
      try {
        const found: string[] = [];
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          if (key !== null && key.startsWith(prefix)) {
            found.push(key);
          }
        }
        return found;
      } catch {
        return [];
      }
    },
  };
}

/**
 * #252/#244's rule: no hover and a coarse primary pointer. Asking `pointer:
 * fine` too keeps a hybrid device (a tablet with a trackpad) and a stub that
 * answers yes to every query reading as desktop. No `matchMedia`: desktop.
 */
export function readTouchPrimary(matchMedia: ((query: string) => { matches: boolean }) | undefined): boolean {
  if (typeof matchMedia !== "function") {
    return false;
  }
  return matchMedia("(hover: none) and (pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches;
}
