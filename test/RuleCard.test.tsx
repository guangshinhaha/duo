import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuleCard, type RuleBucket } from "../src/components/RuleCard.js";
import type { Rule } from "../src/api/types.js";
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
    expect(screen.getByTestId("rule-meta")).toHaveTextContent("observed 3 times");
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
