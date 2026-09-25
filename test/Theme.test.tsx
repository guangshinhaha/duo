// Node builtins resolve at runtime (vitest runs in Node) but the app tsconfig
// deliberately has no node types — the app never touches them. Suppressed
// here rather than adding `node` to tsconfig `types` for one test file.
// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../src/routes/Settings.js";
import { initTheme, setThemePreference, THEME_STORAGE_KEY } from "../src/theme.js";
import type { DuoApiConfig } from "../src/api/client.js";

const api: DuoApiConfig = { baseUrl: "http://test:7717", token: "tok" };
const onConfigChange = vi.fn();

/*
 * #35: the theme is a choice, not an OS default. These tests cover the
 * three ACs: the control applies and remembers; "system" leaves the
 * palette to the OS's own live media query; and both palettes are
 * complete against each other, with --muted at Part 4's AAA target on
 * every backdrop it can sit on.
 */

/** #31's WCAG helpers, copied rather than imported — cross-test imports couple suites. */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const channel = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const tokensCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles", "tokens.css"), "utf8");

/** One declaration block's custom properties, name → value. */
function colorTokens(block: string): Record<string, string> {
  const entries = [...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()] as const);
  return Object.fromEntries(entries);
}

function firstBlock(pattern: RegExp): string {
  const match = tokensCss.match(pattern);
  if (!match) {
    throw new Error(`tokens.css has no block for ${pattern}`);
  }
  return match[0];
}

// `:root` before any attribute is the dark default; the light override is
// its own block, and the system-follow block repeats it under a media
// query keyed so an explicit dark choice is excluded.
const darkPalette = colorTokens(firstBlock(/:root\s*\{[^}]*\}/));
const lightPalette = colorTokens(firstBlock(/:root\[data-theme="light"\]\s*\{[^}]*\}/));

describe("#35 AC1 — the theme can be chosen, applied now, and remembered", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("picking light or dark stamps it immediately; picking system unstamps; each choice is remembered", () => {
    render(<Settings api={api} session={null} onConfigChange={onConfigChange} onSignOut={() => {}} onPairDuo={() => {}} onWorkspaceSignIn={() => {}} />);
    const control = screen.getByLabelText("Theme");

    fireEvent.change(control, { target: { value: "light" } });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    fireEvent.change(control, { target: { value: "dark" } });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    // "system" is the absence of a stamp — the OS's own media query
    // takes over, which is exactly what AC2 exercises.
    fireEvent.change(control, { target: { value: "system" } });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("a fresh launch stamps the remembered choice; no remembered choice (or a stray value) means system", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(initTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    delete document.documentElement.dataset.theme;
    expect(initTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset.theme;
    expect(initTheme()).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);

    localStorage.setItem(THEME_STORAGE_KEY, "high-contrast");
    expect(initTheme()).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("#35 AC2 — system means system, without a reload", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("the unstamped root is governed by a live prefers-color-scheme block that dark cannot leak into", () => {
    // The follow is CSS, not JavaScript: with no stamp, the OS flipping
    // appearance re-evaluates the media query in place — nothing to
    // reload, nothing to listen for. The block must exist, carry the
    // light palette, and be keyed so an explicit dark choice is excluded.
    const media = tokensCss.match(/@media \(prefers-color-scheme: light\)\s*\{/);
    expect(media).not.toBeNull();
    const systemBlock = firstBlock(/:root:not\(\[data-theme="dark"\]\)\s*\{[^}]*\}/);
    expect(colorTokens(systemBlock)).toEqual(lightPalette);

    // And the exclusion keys on exactly what setThemePreference stamps.
    setThemePreference("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    setThemePreference("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("#35 AC3 — both themes are complete, and muted meets Part 4's AAA", () => {
  it("light defines every colour dark does, and neither inherits from the other", () => {
    expect(Object.keys(lightPalette).sort()).toEqual(Object.keys(darkPalette).sort());
    // Completeness is also distinctness: every colour that is not
    // deliberately shared must differ between the ramps. `--refused` is
    // the one deliberate share — a mid-grey that Part 4 gives both
    // themes explicitly.
    const shared = new Set(["refused"]);
    for (const [name, value] of Object.entries(lightPalette)) {
      if (!shared.has(name)) {
        expect(value, `--${name} is not inherited from the dark ramp`).not.toBe(darkPalette[name]);
      }
    }
  });

  it("--muted carries provenance at AAA (7:1) on every backdrop, in both themes", () => {
    for (const [label, palette] of [["dark", darkPalette], ["light", lightPalette]] as const) {
      for (const backdrop of ["bg", "surface", "surface-2"]) {
        expect(contrast(palette.muted, palette[backdrop]), `${label} --muted on --${backdrop}`).toBeGreaterThanOrEqual(7);
      }
    }
  });
});
