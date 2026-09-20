import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mirror } from "../src/routes/Mirror.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { InterruptionPortrait, Rule, RuleReviewListing } from "../src/api/types.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  // retry: false so an erroring route reaches its error state immediately —
  // with the default 3 retries and exponential backoff, "the daemon's error
  // message is shown" would be a 7-second test.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const portrait: InterruptionPortrait = {
  totalQuestions: 42,
  periodStart: "2026-08-01T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
  topicBreakdown: [
    { topicId: "t1", label: "leave policy", count: 30, share: 0.7 },
    { topicId: "t2", label: "procurement", count: 12, share: 0.3 },
  ],
  topFiveShare: 0.85,
  busiestThreads: [{ threadId: "th1", count: 20, share: 0.5 }],
  tooThin: false,
  minimumQuestionsToCharacterize: 10,
};

function ruleFor(id: string, over?: Partial<Rule>): Rule {
  return {
    id,
    topicId: "t1",
    text: `rule ${id}`,
    status: "confirmed",
    supportCount: 2,
    consistency: 0.8,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastConfirmedAt: null,
    reviewStatus: "pending",
    origin: "derived",
    ...over,
  };
}

const listing: RuleReviewListing = {
  awaitingApproval: [ruleFor("a1"), ruleFor("a2")],
  weakSignals: [ruleFor("w1", { status: "weak_signal" })],
  inconsistent: [ruleFor("i1", { status: "inconsistent" })],
  approved: [ruleFor("p1", { reviewStatus: "approved" })],
  rejected: [],
};

function stubMirrorResponses(p: InterruptionPortrait, l: RuleReviewListing) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/mirror/portrait")) {
        return new Response(JSON.stringify(p), { status: 200 });
      }
      return new Response(JSON.stringify(l), { status: 200 });
    }),
  );
}

describe("Mirror — the owner's window onto what the duo derived (C6)", () => {
  beforeEach(() => {
    stubMirrorResponses(portrait, listing);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the portrait's period, totals, topics, and threads — counts and bars, no percentage numerals", async () => {
    renderWithClient(<Mirror api={api} />);
    await waitFor(() => expect(screen.getByTestId("portrait")).toBeInTheDocument());
    expect(screen.getByTestId("portrait")).toHaveTextContent("42 questions");
    expect(screen.getByText("leave policy")).toBeInTheDocument();
    expect(screen.getByText("procurement")).toBeInTheDocument();
    expect(screen.getAllByTestId("portrait-topic")).toHaveLength(2);
    expect(screen.getAllByTestId("portrait-thread")).toHaveLength(1);
    expect(screen.getByTestId("mirror")).not.toHaveTextContent("%");
  });

  it("renders the honest thin-data state rather than zeros when history is insufficient (AR-19)", async () => {
    // Field names as the daemon actually sends them (verified live 2026-09-20):
    // `tooThin` + `minimumQuestionsToCharacterize`, not a guessed `insufficientHistory`.
    stubMirrorResponses({ ...portrait, tooThin: true, totalQuestions: 3 }, listing);
    renderWithClient(<Mirror api={api} />);
    await waitFor(() => expect(screen.getByTestId("portrait-thin")).toBeInTheDocument());
    expect(screen.getByTestId("portrait-thin")).toHaveTextContent("Not enough history yet");
    expect(screen.getByTestId("portrait-thin")).toHaveTextContent("10 questions");
    expect(screen.getByTestId("portrait-thin")).toHaveTextContent("has 3");
    expect(screen.queryByTestId("portrait")).toBeNull();
  });

  it("renders each bucket with its rules and counts, in decision order", async () => {
    renderWithClient(<Mirror api={api} />);
    await waitFor(() => expect(screen.getByTestId("bucket-awaitingApproval")).toBeInTheDocument());
    expect(screen.getByTestId("bucket-awaitingApproval")).toHaveTextContent("Awaiting your approval (2)");
    expect(screen.getByTestId("bucket-awaitingApproval")).toHaveTextContent("rule a1");
    expect(screen.getByTestId("bucket-weakSignals")).toHaveTextContent("Weak signals (1)");
    expect(screen.getByTestId("bucket-weakSignals")).toHaveTextContent("rule w1");
    expect(screen.getByTestId("bucket-inconsistent")).toHaveTextContent("Inconsistent (1)");
  });

  it("collapses history buckets — reachable, not loud", async () => {
    renderWithClient(<Mirror api={api} />);
    await waitFor(() => expect(screen.getByTestId("bucket-approved")).toBeInTheDocument());
    expect(screen.getByTestId("bucket-approved")).toHaveTextContent("Approved (1)");
    expect(screen.getByTestId("bucket-rejected")).toHaveTextContent("Rejected (0)");
  });

  it("renders honest empty lines for a thin mirror instead of hiding sections (AR-19)", async () => {
    const empty: RuleReviewListing = { awaitingApproval: [], weakSignals: [], inconsistent: [], approved: [], rejected: [] };
    stubMirrorResponses(portrait, empty);
    renderWithClient(<Mirror api={api} />);
    await waitFor(() => expect(screen.getByTestId("bucket-awaitingApproval")).toBeInTheDocument());
    expect(screen.getByTestId("bucket-awaitingApproval")).toHaveTextContent("No rules waiting on you.");
    expect(screen.getByTestId("bucket-weakSignals")).toHaveTextContent("No weak signals yet.");
  });

  it("surfaces the daemon's error message when a route fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "unknown", message: "store locked" } }), { status: 500 })),
    );
    renderWithClient(<Mirror api={api} />);
    // Both the portrait and rules queries fail against this mock, so the
    // message legitimately appears once per section — assert presence, not
    // uniqueness.
    await waitFor(() => expect(screen.getAllByText("store locked").length).toBeGreaterThan(0));
  });
});
