import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Knows } from "../src/profile/Knows.js";
import type { DuoKnowledge, ExcludedEvidence, TopicCoverageReport } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";
import { readComposerBuffer, writeComposerBuffer } from "../src/composerBuffer.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/*
 * #45, on its live surface: the profile's Knows tab (the old Knowledge page's
 * body, in an owner's words). Fixtures speak the daemon's side of the wire;
 * the tab also reads /channels for its "Where it listens" section, which
 * ProfileChannels.test.tsx pins — here it is an empty list.
 */
function knowledgeFor(over?: Partial<DuoKnowledge>): DuoKnowledge {
  return {
    records: { total: 312, bySource: { slack: 288, markdown: 24 } },
    lastImport: {
      runAt: "2026-09-18T09:15:00.000Z",
      staged: 318,
      written: 24,
      alreadyPresent: 288,
      skippedDmConversations: 4,
      discardedOtherText: 2,
      discardedAboveCeiling: 0,
    },
    corpus: {
      tooThin: false,
      minimumQuestionsToCharacterize: 10,
      totalQuestions: 214,
      periodStart: "2026-08-20T00:00:00.000Z",
      periodEnd: "2026-09-19T00:00:00.000Z",
      topicBreakdown: [
        { topicId: "t-sched", label: "scheduling", count: 73, share: 0.34 },
        { topicId: "t-money", label: "money", count: 45, share: 0.21 },
      ],
    },
    rules: { byReviewStatus: { pending: 3, approved: 12, rejected: 2, superseded: 1 } },
    providers: { inference: "qwen-local", embedding: { name: "ollama", model: "nomic-embed-text" } },
    sharedUsage: {
      totalQuestions: 55,
      distinctAskers: 9,
      repeatAskers: 4,
      answeredCount: 41,
      declinedCount: 14,
      answerRate: 41 / 55,
      escalationRate: 14 / 55,
      weeklyTrend: [
        { weekStart: "2026-09-07", questionCount: 21 },
        { weekStart: "2026-09-14", questionCount: 34 },
      ],
      gaps: [{ question: "What's the wifi password?", count: 3 }],
      lastAskedAt: "2026-09-19T17:02:00.000Z",
      daysSinceLastAsk: 1,
      abandoned: false,
      summary: "The shared duo answered 41 of 55 questions over the last month.",
    },
    ...over,
  };
}

/** duo#277: the empty, honest default — no history, nothing thin to call out. Tests that don't care about coverage get this; tests that do pass their own via `stubKnowledge`'s fourth argument. */
function coverageFor(over?: Partial<TopicCoverageReport>): TopicCoverageReport {
  return {
    totalQuestions: 0,
    tooThin: true,
    minimumQuestionsToCharacterize: 10,
    coveredShare: 0,
    topics: [],
    gaps: [],
    ...over,
  };
}

function stubKnowledge(knowledge: DuoKnowledge, excluded: ExcludedEvidence[] = [], coverage: TopicCoverageReport = coverageFor()) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).replace("http://test", "");
      if (path === "/channels") {
        return new Response("[]", { status: 200 });
      }
      if (path === "/knowledge/evidence/excluded") {
        return new Response(JSON.stringify({ excluded }), { status: 200 });
      }
      if (path === "/knowledge/coverage") {
        return new Response(JSON.stringify(coverage), { status: 200 });
      }
      return new Response(JSON.stringify(knowledge), { status: 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  writeComposerBuffer("");
});

