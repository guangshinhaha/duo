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
    provenance: { origin: "unknown" },
    delivery: null,
  };
}

function knowledgeFor() {
  return {
    records: { total: 0, bySource: {} },
    lastImport: null,
    corpus: {
      tooThin: true,
      minimumQuestionsToCharacterize: 10,
      totalQuestions: 0,
      periodStart: null,
      periodEnd: null,
      topicBreakdown: [],
    },
    rules: { byReviewStatus: { pending: 0, approved: 0, rejected: 0, superseded: 0 } },
    providers: { inference: null, embedding: null },
    sharedUsage: {
      totalQuestions: 0,
      distinctAskers: 0,
      repeatAskers: 0,
      answeredCount: 0,
      declinedCount: 0,
      answerRate: 0,
      escalationRate: 0,
      weeklyTrend: [],
      gaps: [],
      lastAskedAt: null,
      daysSinceLastAsk: null,
      abandoned: false,
      summary: "The shared duo is not being used.",
    },
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
      // #40: the sidebar's roster query answers on its own, so the one
      // deliberately-held promise below is the drafts request this test
      // is about — not whichever query happened to fire last.
      if (url.includes("/duos")) {
        return Promise.resolve(new Response(JSON.stringify([{ kind: "personal" }]), { status: 200 }));
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

  it("navigates to Corrections on #corrections, beside Review in the loop's own order", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );

    render(<App />);

    // The queue is a first-class surface (AR-14's second half): its own
    // sidebar entry, directly under Review — the loop's two queues read
    // together, not buried behind another surface.
    const link = screen.getByRole("link", { name: "Corrections" });
    expect(link).toHaveAttribute("href", "#corrections");
    const entries = [...screen.getByRole("navigation").querySelectorAll("a")].map((a) => a.textContent);
    expect(entries.indexOf("Review")).toBeLessThan(entries.indexOf("Corrections"));
    expect(entries.indexOf("Corrections")).toBeLessThan(entries.indexOf("Duo"));

    window.location.hash = "#corrections";
    window.dispatchEvent(new Event("hashchange"));
    // GET /review returns [] against this stub, so the queue shows its
    // honest empty state — the route mounted, not Review with no drafts.
    await waitFor(() => expect(screen.getByTestId("corrections-empty")).toBeInTheDocument());
    expect(screen.queryByText("Nothing waiting on you.")).toBeNull();
  });

  it("navigates to Knowledge on #knowledge, beside the your-duo surfaces", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/knowledge")) {
          return new Response(JSON.stringify(knowledgeFor()), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );

    render(<App />);

    // Knowledge sits with the your-duo surfaces, right after Mirror — what
    // it derived, then what it knows.
    const link = screen.getByRole("link", { name: "Knowledge" });
    expect(link).toHaveAttribute("href", "#knowledge");
    const entries = [...screen.getByRole("navigation").querySelectorAll("a")].map((a) => a.textContent);
    expect(entries.indexOf("Mirror")).toBeLessThan(entries.indexOf("Knowledge"));
    expect(entries.indexOf("Knowledge")).toBeLessThan(entries.indexOf("Settings"));

    window.location.hash = "#knowledge";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(screen.getByTestId("knowledge")).toBeInTheDocument());
    expect(screen.queryByText("Nothing waiting on you.")).toBeNull();
  });

  it("⌘K opens search over any route and closes back onto the same screen, nothing lost (#46)", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    // Review is the populated route: a draft card is on screen when search
    // opens over it, and the same card is still there when it closes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/drafts")) {
          return new Response(JSON.stringify([draftFor("A")]), { status: 200 });
        }
        if (String(url).includes("/knowledge")) {
          // The overlay's empty-vs-no-match read mounts on open; serve the
          // real shape so it never dereferences a bare [].
          return new Response(JSON.stringify(knowledgeFor()), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );

    render(<App />);
    await waitFor(() => expect(screen.getByText("question from A's daemon")).toBeInTheDocument());

    // Open from the keyboard, over the open screen.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(screen.getByTestId("search-overlay")).toBeInTheDocument());
    // Over, not instead of: the route underneath never unmounted.
    expect(screen.getByText("question from A's daemon")).toBeInTheDocument();

    // Close from the keyboard: the same screen, the same state.
    fireEvent.keyDown(screen.getByPlaceholderText(/search what your duo knows/i), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("search-overlay")).toBeNull());
    expect(screen.getByText("question from A's daemon")).toBeInTheDocument();

    // Ctrl+K is the same gesture on the other platform.
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId("search-overlay")).toBeInTheDocument());
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

  it("navigates to Settings on #settings, and unpair clears the persisted cache and returns to Setup", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "tok" }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([draftFor("A")]), { status: 200 })),
    );

    render(<App />);

    // Review loads first (the default route) so a query actually runs and
    // the persister has something to write — Settings itself queries
    // nothing, so without this the cache-removal below would prove nothing.
    await waitFor(() => expect(screen.getByText("question from A's daemon")).toBeInTheDocument());
    await waitFor(() => expect(localStorage.getItem("duo-cache")).toContain("question from A's daemon"), { timeout: 3000 });

    window.location.hash = "#settings";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(screen.getByTestId("settings")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("settings-unpair"));
    fireEvent.click(screen.getByTestId("settings-unpair-confirm"));

    // Back to the first-run screen, with neither the config nor the old
    // duo's cached data left behind on this device.
    await waitFor(() => expect(screen.getByPlaceholderText("100.64.1.5:7717")).toBeInTheDocument());
    expect(localStorage.getItem("duo.api-config")).toBeNull();
    await waitFor(() => expect(localStorage.getItem("duo-cache")).toBeNull());
  });
});
