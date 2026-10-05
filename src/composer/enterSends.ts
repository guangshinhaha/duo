/**
 * #244: whether a bare Enter sends. On a device whose primary input is a
 * touch screen (no hover, a coarse pointer — a phone or tablet keyboard),
 * Enter is a new line and the Send button sends, as most mobile chat apps
 * do; everywhere else Enter sends and Shift+Enter is the new line. Read at
 * keypress time, so a tablet that gains a keyboard and trackpad follows.
 */
export function enterSends(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  // `pointer` names the primary pointer, which can't be both coarse and fine;
  // asking both keeps the answer "desktop" wherever the environment can't
  // honestly say (a stub that answers yes to every query).
  const touchFirst = window.matchMedia("(hover: none) and (pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches;
  return !touchFirst;
}