describe("#45 — the Knows tab says what your duo knows", () => {
  it("describes what it has read: records by source, the last import, topic coverage — and leaves rule counts to the Rules tab", async () => {
    stubKnowledge(knowledgeFor());
    renderWithClient(<Knows api={api} />);
    await waitFor(() => expect(screen.getByTestId("knows-tab")).toBeInTheDocument());

    // Every source the daemon names, with its count — the daemon's own
    // strings, no client-side registry.
    const sources = screen.getAllByTestId("record-source").map((el) => el.textContent);
    expect(sources.some((t) => t?.includes("slack") && t?.includes("288"))).toBe(true);
    expect(sources.some((t) => t?.includes("markdown") && t?.includes("24"))).toBe(true);

    // The last import: when it ran and what it did, in the daemon's counts.
    expect(screen.getByTestId("last-import").textContent).toContain("24");
    expect(screen.getByTestId("last-import").textContent).toContain("288");

    // Topic coverage: label, count, a bar for the share.
    const topics = screen.getAllByTestId("knowledge-topic").map((el) => el.textContent);
    expect(topics.some((t) => t?.includes("scheduling") && t?.includes("73"))).toBe(true);
    expect(screen.getAllByTestId("knowledge-topic-share-fill").length).toBe(2);

    // The old page's rule counts by review status now live on the Rules tab
    // ("rules-counts", pinned in Profile.test.tsx) — none renders here, and
    // none of the daemon's status codes leak into this tab.
    expect(screen.queryByTestId("rule-counts")).toBeNull();
    expect(screen.getByTestId("knows-tab").textContent).not.toMatch(/superseded/i);
  });

  it("states thinness, not implies it: the verdict names the bar and what would thicken it — and no breakdown renders", async () => {
    stubKnowledge(
      knowledgeFor({
        corpus: {
          tooThin: true,
          minimumQuestionsToCharacterize: 10,
          totalQuestions: 4,
          periodStart: "2026-09-10T00:00:00.000Z",
          periodEnd: "2026-09-19T00:00:00.000Z",
          topicBreakdown: [{ topicId: "t-sched", label: "scheduling", count: 4, share: 1 }],
        },
      }),
    );
    renderWithClient(<Knows api={api} />);

    // The threshold, the count, and the action that changes it. A breakdown
    // of four questions would be costume jewellery — none renders.
    const thin = await waitFor(() => screen.getByTestId("corpus-thin"));
    expect(thin.textContent).toContain("10");
    expect(thin.textContent).toContain("4");
    expect(thin.textContent).toMatch(/import/i);
    expect(screen.queryByTestId("knowledge-topic")).toBeNull();
  });

  it("renders no percentage the data cannot carry — counts and bars, never numerals of derived rates", async () => {
    stubKnowledge(knowledgeFor());
    renderWithClient(<Knows api={api} />);
    await waitFor(() => expect(screen.getByTestId("knows-tab")).toBeInTheDocument());

    // The answer rate arrives as a fraction; it renders as a bar with the
    // counts it came from beside it. Nowhere on the tab does a percentage
    // numeral appear — not for shares, not for rates.
    expect(screen.getByTestId("answer-rate-fill")).toBeInTheDocument();
    expect(screen.getByTestId("knows-others").textContent).toContain("41 of 55");
    expect(screen.getByTestId("knows-tab").textContent).not.toMatch(/\d+(\.\d+)?\s?%/);
  });

  it("names the providers: which is answering, which is embedding", async () => {
    stubKnowledge(knowledgeFor());
    renderWithClient(<Knows api={api} />);
    await waitFor(() => expect(screen.getByTestId("knows-tab")).toBeInTheDocument());

    expect(screen.getByTestId("inference-provider").textContent).toContain("qwen-local");
    expect(screen.getByTestId("embedding-provider").textContent).toContain("ollama");
    expect(screen.getByTestId("embedding-provider").textContent).toContain("nomic-embed-text");
  });

  it("says so plainly when no provider is configured — an absence is a fact, not a blank", async () => {
    stubKnowledge(knowledgeFor({ providers: { inference: null, embedding: null } }));
    renderWithClient(<Knows api={api} />);
    await waitFor(() => expect(screen.getByTestId("knows-tab")).toBeInTheDocument());

    expect(screen.getByTestId("inference-provider").textContent).toMatch(/nothing is set up to write answers/i);
    expect(screen.getByTestId("embedding-provider").textContent).toMatch(/nothing is set up to search your history/i);
  });

  it("when others ask: the daemon's summary verbatim, its askers, and its gaps", async () => {
    stubKnowledge(knowledgeFor());
    renderWithClient(<Knows api={api} />);
    await waitFor(() => expect(screen.getByTestId("knows-tab")).toBeInTheDocument());

    expect(screen.getByTestId("shared-usage-summary").textContent).toBe(
      "The shared duo answered 41 of 55 questions over the last month.",
    );
    expect(within(screen.getByTestId("knows-others")).getByText(/asked by 9 people/)).toBeInTheDocument();
    const gaps = screen.getAllByTestId("usage-gap").map((el) => el.textContent);
    expect(gaps.some((t) => t?.includes("wifi password") && t?.includes("3"))).toBe(true);
  });

  it("a store that has never seen an import says so, in words", async () => {
    stubKnowledge(knowledgeFor({ lastImport: null }));
    renderWithClient(<Knows api={api} />);
    await waitFor(() => expect(screen.getByTestId("knows-tab")).toBeInTheDocument());
    expect(screen.getByTestId("last-import").textContent).toMatch(/no import yet/i);
  });
});

