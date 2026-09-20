import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { DraftRecord } from "../src/api/types.js";

function draftFor(owner: string): DraftRecord {
  return {
    id: `${owner}-draft`,
    question: `question from ${owner}'s daemon`,
    threadContext: null,
    draftText: `answer from ${owner}'s daemon`,
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.8,
    sources: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    outcome: null,
    outcomeRecordedAt: null,
    sentText: null,
    refused: false,
    escalationThreshold: 0.55,
  };
}

describe("App — the query cache never leaks across a reconnect to a different daemon", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("does not show daemon A's cached drafts while daemon B's request is still in flight after reconnecting", async () => {
    let resolveB!: (value: Response) => void;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("daemon-a")) {
        return Promise.resolve(new Response(JSON.stringify([draftFor("A")]), { status: 200 }));
      }
      // daemon B's request is held open deliberately, so a synchronous
      // stale-cache read (if the bug were still present) would be
      // observable before this ever resolves.
      return new Promise<Response>((resolve) => {
        resolveB = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText("100.64.1.5:7717"), { target: { value: "daemon-a:7717" } });
    fireEvent.change(screen.getByRole("textbox", { name: /token/i }), { target: { value: "tok-a" } });
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => expect(screen.getByText("question from A's daemon")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Disconnect"));
    fireEvent.change(screen.getByPlaceholderText("100.64.1.5:7717"), { target: { value: "daemon-b:7717" } });
    fireEvent.change(screen.getByRole("textbox", { name: /token/i }), { target: { value: "tok-b" } });
    fireEvent.click(screen.getByText("Connect"));

    // Daemon A's question must not still be showing while daemon B's
    // request hasn't resolved yet — that would mean the cache carried A's
    // data across the reconnect.
    expect(screen.queryByText("question from A's daemon")).toBeNull();

    resolveB(new Response(JSON.stringify([draftFor("B")]), { status: 200 }));
    await waitFor(() => expect(screen.getByText("question from B's daemon")).toBeInTheDocument());
    expect(screen.queryByText("question from A's daemon")).toBeNull();
  });
});

describe("App — hash routing between the surfaces", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    window.location.hash = "";
  });

  it("opens on Review, navigates to Mirror on #mirror, and back", async () => {
    // A stored config skips Setup, so the shell renders straight into the
    // route tree this test is actually about.
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/mirror/portrait")) {
          return new Response(
            JSON.stringify({
              totalQuestions: 0,
              periodStart: null,
              periodEnd: null,
              topicBreakdown: [],
              topFiveShare: 0,
              busiestThreads: [],
              tooThin: true,
              minimumQuestionsToCharacterize: 10,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/mirror/rules")) {
          return new Response(JSON.stringify({ awaitingApproval: [], weakSignals: [], inconsistent: [], approved: [], rejected: [] }), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );

    render(<App />);

    // Fresh launch: the empty hash is Review, the default surface.
    await waitFor(() => expect(screen.getByText("Nothing waiting on you.")).toBeInTheDocument());

    window.location.hash = "#mirror";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(screen.getByTestId("mirror")).toBeInTheDocument());
    expect(screen.queryByText("Nothing waiting on you.")).toBeNull();

    window.location.hash = "#review";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(screen.getByText("Nothing waiting on you.")).toBeInTheDocument());
    expect(screen.queryByTestId("mirror")).toBeNull();
  });

  it("navigates to Duo on #duo and back to Review", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );

    render(<App />);

    window.location.hash = "#duo";
    window.dispatchEvent(new Event("hashchange"));
    // GET /drafts returns [] against this stub, so the thread view shows
    // its honest empty state — the route mounted, not Review with no drafts.
    await waitFor(() => expect(screen.getByTestId("duo-empty")).toBeInTheDocument());
    expect(screen.getByTestId("composer")).toBeInTheDocument();
    expect(screen.queryByText("Nothing waiting on you.")).toBeNull();

    window.location.hash = "#review";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(screen.getByText("Nothing waiting on you.")).toBeInTheDocument());
    expect(screen.queryByTestId("duo-thread")).toBeNull();
  });

  it("navigates to Trust on #trust", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );

    render(<App />);

    window.location.hash = "#trust";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(screen.getByTestId("trust-empty")).toBeInTheDocument());
    expect(screen.queryByText("Nothing waiting on you.")).toBeNull();
  });

  it("navigates to Audit on #audit", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );

    render(<App />);

    window.location.hash = "#audit";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(screen.getByTestId("audit-empty")).toBeInTheDocument());
    expect(screen.queryByText("Nothing waiting on you.")).toBeNull();
  });
});
