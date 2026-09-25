// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ESLint } from "eslint";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ProvenanceLine } from "../src/components/ProvenanceLine.js";
import { DraftCard } from "../src/components/DraftCard.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftProvenance, DraftRecord } from "../src/api/types.js";

/*
 * #43: the client carries no channel-specific knowledge. Channels are the
 * core's concern — the daemon sends a kind and an adapter-supplied label,
 * and this repository renders them without recognising either. The rule
 * is the AR-13 pattern applied to vocabulary: a principle with a failing
 * lint is a principle, one in a document is a hope.
 *
 * The carve-out from the issue's clarifying comment: the NATIVE kind is
 * ours (first-class, not a bridge) and stays permitted — the rule is a
 * blocklist of external product names, never an allowlist of kinds, so
 * native and unknown kinds pass through it structurally.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const api: DuoApiConfig = { baseUrl: "http://test:7717", token: "tok" };

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function channelDraft(provenance: DraftProvenance, overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: "d1",
    question: "the question",
    threadContext: null,
    draftText: "the answer",
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
    delivery: null,
    ...overrides,
    provenance,
  };
}

/** The real config, the real rule, a synthetic file path — no fixture on disk. */
async function lintSource(source: string, filename: string) {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(source, { filePath: join(root, filename) });
  return result?.messages ?? [];
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#43 AC1 — no channel is named in the source", () => {
  it("the linter over every client source file reports nothing", async () => {
    // The lint rule is AST-based, so documentation (comments) is
    // structurally invisible to it — "no matches outside documentation"
    // is not a filter bolted on; it is what the mechanism cannot see.
    // The whole-config run also carries AR-13's rule with it.
    const eslint = new ESLint({ cwd: root });
    const results = await eslint.lintFiles(["src/**/*.ts", "src/**/*.tsx"]);
    const errors = results.flatMap((result) => result.messages);
    expect(errors).toEqual([]);
  });
});

describe("#43 AC2 — labels come from the daemon", () => {
  it("the origin line is the adapter's own kind and asker strings, verbatim, capitalisation included", () => {
    render(
      <ProvenanceLine
        provenance={{ origin: "channel", channelKind: "ZulipClassic", askerRef: "@river", threadId: null, permalink: null }}
      />,
    );
    // Not " zulipclassic", not "Zulip Classic", not a client-side name —
    // the daemon's exact string, byte for byte.
    expect(screen.getByTestId("draft-origin").textContent).toBe("Asked by @river in ZulipClassic");
  });
});

describe("#43 AC3 — the rule is enforced", () => {
  it("a channel-specific string fails lint with a message that says channels belong to the core", async () => {
    const messages = await lintSource('export const brand = "Slack";\n', "src/__fixture__.ts");
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((message) => /channels belong to the core/i.test(message.message))).toBe(true);
  });

  it("a channel-specific icon name fails lint too", async () => {
    const messages = await lintSource(
      "export const slackLogo = document.createElement(\"span\");\n",
      "src/__fixture__.ts",
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("documentation is permitted — a comment naming a product does not fire", async () => {
    const messages = await lintSource("// it came from Slack, and the adapter knows the rest\n", "src/__fixture__.ts");
    expect(messages).toEqual([]);
  });

  it("the native kind is permitted (the carve-out), and so is any unknown kind", async () => {
    const native = await lintSource('export const kind = "native";\n', "src/__fixture__.ts");
    expect(native).toEqual([]);
    const unknown = await lintSource('export const kind = "brand-new-adapter";\n', "src/__fixture__.ts");
    expect(unknown).toEqual([]);
  });
});

describe("#43 AC4 — an unknown channel still renders", () => {
  it("a draft from a kind this client has never seen renders whole, keyed on nothing", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))),
    );
    renderWithClient(
      <DraftCard
        api={api}
        draft={channelDraft({
          origin: "channel",
          channelKind: "brand-new-adapter",
          askerRef: "@someone",
          threadId: null,
          permalink: null,
        })}
      />,
    );
    // The card itself renders — question, answer, disposition controls —
    // and the origin line says the unknown kind exactly as sent.
    expect(screen.getByTestId("draft-card")).toBeTruthy();
    expect(screen.getByTestId("draft-origin").textContent).toBe("Asked by @someone in brand-new-adapter");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });
});
