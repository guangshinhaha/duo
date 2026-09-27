import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { clearPacing, dayOf, isSetAside, setAside, weekOf } from "../src/cardPacing.js";
import { DigestCard, NoticeCard, OfferCard, RulesCard, TrainingCards, digestOf, offerSentence } from "../src/components/TrainingCards.js";
import { Duo } from "../src/routes/Duo.js";

/*
 * Training in the background (#145): rules to confirm, offers, notices, the
 * weekly digest and confirmations arrive as a few cards in your duo's chat —
 * batched, paced, and never silent about a decision.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

const candidate = (id: string) => ({
  id,
  kind: "style",
  draftId: `d-${id}`,
  question: `question ${id}`,
  draftText: "within the hour",
  sentText: "in about ten minutes",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  reviewedAt: null,
});
const rule = (id: string, text = `rule ${id}`) => ({
  id,
  topicId: "t",
  text,
  status: "confirmed",
  supportCount: 7,
  consistency: 0.9,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastConfirmedAt: null,
  reviewStatus: "pending",
  origin: "derived",
});
const offer = (over: Record<string, unknown> = {}) => ({
  topicId: "deploy",
  topicLabel: "deploy-access",
  tier: "T1",
  currentLevel: "approve",
  offeredLevel: "auto",
  cleanStreak: 12,
  ...over,
});
const auditAt = (id: string, createdAt: string, declined = false) => ({
  id,
  createdAt,
  question: "q",
  askerRef: "a",
  askerResolved: true,
  declined,
  answerText: "t",
});

interface World {
  review: unknown;
  rules: unknown;
  promotions: unknown;
  audit: unknown;
  t4: unknown;
}

/** A daemon with each of the five reads the cards make, and every POST recorded. */
function stubDaemon(world: Partial<World> = {}) {
  const w: World = { review: [], rules: { awaitingApproval: [] }, promotions: [], audit: [], t4: [], ...world };
  const posts: Array<{ url: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({}), { status: 200 });
    }
    const path = new URL(url).pathname;
    const body = path.endsWith("/review")
      ? w.review
      : path.endsWith("/mirror/rules")
        ? w.rules
        : path.endsWith("/trust/promotions")
          ? w.promotions
          : path.endsWith("/audit")
            ? w.audit
            : path.endsWith("/actions/t4/pending")
              ? w.t4
              : [];
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posts };
}

