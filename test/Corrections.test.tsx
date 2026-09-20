import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Corrections } from "../src/routes/Corrections.js";
import { queryKeys } from "../src/api/queries.js";
import { apiRequest } from "../src/api/client.js";
import type { CorrectionCandidate } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

function candidateFor(over?: Partial<CorrectionCandidate>): CorrectionCandidate {
  return {
    id: "c-1",
    kind: "style",
    draftId: "d-1",
    question: "What should I tell the team about next week?",
    draftText: "I'm off next Friday; back the following Monday.",
    sentText: "I'm off next Friday, back the following Monday — anything urgent, ping Sam.",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    reviewedAt: null,
    ...over,
  };
}

/** Serves the pending queue on GET, records POSTs, and decides daemon-side — the POST writes the status, so the next GET the invalidation fires no longer holds the candidate. */
function stubQueue(candidates: CorrectionCandidate[]) {
  const pending = () => candidates.filter((c) => c.status === "pending");
  const posts: { url: string; body?: unknown }[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST") {
      posts.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      const id = url.split("/").at(-2)!;
      const decided = candidates.find((c) => c.id === id);
      if (decided) {
        decided.status = url.endsWith("/approve") ? "approved" : "rejected";
        decided.reviewedAt = "2026-01-02T00:00:00.000Z";
      }
      return Promise.resolve(new Response(JSON.stringify({ candidate: decided }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify(pending()), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posts, fetchMock };
}

describe("#44 — the correction queue has a screen", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("each candidate shows its kind, the question, what the duo drafted, and what was actually sent", async () => {
    stubQueue([
      candidateFor({ id: "c-1", kind: "style" }),
      candidateFor({
        id: "c-2",
        kind: "substance",
        draftId: "d-2",
        question: "How many days off do I have left?",
        draftText: "Five days.",
        sentText: "Ten days, after the carryover.",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);
    renderWithClient(<Corrections api={api} />);

    const cards = await waitFor(() => screen.getAllByTestId("candidate"));
    expect(cards).toHaveLength(2);
    // The kinds are the daemon's own strings, verbatim — no registry here.
    expect(screen.getAllByTestId("candidate-kind").map((el) => el.textContent)).toEqual(["style", "substance"]);
    // The questions read as the askers' turns, and both drafts and both
    // sent texts are present — the diff carries them. A word diff never
    // holds a full sentence contiguously (the changed words break the
    // runs), so the pin is each side's distinctive fragment, present in
    // the composed text of the diff.
    const questions = screen.getAllByTestId("owner-message").map((el) => el.textContent);
    expect(questions.some((t) => t?.includes("What should I tell the team about next week?"))).toBe(true);
    expect(questions.some((t) => t?.includes("How many days off do I have left?"))).toBe(true);
    const diffs = screen.getAllByTestId("edit-diff").map((el) => el.textContent);
    expect(diffs[0]).toContain("I'm off next");
    expect(diffs[0]).toContain("back the following Monday");
    expect(diffs[0]).toContain("anything urgent, ping Sam.");
    expect(diffs[1]).toContain("Five");
    expect(diffs[1]).toContain("Ten");
    expect(diffs[1]).toContain("after the carryover");
  });

  it("the difference between draft and sent is what the eye lands on — the change is marked, in place", async () => {
    stubQueue([
      candidateFor({
        draftText: "Five days per quarter.",
        sentText: "Ten days per quarter — anything urgent, ping Sam.",
      }),
    ]);
    renderWithClient(<Corrections api={api} />);
    await waitFor(() => expect(screen.getByTestId("candidate")).toBeInTheDocument());

    // The duo's words are struck, the owner's replacements marked, reading
    // in place — the same diff grammar the edit itself used (#23), because
    // the candidate IS that edit, waiting for a verdict. Word diffs emit a
    // run per changed span, so the marks are read as a set.
    const removed = screen.getAllByTestId("edit-diff-removed").map((el) => el.textContent).join(" ");
    expect(removed).toContain("Five");
    const added = screen.getAllByTestId("edit-diff-added").map((el) => el.textContent).join(" ");
    expect(added).toContain("Ten");
    expect(added).toContain("anything urgent, ping Sam.");
    // The diff sits inside the duo's labelled bubble: the change reads as
    // an edit ON the duo's draft, never as the duo posing as anyone.
    expect(screen.getByTestId("edit-diff").closest('[data-testid="duo-message"]')).not.toBeNull();
  });

  it("approving posts to the daemon's route and the list refreshes without the decided candidate", async () => {
    const { posts } = stubQueue([candidateFor()]);
    renderWithClient(<Corrections api={api} />);
    await waitFor(() => expect(screen.getByTestId("candidate")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("http://test/review/c-1/approve");
    // The queue the screen reads is the daemon's pending list — after the
    // decision, the refetched list no longer holds the candidate.
    await waitFor(() => expect(screen.getByTestId("corrections-empty")).toBeInTheDocument());
  });

  it("rejecting posts to /reject and the candidate leaves the queue", async () => {
    const { posts } = stubQueue([candidateFor()]);
    renderWithClient(<Corrections api={api} />);
    await waitFor(() => expect(screen.getByTestId("candidate")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Reject"));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("http://test/review/c-1/reject");
    await waitFor(() => expect(screen.getByTestId("corrections-empty")).toBeInTheDocument());
  });

  it("an already-reviewed candidate reports the daemon's 409 as an honest message", async () => {
    const message = 'Correction candidate "c-1" was already reviewed (status: "approved")';
    const fetchMock = vi.fn((_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ error: { code: "CandidateAlreadyReviewedError", message } }), { status: 409 }));
      }
      return Promise.resolve(new Response(JSON.stringify([candidateFor()]), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Corrections api={api} />);
    await waitFor(() => expect(screen.getByTestId("candidate")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Approve"));

    // The daemon's own words, verbatim — the client adds no interpretation
    // on top of a race another device won.
    await waitFor(() => expect(screen.getByTestId("mutation-error")).toHaveTextContent(message));
    // The candidate is still on screen: a 409 disposed of nothing here.
    expect(screen.getByTestId("candidate")).toBeInTheDocument();
  });

  it("empty explains that editing a draft is what puts something here", async () => {
    renderWithClient(<Corrections api={api} />);
    await waitFor(() => expect(screen.getByTestId("corrections-empty")).toBeInTheDocument());
    expect(screen.getByTestId("corrections-empty").textContent).toMatch(/editing a draft/i);
  });

  it("approving refreshes the mirror's rules too — an approved candidate is a rule the Mirror counts", async () => {
    let rulesFetches = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
      if (String(url).includes("/mirror/rules")) {
        rulesFetches += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ awaitingApproval: [], weakSignals: [], inconsistent: [], approved: [], rejected: [] }), { status: 200 }),
        );
      }
      if (init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ candidate: candidateFor() }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([candidateFor()]), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    // The Mirror's rules query mounted alongside the queue, under the one
    // client both share in the app: what #44 must refresh is visible as a
    // second fetch of /mirror/rules after the decision lands.
    function MirrorRulesProbe() {
      useQuery({ queryKey: queryKeys.mirrorRules, queryFn: () => apiRequest(api, "/mirror/rules") });
      return null;
    }
    renderWithClient(
      <>
        <Corrections api={api} />
        <MirrorRulesProbe />
      </>,
    );
    await waitFor(() => expect(rulesFetches).toBe(1));
    await waitFor(() => expect(screen.getByTestId("candidate")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(rulesFetches).toBe(2));
  });
});
