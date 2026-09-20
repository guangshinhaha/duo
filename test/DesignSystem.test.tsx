// Node built-ins for the source scans, following contrast.test.tsx's lead:
// the app tsconfig deliberately has no node types. Suppressed here rather
// than adding `node` to tsconfig `types` for the design-system tests.
// @ts-expect-error no node types by design
import { readFileSync, readdirSync, statSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeterBar } from "../src/components/MeterBar.js";
import { Review } from "../src/routes/Review.js";
import { Setup } from "../src/routes/Setup.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord } from "../src/api/types.js";

/*
 * #33: every surface was built from the same three declarations —
 * `rounded-[var(--r-lg)] border border-[var(--edge)] p-4` — so a draft
 * card, a message, a trust row, a form field and a button were the same
 * object at different sizes. A flat hierarchy is most of why a working app
 * reads as unfinished. These tests pin the system Part 4 specifies: spacing
 * from the 4px scale, three distinguishable shapes (container / entry /
 * control), one type scale of four roles, and colour that carries meaning
 * only. They read the source the way contrast.test.tsx reads tokens.css —
 * a palette change can't quietly reintroduce the flatness.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every .ts/.tsx under src/ — the scan surface for the scale tests. */
function srcSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.(tsx?|ts)$/.test(name)) {
        out.push(path);
      }
    }
  };
  walk(join(root, "src"));
  return out;
}

const tokensCss = readFileSync(join(root, "src", "styles", "tokens.css"), "utf8");

/*
 * Spec-mandated exceptions to the 4px scale, enumerated with the spec
 * that mandates each. Empty today: widths and heights never enter the
 * scan (Part 4's confidence hairline IS a 2px stroke), so nothing needs
 * an entry yet — but the mechanism exists so the next spec-mandated
 * exception is one line here, not a scan rewrite or a silently-passing
 * pattern. A stale entry fails the test alongside a new offender.
 */
const SPACING_EXCEPTIONS: Record<string, string> = {
  // "src/components/Example.tsx: py-[2px]": "Part 4 §density mandates …",
};

describe("#33 — spacing comes from tokens", () => {
  it("every padding, margin and gap utility is a multiple of the 4px scale", () => {
    // Tailwind v4 derives each spacing utility from --spacing, which
    // tokens.css points at --sp — so a whole step IS the token. The half
    // steps (0.5/1.5/2.5/3.5) are the per-component choices that escape
    // the scale; the issue's AC is that they don't exist. Widths and
    // heights are exempt by design: the confidence hairline's 2px is
    // Part 4's own stroke, not spacing.
    const property = "(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)";
    const step = new RegExp(`${property}-(\\d+(?:\\.\\d+)?)`, "g");
    const arbitrary = new RegExp(`${property}-\\[(\\d+(?:\\.\\d+)?)px\\]`, "g");
    const offenders: string[] = [];
    for (const path of srcSources()) {
      const text = readFileSync(path, "utf8");
      const relative = join("src", path.slice(root.length + 1));
      for (const match of text.matchAll(step)) {
        if ((parseFloat(match[1]!) * 4) % 4 !== 0) {
          offenders.push(`${relative}: ${match[0]}`);
        }
      }
      for (const match of text.matchAll(arbitrary)) {
        if (parseFloat(match[1]!) % 4 !== 0) {
          offenders.push(`${relative}: ${match[0]}`);
        }
      }
    }
    expect(offenders.filter((offender) => !SPACING_EXCEPTIONS[offender])).toEqual([]);
    // An allowlist entry that no longer matches anything is stale — it
    // would keep passing after the exception it named is gone.
    expect(offenders.filter((offender) => SPACING_EXCEPTIONS[offender])).toEqual(Object.keys(SPACING_EXCEPTIONS));
  });

  it("the whole spacing scale derives from --sp", () => {
    expect(tokensCss).toMatch(/--spacing:\s*var\(--sp\)/);
  });
});

