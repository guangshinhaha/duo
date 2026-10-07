import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandSearch } from "../src/components/CommandSearch.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { MessageSearchHit, RoomSummary, WorkspaceConnection } from "../src/workspace/matrix.js";

/*
 * duo#300: filters on top of "search what was said" (#70/#207), and the
 * answer-on-top built from exactly those filtered hits. The filtering
 * itself never asks the homeserver a second question — `searchMessages` is
 * called once, with the free-text term only, and every chip narrows what's
 * already on screen (`workspace/searchQuery.ts` carries the unit coverage
 * for the parsing/matching rules themselves; this file drives the real
 * component wiring end to end).
 */

const PROJECT = "!project-x:workspace.example";
const ROOMS: RoomSummary[] = [
  {
    kind: "group",
    name: "project-x",
    topic: null,
    avatarUrl: null,
    members: [],
    latest: null,
    unread: { notifications: 0, mentions: 0 },
    muted: false,
    notifications: "all",
    canEdit: { name: false, topic: false, avatar: false },
    roomId: PROJECT,
  },
];

function titleOf(room: RoomSummary): string {
  return room.name ?? room.roomId;
}

function hit(over: Partial<MessageSearchHit>): MessageSearchHit {
  return {
    eventId: "$default",
    roomId: PROJECT,
    senderId: "@bose:workspace.example",
    senderName: "Bose",
    body: "refund policy?",
    originServerTs: 1_700_000_000_000,
    threadRootEventId: null,
    context: { before: [], after: [] },
    ...over,
  };
}

function fakeConnection(searchHits: readonly MessageSearchHit[]) {
  const searchMessages = vi.fn(async () => ({ hits: searchHits, next: null }));
  const connection = {
    userId: "@ana:workspace.example",
    findRooms: vi.fn(async () => []),
    searchPeople: vi.fn(async () => []),
    startDirect: vi.fn(async (userId: string) => `!fresh-${userId}`),
    getProfile: vi.fn(async () => null),
    searchMessages,
  } as unknown as WorkspaceConnection;
  return { connection, searchMessages };
}

function renderSearch(props: Partial<Parameters<typeof CommandSearch>[0]> & { connection: WorkspaceConnection }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CommandSearch onStartedConversation={() => {}} rooms={ROOMS} titleOf={titleOf} {...props}>
        <div data-testid="the-list">the conversation list</div>
      </CommandSearch>
    </QueryClientProvider>,
  );
}

const input = () => screen.getByRole("combobox", { name: "Search the workspace" });

beforeEach(() => {
  window.location.hash = "";
});

afterEach(() => {
  window.location.hash = "";
  vi.unstubAllGlobals();
});

