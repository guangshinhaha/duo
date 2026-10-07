import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DailyBrief, DraftRecord } from "../src/api/types.js";
import { DailyBriefCard } from "../src/components/DailyBriefCard.js";
import { isDailyBriefDue, markDailyBriefShown } from "../src/dailyBriefPrefs.js";

/*
 * duo#282 (digital-duo#279): the daily brief card — the first card in Your
 * duo. Clock-sensitive (it only shows when `isDailyBriefDue` says so), so
 * every test pins `now` rather than trusting whatever hour the suite
 * happens to run at.
 */

const api: DuoApiConfig = { baseUrl: "http://d:7717", token: "t" };
const NOW = new Date("2026-06-15T09:00:00");

function draftFor(id: string, question: string): DraftRecord {
  return {
    id,
    question,
    threadContext: null,
    draftText: "a",
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.8,
    sources: [],
    createdAt: "2026-06-15T08:00:00.000Z",
    outcome: null,
    outcomeRecordedAt: null,
    sentText: null,
    refused: false,
    escalationThreshold: 0.55,
    provenance: { origin: "owner" },
    delivery: null,
  };
}

function stub(brief: DailyBrief, pendingDrafts: DraftRecord[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL) => {
      const href = String(url);
      if (href.includes("/daily-brief")) {
        return Promise.resolve(new Response(JSON.stringify(brief), { status: 200 }));
      }
      if (href.includes("/drafts")) {
        return Promise.resolve(new Response(JSON.stringify(pendingDrafts), { status: 200 }));
      }
      return Promise.resolve(new Response("[]", { status: 200 }));
    }),
  );
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <DailyBriefCard api={api} />
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe("duo#282 — DailyBriefCard", () => {
  it("is due by default and shows an honest all-clear with nothing to report", async () => {
    expect(isDailyBriefDue(NOW)).toBe(true);
    stub({ since: "x", generatedAt: "y", waitingOnYou: [], passedOn: [], handledByDuo: [], allClear: true });
    renderCard();
    expect(await screen.findByTestId("daily-brief-all-clear")).toHaveTextContent("All clear");
  });

  it("lists waiting-on-you and passed-on items, each linking to where they came from", async () => {
    stub(
      {
        since: "x",
        generatedAt: "y",
        waitingOnYou: [{ draftId: "1", question: "what's the refund window", createdAt: "2026-06-15T08:00:00.000Z" }],
        passedOn: [{ draftId: "2", question: "legal question", escalationReason: "below threshold", createdAt: "2026-06-15T08:00:00.000Z" }],
        handledByDuo: [],
        allClear: false,
      },
      [draftFor("1", "what's the refund window"), draftFor("2", "legal question")],
    );
    renderCard();
    const waitingItem = await screen.findByTestId("daily-brief-waiting-item");
    expect(waitingItem).toHaveTextContent("what's the refund window");
    // An owner-asked question (provenance origin "owner") has nowhere but Your duo itself.
    expect(waitingItem.querySelector("a")).toHaveAttribute("href", "#duo");
    const passedItem = screen.getByTestId("daily-brief-passed-on-item");
    expect(passedItem).toHaveTextContent("legal question");
  });

  it("links a handled-by-duo item to the Activity tab", async () => {
    stub({
      since: "x",
      generatedAt: "y",
      waitingOnYou: [],
      passedOn: [],
      handledByDuo: [{ id: "h1", question: "what's the refund window", askerRef: "colleague", createdAt: "2026-06-15T08:00:00.000Z" }],
      allClear: false,
    });
    renderCard();
    const item = await screen.findByTestId("daily-brief-handled-item");
    expect(item.querySelector("a")).toHaveAttribute("href", "#duo/profile/activity");
  });

  it("Done dismisses the card and marks it shown for today", async () => {
    stub({ since: "x", generatedAt: "y", waitingOnYou: [], passedOn: [], handledByDuo: [], allClear: true });
    renderCard();
    await screen.findByTestId("daily-brief-card");
    fireEvent.click(screen.getByTestId("daily-brief-dismiss"));
    expect(screen.queryByTestId("daily-brief-card")).toBeNull();
    markDailyBriefShown(NOW);
    expect(isDailyBriefDue(NOW)).toBe(false);
  });

  it("renders nothing when it isn't due yet today", () => {
    markDailyBriefShown(NOW);
    stub({ since: "x", generatedAt: "y", waitingOnYou: [], passedOn: [], handledByDuo: [], allClear: true });
    renderCard();
    expect(screen.queryByTestId("daily-brief-card")).toBeNull();
  });

  it("renders nothing when the response isn't really a DailyBrief, rather than crashing the page", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    renderCard();
    expect(screen.queryByTestId("daily-brief-card")).toBeNull();
  });
});
