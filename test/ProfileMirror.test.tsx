import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import type { InterruptionPortrait, PinnedAnswer, RefusalsListing, Rule, RuleReviewListing } from "../src/api/types.js";
import { Portrait } from "../src/profile/Portrait.js";
import { RefusalsSection } from "../src/profile/Refusals.js";
import { Rules } from "../src/profile/Rules.js";

/*
 * What the old Mirror page pinned, carried to the profile tabs that now own
 * it: the Portrait tab for the portrait, the Rules tab for the rule buckets.
 * RefusalsSection moved to May do with #269 — it is a limit now, owner-
 * authored in the app, not a Rules-tab, files-only read (see test/Hosted.test.tsx
 * and test/Profile.test.tsx for the May do tab's own coverage); this file
 * still exercises RefusalsSection's own read/write behaviour directly.
 */

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

function stubMirrorResponses(
  p: InterruptionPortrait,
  l: RuleReviewListing,
  r: RefusalsListing = refusals,
  pinnedAnswers: readonly PinnedAnswer[] = [],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/mirror/portrait")) {
        return new Response(JSON.stringify(p), { status: 200 });
      }
      if (url.includes("/mirror/refusals")) {
        return new Response(JSON.stringify(r), { status: 200 });
      }
      // duo#275: checked before the bare "/mirror/rules" catch-all below —
      // "/mirror/pinned-answers" would otherwise fall through to it and come
      // back shaped like a RuleReviewListing instead of `{ pinnedAnswers }`.
      if (url.includes("/mirror/pinned-answers")) {
        return new Response(JSON.stringify({ pinnedAnswers }), { status: 200 });
      }
      if (url.includes("/review")) {
        return new Response("[]", { status: 200 });
      }
      return new Response(JSON.stringify(l), { status: 200 });
    }),
  );
}

describe("Portrait tab — the owner's window onto what the duo worked out (C6)", () => {
  beforeEach(() => {
    stubMirrorResponses(portrait, listing);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the portrait's period, totals, topics, and threads — counts and bars, no percentage numerals", async () => {
    renderWithClient(<Portrait api={api} />);
    await waitFor(() => expect(screen.getByTestId("portrait-tab")).toBeInTheDocument());
    expect(screen.getByTestId("portrait-source")).toHaveTextContent("42 questions");
    expect(screen.getByTestId("portrait-source")).toHaveTextContent("–"); // the period, start to end
    expect(screen.getByTestId("portrait-sentences")).toHaveTextContent("You were asked about leave policy 30 times.");
    // The numbers are one tap away (in the <details>), but present in the DOM.
    expect(screen.getByText("leave policy", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("procurement", { selector: "span" })).toBeInTheDocument();
    expect(screen.getAllByTestId("portrait-topic")).toHaveLength(2);
    expect(screen.getAllByTestId("portrait-thread")).toHaveLength(1);
    expect(screen.getByTestId("portrait-tab")).not.toHaveTextContent("%");
  });

  it("renders the honest thin-data state rather than zeros when history is insufficient (AR-19)", async () => {
    // Field names as the daemon actually sends them (verified live 2026-09-20):
    // `tooThin` + `minimumQuestionsToCharacterize`, not a guessed `insufficientHistory`.
    stubMirrorResponses({ ...portrait, tooThin: true, totalQuestions: 3 }, listing);
    renderWithClient(<Portrait api={api} />);
    await waitFor(() => expect(screen.getByTestId("portrait-thin")).toBeInTheDocument());
    expect(screen.getByTestId("portrait-thin")).toHaveTextContent("Not enough history yet");
    expect(screen.getByTestId("portrait-thin")).toHaveTextContent("10 questions");
    expect(screen.getByTestId("portrait-thin")).toHaveTextContent("has 3");
    expect(screen.queryByTestId("portrait-sentences")).toBeNull();
    expect(screen.queryByTestId("portrait-numbers")).toBeNull();
  });

  it("surfaces the daemon's error message when the portrait cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "unknown", message: "store locked" } }), { status: 500 })),
    );
    renderWithClient(<Portrait api={api} />);
    await waitFor(() => expect(screen.getByText("store locked")).toBeInTheDocument());
    expect(screen.getByTestId("route-error")).toBeInTheDocument();
  });

  it("renders no free-text editing and no percentage numeral", async () => {
    const { container } = renderWithClient(<Portrait api={api} />);
    await screen.findByTestId("portrait-sentences");
    expect(container.querySelectorAll("input, textarea, select, [contenteditable]")).toHaveLength(0);
    expect(container).not.toHaveTextContent("%");
  });
});

