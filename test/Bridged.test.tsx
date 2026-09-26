import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftRecord } from "../src/api/types.js";
import { bridgedHref, bridgedIdOf, groupBridged, sourceLabel } from "../src/shell/bridged.js";
import { buildWaitingItems } from "../src/shell/waiting.js";
import { stubDesktop } from "./desktop.js";

/*
 * #150: a question someone asked on another platform is a chat with them.
 * The daemon keeps drafts, not conversations, and has no thread history to
 * read (the question and the thread's text are all it stores), so a bridged
 * chat is the drafts that share an asker or a thread — and it says so.
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

const slack = (askerRef: string, threadId: string | null = null): DraftRecord["provenance"] => ({
  origin: "channel",
  channelKind: "slack",
  askerRef,
  threadId,
  permalink: null,
});

describe("#150 — what makes a chat out of a bridged question", () => {
  it("one chat per thread when the channel names one, per asker otherwise", () => {
    const chats = groupBridged([
      draft("a", "2026-01-01T00:00:00.000Z", { provenance: slack("dana", "t1") }),
      draft("b", "2026-01-01T01:00:00.000Z", { provenance: slack("lee", "t1") }),
      draft("c", "2026-01-01T02:00:00.000Z", { provenance: slack("dana") }),
      draft("d", "2026-01-01T03:00:00.000Z", { provenance: slack("dana") }),
    ]);
    expect(chats.map((chat) => [chat.askers, chat.drafts.map((d) => d.id)])).toEqual([
      [["dana"], ["c", "d"]],
      [["dana", "lee"], ["a", "b"]],
    ]);
  });

  it("only a question from elsewhere is one: your own asks, old rows and workspace messages are not", () => {
    expect(bridgedIdOf(draft("o", "2026-01-01T00:00:00.000Z", { provenance: { origin: "owner" } }))).toBeNull();
    expect(bridgedIdOf(draft("u", "2026-01-01T00:00:00.000Z"))).toBeNull();
    expect(
      bridgedIdOf(draft("n", "2026-01-01T00:00:00.000Z", { provenance: { ...(slack("dana") as object), permalink: "https://matrix.to/#/!r:w/$e" } as DraftRecord["provenance"] })),
    ).toBeNull();
    expect(bridgedIdOf(draft("s", "2026-01-01T00:00:00.000Z", { provenance: slack("dana") }))).toBe("bridge:slack:dana");
  });

  it("a draft in two lists counts once, and a refused one is not waiting", () => {
    const one = draft("a", "2026-01-01T00:00:00.000Z", { provenance: slack("dana") });
    const refused = draft("r", "2026-01-01T01:00:00.000Z", { provenance: slack("dana"), escalated: true, refused: true });
    const [chat] = groupBridged([one, one, refused]);
    expect(chat!.drafts).toHaveLength(2);
    expect(chat!.waiting.map((d) => d.id)).toEqual(["a"]);
  });

  it("names the source as the daemon said it, first letter up", () => {
    expect(sourceLabel("slack")).toBe("Slack");
    expect(sourceLabel("teams-bridge")).toBe("Teams-bridge");
  });

  it("waiting rows: one per bridged chat, leading into it, naming who and where", () => {
    const items = buildWaitingItems(
      [
        draft("a", "2026-01-01T00:00:00.000Z", { provenance: slack("dana") }),
        draft("b", "2026-01-01T01:00:00.000Z", { provenance: slack("dana") }),
        draft("c", "2026-01-01T02:00:00.000Z"),
      ],
      [],
      [],
    );
    expect(items.map((item) => [item.kind, item.count, item.href, item.label, item.source])).toEqual([
      ["bridged", 2, bridgedHref("bridge:slack:dana"), "dana", "Slack"],
      ["draft", 1, "#draft/c", null, null],
    ]);
  });
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

function fakeDaemon(initial: DraftRecord[]) {
  let log = [...initial];
  const outcomes: Array<{ id: string; body: { outcome: string; sentText?: string } }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const outcome = /\/drafts\/([^/]+)\/outcome$/.exec(url);
    if (outcome && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { outcome: string; sentText?: string };
      outcomes.push({ id: outcome[1]!, body });
      log = log.map((d) =>
        d.id === outcome[1]
          ? { ...d, outcome: body.outcome as DraftRecord["outcome"], outcomeRecordedAt: "2026-01-02T00:00:00.000Z", sentText: body.sentText ?? d.draftText, delivery: { state: "delivered" } }
          : d,
      );
      return json({});
    }
    const single = /\/drafts\/([^/?]+)$/.exec(url);
    if (single) {
      const found = log.find((d) => d.id === single[1]);
      return found ? json(found) : json({ error: { code: "not_found", message: "no such draft" } }, 404);
    }
    if (url.includes("/drafts?outcome=pending")) {
      return json(log.filter((d) => d.outcome === null));
    }
    if (url.includes("/drafts?limit=")) {
      return json([...log].reverse());
    }
    return json([]);
  });
  return { fetchMock, outcomes };
}

async function renderApp() {
  vi.resetModules();
  const { App } = await import("../src/App.js");
  return render(<App />);
}

function navigate(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
}

const CHAT = `#chat/${encodeURIComponent("bridge:slack:dana")}`;

const QUESTION = draft("d1", "2026-01-01T09:00:00.000Z", {
  question: "is the staging deploy frozen?",
  threadContext: "#platform-help: deploys this week",
  draftText: "Not frozen — deploys resume after 3pm.",
  provenance: slack("dana"),
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
  stubDesktop();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

describe("#150 — a bridged question in the chat list and in its own chat", () => {
  it("is a row in Chats that says where it came from and that a draft waits", async () => {
    vi.stubGlobal("fetch", fakeDaemon([QUESTION]).fetchMock);
    await renderApp();

    const row = await screen.findByTestId("bridged-entry");
    expect(within(row).getByTestId("bridged-row-title")).toHaveTextContent("dana");
    expect(within(row).getByTestId("source-badge")).toHaveTextContent("Slack");
    expect(within(row).getByTestId("bridged-preview")).toHaveTextContent("Draft ready");
    expect(within(row).getByTestId("bridged-count")).toHaveTextContent("1");
    expect(within(row).getByTestId("bridged-link")).toHaveAttribute("href", CHAT);
    // Never a native conversation's row.
    expect(screen.queryByTestId("conversations-entry")).toBeNull();
  });

  it("the chat: their question on their side with its source, the thread's text, and your duo's draft in the tray", async () => {
    vi.stubGlobal("fetch", fakeDaemon([QUESTION]).fetchMock);
    await renderApp();
    navigate(CHAT);

    const chat = await screen.findByTestId("bridged-chat");
    expect(within(chat).getByTestId("bridged-title")).toHaveTextContent("dana");
    expect(within(chat).getByTestId("bridged-source")).toHaveTextContent("Slack");
    // It never passes for a native chat: it says what it does not have.
    expect(within(chat).getByTestId("bridged-note")).toHaveTextContent(/From Slack/);
    expect(within(chat).getByTestId("bridged-note")).toHaveTextContent(/rest of the thread stays there/);
    expect(within(chat).getByTestId("asker-line")).toHaveTextContent("Slack · dana");
    expect(within(chat).getByTestId("asker-message")).toHaveTextContent("is the staging deploy frozen?");
    expect(within(chat).getByTestId("asker-context")).toHaveTextContent("#platform-help: deploys this week");
    // The draft is above where you decide it, not in the transcript.
    const tray = within(within(chat).getByTestId("bridged-drafts")).getByTestId("draft-tray");
    expect(tray).toHaveTextContent("Not frozen — deploys resume after 3pm.");
    expect(within(within(chat).getByTestId("bridged-turns")).queryByText(/deploys resume after 3pm/)).toBeNull();
    // A native chat's composer is not here — there is no way to post to the bridge but through a draft.
    expect(screen.queryByTestId("room-composer")).toBeNull();
  });

  it("Send records the outcome exactly as anywhere else, and the reply lands on your side with how its delivery went", async () => {
    const daemon = fakeDaemon([QUESTION]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    await renderApp();
    navigate(CHAT);

    const drafts = await screen.findByTestId("bridged-drafts");
    fireEvent.click(await within(drafts).findByRole("button", { name: "Send" }));

    await waitFor(() => expect(daemon.outcomes).toEqual([{ id: "d1", body: { outcome: "sent" } }]));
    const reply = await screen.findByTestId("bridged-reply");
    expect(reply).toHaveTextContent("Not frozen — deploys resume after 3pm.");
    await waitFor(() => expect(within(reply).getByTestId("delivery-state")).toHaveTextContent("Delivered."));
    expect(screen.queryByTestId("bridged-drafts")).toBeNull();
  });

  it("an old #draft address opens the chat its question belongs to", async () => {
    vi.stubGlobal("fetch", fakeDaemon([QUESTION]).fetchMock);
    await renderApp();
    navigate("#draft/d1");

    await screen.findByTestId("bridged-chat");
    expect(window.location.hash).toBe(CHAT);
  });

  it("a chat the duo has no recent question for says so, with the way back", async () => {
    vi.stubGlobal("fetch", fakeDaemon([]).fetchMock);
    await renderApp();
    navigate(CHAT);

    expect(await screen.findByTestId("bridged-not-found")).toHaveTextContent("isn’t in your duo’s recent questions");
  });
});
