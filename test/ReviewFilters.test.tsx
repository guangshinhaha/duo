import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Review } from "../src/routes/Review.js";
import type { DraftRecord } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderReview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Review api={api} />
    </QueryClientProvider>,
  );
}

function draftFor(id: string, over?: Partial<DraftRecord>): DraftRecord {
  return {
    id,
    question: `q-${id}`,
    threadContext: null,
    draftText: `a-${id}`,
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.8,
    sources: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    outcome: null,
    outcomeRecordedAt: null,
    sentText: null,
    refused: false,
    escalationThreshold: 0.6,
    provenance: { origin: "owner" },
    delivery: null,
    ...over,
  };
}

/** The pile #50 exists to tame: owner drafts, channel drafts on two channels, a judgment escalation, and a refusal. */
const QUEUE: DraftRecord[] = [
  draftFor("owner-draft"),
  draftFor("slack-draft", {
    provenance: { origin: "channel", channelKind: "slack", askerRef: "U1", threadId: "C1", permalink: null },
  }),
  draftFor("escalation", {
    escalated: true,
    escalationReason: "Not sure enough to draft.",
    draftText: null,
    provenance: { origin: "channel", channelKind: "slack", askerRef: "U2", threadId: "C1", permalink: null },
  }),
  draftFor("refusal", {
    escalated: true,
    refused: true,
    escalationReason: "This is not something I answer.",
    draftText: null,
  }),
  draftFor("email-draft", {
    provenance: { origin: "channel", channelKind: "email", askerRef: "boss@acme.com", threadId: null, permalink: null },
  }),
];

function stubQueue(drafts: DraftRecord[] = QUEUE) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(drafts), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const questionsVisible = () =>
  screen
    .getAllByTestId("draft-card")
    .map((card) => card.querySelector('[data-testid="owner-message"]')?.textContent ?? "");

describe("#50 — filter the Review queue by state and origin", () => {
  beforeEach(() => {
    stubQueue();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("narrows by state: drafts, escalations, or refusals", async () => {
    renderReview();
    await waitFor(() => expect(screen.getAllByTestId("draft-card")).toHaveLength(5));

    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: "drafts" } });
    expect(questionsVisible()).toEqual(["Youq-owner-draft", "Youq-slack-draft", "Youq-email-draft"]);

    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: "escalations" } });
    expect(questionsVisible()).toEqual(["Youq-escalation"]);

    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: "refusals" } });
    expect(questionsVisible()).toEqual(["Youq-refusal"]);

    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: "all" } });
    expect(screen.getAllByTestId("draft-card")).toHaveLength(5);
  });

  it("narrows by origin: channel and asker, options built from what is on the wire", async () => {
    renderReview();
    await waitFor(() => expect(screen.getAllByTestId("draft-card")).toHaveLength(5));

    // The option list is the queue's own vocabulary — every channel kind
    // and every asker actually present, nothing invented.
    const channel = screen.getByLabelText(/channel/i) as HTMLSelectElement;
    expect([...channel.options].map((o) => o.value)).toEqual(["all", "slack", "email"]);
    const asker = screen.getByLabelText(/asker/i) as HTMLSelectElement;
    expect([...asker.options].map((o) => o.value)).toEqual(["all", "U1", "U2", "boss@acme.com"]);

    fireEvent.change(channel, { target: { value: "slack" } });
    expect(questionsVisible()).toEqual(["Youq-slack-draft", "Youq-escalation"]);

    fireEvent.change(asker, { target: { value: "U1" } });
    expect(questionsVisible()).toEqual(["Youq-slack-draft"]);
  });

  it("an active filter is visible, counts the hidden, and one action clears it", async () => {
    renderReview();
    await waitFor(() => expect(screen.getAllByTestId("draft-card")).toHaveLength(5));
    expect(screen.queryByTestId("filter-status")).toBeNull();

    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: "drafts" } });
    expect(screen.getByTestId("filter-status").textContent).toContain("2 hidden");

    // One action, both dimensions back to everything.
    fireEvent.change(screen.getByLabelText(/channel/i), { target: { value: "slack" } });
    expect(screen.getByTestId("filter-status").textContent).toContain("4 hidden");
    fireEvent.click(screen.getByTestId("filter-clear"));
    expect(screen.getAllByTestId("draft-card")).toHaveLength(5);
    expect(screen.queryByTestId("filter-status")).toBeNull();
  });

  it("a slice with nothing in it says so, with the hidden count still honest", async () => {
    renderReview();
    await waitFor(() => expect(screen.getAllByTestId("draft-card")).toHaveLength(5));
    // Refusals on slack: the one refusal in the queue is owner-asked.
    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: "refusals" } });
    fireEvent.change(screen.getByLabelText(/channel/i), { target: { value: "slack" } });
    expect(screen.queryByTestId("draft-card")).toBeNull();
    expect(screen.getByTestId("filter-status").textContent).toContain("5 hidden");
    expect(screen.getByTestId("filter-empty").textContent).toMatch(/nothing in this slice/i);
  });

  it("filtering is presentation only — the fetch list never moves", async () => {
    const fetchMock = stubQueue();
    renderReview();
    await waitFor(() => expect(screen.getAllByTestId("draft-card")).toHaveLength(5));
    const callsAfterLoad = fetchMock.mock.calls.length;

    for (const value of ["drafts", "escalations", "refusals", "all"]) {
      fireEvent.change(screen.getByLabelText(/state/i), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText(/channel/i), { target: { value: "email" } });
    fireEvent.click(screen.getByTestId("filter-clear"));

    // Every filter change served from state; the daemon heard nothing new.
    // (Only usePendingDrafts fetches here — no card actions are fired — so
    // an unchanged call count IS an unchanged request list.)
    expect(fetchMock.mock.calls.length).toBe(callsAfterLoad);
  });

  it("the sidebar badge counts everything, whatever the filter shows (App-level)", async () => {
    stubQueue();
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://test", token: "tok" }));
    window.location.hash = "#review";
    window.dispatchEvent(new Event("hashchange"));
    const { App } = await import("../src/App.js");
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("review-badge")).toHaveTextContent("5"));
    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: "drafts" } });
    await waitFor(() => expect(screen.getAllByTestId("draft-card")).toHaveLength(3));
    // The badge is the queue's count, not the view's — §3.1's "badge =
    // drafts where outcome is null" holds under any filter.
    expect(screen.getByTestId("review-badge")).toHaveTextContent("5");
    window.location.hash = "";
  });
});