describe("Rules tab — the buckets, and no authoring here (AR-18)", () => {
  beforeEach(() => {
    stubMirrorResponses(portrait, listing);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders each bucket with its rules and counts, in decision order", async () => {
    renderWithClient(<Rules api={api} />);
    await waitFor(() => expect(screen.getByTestId("bucket-awaitingApproval")).toBeInTheDocument());
    expect(screen.getByTestId("bucket-awaitingApproval")).toHaveTextContent("Waiting for you (2)");
    expect(screen.getByTestId("bucket-awaitingApproval")).toHaveTextContent("rule a1");
    expect(screen.getByTestId("bucket-weakSignals")).toHaveTextContent("Not sure yet (1)");
    expect(screen.getByTestId("bucket-weakSignals")).toHaveTextContent("rule w1");
    expect(screen.getByTestId("bucket-inconsistent")).toHaveTextContent("Contradicting each other (1)");
    const order = ["awaitingApproval", "weakSignals", "inconsistent", "approved", "rejected"].map((key) => screen.getByTestId(`bucket-${key}`));
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("collapses history buckets — reachable, not loud", async () => {
    renderWithClient(<Rules api={api} />);
    await waitFor(() => expect(screen.getByTestId("bucket-approved")).toBeInTheDocument());
    expect(screen.getByTestId("bucket-approved")).toHaveTextContent("In use (1)");
    expect(screen.getByTestId("bucket-rejected")).toHaveTextContent("Set aside (0)");
    expect(screen.getByTestId("bucket-approved").tagName).toBe("DETAILS");
    expect(screen.getByTestId("bucket-rejected").tagName).toBe("DETAILS");
    expect(screen.getByTestId("bucket-awaitingApproval").tagName).toBe("SECTION");
  });

  it("renders honest empty lines for a thin mirror instead of hiding sections (AR-19)", async () => {
    const empty: RuleReviewListing = { awaitingApproval: [], weakSignals: [], inconsistent: [], approved: [], rejected: [] };
    stubMirrorResponses(portrait, empty);
    renderWithClient(<Rules api={api} />);
    await waitFor(() => expect(screen.getByTestId("bucket-awaitingApproval")).toBeInTheDocument());
    expect(screen.getByTestId("bucket-awaitingApproval")).toHaveTextContent("Nothing to confirm.");
    expect(screen.getByTestId("bucket-weakSignals")).toHaveTextContent("Nothing it is unsure about.");
    expect(screen.getByTestId("bucket-inconsistent")).toHaveTextContent("No contradictions.");
    expect(screen.getByTestId("bucket-approved")).toHaveTextContent("Nothing in use yet.");
    expect(screen.getByTestId("bucket-rejected")).toHaveTextContent("Nothing set aside.");
  });

  it("surfaces the daemon's error message when the rules route fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "unknown", message: "store locked" } }), { status: 500 })),
    );
    renderWithClient(<Rules api={api} />);
    await waitFor(() => expect(screen.getAllByText("store locked").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("bucket-awaitingApproval")).toBeNull();
  });

  describe("authoring stays with the files, for the buckets this tab still owns (AR-18)", () => {
    it("renders no free-text editing anywhere on the Rules tab", async () => {
      const { container } = renderWithClient(<Rules api={api} />);
      await screen.findByTestId("bucket-awaitingApproval");
      expect(container.querySelectorAll("input, textarea, select, [contenteditable]")).toHaveLength(0);
      expect(screen.queryAllByRole("button").length).toBeGreaterThan(0); // approve / reject / promote are here…
      for (const button of screen.queryAllByRole("button")) {
        expect(button.textContent ?? "").not.toMatch(/\b(add|edit|write|record|new|save)\b/i); // …authoring is not
      }
    });

    it("carries no percentage numeral anywhere on the Rules tab", async () => {
      renderWithClient(<Rules api={api} />);
      await screen.findByTestId("bucket-awaitingApproval");
      expect(screen.getByTestId("rules-tab")).not.toHaveTextContent("%");
    });

    it("points at May do instead of listing never-answer rules here (#269)", async () => {
      renderWithClient(<Rules api={api} />);
      await screen.findByTestId("bucket-awaitingApproval");
      expect(screen.queryByTestId("refusals")).toBeNull();
      expect(screen.getByTestId("rules-never-answer-pointer")).toHaveTextContent("May do");
    });
  });
});

function pinnedAnswerFor(id: string, over?: Partial<PinnedAnswer>): PinnedAnswer {
  return {
    id,
    pattern: "vacation leave",
    answerText: "Ten days a year.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sourceLabel: null,
    ...over,
  };
}

describe("Rules tab — Pinned answers (duo#275): the owner's own overrides, read first", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders an honest empty state with none pinned yet", async () => {
    stubMirrorResponses(portrait, listing, refusals, []);
    renderWithClient(<Rules api={api} />);
    await waitFor(() => expect(screen.getByTestId("bucket-pinnedAnswers")).toBeInTheDocument());
    expect(screen.getByTestId("bucket-pinnedAnswers")).toHaveTextContent("Pinned answers (0)");
    expect(screen.getByTestId("bucket-pinnedAnswers")).toHaveTextContent("Nothing pinned yet.");
  });

  it("lists a pinned answer as the owner's own words (OwnerMessage), with its pattern and no free-text inputs by default", async () => {
    stubMirrorResponses(portrait, listing, refusals, [pinnedAnswerFor("pin1")]);
    renderWithClient(<Rules api={api} />);
    await waitFor(() => expect(screen.getByTestId("pinned-answer-card")).toBeInTheDocument());
    expect(screen.getByTestId("pinned-answer-card")).toHaveTextContent("Pinned to: vacation leave");
    expect(screen.getByTestId("pinned-answer-card")).toHaveTextContent("Ten days a year.");
    // The owner's own words — OwnerMessage's "You" attribution, never DuoMessage's.
    expect(screen.getByTestId("pinned-answer-card").querySelector('[data-testid="owner-message"]')).not.toBeNull();
    expect(screen.getByTestId("pinned-answer-card").querySelector('[data-testid="duo-message"]')).toBeNull();
    expect(screen.getByTestId("pinned-answer-card").querySelectorAll("input, textarea")).toHaveLength(0);
  });

  it("shows the sourceLabel when the daemon recorded one, and omits it when null", async () => {
    stubMirrorResponses(portrait, listing, refusals, [pinnedAnswerFor("pin1", { sourceLabel: "pinned from #general" })]);
    renderWithClient(<Rules api={api} />);
    await waitFor(() => expect(screen.getByTestId("pinned-answer-source")).toHaveTextContent("pinned from #general"));

    cleanup();
    stubMirrorResponses(portrait, listing, refusals, [pinnedAnswerFor("pin2", { sourceLabel: null })]);
    renderWithClient(<Rules api={api} />);
    await waitFor(() => expect(screen.getByTestId("pinned-answer-card")).toBeInTheDocument());
    expect(screen.queryByTestId("pinned-answer-source")).toBeNull();
  });

  it("Edit opens an editable form prefilled with the current pattern and wording", async () => {
    stubMirrorResponses(portrait, listing, refusals, [pinnedAnswerFor("pin1")]);
    renderWithClient(<Rules api={api} />);
    await waitFor(() => expect(screen.getByTestId("pinned-answer-card")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("pinned-answer-edit"));
    expect(await screen.findByTestId("pinned-answer-pattern-input")).toHaveValue("vacation leave");
    expect(screen.getByTestId("pinned-answer-text-input")).toHaveValue("Ten days a year.");
  });

  it("Unpin calls the daemon's delete route and settles to a confirmation", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          calls.push(url);
          return new Response(JSON.stringify({ deleted: true }), { status: 200 });
        }
        if (url.includes("/mirror/portrait")) return new Response(JSON.stringify(portrait), { status: 200 });
        if (url.includes("/mirror/refusals")) return new Response(JSON.stringify(refusals), { status: 200 });
        if (url.includes("/mirror/pinned-answers")) return new Response(JSON.stringify({ pinnedAnswers: [pinnedAnswerFor("pin1")] }), { status: 200 });
        if (url.includes("/review")) return new Response("[]", { status: 200 });
        return new Response(JSON.stringify(listing), { status: 200 });
      }),
    );
    renderWithClient(<Rules api={api} />);
    await waitFor(() => expect(screen.getByTestId("pinned-answer-remove")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("pinned-answer-remove"));
    await waitFor(() => expect(calls.some((url) => url.includes("/mirror/pinned-answers/pin1"))).toBe(true));
    await screen.findByTestId("pinned-answer-removed");
  });
});

