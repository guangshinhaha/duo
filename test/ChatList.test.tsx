import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { ChatList } from "../src/shell/ChatList.js";
import type { Route } from "../src/shell/routes.js";
import type { ChatSection, RoomSummary, WorkspaceConnection } from "../src/workspace/matrix.js";

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
  topic: null,
  avatarUrl: null,
  members: [{ userId: "@bose:workspace.example", name: "Bose" }],
  latest: { at: Date.now() - 60_000, body: "lunch?" },
  unread: { notifications: 0, mentions: 0 },
  muted: false,
  notifications: "all",
  canEdit: { name: false, topic: false, avatar: false, pins: false },
  ...overrides,
});

function connectionWith(rooms: RoomSummary[]): WorkspaceConnection {
  return {
    rooms: async () => rooms,
    subscribe: () => () => {},
    // #207: CommandSearch's local filter and recent-conversations state —
    // minimal fakes, since the matching rules are pinned at the seam
    // (WorkspaceMatrixSeam.test.ts) and in CommandSearch.test.tsx.
    findRooms: async (query: string) => {
      const needle = query.trim().toLowerCase();
      return needle === "" ? rooms : rooms.filter((room) => (room.name ?? "").toLowerCase().includes(needle));
    },
    searchPeople: async () => [],
    getProfile: async () => null,
  } as unknown as WorkspaceConnection;
}

