import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rules } from "../src/profile/Rules.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { RuleReviewListing, TopicCoverageReport } from "../src/api/types.js";

/*
 * duo#317 AC2: "the flow ends with approved rules and a visible coverage
 * number." The first run hands off to this tab (`Onboarding.tsx`'s
 * `onFinish`, unchanged) the moment the first rule exists, so the coverage
 * number has to live here, on the same screen as Approve/Reject — not
 * buried back in Knows, where a first-run owner never goes. `CoverageSummary`
 * (`src/profile/CoverageSummary.tsx`) is the exact component Knows already
 * shipped for duo#277; this file pins that the Rules tab reads the same
 * route and renders the same words, so the two screens can't disagree.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const emptyRules: RuleReviewListing = { awaitingApproval: [], weakSignals: [], inconsistent: [], approved: [], rejected: [] };

function coverageFor(over?: Partial<TopicCoverageReport>): TopicCoverageReport {
  return { totalQuestions: 0, tooThin: true, minimumQuestionsToCharacterize: 10, coveredShare: 0, topics: [], gaps: [], ...over };
}

function stubRulesTab(rules: RuleReviewListing, coverage: TopicCoverageReport) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(String(url)).pathname;
      if (path === "/mirror/rules") {
        return new Response(JSON.stringify(rules), { status: 200 });
      }
      if (path === "/knowledge/coverage") {
        return new Response(JSON.stringify(coverage), { status: 200 });
      }
      if (path === "/mirror/pinned-answers") {
        return new Response(JSON.stringify({ pinnedAnswers: [] }), { status: 200 });
      }
      // /review (correction candidates) and anything else this tab reads.
      return new Response(JSON.stringify([]), { status: 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("duo#317 AC2 — the Rules tab shows a coverage number alongside approval", () => {
  it("below the daemon's minimum, says so with its own counts — never a percentage", async () => {
    stubRulesTab(emptyRules, coverageFor({ totalQuestions: 4, minimumQuestionsToCharacterize: 10 }));
    renderWithClient(<Rules api={api} />);

    await waitFor(() => expect(screen.getByTestId("rules-tab")).toBeInTheDocument());
    const coverage = screen.getByTestId("rules-coverage");
    expect(coverage).toHaveTextContent(/4/);
    expect(coverage).toHaveTextContent(/10/);
    expect(coverage.textContent).not.toMatch(/%/);
  });

  it("once there's enough history, shows the covered count and a meter, the same words Knows shows", async () => {
    stubRulesTab(
      emptyRules,
      coverageFor({
        tooThin: false,
        totalQuestions: 20,
        coveredShare: 0.6,
        topics: [
          { topicId: "t1", label: "deploy access", questionCount: 12, covered: true, share: 0.6, ruleStatus: "confirmed", reviewStatus: "approved" },
          { topicId: "t2", label: "leave policy", questionCount: 8, covered: false, share: 0.4, ruleStatus: "none", reviewStatus: "none" },
        ],
        gaps: [{ topicId: "t2", label: "leave policy", questionCount: 8, share: 0.4, covered: false, ruleStatus: "none", reviewStatus: "none" }],
      }),
    );
    renderWithClient(<Rules api={api} />);

    await waitFor(() => expect(screen.getByTestId("coverage-summary")).toBeInTheDocument());
    expect(screen.getByTestId("coverage-summary")).toHaveTextContent("12 of 20");
    expect(screen.getByTestId("coverage-share-fill")).toBeInTheDocument();
    expect(screen.getByTestId("coverage-gap")).toHaveTextContent("leave policy");
    expect(screen.getByTestId("rules-coverage").textContent).not.toMatch(/\d+(\.\d+)?\s?%/);
  });
});
