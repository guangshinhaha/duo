import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatternSection, RateSection } from "../src/profile/Patterns.js";
import { escalationPattern } from "../src/escalations/pattern.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord, EscalationDigestItem, EscalationUrgencyRate, SentEscalationDigest } from "../src/api/types.js";

/*
 * #54, in its new home: the Activity tab's "Where it runs out". The
 * Escalations page is gone; its two sections live on as `RateSection` and
 * `PatternSection` (src/profile/Patterns.tsx). What the duo keeps having to
 * ask about. The routes are digital-duo
 * #178's — `GET /escalations/history` (sent digests, oldest first, paged by
 * limit + an offset cursor) and `GET /escalations/rate` ({ total, urgent,
 * rate }). Each acceptance criterion of the issue is a test here, written
 * before the surface: the pattern reads at a glance, it leads to the fix
 * that already exists, and the rate carries no precision the data lacks.
 */

/** What the Activity tab's "Where it runs out" section mounts, in its order. */
function RunsOut({ api }: { api: DuoApiConfig }) {
  return (
    <>
      <RateSection api={api} />
      <PatternSection api={api} />
    </>
  );
}

const api: DuoApiConfig = { baseUrl: "http://test:7717", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function item(draftId: string, question: string, createdAt: string, overrides: Partial<EscalationDigestItem> = {}): EscalationDigestItem {
  return {
    draftId,
    question,
    threadContext: null,
    escalationReason: "This touches the payroll correction you said only you decide on.",
    createdAt,
    ...overrides,
  };
}

function digest(id: string, createdAt: string, items: EscalationDigestItem[]): SentEscalationDigest {
  return { id, createdAt, itemCount: items.length, items };
}

const PAY = "Should I approve Priya's backdated pay fix?";
const WIFI = "What's the wifi password?";
const VENDOR = "Can you follow up on the vendor invoice?";

/** Three digests: the pay fix escalated three times, the wifi twice, the vendor once. */
function digests(): SentEscalationDigest[] {
  return [
    digest("g1", "2026-09-10T08:00:00.000Z", [item("p1", PAY, "2026-09-09T10:00:00.000Z"), item("w1", WIFI, "2026-09-09T11:00:00.000Z")]),
    digest("g2", "2026-09-17T08:00:00.000Z", [item("p2", PAY, "2026-09-16T10:00:00.000Z"), item("v1", VENDOR, "2026-09-16T12:00:00.000Z")]),
    digest("g3", "2026-09-24T08:00:00.000Z", [item("p3", PAY, "2026-09-23T10:00:00.000Z"), item("w2", WIFI, "2026-09-23T15:00:00.000Z")]),
  ];
}

function draftFor(id: string, overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id,
    question: PAY,
    threadContext: null,
    draftText: null,
    escalated: true,
    escalationReason: "This touches the payroll correction you said only you decide on.",
    confidenceScore: 0.47,
    sources: [],
    createdAt: "2026-09-23T10:00:00.000Z",
    outcome: null,
    outcomeRecordedAt: null,
    sentText: null,
    refused: false,
    escalationThreshold: 0.55,
    provenance: { origin: "owner" },
    delivery: null,
    ...overrides,
  };
}

const rateFor = (over: Partial<EscalationUrgencyRate> = {}): EscalationUrgencyRate => ({ total: 12, urgent: 3, rate: 0.25, ...over });

