// Node builtins resolve at runtime (vitest runs in Node) but the app tsconfig
// deliberately has no node types — the app never touches them. Suppressed
// here rather than adding `node` to tsconfig `types` for one test file.
// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { readdirSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Review } from "../src/routes/Review.js";
import { Settings } from "../src/routes/Settings.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord } from "../src/api/types.js";

/*
 * #36: the keyboard layer. Four laws, each pinned: the queue is
 * walkable entry by entry with the arrows; Escape leaves whatever
 * opened — discarding nothing that was not already discardable — and
 * hands focus back to the opener; one focus law rings every control in
 * the accent at contrast, in both themes; and Settings is the one place
 * that lists the shortcuts that exist.
 */

const api: DuoApiConfig = { baseUrl: "http://test:7717", token: "tok" };

function draftAt(index: number): DraftRecord {
  return {
    id: `d${index}`,
    question: `question number ${index}`,
    threadContext: null,
    draftText: `answer number ${index}`,
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.8,
    sources: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    outcome: null,
    outcomeRecordedAt: null,
    sentText: null,
    refused: false,
    escalationThreshold: 0.55,
    provenance: { origin: "unknown" },
    delivery: null,
  };
}

/** #48: Settings lists the paired devices, so it needs a query client and a daemon that answers (an empty list — these tests are about other things). */
function renderSettings() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Settings api={api} session={null} onConfigChange={() => {}} onSignOut={() => {}} onPairDuo={() => {}} onWorkspaceSignIn={() => {}} />
    </QueryClientProvider>,
  );
}

