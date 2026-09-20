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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { DraftCard } from "../src/components/DraftCard.js";
import { RuleCard } from "../src/components/RuleCard.js";
import { Setup } from "../src/routes/Setup.js";
import { Settings } from "../src/routes/Settings.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord, Rule } from "../src/api/types.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

/*
 * #31: every primary button rendered white on `--accent`, which measures
 * 2.98:1 in dark mode — below AA for text and below the 3:1 floor for UI
 * components. The fix is a foreground choice, not a second accent: the
 * button label takes `var(--bg)` (the pattern `Ask.tsx` already used),
 * which measures ≥ 4.5:1 against `--accent` in both themes. These tests
 * read the token values out of `tokens.css` itself so a palette change
 * can't quietly reintroduce a failing pair.
 */

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

/** Every declared value of a token in file order — `:root` (dark) first, then the light overrides (the media-query block repeats them). */
function tokenValues(name: string): string[] {
  const matches = [...tokensCss.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`, "g"))].map((m) => m[1].toLowerCase());
  return [...new Set(matches)];
}

const accentDark = tokenValues("accent")[0];
const accentLight = tokenValues("accent")[1];
const bgDark = tokenValues("bg")[0];
const bgLight = tokenValues("bg")[1];

describe("#31 — primary actions pass AA in both themes, with one accent", () => {
  it("dark-mode accent with the app's own background as label colour meets 4.5:1", () => {
    expect(contrast(bgDark, accentDark)).toBeGreaterThanOrEqual(4.5);
  });

  it("light-mode accent with the light background as label colour meets 4.5:1", () => {
    expect(contrast(bgLight, accentLight)).toBeGreaterThanOrEqual(4.5);
  });

  it("white on the dark accent is what failed — it stays below AA, so no primary button may use it again", () => {
    expect(contrast("#ffffff", accentDark)).toBeLessThan(4.5);
  });

  it("there is still exactly one accent, with one meaning (§1.6)", () => {
    // One accent token per theme, unchanged in kind: the fix was the
    // foreground, not a second accent value.
    expect(tokenValues("accent")).toHaveLength(2);
  });
});

/** The foreground contract as rendered: every primary button labels itself with `var(--bg)`, never `text-white`. */
function primaryButton(label: string | RegExp): HTMLElement {
  const button = screen.getByText(label, { selector: "button" }).closest("button");
  if (!(button instanceof HTMLElement)) {
    throw new Error(`no button for ${String(label)}`);
  }
  expect(button.className).toContain("bg-[var(--accent)]");
  expect(button.className).not.toContain("text-white");
  expect(button.className).toContain("text-[var(--bg)]");
  return button;
}

const draft: DraftRecord = {
  id: "d1",
  question: "What's our refund policy?",
  threadContext: null,
  draftText: "Refunds within 30 days.",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.8,
  sources: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.6,
  provenance: { origin: "unknown" },
};

const escalated: DraftRecord = { ...draft, id: "d2", escalated: true, draftText: null, escalationReason: "not sure enough", refused: false };

const rule: Rule = {
  id: "r1",
  topicId: "t1",
  text: "Always point refund questions at the runbook.",
  status: "confirmed",
  supportCount: 3,
  consistency: 0.9,
  createdAt: "2026-09-01T00:00:00.000Z",
  lastConfirmedAt: null,
  reviewStatus: "pending",
  origin: "derived",
};

/** Composer/DraftCard/RuleCard mutate through TanStack, so their renders need a client. */
function renderWithClient(ui: React.ReactElement): ReturnType<typeof render> {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("#31 — every primary button renders the accessible foreground", () => {
  it("Setup's Connect", () => {
    render(<Setup onConnect={() => {}} />);
    primaryButton("Connect");
  });

  it("Composer's Ask", () => {
    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    primaryButton("Ask");
  });

  it("DraftCard's Send, Send edited, and Answer", () => {
    const { unmount } = renderWithClient(<DraftCard api={api} draft={draft} />);
    primaryButton("Send");
    fireEvent.click(screen.getByText("Edit", { selector: "button" }));
    // #23: "Send edited" exists only once the text actually differs — make
    // a change so the changed-state button is the one under test.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: `${draft.draftText ?? ""} More.` } });
    primaryButton("Send edited");
    unmount();

    renderWithClient(<DraftCard api={api} draft={escalated} />);
    // The Answer button's input must be non-empty for it to matter, but the
    // foreground is on the element regardless of its disabled state.
    primaryButton("Answer");
  });

  it("RuleCard's approve and promote", () => {
    const { unmount } = renderWithClient(<RuleCard api={api} rule={rule} bucket="awaitingApproval" />);
    primaryButton("Approve");
    unmount();
    renderWithClient(<RuleCard api={api} rule={{ ...rule, status: "weak_signal" }} bucket="weakSignals" />);
    primaryButton("Promote");
  });

  it("Settings' Save", () => {
    render(<Settings api={api} onConfigChange={() => {}} />);
    primaryButton("Save");
  });

  it("a disabled primary button keeps its shape and label at 40% opacity", () => {
    render(<Setup onConnect={() => {}} />);
    // Connect starts disabled (empty address/token). Distinguishable-as-a-
    // control is the accent background and the label, kept by the opacity
    // utility that was already there — not a contrast ratio (WCAG exempts
    // disabled controls).
    const button = primaryButton("Connect");
    expect(button.className).toContain("disabled:opacity-40");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button).toHaveTextContent("Connect");
  });
});