// #269 moved never-answer rules off the files-only Rules tab into May do,
// owner-authored from the app — RefusalsSection itself, exercised directly.
describe("RefusalsSection — never-answer rules, owner-authored in the app (#269)", () => {
  beforeEach(() => {
    stubMirrorResponses(portrait, listing);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows each refusal with what is refused and the basis the owner wrote", async () => {
    renderWithClient(<RefusalsSection api={api} />);
    const rows = await screen.findAllByTestId("refusal");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Salary negotiations");
    expect(rows[0]).toHaveTextContent("Never speak for me on pay");
    expect(screen.getByTestId("refusals")).toHaveTextContent("Never answers (2)");
  });

  it("says so, rather than showing a blank, when a refusal carries no written reason", async () => {
    renderWithClient(<RefusalsSection api={api} />);
    const rows = await screen.findAllByTestId("refusal");
    expect(rows[1]).toHaveTextContent("Legal holds");
    expect(rows[1]).toHaveTextContent("No reason written.");
  });

  it("keeps the owner's multi-line reason as written", async () => {
    stubMirrorResponses(portrait, listing, { decided: true, refusals: [{ heading: "Pay", reason: "line one\nline two" }] });
    renderWithClient(<RefusalsSection api={api} />);
    const reason = await screen.findByTestId("refusal-reason");
    expect(reason.textContent).toBe("line one\nline two");
    expect(reason.className).toContain("whitespace-pre-wrap");
  });

  it("tells 'never asked' from 'asked, none' — the daemon's own decided flag (AR-19)", async () => {
    stubMirrorResponses(portrait, listing, { decided: false, refusals: [] });
    const { unmount } = renderWithClient(<RefusalsSection api={api} />);
    await waitFor(() => expect(screen.getByTestId("refusals-undecided")).toBeInTheDocument());
    expect(screen.getByTestId("refusals-undecided")).toHaveTextContent("haven't been asked");
    expect(screen.queryAllByTestId("refusal")).toHaveLength(0);
    unmount();

    stubMirrorResponses(portrait, listing, { decided: true, refusals: [] });
    renderWithClient(<RefusalsSection api={api} />);
    await waitFor(() => expect(screen.getByTestId("refusals-none")).toBeInTheDocument());
    expect(screen.getByTestId("refusals-none")).toHaveTextContent("none");
    expect(screen.queryByTestId("refusals-undecided")).toBeNull();
  });

  it("offers to add a rule right here instead of pointing at the terminal (#269 supersedes AR-18 for this one list)", async () => {
    stubMirrorResponses(portrait, listing, { decided: false, refusals: [] });
    renderWithClient(<RefusalsSection api={api} />);
    await waitFor(() => expect(screen.getByTestId("refusals-undecided")).toBeInTheDocument());
    expect(screen.getByTestId("refusals-undecided")).toHaveTextContent("Add a rule below");
    expect(screen.getByTestId("refusal-add")).toBeInTheDocument();
  });

  it("surfaces the daemon's error message when refusals cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/mirror/refusals")) {
          return new Response(JSON.stringify({ error: { code: "unknown", message: "refusals file unreadable" } }), { status: 500 });
        }
        return new Response(JSON.stringify(listing), { status: 200 });
      }),
    );
    renderWithClient(<RefusalsSection api={api} />);
    await waitFor(() => expect(screen.getByText("refusals file unreadable")).toBeInTheDocument());
  });

  it("merely reading the view makes no write — a rule is only ever saved by an explicit Save", async () => {
    renderWithClient(<RefusalsSection api={api} />);
    await screen.findAllByTestId("refusal");
    const calls = vi.mocked(fetch).mock.calls as unknown as [string, RequestInit | undefined][];
    expect(calls.some(([url]) => url === "http://test/mirror/refusals")).toBe(true);
    expect(calls.filter(([, init]) => init?.method && init.method !== "GET")).toEqual([]);
  });
});
