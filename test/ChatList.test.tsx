import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { ChatList } from "../src/shell/ChatList.js";
import type { Route } from "../src/shell/routes.js";
import type { RoomSummary, WorkspaceConnection } from "../src/workspace/matrix.js";

/*
 * The chat list (#141, docs/design-language.md §6.2): people, groups and
 * colleagues' duos in one list, with the owner's own duo pinned first —
 * even with no workspace — and a duo never dressed as a person.
 */

const api: DuoApiConfig = { baseUrl: "http://d:7717", token: "t" };

const room = (roomId: string, overrides: Partial<RoomSummary> = {}): RoomSummary => ({
  roomId,
  kind: "direct",
  name: null,
  members: [{ userId: "@bose:workspace.example", name: "Bose" }],
  latest: { at: Date.now() - 60_000, body: "lunch?" },
  unread: { notifications: 0, mentions: 0 },
  muted: false,
  notifications: "all",
  ...overrides,
});

function connectionWith(rooms: RoomSummary[]): WorkspaceConnection {
  return { rooms: async () => rooms, subscribe: () => () => {} } as unknown as WorkspaceConnection;
}

function renderList(props: Partial<Parameters<typeof ChatList>[0]> = {}, route: Route = "chats") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <ChatList
        api={api}
        connection={null}
        onPairDuo={() => {}}
        onSignIn={() => {}}
        onSignOutWorkspace={() => {}}
        route={route}
        session={null}
        workspaceError={null}
        {...props}
      />
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  window.location.hash = "";
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("#141 — your duo is pinned first, and is never a person", () => {
  it("is the one row with no workspace at all, and a workspace is offered, not demanded", () => {
    renderList();
    const duo = screen.getByTestId("duo-link");
    expect(duo).toHaveAttribute("href", "#duo");
    expect(within(duo).getByTestId("duo-title")).toHaveTextContent("Your duo");
    expect(screen.getAllByTestId("chat-avatar")).toHaveLength(1);
    expect(screen.getByTestId("conversations-signin")).toBeInTheDocument();
  });

  it("wears the mark, never initials — and so does a colleague's duo, named from the id grammar and not from a name it chose", async () => {
    const duoRoom = room("!d:w", { members: [{ userId: "@duo-carol:workspace.example", name: "Totally A Person" }] });
    renderList({ connection: connectionWith([duoRoom, room("!b:w")]), session: {} as never });

    const rows = await screen.findAllByTestId("conversations-room");
    const [carol, bose] = rows;
    // The duo's title is the structural possessive, never the display name it set.
    expect(within(carol!).getByTestId("room-title")).toHaveTextContent("carol's duo");
    expect(carol!.textContent).not.toContain("Totally A Person");
    expect(within(carol!).getByTestId("chat-avatar")).toHaveAttribute("data-kind", "duo");
    expect(within(carol!).getByTestId("chat-avatar")).not.toHaveTextContent(/[A-Za-z]/);
    // A person is their initials.
    expect(within(bose!).getByTestId("chat-avatar")).toHaveAttribute("data-kind", "person");
    expect(within(bose!).getByTestId("chat-avatar")).toHaveTextContent("B");
  });

  it("with no duo paired, a member sees their conversations and the pairing offered", async () => {
    renderList({ api: null, connection: connectionWith([room("!b:w")]), session: {} as never });
    await screen.findByTestId("conversations-list");
    expect(screen.queryByTestId("duo-link")).toBeNull();
    expect(screen.getByTestId("no-duo-pair")).toBeInTheDocument();
  });
});

describe("#141 — the keyboard walks the list", () => {
  const rooms = [room("!a:w", { members: [{ userId: "@ana:workspace.example", name: "Ana" }] }), room("!b:w")];

  async function ready() {
    renderList({ connection: connectionWith(rooms), session: {} as never });
    await screen.findByTestId("conversations-list");
  }

  it("⌘1–9 open the rows in order, your duo first", async () => {
    await ready();
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(window.location.hash).toBe("#duo");
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(window.location.hash).toBe("#chat/!a%3Aw");
    fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    expect(window.location.hash).toBe("#chat/!b%3Aw");
    fireEvent.keyDown(window, { key: "9", metaKey: true }); // no ninth row: nothing moves
    expect(window.location.hash).toBe("#chat/!b%3Aw");
  });

  it("J and K step through the list and wrap", async () => {
    await ready();
    window.location.hash = "#duo";
    fireEvent.keyDown(window, { key: "j" });
    expect(window.location.hash).toBe("#chat/!a%3Aw");
    fireEvent.keyDown(window, { key: "j" });
    expect(window.location.hash).toBe("#chat/!b%3Aw");
    fireEvent.keyDown(window, { key: "j" });
    expect(window.location.hash).toBe("#duo");
    fireEvent.keyDown(window, { key: "k" });
    expect(window.location.hash).toBe("#chat/!b%3Aw");
  });

  it("never steals a keystroke from a field the owner is typing in", async () => {
    await ready();
    window.location.hash = "#duo";
    const field = document.createElement("textarea");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "j" });
    fireEvent.keyDown(field, { key: "1", metaKey: true });
    field.remove();
    expect(window.location.hash).toBe("#duo");
    // …and a key aimed at the window itself (no element) is still handled without a throw.
    expect(() => fireEvent.keyDown(window, { key: "x" })).not.toThrow();
  });
});

