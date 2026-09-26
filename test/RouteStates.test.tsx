import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WaitingHome } from "../src/shell/WaitingHome.js";
import type { DuoApiConfig } from "../src/api/client.js";

/*
 * #37: the states between the states. An empty waiting queue is the app's
 * opening screen for weeks (AR-19), so it makes the product's argument
 * rather than apologising; a load shows the shape of what's coming and
 * says so when it's slow; an error says what happened and what to try,
 * in the app's voice, with the daemon's own words beneath, verbatim.
 */

const api: DuoApiConfig = { baseUrl: "http://test:7717", token: "tok" };

function renderWaiting() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WaitingHome api={api} />
    </QueryClientProvider>,
  );
}

function knowledgeFor(overrides: Record<string, unknown> = {}) {
  return {
    records: { total: 0, bySource: {} },
    lastImport: null,
    corpus: {
      tooThin: true,
      minimumQuestionsToCharacterize: 10,
      totalQuestions: 0,
      periodStart: null,
      periodEnd: null,
      topicBreakdown: [],
    },
    rules: { byReviewStatus: { pending: 0, approved: 0, rejected: 0, superseded: 0 } },
    providers: { inference: null, embedding: null },
    sharedUsage: {
      totalQuestions: 0, distinctAskers: 0, repeatAskers: 0, answeredCount: 0, declinedCount: 0,
      answerRate: 0, escalationRate: 0, weeklyTrend: [], gaps: [], lastAskedAt: null,
      daysSinceLastAsk: null, abandoned: false, summary: "The shared duo is not being used.",
    },
    ...overrides,
  };
}

/** One stub serving the reads the waiting front door makes: the queues and the knowledge enrichment. */
function stubReviewFetch(handlers: { drafts?: () => Response; knowledge?: () => Response }) {
  return vi.fn((url: string): Promise<Response> => {
    if (String(url).includes("/knowledge")) {
      return Promise.resolve(handlers.knowledge ? handlers.knowledge() : new Response(JSON.stringify(knowledgeFor()), { status: 200 }));
    }
    return Promise.resolve(handlers.drafts ? handlers.drafts() : new Response(JSON.stringify([]), { status: 200 }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("#37 AC1 — the empty queue makes the case", () => {
  it("keeps the headline and states what the duo knows and the one thing that would teach it more — nothing imported yet", async () => {
    vi.stubGlobal("fetch", stubReviewFetch({}));
    renderWaiting();

    // The headline the app has always opened with, still the headline.
    expect(await screen.findByText("Nothing waiting on you.")).toBeInTheDocument();

    // What it knows so far: the daemon's own counts, no import yet —
    // Knowledge's own sentences, not paraphrased, because they are the
    // product's argument already written.
    const facts = await screen.findByTestId("waiting-home-knowledge");
    expect(facts).toHaveTextContent("0 records");
    expect(facts).toHaveTextContent("No import yet — importing your records is what gives the duo something to answer from.");
    expect(facts).toHaveTextContent("Not enough history yet — the corpus starts to mean something at 10 questions, and this duo has 0. Importing more records is what thickens it.");
    // The one factual pointer to what is already there.
    expect(facts).toHaveTextContent("⌘K searches what your duo knows.");
  });

  it("a corpus past the bar: what's behind it, and that asking is what thickens it", async () => {
    vi.stubGlobal(
      "fetch",
      stubReviewFetch({
        knowledge: () =>
          new Response(
            JSON.stringify(
              knowledgeFor({
                records: { total: 312, bySource: { slack: 312 } },
                lastImport: { runAt: "2026-09-01T10:00:00.000Z", written: 312, alreadyPresent: 4, skippedDmConversations: 7 },
                corpus: {
                  tooThin: false,
                  minimumQuestionsToCharacterize: 10,
                  totalQuestions: 41,
                  periodStart: "2026-06-01T00:00:00.000Z",
                  periodEnd: "2026-09-01T00:00:00.000Z",
                  topicBreakdown: [],
                },
              }),
            ),
            { status: 200 },
          ),
      }),
    );
    renderWaiting();

    const facts = await screen.findByTestId("waiting-home-knowledge");
    expect(facts).toHaveTextContent("312 records");
    // Knowledge's own last-import sentence, verbatim.
    expect(facts).toHaveTextContent("Last import");
    expect(facts).toHaveTextContent("312 written, 4 already present, 7 DM conversations skipped.");
    // Past the bar: the count, and the action the facts support — asking.
    expect(facts).toHaveTextContent("41 questions so far — asking it questions is what thickens it.");
    expect(facts).not.toHaveTextContent("Not enough history yet");
  });

  it("a knowledge read that fails never blanks the queue — the headline and the pointer stand on their own", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string): Promise<Response> => {
        if (String(url).includes("/knowledge")) {
          return Promise.resolve(new Response(JSON.stringify({ error: { code: "store_unavailable", message: "boom" } }), { status: 500 }));
        }
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }),
    );
    renderWaiting();

    expect(await screen.findByText("Nothing waiting on you.")).toBeInTheDocument();
    expect(screen.getByTestId("waiting-home-knowledge")).toHaveTextContent("⌘K searches what your duo knows.");
    // No half-rendered facts: the block either has the daemon's numbers or
    // does not pretend to.
    expect(screen.getByTestId("waiting-home-knowledge").textContent).not.toMatch(/\d+ records/);
  });
});

describe("#37 AC2 — loading has shape, and a slow load says so", () => {
  it("shows the shape of the queue to come, silent until the load is actually slow", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { rerender } = renderWaiting();

    // The skeleton is the queue's own shape: entry blocks, not a word.
    expect(screen.getByTestId("route-loading")).toBeInTheDocument();
    expect(screen.getAllByTestId("route-loading-block")).toHaveLength(3);
    expect(screen.queryByTestId("route-loading-slow")).toBeNull();

    // 1499ms in: still quiet — a normal load never gets the excuse.
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.queryByTestId("route-loading-slow")).toBeNull();

    // One ms later: the load has earned a word.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("route-loading-slow")).toHaveTextContent(/still waiting on the daemon/i);

    // And it is presentation only: the moment data lands the whole state
    // is replaced by the queue, notice and all.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))));
    rerender(<div />);
    vi.useRealTimers();
    renderWaiting();
    await waitFor(() => expect(screen.getByText("Nothing waiting on you.")).toBeInTheDocument());
    expect(screen.queryByTestId("route-loading")).toBeNull();
  });
});