type Handlers = {
  history?: (url: string) => Response | Promise<Response>;
  rate?: () => Response | Promise<Response>;
  draft?: (id: string) => Response | Promise<Response>;
  answer?: (id: string, body: unknown) => Response | Promise<Response>;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Serves the two #178 reads and, for the open-and-answer path, the draft and its answer route. */
function stub(handlers: Handlers = {}) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/escalations/history")) {
      return handlers.history ? handlers.history(url) : json(digests());
    }
    if (url.includes("/escalations/rate")) {
      return handlers.rate ? handlers.rate() : json(rateFor());
    }
    const answer = url.match(/\/drafts\/([^/]+)\/answer$/);
    if (answer && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return handlers.answer ? handlers.answer(answer[1]!, body) : json({ candidateId: "cand-1" });
    }
    const draft = url.match(/\/drafts\/([^/?]+)$/);
    if (draft && method === "GET") {
      return handlers.draft ? handlers.draft(draft[1]!) : json(draftFor(draft[1]!));
    }
    return json([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof stub>) => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${String(url)}`);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#54 AC1 — the pattern is visible: what is escalated most, and how often, at a glance", () => {
  it("leads with the most-escalated question and its count, then the rest in descending order", async () => {
    stub();
    renderWithClient(<RunsOut api={api} />);

    const groups = await screen.findAllByTestId("escalation-group");
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveTextContent(PAY);
    expect(groups[0]).toHaveTextContent("3×");
    expect(groups[1]).toHaveTextContent(WIFI);
    expect(groups[1]).toHaveTextContent("2×");
    expect(groups[2]).toHaveTextContent(VENDOR);
    expect(groups[2]).toHaveTextContent("1×");
  });

  it("draws each group's share of the escalations as a bar — width, not a numeral", async () => {
    stub();
    renderWithClient(<RunsOut api={api} />);
    await screen.findAllByTestId("escalation-group");

    // 3 of the 6 escalations in the digests, 2 of 6, 1 of 6.
    const fills = screen.getAllByTestId("escalation-group-share-fill").map((el) => (el as HTMLElement).style.width);
    expect(fills[0]).toBe("50%");
    expect(fills[1]).toBe(`${(2 / 6) * 100}%`);
    expect(fills[2]).toBe(`${(1 / 6) * 100}%`);
  });

  it("says what it counted: escalations across digests, over the period they span, grouped by identical wording", async () => {
    stub();
    renderWithClient(<RunsOut api={api} />);
    await screen.findAllByTestId("escalation-group");

    const scope = screen.getByTestId("escalation-scope");
    expect(scope).toHaveTextContent("6 escalations across 3 digests");
    expect(scope).toHaveTextContent(new Date("2026-09-09T10:00:00.000Z").toLocaleDateString());
    expect(scope).toHaveTextContent(new Date("2026-09-23T15:00:00.000Z").toLocaleDateString());
    expect(scope).toHaveTextContent(/identical question/i);
    // The digests never carry an urgent escalation — those interrupt live —
    // so the counts above do not claim to be all of them.
    expect(scope).toHaveTextContent(/urgent/i);
  });

  it("reads the daemon's own escalation reason under each group, verbatim", async () => {
    stub();
    renderWithClient(<RunsOut api={api} />);
    const groups = await screen.findAllByTestId("escalation-group");
    expect(within(groups[0]!).getByTestId("escalation-group-reason").textContent).toBe(
      "This touches the payroll correction you said only you decide on.",
    );
  });

  it("folds wording that differs only in case and spacing, and never merges questions that merely resemble each other", () => {
    const pattern = escalationPattern([
      digest("g1", "2026-09-10T08:00:00.000Z", [
        item("a", "Should I approve the fix?", "2026-09-09T10:00:00.000Z"),
        item("b", "  should i   approve the FIX? ", "2026-09-09T11:00:00.000Z"),
        item("c", "Should I approve the fix today?", "2026-09-09T12:00:00.000Z"),
      ]),
    ]);
    expect(pattern.groups.map((g) => g.count)).toEqual([2, 1]);
    expect(pattern.groups[0]!.draftIds).toEqual(["b", "a"]);
    // The group is worded by its most recent member, verbatim.
    expect(pattern.groups[0]!.question).toBe("  should i   approve the FIX? ");
  });

  it("counts a draft once even when two digests list it, and breaks equal counts by the more recent escalation", () => {
    const pattern = escalationPattern([
      digest("g1", "2026-09-10T08:00:00.000Z", [item("a", "Older question", "2026-09-01T00:00:00.000Z"), item("b", "Newer question", "2026-09-05T00:00:00.000Z")]),
      digest("g2", "2026-09-17T08:00:00.000Z", [item("a", "Older question", "2026-09-01T00:00:00.000Z")]),
    ]);
    expect(pattern.totalEscalations).toBe(2);
    expect(pattern.groups.map((g) => g.question)).toEqual(["Newer question", "Older question"]);
    expect(pattern.groups.map((g) => g.count)).toEqual([1, 1]);
  });

  it("pages through the whole history before it counts — limit 100, then the offset cursor — so no digest is left out of a count", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      digest(`p1-${i}`, `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00.000Z`, [item(`d1-${i}`, PAY, "2026-01-01T00:00:00.000Z")]),
    );
    const page2 = [digest("p2-0", "2026-06-01T00:00:00.000Z", [item("d2-0", PAY, "2026-05-31T00:00:00.000Z")])];
    const fetchMock = stub({
      history: (url) => (url.includes("cursor=100") ? json(page2) : json(page1)),
    });
    renderWithClient(<RunsOut api={api} />);

    const groups = await screen.findAllByTestId("escalation-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveTextContent("101×");
    expect(screen.getByTestId("escalation-scope")).toHaveTextContent("101 escalations across 101 digests");
    const historyCalls = calls(fetchMock).filter((c) => c.includes("/escalations/history"));
    expect(historyCalls).toEqual([
      "GET http://test:7717/escalations/history?limit=100",
      "GET http://test:7717/escalations/history?limit=100&cursor=100",
    ]);
  });

  it("opening the view is a read: it never assembles a digest (that POST is the send)", async () => {
    const fetchMock = stub();
    renderWithClient(<RunsOut api={api} />);
    await screen.findAllByTestId("escalation-group");
    await screen.findByTestId("escalation-rate");
    expect(calls(fetchMock).some((c) => c.startsWith("POST"))).toBe(false);
    expect(calls(fetchMock).some((c) => c.includes("/escalations/digest"))).toBe(false);
  });

  it("with no digest sent yet, says so instead of drawing an empty pattern", async () => {
    stub({ history: () => json([]) });
    renderWithClient(<RunsOut api={api} />);
    expect(await screen.findByTestId("escalations-empty")).toHaveTextContent(/no escalations have been batched into a digest/i);
    expect(screen.queryAllByTestId("escalation-group")).toHaveLength(0);
  });

  it("when an older page will not load, the counts say they are incomplete", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => digest(`p1-${i}`, "2026-01-01T00:00:00.000Z", [item(`d1-${i}`, PAY, "2026-01-01T00:00:00.000Z")]));
    stub({
      history: (url) => (url.includes("cursor=100") ? json({ error: { code: "internal", message: "boom" } }, 500) : json(page1)),
    });
    renderWithClient(<RunsOut api={api} />);
    expect(await screen.findByTestId("escalations-incomplete")).toHaveTextContent(/incomplete/i);
    expect((await screen.findAllByTestId("escalation-group"))[0]).toHaveTextContent("100×");
  });

  it("a history the daemon cannot serve is an error that says what to try, not an empty pattern", async () => {
    stub({ history: () => json({ error: { code: "internal", message: "store locked" } }, 500) });
    renderWithClient(<RunsOut api={api} />);
    expect(await screen.findByTestId("route-error")).toHaveTextContent("store locked");
  });
});

describe("#54 AC2 — it leads to the fix: answering a recurring escalation is in reach", () => {
  it("opening a group reads its most recent escalation and offers the answer that queues a standing-order candidate", async () => {
    const fetchMock = stub();
    renderWithClient(<RunsOut api={api} />);
    const groups = await screen.findAllByTestId("escalation-group");

    const open = within(groups[0]!).getByRole("button", { name: /open/i });
    expect(open).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");

    // The group's latest member is p3 (2026-09-23), not the first one digested.
    const card = await screen.findByTestId("draft-card");
    expect(calls(fetchMock)).toContain("GET http://test:7717/drafts/p3");
    expect(card).toHaveTextContent(PAY);
    expect(within(card).getByLabelText(/answer it yourself/i)).toBeInTheDocument();
  });

  it("answering from the group posts to POST /drafts/:id/answer and reports the queued candidate", async () => {
    const fetchMock = stub();
    renderWithClient(<RunsOut api={api} />);
    const groups = await screen.findAllByTestId("escalation-group");
    fireEvent.click(within(groups[0]!).getByRole("button", { name: /open/i }));

    const card = await screen.findByTestId("draft-card");
    fireEvent.change(within(card).getByLabelText(/answer it yourself/i), { target: { value: "Yes — approve it, I've seen the ticket." } });
    fireEvent.click(within(card).getByRole("button", { name: "Answer" }));

    expect(await screen.findByTestId("answer-confirmation")).toHaveTextContent("Queued as a standing-order candidate.");
    const answerCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/drafts/p3/answer"));
    expect(answerCall?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(answerCall?.[1]?.body))).toEqual({ answer: "Yes — approve it, I've seen the ticket." });
  });

  it("a refusal opened from here offers no answer — the same rule as the drafts it came from", async () => {
    stub({ draft: (id) => json(draftFor(id, { refused: true, escalationReason: "Your duo refused this one." })) });
    renderWithClient(<RunsOut api={api} />);
    const groups = await screen.findAllByTestId("escalation-group");
    fireEvent.click(within(groups[0]!).getByRole("button", { name: /open/i }));
    const card = await screen.findByTestId("draft-card");
    expect(within(card).queryByLabelText(/answer it yourself/i)).toBeNull();
  });

  it("a draft this daemon no longer has says so plainly", async () => {
    stub({ draft: () => json({ error: { code: "not_found", message: "No such draft." } }, 404) });
    renderWithClient(<RunsOut api={api} />);
    const groups = await screen.findAllByTestId("escalation-group");
    fireEvent.click(within(groups[0]!).getByRole("button", { name: /open/i }));
    expect(await screen.findByText("This draft is not on this duo.")).toBeInTheDocument();
  });

  it("closing a group puts it away again, and the open control is a real touch target", async () => {
    stub();
    renderWithClient(<RunsOut api={api} />);
    const groups = await screen.findAllByTestId("escalation-group");
    const open = within(groups[0]!).getByRole("button", { name: /open/i });
    expect(open.className).toMatch(/min-h-11/);
    fireEvent.click(open);
    await screen.findByTestId("draft-card");
    fireEvent.click(open);
    await waitFor(() => expect(screen.queryByTestId("draft-card")).toBeNull());
    expect(open).toHaveAttribute("aria-expanded", "false");
  });
});

describe("#54 AC3 — the rate is honest: counts and proportions the data supports, never an invented percentage", () => {
  it("states the daemon's counts, and draws the daemon's own rate as a bar", async () => {
    stub({ rate: () => json(rateFor({ total: 12, urgent: 3, rate: 0.25 })) });
    renderWithClient(<RunsOut api={api} />);

    const rate = await screen.findByTestId("escalation-rate");
    expect(rate).toHaveTextContent("3 of 12 escalations were urgent");
    // The rate is the wire's own figure — drawn, not recomputed.
    expect((screen.getByTestId("escalation-rate-fill") as HTMLElement).style.width).toBe("25%");
  });

  it("never prints a percentage or a decimal anywhere on the screen", async () => {
    stub({ rate: () => json(rateFor({ total: 3, urgent: 1, rate: 1 / 3 })) });
    const { container } = renderWithClient(<RunsOut api={api} />);
    await screen.findByTestId("escalation-rate");
    await screen.findAllByTestId("escalation-group");

    const text = container.textContent ?? "";
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/0\.\d/);
    expect(text).not.toMatch(/33/);
    // The counts are all it says.
    expect(screen.getByTestId("escalation-rate")).toHaveTextContent("1 of 3 escalations were urgent");
  });

  it("agrees with itself in the singular", async () => {
    stub({ rate: () => json(rateFor({ total: 1, urgent: 1, rate: 1 })) });
    renderWithClient(<RunsOut api={api} />);
    expect(await screen.findByTestId("escalation-rate")).toHaveTextContent("1 of 1 escalation was urgent");
  });

  it("with nothing classified yet, there is no rate to draw — a zero would read as a measurement", async () => {
    stub({ rate: () => json(rateFor({ total: 0, urgent: 0, rate: 0 })) });
    renderWithClient(<RunsOut api={api} />);
    const rate = await screen.findByTestId("escalation-rate");
    expect(rate).toHaveTextContent(/no escalations classified yet/i);
    expect(screen.queryByTestId("escalation-rate-track")).toBeNull();
  });

  it("does not stretch a small denominator into a trend: it names that the rate covers every escalation, urgent ones included, and is not the digest's count", async () => {
    stub();
    renderWithClient(<RunsOut api={api} />);
    const rate = await screen.findByTestId("escalation-rate");
    expect(rate).toHaveTextContent(/every escalation/i);
    expect(rate).toHaveTextContent(/live/i);
  });

  it("a rate that will not load leaves the pattern standing, and says the rate is missing", async () => {
    stub({ rate: () => json({ error: { code: "internal", message: "rate store locked" } }, 500) });
    renderWithClient(<RunsOut api={api} />);
    expect((await screen.findAllByTestId("escalation-group")).length).toBe(3);
    expect(await screen.findByTestId("escalation-rate-error")).toHaveTextContent("rate store locked");
  });

  it("a payload that is not the rate's documented shape draws no bar, and says so rather than showing a broken one", async () => {
    stub({ rate: () => json([]) });
    renderWithClient(<RunsOut api={api} />);
    await screen.findAllByTestId("escalation-group");
    expect(await screen.findByTestId("escalation-rate-error")).toHaveTextContent(/wasn't in a shape/i);
    expect(screen.queryByTestId("escalation-rate-fill")).toBeNull();
    expect(screen.queryByTestId("escalation-rate")).toBeNull();
  });
});
