import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchOverlay } from "../src/components/SearchOverlay.js";
import type { DuoApiConfig } from "../src/api/client.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderOverlay(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <SearchOverlay api={api} onClose={onClose} />
      </QueryClientProvider>,
    ),
  };
}

function recordFor(id: string, text: string, source = "slack", sourceRef: string | null = "https://acme.slack.com/archives/C1/p1") {
  return {
    id,
    source,
    sourceRef,
    kind: "decision",
    author: "me",
    text,
    timestamp: "2026-09-01T10:00:00.000Z",
    threadId: null,
    audience: "channel",
    classification: "unknown",
    topics: [],
  };
}

const LEAVE_TEXT =
  "Leave policy: five days per quarter carry over, capped at ten. Same-week requests need Sam's sign-off, and anything crossing a quarter boundary goes to the calendar first so the carry-over math stays honest.";

function searchResponse(results: { record: ReturnType<typeof recordFor>; rank: number }[], extra?: { warning?: string }) {
  return { results, usedEmbeddings: true, ...extra };
}

/** Serves one search page per cursor and a knowledge read for the empty-corpus distinction (#45's query key, deduped by TanStack). */
function stubSearch(pages: { results: ReturnType<typeof searchResponse>["results"] }[], knowledgeTotal = 312) {
  const gets: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string): Promise<Response> => {
      if (String(url).includes("/knowledge")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              records: { total: knowledgeTotal, bySource: {} },
              lastImport: null,
              corpus: { tooThin: true, minimumQuestionsToCharacterize: 10, totalQuestions: 0, periodStart: null, periodEnd: null, topicBreakdown: [] },
              rules: { byReviewStatus: { pending: 0, approved: 0, rejected: 0, superseded: 0 } },
              providers: { inference: null, embedding: null },
              sharedUsage: {
                totalQuestions: 0, distinctAskers: 0, repeatAskers: 0, answeredCount: 0, declinedCount: 0,
                answerRate: 0, escalationRate: 0, weeklyTrend: [], gaps: [], lastAskedAt: null,
                daysSinceLastAsk: null, abandoned: false, summary: "The shared duo is not being used.",
              },
            }),
            { status: 200 },
          ),
        );
      }
      gets.push(String(url));
      const cursorMatch = /[?&]cursor=(\d+)/.exec(String(url));
      const cursor = cursorMatch ? Number(cursorMatch[1]) : 0;
      const page = pages[Math.min(cursor === 0 ? 0 : 1, pages.length - 1)];
      return Promise.resolve(new Response(JSON.stringify(searchResponse(page!.results)), { status: 200 }));
    }),
  );
  return { gets };
}

async function searchFor(query: string) {
  fireEvent.change(screen.getByPlaceholderText(/search what your duo knows/i), { target: { value: query } });
  fireEvent.click(screen.getByRole("button", { name: /search/i }));
  await waitFor(() => expect(screen.getAllByTestId("search-result").length).toBeGreaterThan(0));
}