const draftAt = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
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

function stubQueues(drafts: unknown[], confirmations: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(String(input).includes("/actions/t4/pending") ? confirmations : drafts), { status: 200 }),
    ),
  );
}

describe("#143 — Waiting on you is a count and a filter", () => {
  it("counts drafts and confirmations together, and the chip is lit while the filter is on", async () => {
    stubQueues([draftAt("a", "2026-01-01T00:00:00Z"), draftAt("b", "2026-01-02T00:00:00Z")], [{ id: "t", createdAt: "2026-01-03T00:00:00Z" }]);
    renderList({ filterWaiting: true }, "waiting");
    expect(await screen.findByTestId("waiting-badge")).toHaveTextContent("3");
    expect(screen.getByTestId("waiting-chip")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("all-chip")).not.toHaveAttribute("aria-current");
  });

  it("lists only what waits, oldest first — a draft's own row, then the confirmations", async () => {
    stubQueues([draftAt("late", "2026-01-05T00:00:00Z"), draftAt("early", "2026-01-01T00:00:00Z")], [{ id: "t", createdAt: "2026-01-03T00:00:00Z" }]);
    renderList({ filterWaiting: true }, "waiting");
    const rows = await screen.findAllByTestId("waiting-link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual(["#draft/early", "#confirmations", "#draft/late"]);
    expect(within(rows[1]!).getByTestId("waiting-title")).toHaveTextContent("Confirmations");
    // Not the whole list: your duo is not pinned above a filter that is about what waits.
    expect(screen.queryByTestId("duo-link")).toBeNull();
  });

  it("an answer you asked your duo for waits in Your duo, and the row says so with the hairline's colour", async () => {
    stubQueues([draftAt("mine", "2026-01-01T00:00:00Z", { provenance: { origin: "owner" }, confidenceScore: 0.6 })], []);
    renderList({ filterWaiting: true }, "waiting");
    const row = await screen.findByTestId("waiting-link");
    expect(row).toHaveAttribute("href", "#duo");
    expect(within(row).getByTestId("waiting-title")).toHaveTextContent("Your duo");
    expect(within(row).getByTestId("waiting-preview")).toHaveTextContent("Draft · hedging");
    expect(within(row).getByTestId("draft-line")).toBeInTheDocument();
    expect(within(row).getByTestId("chat-avatar")).toHaveAttribute("data-kind", "duo");
  });

  it("says so when nothing waits — in the list only when the list is the whole page", async () => {
    stubQueues([], []);
    renderList({ filterWaiting: true }, "waiting");
    expect(await screen.findByTestId("waiting-empty")).toHaveTextContent("You're clear.");
    cleanup();
    renderList({ filterWaiting: true, titleAs: "h1" }, "waiting");
    expect(await screen.findByTestId("waiting-empty")).toHaveTextContent("Nothing waiting on you.");
  });

  it("J and K walk only the waiting rows while the filter is on", async () => {
    stubQueues([draftAt("a", "2026-01-01T00:00:00Z"), draftAt("b", "2026-01-02T00:00:00Z")], []);
    renderList({ filterWaiting: true }, "waiting");
    await screen.findAllByTestId("waiting-link");
    window.location.hash = "#waiting";
    fireEvent.keyDown(window, { key: "j" });
    expect(window.location.hash).toBe("#draft/a");
    window.location.hash = "#draft/a";
    fireEvent.keyDown(window, { key: "j" });
    expect(window.location.hash).toBe("#draft/b");
    fireEvent.keyDown(window, { key: "j" });
    expect(window.location.hash).toBe("#draft/a");
  });

  it("a draft for a conversation you hold puts its state on that room's row in the full list, with its count", async () => {
    const roomId = "!p:w";
    const permalink = `https://matrix.to/#/${roomId}/$e?via=w`;
    stubQueues(
      [draftAt("d", "2026-01-01T00:00:00Z", { provenance: { origin: "channel", channelKind: "native", askerRef: "@b:w", threadId: null, permalink } })],
      [],
    );
    renderList({ connection: connectionWith([room(roomId, { name: "project-x", kind: "group" })]), session: {} as never });
    const link = await screen.findByTestId("conversations-room");
    await waitFor(() => expect(within(link).getByTestId("room-preview")).toHaveTextContent("Draft ready"));
    expect(within(link).getByTestId("waiting-count")).toHaveTextContent("1");
  });
});
