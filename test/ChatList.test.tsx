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

describe("#141 — the filter is one number", () => {
  it("shows Waiting on you with the count of drafts and confirmations together, and the active one lit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        new Response(String(input).includes("/actions/t4/pending") ? JSON.stringify([{}]) : JSON.stringify([{}, {}]), { status: 200 }),
      ),
    );
    renderList({}, "waiting");
    expect(await screen.findByTestId("waiting-badge")).toHaveTextContent("3");
    expect(screen.getByTestId("waiting-chip")).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(screen.getByTestId("duo-row-count")).toHaveTextContent("3"));
  });
});
