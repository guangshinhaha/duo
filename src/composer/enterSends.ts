import { getPlatform } from "../platform/index.js";

/**
 * #244: whether a bare Enter sends. On a device whose primary input is a
 * touch screen (no hover, a coarse pointer — a phone or tablet keyboard),
 * Enter is a new line and the Send button sends, as most mobile chat apps
 * do; everywhere else Enter sends and Shift+Enter is the new line. Read at
 * keypress time, so a tablet that gains a keyboard and trackpad follows.
 */
export function enterSends(): boolean {
  // #320: the touch rule is the platform's, shared with every other surface that asks.
  return !getPlatform().isTouchPrimary();
}
