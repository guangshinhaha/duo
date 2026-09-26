import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mirror } from "../src/routes/Mirror.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { InterruptionPortrait, RefusalsListing, Rule, RuleReviewListing } from "../src/api/types.js";

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

// GET /mirror/refusals (digital-duo #182): pure duo/refusals.md file state —
// `decided` says whether the owner has ever answered the question at all, a
// distinction the empty list alone cannot carry.
const refusals: RefusalsListing = {
  decided: true,
  refusals: [
    { heading: "Salary negotiations", reason: "Never speak for me on pay — that is a conversation I have myself." },
    { heading: "Legal holds", reason: "" },
  ],
};

function stubMirrorResponses(p: InterruptionPortrait, l: RuleReviewListing, r: RefusalsListing = refusals) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/mirror/portrait")) {
        return new Response(JSON.stringify(p), { status: 200 });
      }
      if (url.includes("/mirror/refusals")) {
        return new Response(JSON.stringify(r), { status: 200 });
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

  describe("refusals — what the duo will not speak for the owner on, and why (#53)", () => {
    it("shows each refusal with what is refused and the basis the owner wrote", async () => {
      renderWithClient(<Mirror api={api} />);
      const rows = await screen.findAllByTestId("refusal");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent("Salary negotiations");
      expect(rows[0]).toHaveTextContent("Never speak for me on pay");
      expect(screen.getByTestId("refusals")).toHaveTextContent("Refusals (2)");
    });

    it("says so, rather than showing a blank, when a refusal carries no written reason", async () => {
      renderWithClient(<Mirror api={api} />);
      const rows = await screen.findAllByTestId("refusal");
      expect(rows[1]).toHaveTextContent("Legal holds");
      expect(rows[1]).toHaveTextContent("No reason written.");
    });

    it("keeps the owner's multi-line reason as written", async () => {
      stubMirrorResponses(portrait, listing, { decided: true, refusals: [{ heading: "Pay", reason: "line one\nline two" }] });
      renderWithClient(<Mirror api={api} />);
      const reason = await screen.findByTestId("refusal-reason");
      expect(reason.textContent).toBe("line one\nline two");
      expect(reason.className).toContain("whitespace-pre-wrap");
    });

    it("tells 'never asked' from 'asked, none' — the daemon's own decided flag (AR-19)", async () => {
      stubMirrorResponses(portrait, listing, { decided: false, refusals: [] });
      const { unmount } = renderWithClient(<Mirror api={api} />);
      await waitFor(() => expect(screen.getByTestId("refusals-undecided")).toBeInTheDocument());
      expect(screen.getByTestId("refusals-undecided")).toHaveTextContent("hasn't been asked");
      expect(screen.queryAllByTestId("refusal")).toHaveLength(0);
      unmount();

      stubMirrorResponses(portrait, listing, { decided: true, refusals: [] });
      renderWithClient(<Mirror api={api} />);
      await waitFor(() => expect(screen.getByTestId("refusals-none")).toBeInTheDocument());
      expect(screen.getByTestId("refusals-none")).toHaveTextContent("none");
      expect(screen.queryByTestId("refusals-undecided")).toBeNull();
    });

    it("points the empty state at the terminal instead of offering to record one here (AR-18)", async () => {
      stubMirrorResponses(portrait, listing, { decided: false, refusals: [] });
      renderWithClient(<Mirror api={api} />);
      await waitFor(() => expect(screen.getByTestId("refusals-undecided")).toBeInTheDocument());
      expect(screen.getByTestId("refusals-undecided")).toHaveTextContent("duo mirror refusals");
    });

    it("surfaces the daemon's error message when refusals cannot be read, without taking the rest down", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/mirror/refusals")) {
            return new Response(JSON.stringify({ error: { code: "unknown", message: "refusals file unreadable" } }), { status: 500 });
          }
          if (url.includes("/mirror/portrait")) {
            return new Response(JSON.stringify(portrait), { status: 200 });
          }
          return new Response(JSON.stringify(listing), { status: 200 });
        }),
      );
      renderWithClient(<Mirror api={api} />);
      await waitFor(() => expect(screen.getByText("refusals file unreadable")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByTestId("bucket-awaitingApproval")).toBeInTheDocument());
    });

    it("reads the daemon's route and nothing else — no write leaves the refusals view", async () => {
      renderWithClient(<Mirror api={api} />);
      await screen.findAllByTestId("refusal");
      const calls = vi.mocked(fetch).mock.calls as unknown as [string, RequestInit | undefined][];
      expect(calls.some(([url]) => url === "http://test/mirror/refusals")).toBe(true);
      expect(calls.filter(([, init]) => init?.method && init.method !== "GET")).toEqual([]);
    });
  });

  describe("authoring stays with the files (AR-18, #53)", () => {
    it("renders no free-text editing anywhere on the Mirror — rules or refusals", async () => {
      const { container } = renderWithClient(<Mirror api={api} />);
      await screen.findAllByTestId("refusal");
      await screen.findByTestId("bucket-awaitingApproval");
      expect(container.querySelectorAll("input, textarea, select, [contenteditable]")).toHaveLength(0);
      for (const button of screen.queryAllByRole("button")) {
        expect(button.textContent ?? "").not.toMatch(/\b(add|edit|write|record|new|save)\b/i);
      }
    });

    it("carries no percentage numeral anywhere, refusals included", async () => {
      renderWithClient(<Mirror api={api} />);
      await screen.findAllByTestId("refusal");
      expect(screen.getByTestId("mirror")).not.toHaveTextContent("%");
    });
  });
});
