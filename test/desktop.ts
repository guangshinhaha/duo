import { vi } from "vitest";

/**
 * Lays the shell out as a window at least 768px wide: the chat list and the
 * open surface side by side. Without it a test DOM has no `matchMedia` and the
 * shell takes its narrow layout — one screen at a time, as on a phone. Call it
 * before render; `vi.unstubAllGlobals()` (already in every App test's cleanup)
 * puts it back.
 */
export function stubDesktop(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

/**
 * The opposite: a window narrower than 768px. The shell shows one screen at a
 * time — the chat list is home, and everything else is pushed onto it with a
 * way back. (A bare test DOM defaults to the desktop layout, since happy-dom's
 * viewport is 1024 wide; call this to be the phone.)
 */
export function stubPhone(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}