describe("duo#300 — filter chips narrow the hits already on screen, with no second ask", () => {
  it("strips the from: token from what's sent to the homeserver, and narrows the rendered hits to it", async () => {
    const { connection, searchMessages } = fakeConnection([
      hit({ eventId: "$1", senderId: "@bose:workspace.example", senderName: "Bose" }),
      hit({ eventId: "$2", senderId: "@aisha:workspace.example", senderName: "Aisha" }),
    ]);
    renderSearch({ connection });

    fireEvent.change(input(), { target: { value: "from:bose refund" } });
    fireEvent.click(await screen.findByTestId("command-search-messages"));

    expect(await screen.findAllByTestId("message-search-hit")).toHaveLength(1);
    expect(searchMessages).toHaveBeenCalledWith("refund", undefined);
    expect(screen.getByTestId("message-search-filter-from")).toHaveTextContent("from: bose");
  });

  it("removing the chip shows every hit again, without asking the homeserver again", async () => {
    const { connection, searchMessages } = fakeConnection([
      hit({ eventId: "$1", senderId: "@bose:workspace.example", senderName: "Bose" }),
      hit({ eventId: "$2", senderId: "@aisha:workspace.example", senderName: "Aisha" }),
    ]);
    renderSearch({ connection });

    fireEvent.change(input(), { target: { value: "from:bose refund" } });
    fireEvent.click(await screen.findByTestId("command-search-messages"));
    expect(await screen.findAllByTestId("message-search-hit")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("message-search-filter-from"));

    expect(await screen.findAllByTestId("message-search-hit")).toHaveLength(2);
    expect(screen.queryByTestId("message-search-filter-from")).toBeNull();
    expect(searchMessages).toHaveBeenCalledTimes(1);
  });

  it("a filter that matches nothing says so, distinctly from a search with no results at all", async () => {
    const { connection } = fakeConnection([hit({ eventId: "$1", senderName: "Bose" })]);
    renderSearch({ connection });

    fireEvent.change(input(), { target: { value: "from:nobody refund" } });
    fireEvent.click(await screen.findByTestId("command-search-messages"));

    expect(await screen.findByTestId("message-search-filtered-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("message-search-empty")).toBeNull();
  });
});

describe("duo#300 — the answer on top", () => {
  const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

  it("a plain search never reaches the daemon — asking is a separate, deliberate action", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { connection } = fakeConnection([hit({ eventId: "$1", senderName: "Bose", body: "Refunds within 30 days are automatic." })]);
    renderSearch({ connection, api });

    fireEvent.change(input(), { target: { value: "refund" } });
    fireEvent.click(await screen.findByTestId("command-search-messages"));
    await screen.findAllByTestId("message-search-hit");

    expect(screen.getByTestId("message-search-ask-answer")).toBeInTheDocument();
    expect(screen.queryByTestId("message-search-answer")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders no ask button at all with no duo paired", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { connection } = fakeConnection([hit({ eventId: "$1" })]);
    renderSearch({ connection, api: null });

    fireEvent.change(input(), { target: { value: "refund" } });
    fireEvent.click(await screen.findByTestId("command-search-messages"));
    await screen.findAllByTestId("message-search-hit");

    expect(screen.queryByTestId("message-search-ask-answer")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asking sends exactly the member's own filtered hits, and renders the daemon's answer behind the hairline with its cited source", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "http://test/search/answer"
          ? new Response(JSON.stringify({ kind: "answered", text: "Refunds are automatic within 30 days.", citedIds: ["$1"] }), { status: 200 })
          : new Response("not found", { status: 404 }),
      ),
    );
    const { connection } = fakeConnection([
      hit({ eventId: "$1", senderName: "Bose", body: "Refunds within 30 days are automatic." }),
    ]);
    renderSearch({ connection, api });

    fireEvent.change(input(), { target: { value: "refund" } });
    fireEvent.click(await screen.findByTestId("command-search-messages"));
    fireEvent.click(await screen.findByTestId("message-search-ask-answer"));

    expect(await screen.findByTestId("message-search-answer")).toHaveTextContent("Refunds are automatic within 30 days.");
    expect(screen.getByTestId("message-search-answer-source")).toHaveTextContent("Bose in project-x");

    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] === "http://test/search/answer")!;
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body).toEqual({ query: "refund", hits: [{ id: "$1", text: "Refunds within 30 days are automatic.", from: "Bose" }] });
  });

  it("says so plainly when the daemon has nothing safe to show, rather than leaving the member waiting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ kind: "no_answer" }), { status: 200 })));
    const { connection } = fakeConnection([hit({ eventId: "$1" })]);
    renderSearch({ connection, api });

    fireEvent.change(input(), { target: { value: "refund" } });
    fireEvent.click(await screen.findByTestId("command-search-messages"));
    fireEvent.click(await screen.findByTestId("message-search-ask-answer"));

    expect(await screen.findByTestId("message-search-answer-none")).toBeInTheDocument();
    expect(screen.queryByTestId("message-search-answer")).toBeNull();
  });

  it("only answers from the hits that survive the active filter, not every hit the search turned up", async () => {
    const fetchSpy = vi.fn(async (url: string) =>
      url === "http://test/search/answer"
        ? new Response(JSON.stringify({ kind: "answered", text: "30 days.", citedIds: ["$1"] }), { status: 200 })
        : new Response("not found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { connection } = fakeConnection([
      hit({ eventId: "$1", senderName: "Bose", body: "Refunds: 30 days." }),
      hit({ eventId: "$2", senderName: "Aisha", body: "Refunds: ask Finance." }),
    ]);
    renderSearch({ connection, api });

    fireEvent.change(input(), { target: { value: "from:bose refund" } });
    fireEvent.click(await screen.findByTestId("command-search-messages"));
    fireEvent.click(await screen.findByTestId("message-search-ask-answer"));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const call = (fetchSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] === "http://test/search/answer")!;
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body.hits).toEqual([{ id: "$1", text: "Refunds: 30 days.", from: "Bose" }]);
  });
});
