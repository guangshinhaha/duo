import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Knows } from "../src/profile/Knows.js";
import type { DuoKnowledge } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";

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

function stubKnowledge(knowledge: DuoKnowledge) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = String(url).replace("http://test", "");
      return new Response(path === "/channels" ? "[]" : JSON.stringify(knowledge), { status: 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
