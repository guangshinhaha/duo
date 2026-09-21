/**
 * #35: the theme preference. `tokens.css` already carries all three
 * behaviours — dark at `:root`, light at `:root[data-theme="light"]`, and
 * a live `prefers-color-scheme` block that governs any root not
 * explicitly dark — so this module's whole job is one attribute: stamp
 * the choice, or remove the stamp and let the OS's own media query
 * follow. "System" therefore needs no listener and no reload: nothing
 * stamped means the palette is the OS's question, re-answered in place
 * every time the appearance flips.
 */

export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "duo.theme";

/** The remembered choice, or "system" for nothing (or something stale) remembered. */
export function readThemePreference(): ThemePreference {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** The stamp is the whole application: chosen, or absent for the OS's media query. */
function applyStamp(preference: ThemePreference): void {
  if (preference === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = preference;
  }
}

/** Remembers the choice and applies it now. */
export function setThemePreference(preference: ThemePreference): void {
  localStorage.setItem(THEME_STORAGE_KEY, preference);
  applyStamp(preference);
}

/** Launch: stamp what was remembered, before first paint, and report what applied. */
export function initTheme(): ThemePreference {
  const preference = readThemePreference();
  applyStamp(preference);
  return preference;
}