function mount(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe("cardPacing — a card set aside stays aside for its day or week", () => {
  it("names days and weeks stably, and a week by its Monday", () => {
    expect(dayOf(new Date(2026, 8, 26))).toBe("2026-09-26");
    expect(weekOf(new Date(2026, 8, 26))).toBe("2026-09-21"); // Saturday → that week's Monday
    expect(weekOf(new Date(2026, 8, 21))).toBe("2026-09-21"); // Monday is its own
    expect(weekOf(new Date(2026, 8, 27))).toBe("2026-09-21"); // Sunday belongs to the week that began before it
  });

  it("holds a card for the rest of the day, and lets it back tomorrow", () => {
    setAside("rules", "day", new Date(2026, 8, 26, 9));
    expect(isSetAside("rules", new Date(2026, 8, 26, 23))).toBe(true);
    expect(isSetAside("rules", new Date(2026, 8, 27, 0, 1))).toBe(false);
    expect(isSetAside("digest", new Date(2026, 8, 26))).toBe(false);
  });

  it("holds the digest for the rest of the week", () => {
    setAside("digest", "week", new Date(2026, 8, 22));
    expect(isSetAside("digest", new Date(2026, 8, 27))).toBe(true);
    expect(isSetAside("digest", new Date(2026, 8, 28))).toBe(false);
  });

  it("is a courtesy that can be lost: a corrupt or missing store means the card shows again", () => {
    localStorage.setItem("duo.card-pacing", "{not json");
    expect(isSetAside("rules")).toBe(false);
    localStorage.setItem("duo.card-pacing", JSON.stringify(["array"]));
    expect(isSetAside("rules")).toBe(false);
    setAside("rules", "day");
    clearPacing();
    expect(isSetAside("rules")).toBe(false);
  });
});

describe("RulesCard — what your duo wants confirmed, batched", () => {
  it("says how many things and shows the first three with where each came from, then how many more", async () => {
    stubDaemon({ review: [candidate("c1"), candidate("c2")], rules: { awaitingApproval: [rule("r1", "Prod exceptions: say no."), rule("r2")] } });
    mount(<RulesCard api={api} />);
    expect(await screen.findByText("I've got 4 things to check with you")).toBeInTheDocument();
    const items = within(screen.getByTestId("rules-card-items")).getAllByRole("listitem");
    expect(items).toHaveLength(4); // three items and "and 1 more"
    expect(items[0]).toHaveTextContent('You changed "within the hour" to "in about ten minutes".');
    expect(items[3]).toHaveTextContent("and 1 more");
    // The duo's own line, in Signal — a decision is wanted.
    expect(screen.getByTestId("rules-card-line")).toHaveAttribute("data-duo-line", "signal");
  });

  it("approves nothing until asked, then approves every one in one explicit tap — each through its own route", async () => {
    const { posts } = stubDaemon({ review: [candidate("c1")], rules: { awaitingApproval: [rule("r1")] } });
    mount(<RulesCard api={api} />);
    await screen.findByTestId("rules-card");
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByTestId("rules-approve"));
    await waitFor(() => expect(posts.map((post) => post.url).sort()).toEqual(["http://test/mirror/rules/r1/approve", "http://test/review/c1/approve"]));
  });

  it("'Not now' sets it aside for the day, and it stays aside on the next visit", async () => {
    stubDaemon({ review: [candidate("c1")] });
    const view = mount(<RulesCard api={api} />);
    fireEvent.click(await screen.findByTestId("rules-not-now"));
    expect(screen.queryByTestId("rules-card")).toBeNull();
    expect(isSetAside("rules")).toBe(true);
    view.unmount();
    mount(<RulesCard api={api} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId("rules-card")).toBeNull();
  });

  it("'Review one by one' opens the profile's Rules", async () => {
    stubDaemon({ review: [candidate("c1")] });
    mount(<RulesCard api={api} />);
    expect(await screen.findByTestId("rules-review")).toHaveAttribute("href", "#duo/profile/rules");
  });

  it("a single thing reads in the singular, and nothing waiting is no card at all", async () => {
    stubDaemon({ review: [candidate("c1")] });
    mount(<RulesCard api={api} />);
    expect(await screen.findByText("I've got 1 thing to check with you")).toBeInTheDocument();
    expect(screen.getByTestId("rules-approve")).toHaveTextContent("Approve");
    expect(screen.getByTestId("rules-approve")).not.toHaveTextContent("all");
    cleanup();
    stubDaemon();
    mount(<RulesCard api={api} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId("rules-card")).toBeNull();
  });

  it("a payload that is not the documented shape is nothing to show — it never becomes a card", async () => {
    stubDaemon({ review: [{ id: 5 }, "oops", null, { id: "x", kind: "other" }], rules: { awaitingApproval: [{ text: 1 }] } });
    mount(<RulesCard api={api} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId("rules-card")).toBeNull();
  });
});

describe("OfferCard — earned trust arrives as a question, and changes nothing until you answer", () => {
  it("says what the streak was and what it proposes, in plain words", () => {
    expect(offerSentence(offer() as never)).toEqual({
      title: "You've sent my last 12 deploy-access drafts without an edit.",
      body: "Let me answer these on my own? I'll tell you each time, and go back to asking the moment you correct me.",
    });
    expect(offerSentence(offer({ offeredLevel: "approve", cleanStreak: 1, topicLabel: undefined }) as never).title).toBe("You've sent my last 1 deploy draft without an edit.");
    expect(offerSentence(offer({ offeredLevel: "approve" }) as never).body).toContain("draft these for you without checking first");
  });

  it("accepts only on 'Let it answer', declines only on 'Keep asking me' — the daemon's own promotion route, nothing on render", async () => {
    const { posts } = stubDaemon();
    const view = mount(<OfferCard api={api} offer={offer() as never} />);
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByTestId("offer-accept"));
    await waitFor(() => expect(posts).toEqual([{ url: "http://test/trust/promotions/deploy/T1", body: { decision: "accept" } }]));
    view.unmount();

    posts.length = 0;
    mount(<OfferCard api={api} offer={offer() as never} />);
    fireEvent.click(screen.getByTestId("offer-decline"));
    await waitFor(() => expect(posts).toEqual([{ url: "http://test/trust/promotions/deploy/T1", body: { decision: "decline" } }]));
  });

  it("is a question in the duo's own voice, behind its line, with the labels the vocabulary names", () => {
    stubDaemon();
    mount(<OfferCard api={api} offer={offer() as never} />);
    expect(screen.getByTestId("offer-card-attribution")).toHaveTextContent("Your duo");
    expect(screen.getByTestId("offer-accept")).toHaveTextContent("Let it answer");
    expect(screen.getByTestId("offer-decline")).toHaveTextContent("Keep asking me");
  });
});