describe("#46 — search the corpus from the app", () => {
  beforeEach(() => {
    stubSearch([{ results: [] }]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ranked results with enough context to recognise each one", async () => {
    stubSearch([
      {
        results: [
          { record: recordFor("r-1", LEAVE_TEXT), rank: 0 },
          { record: recordFor("r-2", "Leave requests go through the shared calendar.", "markdown", "notes/leave.md"), rank: 1 },
        ],
      },
    ]);
    renderOverlay();
    await searchFor("leave");

    // Daemon's order is the ranking — the rows render in exactly it.
    const rows = screen.getAllByTestId("search-result");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Leave policy");
    expect(rows[1]!.textContent).toContain("shared calendar");
    // Where each came from and when — stated, not implied.
    expect(screen.getAllByTestId("search-result-source").map((el) => el.textContent)).toEqual(["slack", "markdown"]);
    expect(screen.getAllByTestId("timestamp")).toHaveLength(2);
  });

  it("a result leads somewhere: the full record is readable and its origin is stated", async () => {
    stubSearch([{ results: [{ record: recordFor("r-1", LEAVE_TEXT), rank: 0 }] }]);
    renderOverlay();
    await searchFor("leave");

    // The summary carries a preview (mechanically truncated — presentation,
    // not derivation); opening the row reveals the whole record and where
    // exactly it came from. A <details> keeps its body in the DOM closed,
    // so the reveal pins on the open attribute, not on presence.
    const row = screen.getByTestId("search-result") as HTMLDetailsElement;
    expect(screen.getByTestId("search-result-summary").textContent).toContain("…");
    expect(screen.getByTestId("search-result-summary").textContent).not.toContain("carry-over math stays honest");
    expect(row.open).toBe(false);
    fireEvent.click(screen.getByTestId("search-result-summary"));
    expect(row.open).toBe(true);
    expect(screen.getByTestId("search-result-full").textContent).toBe(LEAVE_TEXT);
    expect(screen.getByTestId("search-result-origin").textContent).toContain("slack");
    expect(screen.getByTestId("search-result-origin").textContent).toContain("https://acme.slack.com/archives/C1/p1");
  });

  it("nothing matched says so — and an empty corpus says something else", async () => {
    const { rerender } = renderOverlay();
    // A corpus with records in it: zero results means zero matches.
    stubSearch([{ results: [] }], 312);
    fireEvent.change(screen.getByPlaceholderText(/search what your duo knows/i), { target: { value: "xyzzy" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(screen.getByTestId("search-empty")).toBeInTheDocument());
    expect(screen.getByTestId("search-empty").textContent).toMatch(/nothing matched/i);
    expect(screen.getByTestId("search-empty").textContent).not.toMatch(/hasn't read anything/i);

    // An empty corpus: zero results is a fact about the corpus, not the query.
    stubSearch([{ results: [] }], 0);
    rerender(<div />);
    const client2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={client2}>
        <SearchOverlay api={api} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText(/search what your duo knows/i), { target: { value: "anything" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(screen.getByTestId("search-empty").textContent).toMatch(/hasn't read anything yet/i));
    expect(screen.getByTestId("search-empty").textContent).toMatch(/import/i);
  });

  it("renders the daemon's degraded-retrieval warning verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string): Promise<Response> => {
        if (String(url).includes("/knowledge")) {
          return Promise.resolve(new Response(JSON.stringify({ records: { total: 312, bySource: {} } }), { status: 200 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [{ record: recordFor("r-1", LEAVE_TEXT), rank: 0 }],
              usedEmbeddings: false,
              warning: "Embeddings unavailable (ollama not running); falling back to full-text search only.",
            }),
            { status: 200 },
          ),
        );
      }),
    );
    renderOverlay();
    await searchFor("leave");
    expect(screen.getByTestId("search-warning").textContent).toBe(
      "Embeddings unavailable (ollama not running); falling back to full-text search only.",
    );
  });

  it("pages with the rank cursor: load more asks for the last rank + 1", async () => {
    const full = Array.from({ length: 12 }, (_, i) => ({
      record: recordFor(`r-${i}`, `result number ${i} about vendors`),
      rank: i,
    }));
    const { gets } = stubSearch([{ results: full.slice(0, 10) }, { results: full.slice(10) }]);
    renderOverlay();
    await searchFor("vendors");
    expect(screen.getAllByTestId("search-result")).toHaveLength(10);

    fireEvent.click(screen.getByTestId("search-load-more"));
    await waitFor(() => expect(screen.getAllByTestId("search-result")).toHaveLength(12));
    // A full page means "maybe more" — the second ask pages from rank 10,
    // the last rank earned + 1, exactly the daemon's cursor contract.
    expect(gets.some((g) => g.endsWith("/search?q=vendors"))).toBe(true);
    expect(gets.some((g) => g.endsWith("/search?q=vendors&cursor=10"))).toBe(true);
  });

  it("Escape closes the overlay", async () => {
    const onClose = vi.fn();
    renderOverlay(onClose);
    fireEvent.keyDown(screen.getByPlaceholderText(/search what your duo knows/i), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