describe("#33 — hierarchy is visible by form", () => {
  it("the flat triple is gone: no surface is container, entry and control at once", () => {
    // The issue's own words: the same three declarations made everything
    // the same object. After #33 an entry takes .shape-entry (radius,
    // border and ground move as one), so neither the old triple nor a
    // hand-rolled variant of it can appear.
    const offenders: string[] = [];
    for (const path of srcSources()) {
      const text = readFileSync(path, "utf8");
      if (text.includes("rounded-[var(--r-lg)] border") || text.includes("border border-[var(--edge)] rounded-[var(--r-md)]")) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the shapes are defined once, in tokens", () => {
    expect(tokensCss).toMatch(/\.shape-container\s*\{/);
    expect(tokensCss).toMatch(/\.shape-entry\s*\{/);
    expect(tokensCss).toMatch(/\.shape-entry-quiet\s*\{/);
  });

  it("container, entry and control are distinguishable on one screen", async () => {
    stubDrafts([draftFor("d1")]);
    renderReview();
    await waitFor(() => expect(screen.getAllByTestId("draft-card")).toHaveLength(1));

    const container = screen.getByTestId("review-list");
    expect(container.className).toContain("shape-container");
    expect(container.className).not.toContain("border-[var(--edge)]");

    const entry = screen.getByTestId("draft-card");
    expect(entry.className).toContain("shape-entry");
    expect(entry.className).not.toContain("shape-container");

    // The fixture is self-asked, so the primary control is Keep (#30's
    // vocabulary) — same accent form Send wears on a channel draft.
    const primary = screen.getByText("Keep", { selector: "button" }).closest("button")!;
    // The primary action is the one thing that may carry the accent — and
    // it is not a bordered box: a control shares no declaration with an entry.
    expect(primary.className).toContain("bg-[var(--accent)]");
    expect(primary.className).not.toContain("border-[var(--edge)]");
    expect(primary.className).not.toContain("shape-");

    const ghost = screen.getByText("Edit", { selector: "button" }).closest("button")!;
    expect(ghost.className).toContain("border-[var(--edge)]");
    expect(ghost.className).not.toContain("bg-[var(--surface)]");
    expect(ghost.className).not.toContain("shape-");
  });
});

describe("#33 — the type scale is set once", () => {
  it("defines the four roles with Part 4's values", () => {
    // Body 14/22, headings tightened to -0.011em, one weight jump only
    // (400 and 560). Provenance and identifiers get the two 12px roles —
    // the ramp Part 4 implies but never spelled out, set here so every
    // route reads the same.
    expect(roleBlock("type-heading")).toEqual({
      "font-size": "16px",
      "line-height": "22px",
      "letter-spacing": "-0.011em",
      "font-weight": "560",
    });
    expect(roleBlock("type-body")).toEqual({ "font-size": "14px", "line-height": "22px", "font-weight": "400" });
    expect(roleBlock("type-provenance")).toEqual({ "font-size": "12px", "line-height": "18px", "font-weight": "400" });
    expect(roleBlock("type-identifier")).toEqual({ "font-size": "12px", "line-height": "18px", "font-weight": "560" });
  });

  it("no size or weight utility escapes the roles", () => {
    const offenders: string[] = [];
    const size = /\btext-(?:xs|sm|base|lg|xl|2xl|3xl)\b|\btext-\[\d+(?:\.\d+)?px\]/;
    const weight = /\bfont-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/;
    for (const path of srcSources()) {
      const text = readFileSync(path, "utf8");
      if (size.test(text) || weight.test(text)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every heading renders the heading role", () => {
    const offenders: string[] = [];
    for (const path of srcSources()) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(/<h[1-6][^>]*className="([^"]*)"/g)) {
        if (!match[1]!.includes("type-heading")) {
          offenders.push(`${path}: ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    // And as rendered, not just as written:
    render(<Setup onConnect={() => {}} />);
    expect(document.querySelector("h1")!.className).toContain("type-heading");
  });
});

describe("#33 — colour carries meaning only", () => {
  it("a proportion is not an action: MeterBar's fill is greyscale", () => {
    // §1.6: the accent means *action available* and nothing else. A meter
    // is data, not an action — its fill belongs to the greyscale ramp.
    const { container } = render(<MeterBar value={0.5} testId="census-meter" />);
    const fill = container.querySelector('[data-testid="census-meter-fill"]')!;
    expect(fill.className).not.toContain("var(--accent)");
  });

  it("on a rendered surface, accent means interactive and the state tokens mean state", async () => {
    // AC4's four categories are the allowlist, in those terms: the
    // confidence rule (the hairline), the semantic states (the state
    // rows below), the primary action (the accent, and only on
    // interactive things) — and nothing else, which is what the census
    // asserts: any other coloured pixel fails with nowhere to belong.
    const CONFIDENCE_RULE = new Set(["confidence-hairline"]);
    const SEMANTIC_STATES = new Set(["escalation-reason", "mutation-error", "delivery-state", "answer-confirmation"]);
    const stateBearers = new Set([...CONFIDENCE_RULE, ...SEMANTIC_STATES]);

    // The populated queue exercises every coloured thing Review can show:
    // a hedged draft, a failed-delivery channel draft, and a refusal.
    stubDrafts([
      draftFor("plain", { confidenceScore: 0.5 }),
      draftFor("channel", {
        provenance: { origin: "channel", channelKind: "slack", askerRef: "U1", threadId: "C1", permalink: null },
        delivery: { state: "failed", reason: "workspace left" },
      }),
      draftFor("refusal", { escalated: true, refused: true, draftText: null, escalationReason: "Not something I answer." }),
    ]);
    renderReview();
    await waitFor(() => expect(screen.getAllByTestId("draft-card")).toHaveLength(3));

    const offenders: string[] = [];
    for (const el of document.querySelectorAll("*")) {
      const declared = el.getAttribute("class") ?? "";
      const styled = el.getAttribute("style") ?? "";
      if (declared.includes("var(--accent)")) {
        if (!["BUTTON", "A"].includes(el.tagName)) {
          offenders.push(`accent on ${el.tagName} ${el.getAttribute("data-testid") ?? ""}`);
        }
      }
      if (/(--escalate|--confident|--refused)/.test(`${declared} ${styled}`)) {
        let bearer: Element | null = el;
        while (bearer && !stateBearers.has(bearer.getAttribute("data-testid") ?? "")) {
          bearer = bearer.parentElement;
        }
        if (!bearer) {
          offenders.push(`state colour on ${el.tagName} ${el.getAttribute("data-testid") ?? ""}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Parses a `.type-*` block out of tokens.css into its declarations. */
function roleBlock(name: string): Record<string, string> {
  const match = tokensCss.match(new RegExp(`\\.${name}\\s*\\{([^}]*)\\}`));
  const block: Record<string, string> = {};
  for (const decl of match?.[1]?.split(";") ?? []) {
    const [property, value] = decl.split(":").map((part: string | undefined) => part?.trim());
    if (property && value) {
      block[property] = value;
    }
  }
  return block;
}

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderReview() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Review api={api} />
    </QueryClientProvider>,
  );
}

function draftFor(id: string, over?: Partial<DraftRecord>): DraftRecord {
  return {
    id,
    question: `q-${id}`,
    threadContext: null,
    draftText: `a-${id}`,
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
    provenance: { origin: "owner" },
    delivery: null,
    ...over,
  };
}

function stubDrafts(drafts: DraftRecord[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(drafts), { status: 200 })));
}

beforeEach(() => {
  stubDrafts([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});