describe("#37 AC3 — errors say what happened and what to try", () => {
  it("a network failure names the daemon it cannot reach, shows the wire's own words, and retries on ask", async () => {
    const fetchMock = vi.fn((): Promise<Response> => {
      if (fetchMock.mock.calls.length <= 1) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWaiting();

    const errorState = await screen.findByTestId("route-error");
    expect(errorState).toHaveTextContent("Can't reach the daemon at http://test:7717");
    expect(errorState).toHaveTextContent("check that it's running and reachable");
    // The wire's own words beneath, verbatim — never swallowed.
    expect(screen.getByTestId("route-error-message")).toHaveTextContent("fetch failed");

    fireEvent.click(screen.getByTestId("route-error-retry"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.getByText("Nothing waiting on you.")).toBeInTheDocument());
  });

  it("a daemon failure states its class, its own message beneath, and its code as the identifier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: { code: "draft_store_unavailable", message: "The drafts store could not be opened." } }), { status: 500 }),
          ),
      ),
    );
    renderWaiting();

    const errorState = await screen.findByTestId("route-error");
    expect(errorState).toHaveTextContent("The daemon had a problem.");
    expect(screen.getByTestId("route-error-message")).toHaveTextContent("The drafts store could not be opened.");
    expect(screen.getByTestId("route-error-code")).toHaveTextContent("draft_store_unavailable");
  });

  it("a 404 says the duo doesn't have this", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { code: "not_found", message: "No draft with that id." } }), { status: 404 }))),
    );
    renderWaiting();

    const errorState = await screen.findByTestId("route-error");
    expect(errorState).toHaveTextContent("The daemon doesn't have this.");
    expect(screen.getByTestId("route-error-code")).toHaveTextContent("not_found");
  });

  it("when the daemon sends no code, there is no chip — 'unknown' is the absence of an identifier, not one", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: { message: "Bad ask." } }), { status: 400 }))));
    renderWaiting();

    const errorState = await screen.findByTestId("route-error");
    expect(errorState.textContent).not.toMatch(/unknown/);
    expect(screen.queryByTestId("route-error-code")).toBeNull();
  });
});
