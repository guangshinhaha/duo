// @ts-expect-error no node types by design
import { readFileSync, readdirSync } from "node:fs";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #51: one vocabulary, written down. The product's premise — a duo is
 * labelled and never impersonates its owner — lives or dies in the nouns
 * its strings use, and every new surface inventing its own was the drift
 * this issue closes. These tests hold the three halves that can rot:
 * the list exists and defines the core terms; the same action carries the
 * same name everywhere it appears; and no forbidden framing — the nouns
 * that would make the duo an employee or unlabelled — appears in src at
 * all. The fourth half, daemon-owned strings rendered verbatim, is
 * already pinned by the components that render them; the list's job is to
 * name them as contract so the rule travels with the words.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

/** Every .ts/.tsx under src/ — a scan must not miss a surface. */
function srcSources(): { path: string; content: string }[] {
  return readdirSync(join(root, "src"), { recursive: true })
    .filter((entry: string) => /\.[cm]?tsx?$/.test(entry))
    .map((entry: string) => {
      const path = join("src", String(entry));
      return { path, content: read(path) };
    });
}

const NOUNS = [
  "owner",
  "asker",
  "duo",
  "draft",
  "escalation",
  "refusal",
  "standing order",
  "correction candidate",
  "trust tier",
  "autonomy level",
];

const VERBS = ["ask", "send", "keep", "pass on", "refuse", "forget this device"];

describe("#51 AC1 — the vocabulary is written down", () => {
  it("one doc defines every core noun and verb the product uses", () => {
    const doc = read("docs/vocabulary.md");
    for (const noun of NOUNS) {
      expect(doc, `noun "${noun}" defined`).toMatch(new RegExp(`^### ${noun}$`, "m"));
    }
    for (const verb of VERBS) {
      expect(doc, `verb "${verb}" defined`).toMatch(new RegExp(`^### ${verb}$`, "m"));
    }
  });
});

describe("#51 AC2 — strings match it", () => {
  it("the unpair action carries one name everywhere it appears", () => {
    // The one drift the audit found: the nav said "Disconnect", Settings
    // said "Forget this device" — the same action (this device's stored
    // connection, removed locally; the daemon keeps its own record), under
    // two names. "Forget this device" is the honest one, so it wins.
    for (const file of ["src/App.tsx", "src/routes/Settings.tsx"]) {
      const source = read(file);
      expect(source, file).toMatch(/Forget this device/);
      expect(source, file).not.toMatch(/\bDisconnect\b/);
    }
  });
});

describe("#51 AC3 — the forbidden framings are named", () => {
  it("the list states plainly what a duo is never called and never does", () => {
    const doc = read("docs/vocabulary.md");
    expect(doc).toMatch(/never be called an employee/i);
    expect(doc).toMatch(/never speaks as the owner/i);
    expect(doc).toMatch(/always labelled/i);
  });
});

describe("#51 AC4 — attribution strings stay contract", () => {
  it("the daemon-owned fixed strings are named as verbatim contract", () => {
    const doc = read("docs/vocabulary.md");
    expect(doc).toMatch(/passed-on message/i);
    expect(doc).toMatch(/refusal message/i);
    expect(doc).toMatch(/duo attribution/i);
    expect(doc).toMatch(/verbatim/i);
    expect(doc).toMatch(/never paraphras/i);
  });

  it("no forbidden noun appears anywhere in src", () => {
    for (const file of srcSources()) {
      // Word-bounded so prop names like onDisconnect or comments quoting
      // the rule itself cannot false-positive — and "colleague" is not on
      // the list: it names the human asker, not the duo.
      expect(file.content, file.path).not.toMatch(
        /\b(employee|employees|teammate|teammates|assistant|staff|chatbot|intern)\b/i,
      );
    }
  });
});
