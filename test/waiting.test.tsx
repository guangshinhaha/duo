import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { DraftRecord } from "../src/api/types.js";
import { buildWaitingItems, waitingWords } from "../src/shell/waiting.js";

/*
 * #143: Review is a filter and a count now. The model folds the daemon's two
 * queues into rows — one per place a decision is made — and every count in
 * the app is the sum of them.
 */

const draft = (id: string, createdAt: string, over: Partial<DraftRecord> = {}): DraftRecord => ({
  id,
  question: `question ${id}`,
  threadContext: null,
  draftText: `answer ${id}`,
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.8,
  sources: [],
  createdAt,
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
  provenance: { origin: "unknown" },
  delivery: null,
  ...over,
});

const channel = (roomId: string): DraftRecord["provenance"] => ({
  origin: "channel",
  channelKind: "native",
  askerRef: "@bose:w",
  threadId: null,
  permalink: `https://matrix.to/#/${roomId}/$e?via=w`,
});

describe("buildWaitingItems — where each decision is made", () => {
  it("groups drafts by the chat they answer, and puts a draft for a room you do not hold on its own page", () => {
    const items = buildWaitingItems(
      [
        draft("a", "2026-01-02T00:00:00Z", { provenance: channel("!p:w") }),
        draft("b", "2026-01-01T00:00:00Z", { provenance: channel("!p:w") }),
        draft("c", "2026-01-03T00:00:00Z", { provenance: channel("!elsewhere:w") }),
      ],
      [],
      [{ roomId: "!p:w" }],
    );
    expect(items.map((item) => [item.kind, item.href, item.count])).toEqual([
      ["chat", "#chat/!p%3Aw", 2],
      ["draft", "#draft/c", 1],
    ]);
    // The oldest of a group is the group's age, and its state.
    expect(items[0]!.oldestAt).toBe("2026-01-01T00:00:00Z");
  });

  it("sends a question you asked yourself to Your duo, and confirmations to their own row — oldest first", () => {
    const items = buildWaitingItems(
      [draft("mine", "2026-01-04T00:00:00Z", { provenance: { origin: "owner" } }), draft("x", "2026-01-05T00:00:00Z")],
      [{ createdAt: "2026-01-06T00:00:00Z" }, { createdAt: "2026-01-02T00:00:00Z" }],
      [],
    );
    expect(items.map((item) => [item.kind, item.count])).toEqual([
      ["confirmations", 2], // its oldest is 2 Jan
      ["duo", 1],
      ["draft", 1],
    ]);
  });

  it("reads each row's state from the hairline's own rules, and says it in words", () => {
    const [hedged, passed, refused, confirm] = [
      ...buildWaitingItems([draft("h", "2026-01-01T00:00:00Z", { confidenceScore: 0.6 })], [], []),
      ...buildWaitingItems([draft("p", "2026-01-01T00:00:00Z", { escalated: true, draftText: null, escalationReason: "r" })], [], []),
      ...buildWaitingItems([draft("r", "2026-01-01T00:00:00Z", { escalated: true, refused: true, draftText: null, escalationReason: "r" })], [], []),
      ...buildWaitingItems([], [{ createdAt: "2026-01-01T00:00:00Z" }], []),
    ];
    expect([hedged!.state, passed!.state, refused!.state, confirm!.state]).toEqual(["hedged", "escalated", "refused", null]);
    expect([hedged!, passed!, refused!, confirm!].map(waitingWords)).toEqual([
      "Draft · hedging",
      "Passed to you",
      "Refused",
      "An action needs your yes",
    ]);
    expect(waitingWords({ kind: "chat", state: "confident", count: 3 })).toBe("3 waiting on you");
  });
});

describe("the filter and the count, in the whole app", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    const queue = [draft("early", "2026-01-01T00:00:00Z"), draft("late", "2026-01-02T00:00:00Z")];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/drafts/early")) {
          return new Response(JSON.stringify(queue[0]), { status: 200 });
        }
        return new Response(JSON.stringify(url.includes("/drafts?outcome=pending") ? queue : []), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    localStorage.clear();
    window.location.hash = "";
    document.title = "Duo";
  });

  it("puts the same number in the window title, and clears it with the pairing", async () => {
    window.location.hash = "#waiting";
    const { unmount } = render(<App />);
    await waitFor(() => expect(document.title).toBe("(2) Duo"));
    expect(screen.getByTestId("waiting-badge")).toHaveTextContent("2");
    unmount();
    expect(document.title).toBe("Duo");
  });

  it("the front door says how many wait and starts with the oldest", async () => {
    window.location.hash = "#waiting";
    render(<App />);
    expect(await screen.findByTestId("waiting-home")).toHaveTextContent("2 decisions are waiting on you.");
    expect(screen.getByTestId("waiting-home-start")).toHaveAttribute("href", "#draft/early");
  });

  it("stays a filter while you work down it — opening one keeps the list on what waits — and All turns it off", async () => {
    window.location.hash = "#waiting";
    render(<App />);
    await screen.findByTestId("waiting-list");

    window.location.hash = "#draft/early";
    window.dispatchEvent(new Event("hashchange"));
    await screen.findByTestId("draft-page");
    expect(screen.getByTestId("waiting-list")).toBeInTheDocument();
    expect(screen.getByTestId("waiting-chip")).toHaveClass("bg-[var(--surface-2)]");

    window.location.hash = "#chats";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(screen.queryByTestId("waiting-list")).toBeNull());
    expect(screen.getByTestId("duo-link")).toBeInTheDocument();
  });
});