function renderReview(drafts: DraftRecord[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal(
    "fetch",
    vi.fn((): Promise<Response> => Promise.resolve(new Response(JSON.stringify(drafts), { status: 200 }))),
  );
  return render(
    <QueryClientProvider client={client}>
      <Review api={api} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#36 AC1 — Review is navigable from the keyboard", () => {
  it("exactly one entry is the tab stop, and the tab stop follows real focus", async () => {
    renderReview([draftAt(1), draftAt(2), draftAt(3)]);
    const entries = await screen.findAllByTestId("review-entry");

    // The roving tab stop: one entry is reachable by Tab, the rest by
    // arrow — the queue is one tab stop, not N.
    expect(entries.map((entry) => entry.tabIndex)).toEqual([0, -1, -1]);

    entries[2].focus();
    await waitFor(() => expect(entries[2].tabIndex).toBe(0));
    expect(entries.map((entry) => entry.tabIndex)).toEqual([-1, -1, 0]);
  });

  it("the arrows move focus entry by entry and clamp at both ends", async () => {
    renderReview([draftAt(1), draftAt(2), draftAt(3)]);
    const entries = await screen.findAllByTestId("review-entry");

    entries[0].focus();
    fireEvent.keyDown(entries[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(entries[1]);
    fireEvent.keyDown(entries[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(entries[2]);
    // Past the end is a no-op, not a wrap and not a loss of focus.
    fireEvent.keyDown(entries[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(entries[2]);

    fireEvent.keyDown(entries[2], { key: "ArrowUp" });
    expect(document.activeElement).toBe(entries[1]);
    fireEvent.keyDown(entries[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(entries[0]);
    fireEvent.keyDown(entries[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(entries[0]);
  });

  it("the focused entry's actions are native buttons inside it, and arrows in an editor are the caret's", async () => {
    renderReview([draftAt(1), draftAt(2)]);
    const entries = await screen.findAllByTestId("review-entry");

    // Reachable without a pointer: the focused entry's actions are real
    // buttons inside the focusable entry, so Tab walks straight into
    // them once the entry has focus.
    const actions = entries[0].querySelectorAll("button");
    expect(actions.length).toBeGreaterThan(0);

    // An open editor's arrows belong to the text caret, not the queue.
    fireEvent.click(screen.getAllByText("Edit")[0]);
    const editor = screen.getByRole("textbox");
    editor.focus();
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    expect(document.activeElement).toBe(editor);
  });
});

describe("#36 AC2 — Escape leaves, discarding nothing that was not already discardable", () => {
  it("Escape on a card's editor is Cancel, and focus returns to the Edit that opened it", async () => {
    renderReview([draftAt(1)]);
    const entries = await screen.findAllByTestId("review-entry");
    expect(entries).toHaveLength(1);

    const edit = screen.getByText("Edit");
    edit.focus();
    fireEvent.click(edit);
    const editor = screen.getByRole("textbox");
    fireEvent.change(editor, { target: { value: "an edit that will be discarded" } });

    fireEvent.keyDown(editor, { key: "Escape" });

    // Closed, the edit discarded — exactly what Cancel discards, nothing
    // more (the draft itself is untouched on the wire).
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Send")).toBeInTheDocument();

    // Focus returns where the editor came from.
    await waitFor(() => expect(document.activeElement).toBe(edit));
  });

  it("Escape closes the unpair dialog and returns focus to its trigger", async () => {
    renderSettings();
    const trigger = screen.getByTestId("settings-unpair");
    trigger.focus();
    fireEvent.click(trigger);

    await screen.findByTestId("settings-unpair-confirmation");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("settings-unpair-confirmation")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("#36 AC3 — every interactive element shows focus, at contrast, in both themes", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

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

  function sourceFiles(dir: string): string[] {
    // Dirent, described structurally — the app tsconfig carries no node
    // types by design, so the shape is stated instead of imported.
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry: { name: string; isDirectory(): boolean }) =>
      entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".tsx") || entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
    );
  }

  it("one global :focus-visible rule rings in the accent, and nothing opts out of it", () => {
    const tokensCss = readFileSync(join(srcRoot, "styles", "tokens.css"), "utf8");
    // The law is stated once, for everything focusable: a 2px accent
    // ring, offset so it never eats the control's own border.
    expect(tokensCss).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--accent\);\s*outline-offset:\s*2px;\s*\}/);

    // And no surface suppresses it — `outline-none` anywhere would leave
    // that control invisible to the keyboard.
    const offenders = sourceFiles(srcRoot).filter((file) => readFileSync(file, "utf8").includes("outline-none"));
    expect(offenders).toEqual([]);
  });

  it("the accent ring clears the 3:1 non-text floor on every backdrop, in both themes", () => {
    const tokensCss = readFileSync(join(srcRoot, "styles", "tokens.css"), "utf8");
    // #35's block parsers: each theme's own ramp, paired with its own
    // accent — a ring only ever renders against its own theme.
    const colorTokens = (block: string) =>
      Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2].toLowerCase()] as const));
    const firstBlock = (pattern: RegExp) => {
      const match = tokensCss.match(pattern);
      if (!match) {
        throw new Error(`tokens.css has no block for ${pattern}`);
      }
      return match[0];
    };
    const themes = [
      colorTokens(firstBlock(/:root\s*\{[^}]*\}/)),
      colorTokens(firstBlock(/:root\[data-theme="light"\]\s*\{[^}]*\}/)),
    ];
    for (const palette of themes) {
      for (const backdrop of ["bg", "surface", "surface-2"]) {
        expect(contrast(palette.accent, palette[backdrop])).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("#36 AC4 — shortcuts are discoverable in one place", () => {
  it("Settings lists every shortcut that exists and what it does", () => {
    renderSettings();
    const section = screen.getByText("Keyboard", { selector: "h2" }).closest("section");
    expect(section).not.toBeNull();

    // What exists today, all of it: the search opener, the queue arrows,
    // how an entry's actions are reached, and the way out of anything.
    expect(section).toHaveTextContent("⌘K");
    expect(section).toHaveTextContent("↑ ↓");
    expect(section).toHaveTextContent("Tab");
    expect(section).toHaveTextContent("Esc");
    expect(section).toHaveTextContent("Search what your duo knows");
    expect(section).toHaveTextContent("Move through the Review queue, entry by entry");
    expect(section).toHaveTextContent("Leave an open editor, dialog or menu");
  });
});
