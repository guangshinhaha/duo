import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { DraftRecord } from "../src/api/types.js";

/*
 * #25: a draft has its own address. `#draft/:id` renders one draft alone
 * (GET /drafts/:id — the daemon route §1.4 lists and nothing called), a
 * draft-ready notification opens the draft it is about, and an id that
 * matches nothing says so and offers the way back to Review.
 *
 * Each test uses its own draft id: the App's query client is module-level
 * and shared across the file, so reusing an id would hand a later test the
 * earlier test's cached draft — for the stays-when-decided test that
 * manufactured transition is exactly the bug it exists to pin against.
 */

const baseDraft: DraftRecord = {
  id: "d1",
  question: "How much leave do I get?",
  threadContext: null,
  draftText: "Five days per quarter.",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.8,
  sources: [{ kind: "rule", id: "r1", label: "standing order: five days" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

/**
 * Mounts the whole app at `hash`, serving `draft` (or 404 when absent) at
 * its id. The outcome POST is stateful like the daemon: recording a
 * decision changes what the next single-draft read returns.
 */
function mountApp(draft: DraftRecord | undefined, hash: string): { fetchMock: ReturnType<typeof vi.fn> } {
  let served = draft;
  const id = hash.slice("#draft/".length);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/outcome")) {
      if (served) served = { ...served, outcome: "sent", outcomeRecordedAt: "2026-01-02T00:00:00.000Z" };
      return json({});
    }
    if (url.endsWith(`/drafts/${id}`)) {
      return served ? json(served) : json({ error: { code: "not_found", message: "No such draft." } }, 404);
    }
    // Everything else (the pending list the sidebar badge reads, etc.).
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "tok" }));
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
  render(<App />);
  return { fetchMock };
}

describe("#25 — open a single draft", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    window.location.hash = "";
  });

  it("a draft has its own address: #draft/:id renders it alone, with provenance, sources, and controls", async () => {
    const { fetchMock } = mountApp({ ...baseDraft, id: "d1" }, "#draft/d1");

    await waitFor(() => expect(screen.getByTestId("draft-card")).toBeInTheDocument());
    expect(screen.getByTestId("owner-message")).toHaveTextContent("How much leave do I get?");
    expect(screen.getByTestId("duo-message")).toHaveTextContent("Five days per quarter.");
    expect(screen.getByText("Send", { selector: "button" })).toBeInTheDocument();
    expect(screen.getByText("Edit", { selector: "button" })).toBeInTheDocument();
    expect(screen.getByText("Ignore", { selector: "button" })).toBeInTheDocument();
    expect(screen.getByText("standing order: five days")).toBeInTheDocument();

    // The page's content came from the single-draft route.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/drafts/d1"))).toBe(true);
  });

  it("an unknown id says the draft is not on this duo and offers the way back to Review", async () => {
    mountApp(undefined, "#draft/gone");

    await waitFor(() => expect(screen.getByTestId("draft-not-found")).toBeInTheDocument());
    expect(screen.getByTestId("draft-not-found")).toHaveTextContent("This draft is not on this duo.");
    const back = screen.getByText("Back to Review");
    expect(back.getAttribute("href")).toBe("#review");

    fireEvent.click(back);
    await waitFor(() => expect(window.location.hash).toBe("#review"));
    // happy-dom moves the hash on an anchor click but does not fire the
    // hashchange event a real browser would — the rig's established
    // pattern is to deliver it by hand.
    window.dispatchEvent(new Event("hashchange"));
    // The queue surface is what answers — empty here, which is its own text.
    await waitFor(() => expect(screen.getByText("Nothing waiting on you.")).toBeInTheDocument());
  });

  it("an already-decided draft linked directly stays on its own page — opening is not deciding", async () => {
    mountApp(
      { ...baseDraft, id: "d9", outcome: "sent", outcomeRecordedAt: "2026-01-02T00:00:00.000Z" },
      "#draft/d9",
    );

    await waitFor(() => expect(screen.getByTestId("draft-card")).toBeInTheDocument());
    expect(screen.getByTestId("duo-message")).toHaveTextContent("Five days per quarter.");
    // No bounce: the page keeps its address.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.location.hash).toBe("#draft/d9");
  });

  it("deciding on the page returns to the queue — the draft was dealt with, Review is next", async () => {
    mountApp({ ...baseDraft, id: "d2" }, "#draft/d2");

    await waitFor(() => expect(screen.getByTestId("draft-card")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Send", { selector: "button" }));

    await waitFor(() => expect(window.location.hash).toBe("#review"));
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(screen.getByText("Nothing waiting on you.")).toBeInTheDocument());
  });
});
