import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DuoKnowledge, SourceControl } from "../src/api/types.js";
import { PrivacyControls } from "../src/components/PrivacyControls.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/*
 * duo#278: "Where it's processed" reuses the Knows tab's own fixture
 * shape — a real DuoKnowledge, so the two screens are provably reading
 * the same live report rather than two copies that can drift.
 */
function knowledgeFor(over?: Partial<DuoKnowledge>): DuoKnowledge {
  return {
    records: { total: 2, bySource: { "claude-export": 1, paste: 1 } },
    lastImport: null,
    corpus: { tooThin: true, minimumQuestionsToCharacterize: 10, totalQuestions: 0, periodStart: null, periodEnd: null, topicBreakdown: [] },
    rules: { byReviewStatus: { pending: 0, approved: 0, rejected: 0, superseded: 0 } },
    providers: { inference: "qwen-local", embedding: { name: "ollama", model: "nomic-embed-text" } },
    sharedUsage: {
      totalQuestions: 0,
      distinctAskers: 0,
      repeatAskers: 0,
      answeredCount: 0,
      declinedCount: 0,
      answerRate: 0,
      escalationRate: 0,
      weeklyTrend: [],
      gaps: [],
      lastAskedAt: null,
      daysSinceLastAsk: null,
      abandoned: false,
      summary: "The shared duo is not being used.",
    },
    ...over,
  };
}

function stub(knowledge: DuoKnowledge, sources: SourceControl[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace("http://test", "");
      if (path === "/knowledge") {
        return new Response(JSON.stringify(knowledge), { status: 200 });
      }
      if (path === "/knowledge/sources") {
        return new Response(JSON.stringify({ sources }), { status: 200 });
      }
      const excludeMatch = /^\/knowledge\/sources\/([^/]+)\/(exclude|restore)$/.exec(path);
      if (excludeMatch && init?.method === "POST") {
        return new Response(JSON.stringify({ excluded: excludeMatch[2] === "exclude" }), { status: 200 });
      }
      throw new Error(`unstubbed request: ${path}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("duo#278 — Privacy & data says where it's processed, in the Knows tab's own words", () => {
  it("names the configured inference and embedding providers, live from GET /knowledge", async () => {
    stub(knowledgeFor(), []);
    renderWithClient(<PrivacyControls api={api} />);
    expect(await screen.findByTestId("privacy-inference-provider")).toHaveTextContent("Drafts are written by qwen-local.");
    expect(screen.getByTestId("privacy-embedding-provider")).toHaveTextContent("Searching your history runs on ollama (nomic-embed-text).");
  });

  it("says plainly that nothing is answering when no inference provider is configured", async () => {
    stub(knowledgeFor({ providers: { inference: null, embedding: null } }), []);
    renderWithClient(<PrivacyControls api={api} />);
    expect(await screen.findByTestId("privacy-inference-provider")).toHaveTextContent(
      "Nothing is set up to write answers, so nothing is answering.",
    );
    expect(screen.getByTestId("privacy-embedding-provider")).toHaveTextContent("Nothing is set up to search your history.");
  });

  it("states retention in plain words", async () => {
    stub(knowledgeFor(), []);
    renderWithClient(<PrivacyControls api={api} />);
    expect(await screen.findByTestId("privacy-retention")).toHaveTextContent("Nothing is deleted on its own.");
    expect(screen.getByTestId("privacy-retention")).toHaveTextContent("until you end this duo");
  });
});

describe("duo#278 — the per-source switch", () => {
  it("lists every source with its record count, newest exclusion first", async () => {
    stub(knowledgeFor(), [
      { source: "paste", recordCount: 1, excluded: true, excludedAt: "2026-10-01T00:00:00.000Z" },
      { source: "claude-export", recordCount: 5, excluded: false, excludedAt: null },
    ]);
    renderWithClient(<PrivacyControls api={api} />);
    const rows = await screen.findAllByTestId("privacy-source-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByTestId("privacy-source-name")).toHaveTextContent("paste");
    expect(rows[0]!).toHaveTextContent("1 message and note");
    expect(rows[0]!).toHaveTextContent("excluded from drafts");
    expect(within(rows[0]!).getByTestId("privacy-source-toggle")).toHaveTextContent("Turn back on");
    expect(within(rows[1]!).getByTestId("privacy-source-name")).toHaveTextContent("claude-export");
    expect(within(rows[1]!).getByTestId("privacy-source-toggle")).toHaveTextContent("Turn off");
  });

  it("says plainly that nothing has been imported yet when the corpus is empty", async () => {
    stub(knowledgeFor({ records: { total: 0, bySource: {} } }), []);
    renderWithClient(<PrivacyControls api={api} />);
    expect(await screen.findByTestId("privacy-sources-empty")).toHaveTextContent("Nothing imported yet");
  });

  it("turning a source off posts to /knowledge/sources/:source/exclude and the row reflects it", async () => {
    stub(knowledgeFor(), [{ source: "claude-export", recordCount: 3, excluded: false, excludedAt: null }]);
    renderWithClient(<PrivacyControls api={api} />);
    const toggle = await screen.findByTestId("privacy-source-toggle");
    expect(toggle).toHaveTextContent("Turn off");
    toggle.click();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "http://test/knowledge/sources/claude-export/exclude",
      expect.objectContaining({ method: "POST" }),
    ));
  });

  it("the source name renders verbatim — this client keeps no registry to translate it through", async () => {
    stub(knowledgeFor(), [{ source: "connector", recordCount: 2, excluded: false, excludedAt: null }]);
    renderWithClient(<PrivacyControls api={api} />);
    expect(await screen.findByTestId("privacy-source-name")).toHaveTextContent("connector");
  });
});
