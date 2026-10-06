import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { Activity } from "../src/profile/Activity.js";
import { Knows } from "../src/profile/Knows.js";
import { MayDo } from "../src/profile/MayDo.js";
import { Portrait, portraitSentences } from "../src/profile/Portrait.js";
import { Rules } from "../src/profile/Rules.js";
import { LEVEL_WORDS, TIER_WORDS, plainAsker, relativeDay } from "../src/profile/words.js";

/*
 * The duo's profile (#146): Portrait, Knows, May do, Rules and Activity, in an
 * owner's words. Every fact the old Mirror, Knowledge, Trust, Audit and
 * Escalations screens showed is reachable from here; the daemon's codes are
 * not in the default views.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

const CODES = /\bT[0-4]\b|superseded|consistency|stranger:|colleague:/i;

function mount(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>);
}

const portrait = (over: Record<string, unknown> = {}) => ({
  totalQuestions: 214,
  periodStart: "2026-03-01T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
  topicBreakdown: [
    { topicId: "a", label: "scheduling", count: 73, share: 0.34 },
    { topicId: "b", label: "money", count: 45, share: 0.21 },
    { topicId: "c", label: "hiring", count: 26, share: 0.12 },
    { topicId: "d", label: "design", count: 17, share: 0.08 },
    { topicId: "e", label: "leave", count: 12, share: 0.06 },
  ],
  topFiveShare: 0.81,
  busiestThreads: [{ threadId: "vendor-renewal", count: 9, share: 0.04 }],
  tooThin: false,
  minimumQuestionsToCharacterize: 10,
  ...over,
});
const rule = (id: string, text: string) => ({ id, topicId: "t", text, status: "confirmed", supportCount: 7, consistency: 0.9, createdAt: "2026-01-01T00:00:00.000Z", lastConfirmedAt: null, reviewStatus: "pending", origin: "derived" });
const knowledge = (over: Record<string, unknown> = {}) => ({
  records: { total: 312, bySource: { slack: 288, markdown: 24 } },
  lastImport: { runAt: "2026-09-01T10:00:00.000Z", written: 24, alreadyPresent: 288, skippedDmConversations: 4 },
  corpus: { tooThin: false, minimumQuestionsToCharacterize: 10, totalQuestions: 214, periodStart: "2026-03-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", topicBreakdown: [{ topicId: "a", label: "scheduling", count: 73, share: 0.34 }] },
  rules: { byReviewStatus: { pending: 1, approved: 2, rejected: 0, superseded: 0 } },
  providers: { inference: "openrouter/auto", embedding: { name: "ollama", model: "nomic" } },
  sharedUsage: { totalQuestions: 20, distinctAskers: 4, repeatAskers: 1, answeredCount: 14, declinedCount: 2, answerRate: 0.7, escalationRate: 0.1, weeklyTrend: [], gaps: [{ question: "deploy freeze dates", count: 3 }], lastAskedAt: null, daysSinceLastAsk: null, abandoned: false, summary: "The shared duo is being used." },
  ...over,
});
const audit = (id: string, askerRef: string, createdAt: string, over: Record<string, unknown> = {}) => ({ id, createdAt, question: `question from ${askerRef}`, askerRef, askerResolved: true, declined: false, answerText: "the answer", ...over });

/** A daemon with each read the profile makes; POSTs recorded. */
function stub(routes: Record<string, unknown>) {
  const posts: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        const custom = routes[`POST ${new URL(url).pathname}`];
        return new Response(JSON.stringify(custom ?? {}), { status: 200 });
      }
      const path = new URL(url).pathname;
      const hit = Object.entries(routes).find(([key]) => !key.startsWith("POST ") && path.endsWith(key));
      return new Response(JSON.stringify(hit ? hit[1] : []), { status: 200 });
    }),
  );
  return { posts };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("words — the daemon's codes, in an owner's terms", () => {
  it("names the three levels and four tiers", () => {
    expect(LEVEL_WORDS).toEqual({ ask: "Always asks you", approve: "Drafts for you", auto: "Answers on its own" });
    expect(Object.values(TIER_WORDS).join(" ")).not.toMatch(/\bT\d\b/);
  });
  it("says a day the way a person would", () => {
    const now = new Date(2026, 8, 26, 12);
    expect(relativeDay(new Date(2026, 8, 26, 1).toISOString(), now)).toBe("Today");
    expect(relativeDay(new Date(2026, 8, 25, 23).toISOString(), now)).toBe("Yesterday");
    expect(relativeDay(new Date(2026, 8, 22, 9).toISOString(), now)).toMatch(/^[A-Za-z]+$/); // a weekday
    expect(relativeDay(new Date(2026, 7, 1).toISOString(), now)).toMatch(/\d/); // a date
  });
  it("names an asker by their name, and a bare link as someone with your link", () => {
    expect(plainAsker("colleague:Rae", true)).toBe("Rae");
    expect(plainAsker("stranger:link", true)).toBe("Someone with your link");
    expect(plainAsker("colleague:Jun", false)).toBe("Someone with your link");
    expect(plainAsker("weird", true)).toBe("Someone with your link");
  });
});