/*
 * duo#272 (digital-duo#288): the reversible half of a draft's inline
 * Remove. `GET /knowledge/evidence/excluded` is read back here, newest
 * first, and a Restore undoes one through the daemon's idempotent
 * `/knowledge/evidence/:recordId/restore` — AC3's "visible and reversible
 * ... in Knows".
 */
describe("Knows tab — removed from citation (duo#272)", () => {
  it("says plainly when nothing has been removed", async () => {
    stubKnowledge(knowledgeFor());
    renderWithClient(<Knows api={api} />);
    await waitFor(() => expect(screen.getByTestId("knows-removed-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("knows-removed-list")).toBeNull();
  });

  it("lists every excluded record, with its own label or an honest 'gone' reading", async () => {
    stubKnowledge(knowledgeFor(), [
      { recordId: "e1", excludedAt: "2026-09-20T00:00:00.000Z", label: "past exchange: refund policy" },
      { recordId: "e2", excludedAt: "2026-09-19T00:00:00.000Z", label: null },
    ]);
    renderWithClient(<Knows api={api} />);
    const rows = await waitFor(() => screen.getAllByTestId("knows-removed-row"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("past exchange: refund policy");
    expect(rows[1]).toHaveTextContent("This record no longer exists.");
  });

  it("restoring a row calls the daemon's restore route and the row leaves the list", async () => {
    let excluded: ExcludedEvidence[] = [{ recordId: "e1", excludedAt: "2026-09-20T00:00:00.000Z", label: "past exchange: refund policy" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url).replace("http://test", "");
        if (path === "/channels") {
          return new Response("[]", { status: 200 });
        }
        if (path === "/knowledge/evidence/e1/restore" && init?.method === "POST") {
          excluded = [];
          return new Response(JSON.stringify({ excluded: false }), { status: 200 });
        }
        if (path === "/knowledge/evidence/excluded") {
          return new Response(JSON.stringify({ excluded }), { status: 200 });
        }
        return new Response(JSON.stringify(knowledgeFor()), { status: 200 });
      }),
    );
    renderWithClient(<Knows api={api} />);
    await waitFor(() => expect(screen.getByTestId("knows-removed-row")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("knows-removed-restore"));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://test/knowledge/evidence/e1/restore", expect.objectContaining({ method: "POST" })),
    );
    await waitFor(() => expect(screen.getByTestId("knows-removed-empty")).toBeInTheDocument());
  });

  it("a refused restore keeps the row and shows the daemon's own error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url).replace("http://test", "");
        if (path === "/channels") {
          return new Response("[]", { status: 200 });
        }
        if (path === "/knowledge/evidence/e1/restore" && init?.method === "POST") {
          return new Response(JSON.stringify({ error: { code: "unauthorized", message: "Missing bearer token." } }), { status: 401 });
        }
        if (path === "/knowledge/evidence/excluded") {
          return new Response(JSON.stringify({ excluded: [{ recordId: "e1", excludedAt: "2026-09-20T00:00:00.000Z", label: "past exchange: refund policy" }] }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify(knowledgeFor()), { status: 200 });
      }),
    );
    renderWithClient(<Knows api={api} />);
    await waitFor(() => expect(screen.getByTestId("knows-removed-row")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("knows-removed-restore"));
    await waitFor(() => expect(screen.getByTestId("mutation-error")).toHaveTextContent("Missing bearer token."));
    expect(screen.getByTestId("knows-removed-row")).toBeInTheDocument();
  });
});

/*
 * duo#277: "what your duo can and can't answer yet" — the Knows tab's
 * coverage section, read from its own route (`GET /knowledge/coverage`,
 * separate from `GET /knowledge` itself).
 */
describe("Knows tab — coverage and gaps to teach (duo#277)", () => {
  it("AC1: says so in words when there isn't enough history to characterise, same bar the portrait uses — no breakdown, no gaps", async () => {
    stubKnowledge(knowledgeFor(), [], coverageFor({ tooThin: true, totalQuestions: 4, minimumQuestionsToCharacterize: 10 }));
    renderWithClient(<Knows api={api} />);
    const thin = await waitFor(() => screen.getByTestId("coverage-thin"));
    expect(thin.textContent).toContain("10");
    expect(thin.textContent).toContain("4");
    expect(screen.queryByTestId("coverage-gap")).toBeNull();
    expect(screen.queryByTestId("coverage-summary")).toBeNull();
  });

  it("past the bar: a summary bar (counts, never a percentage) plus every gap, most-asked first, each with a Teach action", async () => {
    stubKnowledge(
      knowledgeFor(),
      [],
      coverageFor({
        tooThin: false,
        totalQuestions: 10,
        coveredShare: 0.6,
        topics: [
          { topicId: "t-leave", label: "Leave policy", questionCount: 6, share: 0.6, covered: true, ruleStatus: "confirmed", reviewStatus: "approved" },
          { topicId: "t-printer", label: "Printer issues", questionCount: 3, share: 0.3, covered: false, ruleStatus: "weak_signal", reviewStatus: "pending" },
          { topicId: "t-onboard", label: "Onboarding", questionCount: 1, share: 0.1, covered: false, ruleStatus: "none", reviewStatus: "none" },
        ],
        gaps: [
          { topicId: "t-printer", label: "Printer issues", questionCount: 3, share: 0.3, covered: false, ruleStatus: "weak_signal", reviewStatus: "pending" },
          { topicId: "t-onboard", label: "Onboarding", questionCount: 1, share: 0.1, covered: false, ruleStatus: "none", reviewStatus: "none" },
        ],
      }),
    );
    renderWithClient(<Knows api={api} />);
    const summary = await waitFor(() => screen.getByTestId("coverage-summary"));
    expect(summary.textContent).toContain("6 of 10");
    expect(screen.getByTestId("coverage-share-fill")).toBeInTheDocument();

    const gaps = screen.getAllByTestId("coverage-gap");
    expect(gaps).toHaveLength(2);
    // Most-asked first, exactly the order the daemon sent.
    expect(gaps[0]).toHaveTextContent("Printer issues");
    expect(gaps[1]).toHaveTextContent("Onboarding");
    expect(gaps[0]).toHaveTextContent("3×");

    // §1.6: no percentage numeral anywhere in this section.
    expect(screen.getByTestId("knows-coverage").textContent).not.toMatch(/\d+(\.\d+)?\s?%/);
  });

  it("AC2: Teach opens Your duo with the gap's own label already in the composer", async () => {
    stubKnowledge(
      knowledgeFor(),
      [],
      coverageFor({
        tooThin: false,
        totalQuestions: 3,
        coveredShare: 0,
        topics: [{ topicId: "t-printer", label: "Printer issues", questionCount: 3, share: 1, covered: false, ruleStatus: "none", reviewStatus: "none" }],
        gaps: [{ topicId: "t-printer", label: "Printer issues", questionCount: 3, share: 1, covered: false, ruleStatus: "none", reviewStatus: "none" }],
      }),
    );
    renderWithClient(<Knows api={api} />);
    await waitFor(() => expect(screen.getByTestId("coverage-gap-teach")).toBeInTheDocument());
    expect(readComposerBuffer()).toBe("");
    fireEvent.click(screen.getByTestId("coverage-gap-teach"));
    expect(readComposerBuffer()).toContain("Printer issues");
    expect(window.location.hash).toBe("#duo");
  });

  it("nothing thin right now: every topic asked about already has an approved answer behind it, and no gap renders", async () => {
    stubKnowledge(
      knowledgeFor(),
      [],
      coverageFor({
        tooThin: false,
        totalQuestions: 6,
        coveredShare: 1,
        topics: [{ topicId: "t-leave", label: "Leave policy", questionCount: 6, share: 1, covered: true, ruleStatus: "confirmed", reviewStatus: "approved" }],
        gaps: [],
      }),
    );
    renderWithClient(<Knows api={api} />);
    await waitFor(() => expect(screen.getByTestId("coverage-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("coverage-gap")).toBeNull();
  });
});