describe("NoticeCard — losing trust is fast, and said out loud", () => {
  it("is one plain sentence from your duo with nothing to press", () => {
    mount(<NoticeCard notice={{ id: "n1", text: "I got that wrong, so I've gone back to asking you first." }} />);
    expect(screen.getByTestId("notice-card-line")).toHaveTextContent("I got that wrong, so I've gone back to asking you first.");
    expect(screen.getByTestId("notice-card-line")).toHaveAttribute("data-duo-line", "neutral");
    expect(within(screen.getByTestId("notice-card")).queryByRole("button")).toBeNull();
  });
});

describe("DigestCard — what your duo did for others this week", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  it("counts only the last seven days, and says what declined means", () => {
    expect(
      digestOf([auditAt("a", "2026-09-25T00:00:00Z"), auditAt("b", "2026-09-20T00:00:00Z", true), auditAt("old", "2026-09-01T00:00:00Z")], now),
    ).toEqual({ total: 2, answered: 1, declined: 1 });
  });

  it("shows once there is something to say and is dismissed for the week", async () => {
    stubDaemon({ audit: [auditAt("a", new Date().toISOString()), auditAt("b", new Date().toISOString(), true)] });
    mount(<DigestCard api={api} />);
    expect(await screen.findByText("2 people asked your duo through your links this week")).toBeInTheDocument();
    expect(screen.getByTestId("digest-counts")).toHaveTextContent("I answered 1 and declined 1 — declined means a boundary you set.");
    expect(screen.getByTestId("digest-activity")).toHaveAttribute("href", "#duo/profile/activity");
    fireEvent.click(screen.getByTestId("digest-dismiss"));
    expect(screen.queryByTestId("digest-card")).toBeNull();
    expect(isSetAside("digest")).toBe(true);
  });

  it("says nothing on a week with nothing to say", async () => {
    stubDaemon({ audit: [auditAt("old", "2020-01-01T00:00:00Z")] });
    mount(<DigestCard api={api} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByTestId("digest-card")).toBeNull();
  });
});

describe("TrainingCards — quiet by default", () => {
  it("renders nothing at all on a day with nothing to learn", async () => {
    stubDaemon();
    mount(<TrainingCards api={api} />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByTestId("training-cards")).toBeEmptyDOMElement();
  });

  it("puts an action waiting on your yes first — the same two-step confirm, in the chat", async () => {
    const action = { id: "act", description: "File a response with the court", reversible: false, tier: "T4" };
    stubDaemon({
      t4: [{ id: "req", actionId: "act", topicId: "evictions", reasoning: "deadline tomorrow", createdAt: "2026-01-02T00:00:00.000Z", executedAt: null, action }],
      review: [candidate("c1")],
    });
    mount(<TrainingCards api={api} />);
    await screen.findByTestId("rules-card");
    const cards = screen.getByTestId("training-cards");
    const confirmation = await within(cards).findByTestId("confirmation-card");
    expect(confirmation).toHaveTextContent("File a response with the court");
    // It opens a question rather than confirming: the one control on the card does not confirm.
    expect(within(confirmation).getByTestId("confirmation-review")).toBeInTheDocument();
    expect(within(cards).queryByTestId("confirmation-confirm")).toBeNull();
    // …and it comes before what your duo wants confirmed.
    expect(confirmation.compareDocumentPosition(screen.getByTestId("rules-card")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows notices it is given, after the offers", async () => {
    stubDaemon({ promotions: [offer()] });
    mount(<TrainingCards api={api} notices={[{ id: "n", text: "I got that wrong, so I've gone back to asking you first." }]} />);
    const offerCard = await screen.findByTestId("offer-card");
    expect(offerCard.compareDocumentPosition(screen.getByTestId("notice-card")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Your duo hosts them", () => {
  it("shows the cards after the conversation, and the chat list says there is something to look at", async () => {
    stubDaemon({ review: [candidate("c1")], promotions: [offer()] });
    mount(<Duo api={api} />);
    expect(await screen.findByTestId("rules-card")).toBeInTheDocument();
    expect(screen.getByTestId("offer-card")).toBeInTheDocument();
    const chat = screen.getByTestId("duo-thread");
    expect(within(chat).getByTestId("training-cards")).toBeInTheDocument();
  });
});