describe("Portrait — who it thinks you are, in words", () => {
  it("builds its sentences from the daemon's own counts, and says a proportion in words, never a percentage", () => {
    const sentences = portraitSentences(portrait() as never);
    expect(sentences).toEqual([
      "You were asked about scheduling 73 times.",
      "Then money (45) and hiring (26).",
      "Your top five topics cover most of everything you're asked.",
      "The busiest thread was vendor-renewal, with 9 questions.",
    ]);
    expect(sentences.join(" ")).not.toContain("%");
    expect(portraitSentences(portrait({ topFiveShare: 0.3 }) as never)[2]).toContain("under half");
    expect(portraitSentences(portrait({ topicBreakdown: [{ topicId: "a", label: "leave", count: 1, share: 1 }], busiestThreads: [] }) as never)).toEqual(["You were asked about leave once."]);
  });

  it("shows the sentences, where they came from, the numbers one tap away, and the rules waiting", async () => {
    stub({ "/mirror/portrait": portrait(), "/mirror/rules": { awaitingApproval: [rule("r1", "x")], weakSignals: [], inconsistent: [], approved: [], rejected: [] } });
    mount(<Portrait api={api} />);
    // The figures are their own spans (so they can count up), but the sentence reads exactly as the daemon's counts say it.
    expect(await screen.findByTestId("portrait-sentences")).toHaveTextContent("You were asked about scheduling 73 times.");
    expect(screen.getByTestId("portrait-source")).toHaveTextContent("214 questions");
    const numbers = screen.getByTestId("portrait-numbers");
    expect(within(numbers).getAllByTestId("portrait-topic")).toHaveLength(5);
    expect(within(numbers).getByTestId("portrait-thread")).toHaveTextContent("vendor-renewal");
    expect(await screen.findByTestId("portrait-rules-link")).toHaveTextContent("1 rule is waiting for you.");
  });

  it("a thin history says so in words instead of dressing it up", async () => {
    stub({ "/mirror/portrait": portrait({ tooThin: true, totalQuestions: 4 }) });
    mount(<Portrait api={api} />);
    expect(await screen.findByTestId("portrait-thin")).toHaveTextContent("starts to get a picture of you at 10 questions, and it has 4");
    expect(screen.queryByTestId("portrait-sentences")).toBeNull();
  });
});

