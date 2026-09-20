// @ts-expect-error no node types by design (see test/contrast.test.tsx)
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfidenceHairline, hairlineState } from "../src/components/ConfidenceHairline.js";
import { DraftCard } from "../src/components/DraftCard.js";
import { App } from "../src/App.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftPipelineResult, DraftRecord } from "../src/api/types.js";

describe("hairlineState (client-tech-design.md Part 4)", () => {
  it("is refused for a refused escalation", () => {
    const result: DraftPipelineResult = { kind: "escalation", draftId: "d1", reason: "refused subject", refused: true, confidence: undefined };
    expect(hairlineState(result)).toBe("refused");
  });

  it("is escalated for a non-refused escalation", () => {
    const result: DraftPipelineResult = { kind: "escalation", draftId: "d1", reason: "no evidence", refused: false, confidence: undefined };
    expect(hairlineState(result)).toBe("escalated");
  });

  it("is confident when the score clears threshold + 0.15", () => {
    const result: DraftPipelineResult = {
      kind: "draft",
      draftId: "d1",
      text: "answer",
      sources: [],
      confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 },
    };
    expect(hairlineState(result)).toBe("confident");
  });

  it("is hedged just above threshold", () => {
    const result: DraftPipelineResult = {
      kind: "draft",
      draftId: "d1",
      text: "answer",
      sources: [],
      confidence: { score: 0.6, passesThreshold: true, threshold: 0.55 },
    };
    expect(hairlineState(result)).toBe("hedged");
  });
});

/*
 * #32: Part 4's hairline is "2px on the draft's leading edge" — a vertical
 * rule in the gutter you can scan a column by. It had shipped as `h-0.5
 * w-full`: a horizontal strip across the top of the card, which reads as
 * decoration and competes with the card's border. These tests pin the
 * placement; the four-state derivation above is unchanged and still
 * percentage-free.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

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
};

const escalatedDraft: DraftRecord = {
  ...draft,
  id: "d2",
  escalated: true,
  draftText: null,
  escalationReason: "not confident enough",
};

function renderWithClient(ui: React.ReactElement): ReturnType<typeof render> {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

/** The #32 shape contract: a vertical 2px rule, first child of a row-laid-out entry. */
function expectGutterRule(entry: HTMLElement): void {
  const hairline = screen.getByTestId("confidence-hairline");
  expect(hairline.className, "2px wide — the rule is vertical").toContain("w-0.5");
  expect(hairline.className, "not the old horizontal strip").not.toContain("h-0.5");
  expect(hairline.className, "not the old horizontal strip").not.toContain("w-full");
  expect(hairline.className, "stretches the full height of the entry").toContain("self-stretch");
  expect(entry.className, "the entry lays out as a row so the rule can lead it").toContain("flex-row");
  expect(entry.firstElementChild, "the rule leads the entry — the leading edge").toBe(hairline);
}

describe("#32 — the hairline sits in the gutter, on the leading edge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    window.location.hash = "";
  });

  it("on a draft card", () => {
    renderWithClient(<DraftCard api={api} draft={draft} />);
    expectGutterRule(screen.getByTestId("draft-card"));
  });

  it("on an escalation card", () => {
    renderWithClient(<DraftCard api={api} draft={escalatedDraft} />);
    expectGutterRule(screen.getByTestId("draft-card"));
  });

  it("on a thread entry", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([draft]), { status: 200 })));
    window.location.hash = "#duo";
    render(<App />);
    try {
      const entry = await screen.findByTestId("thread-entry");
      expectGutterRule(entry);
    } finally {
      window.location.hash = "";
    }
  });
});

describe("#32 — the four states render distinguishably, still never a percentage", () => {
  const results: Record<string, DraftPipelineResult> = {
    refused: { kind: "escalation", draftId: "d1", reason: "refused", refused: true, confidence: undefined },
    escalated: { kind: "escalation", draftId: "d1", reason: "no evidence", refused: false, confidence: undefined },
    hedged: { kind: "draft", draftId: "d1", text: "answer", sources: [], confidence: { score: 0.6, passesThreshold: true, threshold: 0.55 } },
    confident: { kind: "draft", draftId: "d1", text: "answer", sources: [], confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 } },
  };

  it.each(Object.entries(results))("%s renders its state, token colour, and no percentage", (state, result) => {
    const { container, unmount } = render(<ConfidenceHairline result={result} />);
    const hairline = screen.getByTestId("confidence-hairline");
    expect(hairline).toHaveAttribute("data-state", state);
    expect(container.textContent ?? "").not.toContain("%");
    unmount();
  });

  it("escalated and hedged differ by opacity — same token, different presence", () => {
    const { unmount: u1 } = render(<ConfidenceHairline result={results.escalated} />);
    const escalatedRule = screen.getByTestId("confidence-hairline");
    const escalatedStyle = { backgroundColor: escalatedRule.style.backgroundColor, opacity: escalatedRule.style.opacity };
    u1();
    render(<ConfidenceHairline result={results.hedged} />);
    const hedgedRule = screen.getByTestId("confidence-hairline");
    expect(hedgedRule.style.backgroundColor).toBe(escalatedStyle.backgroundColor);
    expect(hedgedRule.style.opacity).not.toBe(escalatedStyle.opacity);
    expect(hedgedRule.style.opacity).toBe("0.4");
  });

  it("each state's token colour is distinct from the others in both themes", () => {
    const tokensCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles", "tokens.css"), "utf8");
    const themeValue = (themeIndex: number, token: string): [number, number, number] => {
      const values = [...tokensCss.matchAll(new RegExp(`--${token}:\\s*#([0-9a-fA-F]{6})`, "g"))].map((m) => m[1]);
      const hex = values[themeIndex];
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    };
    // Dark is `:root` (index 0); light is the first override (index 1; the
    // media-query block repeats it).
    for (const themeIndex of [0, 1]) {
      const colors = {
        escalate: themeValue(themeIndex, "escalate"),
        confident: themeValue(themeIndex, "confident"),
        refused: themeValue(themeIndex, "refused"),
      };
      const pairs: [string, [number, number, number]][] = Object.entries(colors);
      for (let i = 0; i < pairs.length; i += 1) {
        for (let j = i + 1; j < pairs.length; j += 1) {
          const [nameA, a] = pairs[i];
          const [nameB, b] = pairs[j];
          const rgbDistance = Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
          // 50, not higher: `--refused` (grey) and `--confident` (green) are
          // clearly different hues at RGB distance ~59 — the floor guards
          // against two states collapsing onto one colour, not against
          // subtle shade differences.
          expect(rgbDistance, `${nameA} vs ${nameB} in theme ${themeIndex} must be distinguishable`).toBeGreaterThan(50);
        }
      }
    }
  });
});
