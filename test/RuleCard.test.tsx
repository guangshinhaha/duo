import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuleCard, type RuleBucket } from "../src/components/RuleCard.js";
import type { Rule, RuleWithEvidence } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function ruleFor(over?: Partial<Rule>): Rule {
  return {
    id: "r1",
    topicId: "t1",
    text: "Answer leave questions from the policy doc.",
    status: "confirmed",
    supportCount: 3,
    consistency: 0.9,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastConfirmedAt: null,
    reviewStatus: "pending",
    origin: "derived",
    ...over,
  };
}

describe("RuleCard — read and disposition only (AR-18), never authoring", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(ruleFor()), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["awaitingApproval", ["approve-rule", "reject-rule"]],
    ["weakSignals", ["promote-rule", "reject-rule"]],
    ["inconsistent", ["reject-rule"]],
    ["approved", []],
    ["rejected", []],
  ] as const)("bucket %s offers exactly the actions the daemon's preconditions allow", (bucket, expected) => {
    renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket={bucket as RuleBucket} />);
    const offered = expected as readonly string[];
    for (const testId of ["approve-rule", "reject-rule", "promote-rule"]) {
      const button = screen.queryByTestId(testId);
      if (offered.includes(testId)) {
        expect(button).not.toBeNull();
      } else {
        expect(button).toBeNull();
      }
    }
  });

  it("renders rule text inside the duo-attributed container, never as the owner's own words", () => {
    renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket="awaitingApproval" />);
    expect(screen.getByTestId("duo-message")).toHaveTextContent("Answer leave questions from the policy doc.");
    expect(screen.getByTestId("duo-message-attribution")).toHaveTextContent("Your duo");
  });

  it("shows support count without ever rendering a percentage numeral", () => {
    renderWithClient(<RuleCard api={api} rule={ruleFor({ supportCount: 3 })} bucket="awaitingApproval" />);
    expect(screen.getByTestId("rule-meta")).toHaveTextContent("seen 3 times");
    expect(screen.getByTestId("rule-card")).not.toHaveTextContent("%");
  });

  it("posts the action to the daemon's route and disables buttons while pending", async () => {
    renderWithClient(<RuleCard api={api} rule={ruleFor({ id: "r9" })} bucket="awaitingApproval" />);
    fireEvent.click(screen.getByTestId("approve-rule"));
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "http://test/mirror/rules/r9/approve",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("renders the daemon's own error message when an action is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "InvalidReviewActionError", message: 'Rule "r1" has derivation status "inconsistent", not "confirmed" — only a confirmed rule can be approved.' } }), { status: 409 }),
      ),
    );
    renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket="awaitingApproval" />);
    fireEvent.click(screen.getByTestId("approve-rule"));
    await waitFor(() => expect(screen.getByTestId("mutation-error")).toHaveTextContent("only a confirmed rule can be approved"));
  });
});

// GET /mirror/rules/:id (digital-duo #182's RuleWithEvidence): the rule plus
// the exchanges its evidence cites, resolved to real text. A citation whose
// record has since been removed comes back with null text — evidence tracing
// degrades rather than making the whole rule unviewable.
function withEvidence(rule: Rule, evidence: RuleWithEvidence["evidence"]): RuleWithEvidence {
  return { rule, evidence };
}

const exchanges: RuleWithEvidence["evidence"] = [
  { qaPairId: "qa-1", questionText: "How many leave days do I get?", answerText: "Twenty a year, see the policy doc." },
  { qaPairId: "qa-2", questionText: "Can I carry leave over?", answerText: "Five days carry over, the rest lapses." },
  { qaPairId: "qa-gone", questionText: null, answerText: null },
];

function stubEvidence(detail: RuleWithEvidence) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith(`/mirror/rules/${detail.rule.id}`)) {
        return new Response(JSON.stringify(detail), { status: 200 });
      }
      return new Response(JSON.stringify(detail.rule), { status: 200 });
    }),
  );
}

function evidenceCalls(): string[] {
  return (vi.mocked(fetch).mock.calls as unknown as [string][]).map(([url]) => url).filter((url) => /\/mirror\/rules\/[^/]+$/.test(url));
}