/** #296: `connectionWith` plus a real, in-memory `duo.sidebar.sections` door — close enough to the real account-data round trip for the sidebar's own behaviour, without touching matrix.ts at all. */
function connectionWithSections(rooms: RoomSummary[], initial: ChatSection[] = []): WorkspaceConnection {
  let stored: readonly ChatSection[] = initial;
  const handlers = new Set<(sections: readonly ChatSection[]) => void>();
  return {
    ...connectionWith(rooms),
    sections: async () => stored,
    setSections: async (next: readonly ChatSection[]) => {
      stored = next;
      for (const handler of handlers) {
        handler(stored);
      }
    },
    subscribeSections: (handler: (sections: readonly ChatSection[]) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  } as unknown as WorkspaceConnection;
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
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  localStorage.clear();
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
    // #208: sectioned — Direct messages ahead of Duos — so Bose leads and carol's duo follows.
    const [bose, carol] = rows;
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

describe("#208 — people are named, kinds are visible, and the list is sectioned", () => {
  it("a direct message shows the other person's real name and the person icon, never a raw id or a group's #", async () => {
    const dm = room("!dm:w", { kind: "direct", name: null, members: [{ userId: "@bose:workspace.example", name: "Bose" }] });
    renderList({ connection: connectionWith([dm]), session: {} as never });

    const row = await screen.findByTestId("conversations-room");
    expect(within(row).getByTestId("room-title")).toHaveTextContent("Bose");
    expect(within(row).getByTestId("chat-avatar")).toHaveAttribute("data-kind", "person");
    expect(within(row).getByTestId("chat-avatar")).toHaveTextContent("B");
  });

  it("a group room with no explicit name still reads under a sensible generated name, and is still categorized as a group — never '#' only, never a person", async () => {
    const unnamed = room("!g:w", {
      kind: "group",
      name: null,
      members: [
        { userId: "@ana:workspace.example", name: "Ana" },
        { userId: "@bose:workspace.example", name: "Bose" },
      ],
    });
    renderList({ connection: connectionWith([unnamed]), session: {} as never });

    const row = await screen.findByTestId("conversations-room");
    // No `m.room.name`: the title falls back to its members, exactly the
    // way a direct conversation's would — but the icon still reads "group",
    // driven by `kind`, never by whether a name happened to be set (#208).
    expect(within(row).getByTestId("room-title")).toHaveTextContent("Ana, Bose");
    expect(within(row).getByTestId("chat-avatar")).toHaveAttribute("data-kind", "group");
    expect(within(row).getByTestId("chat-avatar")).toHaveTextContent("#");
  });

  it("sections render in order — Channels, then Direct messages, then Duos — each its own icon", async () => {
    const channel = room("!c:w", { kind: "channel", name: "general", members: [{ userId: "@dee:workspace.example", name: "Dee" }] });
    const dm = room("!d:w", { kind: "direct", name: null, members: [{ userId: "@bose:workspace.example", name: "Bose" }] });
    const duo = room("!e:w", { kind: "direct", name: null, members: [{ userId: "@duo-carol:workspace.example", name: "duo-carol" }] });
    // Shuffled on purpose: the sections are the seam's own grouping, not the input order.
    renderList({ connection: connectionWith([duo, dm, channel]), session: {} as never });

    await screen.findAllByTestId("conversations-room");
    const headers = screen.getAllByTestId(/^chat-section-/);
    expect(headers.map((header) => header.getAttribute("data-testid"))).toEqual([
      "chat-section-channels",
      "chat-section-direct-messages",
      "chat-section-duos",
    ]);
    const titles = screen.getAllByTestId("room-title").map((title) => title.textContent);
    expect(titles).toEqual(["general", "Bose", "carol's duo"]);
  });

  it("a muted conversation sits last within its own section, not off the list", async () => {
    const loud = room("!loud:w", { kind: "direct", name: null, members: [{ userId: "@ana:workspace.example", name: "Ana" }], muted: false });
    const quiet = room("!quiet:w", { kind: "direct", name: null, members: [{ userId: "@bose:workspace.example", name: "Bose" }], muted: true });
    // Muted one first in the input: it must still land last once rendered.
    renderList({ connection: connectionWith([quiet, loud]), session: {} as never });

    await screen.findAllByTestId("conversations-room");
    const titles = screen.getAllByTestId("room-title").map((title) => title.textContent);
    expect(titles).toEqual(["Ana", "Bose"]);
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

describe("duo#290 — a composer draft marks the row it's waiting in", () => {
  it("shows the member's own typed-but-unsent words, with a pencil, never the word \"Draft\"", async () => {
    stubQueues([], []);
    renderList({ connection: connectionWith([room("!p:w", { name: "project-x", kind: "group", draft: "let me check with" })]), session: {} as never });
    const link = await screen.findByTestId("conversations-room");
    const preview = await within(link).findByTestId("room-draft-preview");
    expect(preview).toHaveTextContent("let me check with");
    // #1 of vocabulary.md's rules travels structurally, not just by copy
    // choice here — but the word itself is the one most likely to drift
    // back in by accident, since the issue that asked for this feature
    // (duo#290) names it "Draft" throughout. It must never appear as text
    // in this row: that noun is already spent, on the duo's own object,
    // one branch up in this same ternary (`waitingByRoom`'s "Draft ready").
    expect(preview).not.toHaveTextContent(/draft/i);
  });

  it("never shows beside a draft your duo is holding for the same room — that one needs a decision, this one is just unfinished", async () => {
    const roomId = "!p:w";
    const permalink = `https://matrix.to/#/${roomId}/$e?via=w`;
    stubQueues(
      [draftAt("d", "2026-01-01T00:00:00Z", { provenance: { origin: "channel", channelKind: "native", askerRef: "@b:w", threadId: null, permalink } })],
      [],
    );
    renderList({
      connection: connectionWith([room(roomId, { name: "project-x", kind: "group", draft: "let me check with" })]),
      session: {} as never,
    });
    const link = await screen.findByTestId("conversations-room");
    await waitFor(() => expect(within(link).getByTestId("room-preview")).toHaveTextContent("Draft ready"));
    expect(within(link).queryByTestId("room-draft-preview")).toBeNull();
  });

  it("clears the moment the account's own data says there's nothing typed — absent, same as a room that never had one", async () => {
    stubQueues([], []);
    renderList({ connection: connectionWith([room("!p:w", { name: "project-x", kind: "group" })]), session: {} as never });
    const link = await screen.findByTestId("conversations-room");
    expect(within(link).queryByTestId("room-draft-preview")).toBeNull();
    expect(within(link).getByTestId("room-preview")).toHaveTextContent("lunch?");
  });
});

describe("#298 — Unread, Mentions and Duos narrow the list, each with a count", () => {
  const channel = room("!c:w", { kind: "channel", name: "general", members: [{ userId: "@dee:workspace.example", name: "Dee" }] });
  const unread = room("!u:w", {
    kind: "direct",
    name: null,
    members: [{ userId: "@ana:workspace.example", name: "Ana" }],
    unread: { notifications: 2, mentions: 0 },
  });
  const mentioned = room("!m:w", {
    kind: "direct",
    name: null,
    members: [{ userId: "@bose:workspace.example", name: "Bose" }],
    unread: { notifications: 1, mentions: 1 },
  });
  const duo = room("!d:w", { kind: "direct", name: null, members: [{ userId: "@duo-carol:workspace.example", name: "duo-carol" }] });
  const all = [channel, unread, mentioned, duo];

  it("shows each chip's own count, from the full list — not the one narrowed by another chip", async () => {
    renderList({ connection: connectionWith(all), session: {} as never });
    await screen.findAllByTestId("conversations-room");
    expect(screen.getByTestId("unread-chip-count")).toHaveTextContent("2");
    expect(screen.getByTestId("mentions-chip-count")).toHaveTextContent("1");
    expect(screen.getByTestId("duos-chip-count")).toHaveTextContent("1");
  });

  it("Unread narrows the sections to rooms with something unread, and hides the sections that have none left", async () => {
    renderList({ connection: connectionWith(all), session: {} as never });
    await screen.findAllByTestId("conversations-room");
    fireEvent.click(screen.getByTestId("unread-chip"));
    // Ana's unread room and Bose's mentioned-and-unread room both qualify; Dee's channel and carol's duo don't — their sections disappear.
    await waitFor(() => expect(screen.getAllByTestId("room-title").map((t) => t.textContent)).toEqual(["Ana", "Bose"]));
    expect(screen.queryByTestId("chat-section-channels")).toBeNull();
    expect(screen.queryByTestId("chat-section-duos")).toBeNull();
    expect(screen.getByTestId("unread-chip")).toHaveAttribute("aria-current", "page");
  });

  it("Mentions narrows to rooms the member was mentioned in", async () => {
    renderList({ connection: connectionWith(all), session: {} as never });
    await screen.findAllByTestId("conversations-room");
    fireEvent.click(screen.getByTestId("mentions-chip"));
    await waitFor(() => expect(screen.getAllByTestId("room-title").map((t) => t.textContent)).toEqual(["Bose"]));
  });

  it("Duos narrows to colleagues' duos, combined with the section it already has", async () => {
    renderList({ connection: connectionWith(all), session: {} as never });
    await screen.findAllByTestId("conversations-room");
    fireEvent.click(screen.getByTestId("duos-chip"));
    await waitFor(() => expect(screen.getAllByTestId("room-title").map((t) => t.textContent)).toEqual(["carol's duo"]));
    expect(screen.getByTestId("chat-section-duos")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-section-channels")).toBeNull();
    expect(screen.queryByTestId("chat-section-direct-messages")).toBeNull();
  });

  it("says so, distinctly from having no conversations at all, when a filter matches nothing", async () => {
    renderList({ connection: connectionWith([channel]), session: {} as never });
    await screen.findAllByTestId("conversations-room");
    fireEvent.click(screen.getByTestId("duos-chip"));
    expect(await screen.findByTestId("conversations-filter-empty")).toHaveTextContent("No colleagues' duos here yet.");
  });

  it("remembers the last-used filter across a remount — a reload, or a phone leaving and returning to the list", async () => {
    renderList({ connection: connectionWith(all), session: {} as never });
    await screen.findAllByTestId("conversations-room");
    fireEvent.click(screen.getByTestId("duos-chip"));
    await waitFor(() => expect(screen.getByTestId("duos-chip")).toHaveAttribute("aria-current", "page"));
    expect(localStorage.getItem("duo.chat-filter")).toBe("duos");
    cleanup();
    renderList({ connection: connectionWith(all), session: {} as never });
    await screen.findAllByTestId("conversations-room");
    expect(screen.getByTestId("duos-chip")).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByTestId("room-title").map((t) => t.textContent)).toEqual(["carol's duo"]);
  });

  it("All clears a remembered filter back to the whole list", async () => {
    localStorage.setItem("duo.chat-filter", "duos");
    renderList({ connection: connectionWith(all), session: {} as never });
    await waitFor(() => expect(screen.getAllByTestId("room-title").map((t) => t.textContent)).toEqual(["carol's duo"]));
    fireEvent.click(screen.getByTestId("all-chip"));
    await waitFor(() => expect(screen.getAllByTestId("room-title").map((t) => t.textContent)).toEqual(["general", "Ana", "Bose", "carol's duo"]));
    expect(localStorage.getItem("duo.chat-filter")).toBe("all");
  });
});

describe("#296 — the owner's own sections and folders, with unread counts", () => {
  it("with no folders yet, the sidebar renders exactly as it always did — no folder header anywhere", async () => {
    renderList({ connection: connectionWithSections([room("!a:w", { name: "a" })]) });
    await screen.findByTestId("conversations-room");
    expect(screen.queryByTestId(/^chat-folder-/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-section-direct-messages")).toBeInTheDocument();
  });

  it("create, rename, reorder and delete — all from the Folders dialog (AC1)", async () => {
    renderList({ connection: connectionWithSections([room("!a:w", { name: "a" })]) });
    fireEvent.click(await screen.findByTestId("chat-list-folders"));
    const dialog = await screen.findByTestId("folders-dialog");

    fireEvent.change(within(dialog).getByTestId("new-folder-name"), { target: { value: "Ops" } });
    fireEvent.click(within(dialog).getByTestId("new-folder-add"));
    await waitFor(() => expect(within(dialog).getAllByTestId("folders-row")).toHaveLength(1));

    fireEvent.change(within(dialog).getByTestId("new-folder-name"), { target: { value: "Later" } });
    fireEvent.click(within(dialog).getByTestId("new-folder-add"));
    await waitFor(() => expect(within(dialog).getAllByTestId("folders-row")).toHaveLength(2));
    let names = within(dialog).getAllByTestId("folder-name-input").map((input) => (input as HTMLInputElement).value);
    expect(names).toEqual(["Ops", "Later"]);

    // Reorder: "Later" moves ahead of "Ops".
    fireEvent.click(within(dialog).getAllByTestId("folder-move-up")[1]!);
    await waitFor(() => {
      names = within(dialog).getAllByTestId("folder-name-input").map((input) => (input as HTMLInputElement).value);
      expect(names).toEqual(["Later", "Ops"]);
    });

    // Rename "Ops" (now second) to "Operations".
    const opsInput = within(dialog).getAllByTestId("folder-name-input")[1]!;
    fireEvent.change(opsInput, { target: { value: "Operations" } });
    fireEvent.blur(opsInput);
    await waitFor(() => expect(within(dialog).getAllByTestId("folder-name-input")[1]).toHaveValue("Operations"));

    // Delete "Later" (now first).
    fireEvent.click(within(dialog).getAllByTestId("folder-delete")[0]!);
    await waitFor(() => expect(within(dialog).getAllByTestId("folders-row")).toHaveLength(1));
    expect(within(dialog).getByTestId("folder-name-input")).toHaveValue("Operations");
  });

  it("moving a conversation into a folder takes it off the ordinary shelves and under the folder instead (AC2)", async () => {
    renderList({ connection: connectionWithSections([room("!a:w", { name: "a" })], [{ id: "ops", name: "Ops", collapsed: false, roomIds: [] }]) });
    const entry = await screen.findByTestId("conversations-entry");
    fireEvent.click(within(entry).getByTestId("room-more"));
    const select = await screen.findByTestId("room-folder");
    expect(select).toHaveValue("");

    fireEvent.change(select, { target: { value: "ops" } });

    await waitFor(() => expect(screen.getByTestId("chat-folder-ops")).toBeInTheDocument());
    const folderHeader = screen.getByTestId("chat-folder-ops");
    expect(folderHeader).toHaveTextContent("Ops");
    // The room now renders exactly once, after the folder header, not under any ordinary shelf.
    expect(screen.getAllByTestId("conversations-room")).toHaveLength(1);
    expect(screen.queryByTestId("chat-section-direct-messages")).not.toBeInTheDocument();

    // "No folder" ungroups it back — the "more" panel is still open from above.
    fireEvent.change(screen.getByTestId("room-folder"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("chat-section-direct-messages")).toBeInTheDocument());
  });

  it("a folder's own unread count sums its rooms' (AC3), and collapsing hides its rows without losing the count", async () => {
    renderList({
      connection: connectionWithSections(
        [room("!a:w", { name: "a", unread: { notifications: 3, mentions: 0 } }), room("!b:w", { name: "b", unread: { notifications: 2, mentions: 0 } })],
        [{ id: "ops", name: "Ops", collapsed: false, roomIds: ["!a:w", "!b:w"] }],
      ),
    });
    const folderHeader = await screen.findByTestId("chat-folder-ops");
    expect(within(folderHeader).getByTestId("chat-folder-ops-unread")).toHaveTextContent("5");
    expect(screen.getAllByTestId("conversations-room")).toHaveLength(2);

    fireEvent.click(folderHeader);
    await waitFor(() => expect(screen.queryAllByTestId("conversations-room")).toHaveLength(0));
    // The count is still there, even though its rows are hidden.
    expect(within(screen.getByTestId("chat-folder-ops")).getByTestId("chat-folder-ops-unread")).toHaveTextContent("5");
  });

  it("folders sync across devices: another write to the account's own data is reflected without a reload", async () => {
    const connection = connectionWithSections([room("!a:w", { name: "a" })]);
    renderList({ connection });
    await screen.findByTestId("conversations-room");
    expect(screen.queryByTestId(/^chat-folder-/)).not.toBeInTheDocument();

    // A second device writes a folder through the very same account-data door.
    await connection.setSections!([{ id: "remote", name: "From my Mac", collapsed: false, roomIds: [] }]);

    expect(await screen.findByTestId("chat-folder-remote")).toHaveTextContent("From my Mac");
  });
});