describe("Knows — what it has read, where it listens", () => {
  it("keeps every fact of Knowledge and Channels, under headings an owner would use", async () => {
    stub({ "/knowledge": knowledge(), "/channels": [{ kind: "slack", label: "Slack", state: "connected", lastActivityAt: null, muted: false }] });
    mount(<Knows api={api} />);
    await screen.findByTestId("knows-tab");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(["What it has read", "What people ask you", "Where it listens", "What it runs on", "When others ask it"]));
    expect(headings.join(" ")).not.toMatch(/Records|Corpus|Providers|Shared usage/);
    // every fact: counts by source (the daemon's own names), the last import, the import door…
    expect(screen.getByTestId("knows-read")).toHaveTextContent("It has read 312 of your messages and notes.");
    expect(screen.getAllByTestId("record-source").map((el) => el.textContent)).toEqual(["slack288", "markdown24"]);
    expect(screen.getByTestId("last-import")).toHaveTextContent("Last import");
    expect(screen.getByRole("link", { name: "Import more history" })).toHaveAttribute("href", "#onboarding");
    // …what people ask, the connection and its mute…
    expect(screen.getByTestId("knowledge-topic")).toHaveTextContent("scheduling");
    expect(await screen.findByTestId("channel")).toHaveTextContent("Slack");
    // …what it runs on, and how it did when others asked, verbatim.
    expect(screen.getByTestId("inference-provider")).toHaveTextContent("Answering with openrouter/auto.");
    expect(screen.getByTestId("embedding-provider")).toHaveTextContent("Searching your history with ollama (nomic).");
    expect(screen.getByTestId("shared-usage-summary")).toHaveTextContent("The shared duo is being used.");
    expect(screen.getByTestId("usage-gap")).toHaveTextContent("deploy freeze dates");
  });

  it("a payload that is not the documented shape reads as still asking, never a crash", async () => {
    stub({ "/knowledge": [] });
    mount(<Knows api={api} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId("knows-tab")).toBeNull();
  });
});