describe("RuleCard — the evidence behind a rule (#53)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches nothing until the owner asks why — evidence is a read on demand", () => {
    stubEvidence(withEvidence(ruleFor(), exchanges));
    renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket="awaitingApproval" />);
    expect(evidenceCalls()).toEqual([]);
    expect(screen.queryByTestId("rule-evidence")).toBeNull();
    expect(screen.getByTestId("rule-evidence-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the daemon's own GET /mirror/rules/:id and shows each supporting exchange", async () => {
    stubEvidence(withEvidence(ruleFor(), exchanges));
    renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket="awaitingApproval" />);
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("rule-evidence-exchange")).toHaveLength(3));
    expect(evidenceCalls()).toEqual(["http://test/mirror/rules/r1"]);
    expect(screen.getByTestId("rule-evidence-toggle")).toHaveAttribute("aria-expanded", "true");
    const [first, second] = screen.getAllByTestId("rule-evidence-exchange");
    expect(first).toHaveTextContent("How many leave days do I get?");
    expect(first).toHaveTextContent("Twenty a year, see the policy doc.");
    expect(second).toHaveTextContent("Can I carry leave over?");
    expect(screen.getByTestId("rule-evidence")).toHaveTextContent("Cites 3 exchanges");
  });

  it("names a citation whose record is gone instead of dropping it or showing a blank", async () => {
    stubEvidence(withEvidence(ruleFor(), exchanges));
    renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket="awaitingApproval" />);
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("rule-evidence-exchange")).toHaveLength(3));
    expect(screen.getAllByTestId("rule-evidence-exchange")[2]).toHaveTextContent("no longer in the record");
  });

  it("says a rule with no cited exchanges has none — an asserted rule is the owner's word, not the corpus's", async () => {
    const asserted = ruleFor({ origin: "owner_asserted", supportCount: 0 });
    stubEvidence(withEvidence(asserted, []));
    renderWithClient(<RuleCard api={api} rule={asserted} bucket="approved" />);
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    await waitFor(() => expect(screen.getByTestId("rule-evidence-none")).toBeInTheDocument());
    expect(screen.getByTestId("rule-evidence-none")).toHaveTextContent("You asserted this rule");
    expect(screen.queryAllByTestId("rule-evidence-exchange")).toHaveLength(0);
  });

  it("says plainly when a derived rule cites nothing", async () => {
    stubEvidence(withEvidence(ruleFor(), []));
    renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket="awaitingApproval" />);
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    await waitFor(() => expect(screen.getByTestId("rule-evidence-none")).toHaveTextContent("No supporting exchanges"));
  });

  it("closes again, and reopening does not lose the evidence", async () => {
    stubEvidence(withEvidence(ruleFor(), exchanges));
    renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket="awaitingApproval" />);
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    await waitFor(() => expect(screen.getByTestId("rule-evidence")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    expect(screen.queryByTestId("rule-evidence")).toBeNull();
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("rule-evidence-exchange")).toHaveLength(3));
  });

  it("renders the daemon's own message when the rule cannot be opened", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "RuleNotFoundError", message: 'No rule with id "r1"' } }), { status: 404 })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RuleCard api={api} rule={ruleFor()} bucket="awaitingApproval" />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    await waitFor(() => expect(screen.getByTestId("rule-evidence-error")).toHaveTextContent('No rule with id "r1"'));
  });

  it("shows the answer as the owner's own words, never inside the duo's container (AR-13)", async () => {
    stubEvidence(withEvidence(ruleFor(), exchanges));
    renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket="awaitingApproval" />);
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("rule-evidence-exchange")).toHaveLength(3));
    const [first] = screen.getAllByTestId("rule-evidence-exchange");
    expect(first.querySelector("[data-testid='owner-message']")).toHaveTextContent("Twenty a year");
    expect(first.querySelector("[data-testid='duo-message']")).toBeNull();
    // The only duo-attributed text on the card is still the rule itself.
    expect(screen.getAllByTestId("duo-message")).toHaveLength(1);
    expect(screen.getByTestId("duo-message")).toHaveTextContent("Answer leave questions from the policy doc.");
  });

  it.each([
    ["awaitingApproval", ["approve-rule", "reject-rule"]],
    ["weakSignals", ["promote-rule", "reject-rule"]],
    ["inconsistent", ["reject-rule"]],
    ["approved", []],
    ["rejected", []],
  ] as const)("with evidence open, bucket %s still offers exactly the daemon's own dispositions", async (bucket, expected) => {
    stubEvidence(withEvidence(ruleFor(), exchanges));
    renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket={bucket as RuleBucket} />);
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("rule-evidence-exchange")).toHaveLength(3));
    const offered = expected as readonly string[];
    for (const testId of ["approve-rule", "reject-rule", "promote-rule"]) {
      expect(screen.queryByTestId(testId) !== null, testId).toBe(offered.includes(testId));
    }
  });

  it("adds no free-text editing and no percentage numeral when opened (AR-18)", async () => {
    stubEvidence(withEvidence(ruleFor(), exchanges));
    const { container } = renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket="awaitingApproval" />);
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("rule-evidence-exchange")).toHaveLength(3));
    expect(container.querySelectorAll("input, textarea, select, [contenteditable]")).toHaveLength(0);
    expect(screen.getByTestId("rule-card")).not.toHaveTextContent("%");
  });

  it("opening evidence performs no write", async () => {
    stubEvidence(withEvidence(ruleFor(), exchanges));
    renderWithClient(<RuleCard api={api} rule={ruleFor()} bucket="awaitingApproval" />);
    fireEvent.click(screen.getByTestId("rule-evidence-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("rule-evidence-exchange")).toHaveLength(3));
    const calls = vi.mocked(fetch).mock.calls as unknown as [string, RequestInit | undefined][];
    expect(calls.filter(([, init]) => init?.method && init.method !== "GET")).toEqual([]);
  });
});