describe("May do — what it handles on its own, in plain levels", () => {
  const grid = [
    { topicId: "s", topicLabel: "Scheduling", tier: "T0", level: "auto", source: "earned", stale: false },
    { topicId: "h", topicLabel: "Hiring", tier: "T1", level: "ask", source: "granted", stale: true },
  ];

  it("says each topic's level in words, with no codes, and shows what is external or irreversible as never on its own", async () => {
    stub({ "/trust/grid": grid });
    const view = mount(<MayDo api={api} />);
    await screen.findByTestId("may-list");
    const rows = screen.getAllByTestId("may-row");
    expect(rows[0]).toHaveTextContent("Scheduling");
    expect(rows[0]).toHaveTextContent("Answers on its own");
    expect(rows[0]).toHaveTextContent("For answering questions · it earned this");
    expect(rows[1]).toHaveTextContent("Always asks you");
    expect(rows[1]).toHaveTextContent("you granted this · not seen lately");
    expect(view.container.textContent).not.toMatch(CODES);
    expect(screen.getByTestId("may-never")).toHaveTextContent("never on its own. You confirm each one.");
  });

  it("has nothing to flip: no dropdown, no switch — a level changes by accepting an offer or telling your duo", async () => {
    stub({ "/trust/grid": grid });
    mount(<MayDo api={api} />);
    await screen.findByTestId("may-list");
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(within(screen.getByTestId("may-list")).queryByRole("button")).toBeNull();
    // The kinds of thing you may allow are radios in plain words — and there is no fifth.
    const kinds = within(screen.getByRole("group", { name: "On its own, it may" })).getAllByRole("radio");
    expect(kinds).toHaveLength(4);
    expect(screen.getByLabelText("draft replies")).toBeChecked();
    expect(screen.queryByLabelText(/external|irreversible/i)).toBeNull();
  });

  it("an offer set aside from the chat is still here to answer", async () => {
    stub({ "/trust/grid": grid, "/trust/promotions": [{ topicId: "s", topicLabel: "Scheduling", tier: "T0", currentLevel: "approve", offeredLevel: "auto", cleanStreak: 12 }] });
    mount(<MayDo api={api} />);
    expect(await screen.findByTestId("offer-card")).toHaveTextContent("You've sent my last 12 Scheduling drafts without an edit.");
  });

  it("says what earning looks like when nothing is earned yet", async () => {
    stub({ "/trust/grid": [] });
    mount(<MayDo api={api} />);
    expect(await screen.findByTestId("may-empty")).toHaveTextContent("Nothing earned yet.");
  });

  it("falls back to the topic's id when the daemon sent no label — never an empty name", async () => {
    stub({ "/trust/grid": [{ topicId: "vendor-access", tier: "T1", level: "ask", source: "earned", stale: false }] });
    mount(<MayDo api={api} />);
    expect(await screen.findByTestId("may-topic")).toHaveTextContent("vendor-access");
  });

  it("says why when the grid cannot be read, in the daemon's own words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "unknown", message: "store locked" } }), { status: 500 })));
    mount(<MayDo api={api} />);
    expect(await screen.findByText("store locked")).toBeInTheDocument();
  });

  it("tells your duo in words — posts the description and the chosen kind, and reports what happened", async () => {
    const { posts } = stub({ "/trust/grid": grid, "POST /trust/grant": { status: "applied", topicId: "d", topicLabel: "deploy access", tier: "T1" } });
    mount(<MayDo api={api} />);
    await screen.findByTestId("may-list");
    fireEvent.change(screen.getByLabelText("What it may handle"), { target: { value: "questions about deploy access" } });
    fireEvent.click(screen.getByLabelText("do reversible things"));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(posts).toEqual([{ url: "http://test/trust/grant", body: { scopeText: "questions about deploy access", tier: "T2" } }]));
    expect(await screen.findByTestId("grant-outcome")).toHaveTextContent('Done: your duo may now do reversible things on "deploy access".');
  });

  it("never guesses: an ambiguous description asks which topic, and a refusal refuses in the owner's own words", async () => {
    const { posts } = stub({ "/trust/grid": grid, "POST /trust/grant": { status: "ambiguous", candidates: [{ topicId: "x", label: "Deploy access", score: 0.6 }, { topicId: "y", label: "Deploy freezes", score: 0.5 }] } });
    mount(<MayDo api={api} />);
    await screen.findByTestId("may-list");
    fireEvent.change(screen.getByLabelText("What it may handle"), { target: { value: "deploys" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    const picks = await screen.findAllByTestId("grant-candidate");
    expect(picks.map((pick) => pick.textContent)).toEqual(["Deploy access", "Deploy freezes"]);
    fireEvent.click(picks[1]!);
    await waitFor(() => expect(posts[1]?.body).toEqual({ scopeText: "deploys", tier: "T1", topicId: "y" }));
    cleanup();

    stub({ "/trust/grid": grid, "POST /trust/grant": { status: "refused", refusal: { heading: "Comp", reason: "Never on comp." } } });
    mount(<MayDo api={api} />);
    await screen.findByTestId("may-list");
    fireEvent.change(screen.getByLabelText("What it may handle"), { target: { value: "salary questions" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByTestId("grant-outcome")).toHaveTextContent("Refused — it conflicts with something you told your duo to refuse: Comp. Never on comp.");
  });
});

describe("Rules — your standing orders and where they came from", () => {
  it("groups them in an owner's words, the ones waiting first, with the counts in a line", async () => {
    stub({
      "/mirror/rules": { awaitingApproval: [rule("r1", "Prod exceptions: say no.")], weakSignals: [rule("r2", "weak")], inconsistent: [], approved: [rule("r3", "a"), rule("r4", "b")], rejected: [] },
      "/mirror/refusals": { decided: true, refusals: [{ heading: "Comp", reason: "Never speak for me on comp." }] },
      "/review": [{ id: "c1", kind: "style", draftId: "d", question: "leave?", draftText: "Friday", sentText: "Friday, back Monday", status: "pending", createdAt: "2026-01-01T00:00:00.000Z", reviewedAt: null }],
    });
    const view = mount(<Rules api={api} />);
    await screen.findByTestId("rules-tab");
    expect(screen.getByTestId("rules-counts")).toHaveTextContent("2 in use · 1 waiting for you · 0 set aside");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual(expect.arrayContaining(["Waiting for you (1)", "Not sure yet (1)", "Contradicting each other (0)", "From your edits (1)"]));
    expect(within(screen.getByTestId("bucket-awaitingApproval")).getByTestId("rule-card")).toHaveTextContent("Prod exceptions: say no.");
    expect(screen.getByTestId("bucket-approved").tagName).toBe("DETAILS"); // the record, not the work
    expect(within(screen.getByTestId("rules-from-edits")).getByTestId("candidate")).toHaveTextContent("leave?");
    // #269: never-answer rules are limits, kept in May do; Rules points there rather than listing them.
    expect(screen.queryByTestId("refusals")).toBeNull();
    expect(screen.getByTestId("rules-never-answer-pointer")).toHaveTextContent("May do");
    expect(view.container.textContent).not.toMatch(/superseded|inconsistent\b|Awaiting your approval/);
  });
});

describe("Activity — what it did, people first", () => {
  const now = new Date();
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, 12).toISOString();

  it("reads as a person would say it — who, what became of it, when — with the exact record one tap away", async () => {
    stub({
      "/audit": [
        audit("a", "colleague:Rae", day(0)),
        audit("b", "colleague:Jun", day(1), { answerText: "The duo passed this one to the owner. You'll hear back from them directly." }),
        audit("c", "stranger:link", day(2), { declined: true, answerText: "The duo won't answer that one." }),
      ],
    });
    mount(<Activity api={api} />);
    await screen.findByTestId("activity-list");
    const summaries = screen.getAllByTestId("activity-summary").map((el) => el.textContent);
    // Newest first.
    expect(summaries[0]).toBe("Someone with your link · refused — a boundary you set · " + relativeDay(day(2)));
    expect(summaries[1]).toBe("Jun · passed to you · Yesterday");
    expect(summaries[2]).toBe("Rae · answered for you · Today");
    // The default view has none of the daemon's asker references; the detail keeps them exact.
    expect(summaries.join(" ")).not.toMatch(CODES);
    const details = screen.getAllByTestId("activity-record");
    expect(details[2]).toHaveTextContent("colleague:Rae");
    // Only the duo's answer is behind the duo's line; the asker's question is not.
    expect(within(screen.getAllByTestId("activity-answer")[0]!).getByTestId("audit-answer")).toHaveTextContent("The duo won't answer that one.");
    expect(screen.getAllByTestId("activity-answer")[0]).toHaveAttribute("data-duo-line", "refused");
  });

  it("says nothing was asked yet, and keeps 'Where it runs out' beneath", async () => {
    stub({ "/audit": [], "/escalations/rate": { total: 4, urgent: 1, rate: 0.25 } });
    mount(<Activity api={api} />);
    expect(await screen.findByTestId("activity-empty")).toHaveTextContent("No one has asked your duo anything yet.");
    const runsOut = screen.getByTestId("activity-runs-out");
    expect(within(runsOut).getByRole("heading", { name: "Where it runs out" })).toBeInTheDocument();
    expect(await within(runsOut).findByTestId("escalation-rate")).toHaveTextContent("1 of 4 escalations were urgent");
  });

  it("marks an asker it could not resolve rather than passing the raw reference off as a name — and the asker's question is never the owner's", async () => {
    stub({ "/audit": [audit("r", "colleague:Rae", day(1)), audit("u", "someone@other.domain", day(0), { askerResolved: false })] });
    mount(<Activity api={api} />);
    await screen.findByTestId("activity-list");
    const records = screen.getAllByTestId("activity-record");
    // The daemon lists oldest first; the tab reads newest first.
    expect(records[0]).toHaveTextContent("someone@other.domain · unresolved");
    expect(records[1]).not.toHaveTextContent("unresolved");
    expect(screen.queryAllByTestId("owner-message")).toHaveLength(0);
  });

  it("says why when the activity cannot be read, in the daemon's own words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "unknown", message: "store locked" } }), { status: 500 })));
    mount(<Activity api={api} />);
    expect(await screen.findByText("store locked")).toBeInTheDocument();
  });
});
