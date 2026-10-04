import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandSearch } from "../src/components/CommandSearch.js";
import type { RoomSummary, WorkspaceConnection } from "../src/workspace/matrix.js";

/*
 * #207: one search box that finds people, conversations and messages, with
 * suggestions as the member types. The matching RULES (the three merged
 * people sources, the DM-reuse in `startDirect`, local matching on a room's
 * own name and a direct conversation's partner) are pinned at the seam —
 * WorkspaceMatrixSeam.test.ts. This file drives the box itself: does typing
 * ask the right things at the right time (local, instant; people, debounced),
 * does a person who already has a DM read as the conversation and not twice,
 * do the keys move and choose, and does the message hand-off still work.
 */

const PROJECT = "!project-x:workspace.example";
const DIRECT_WITH_BOSE = "!direct-bose:workspace.example";

function room(over: Partial<RoomSummary> & Pick<RoomSummary, "roomId">): RoomSummary {
  return {
    kind: "group",
    name: null,
    topic: null,
    avatarUrl: null,
    members: [],
    latest: null,
    unread: { notifications: 0, mentions: 0 },
    muted: false,
    notifications: "all",
    canEdit: { name: false, topic: false, avatar: false },
    ...over,
  };
}

const ROOMS: RoomSummary[] = [
  room({ roomId: PROJECT, kind: "group", name: "project-x", members: [{ userId: "@dee:workspace.example", name: "Dee" }] }),
  room({ roomId: DIRECT_WITH_BOSE, kind: "direct", members: [{ userId: "@bose:workspace.example", name: "Bose" }] }),
];

function titleOf(r: RoomSummary): string {
  return r.name ?? r.members[0]?.name ?? r.roomId;
}

/** A connection whose `findRooms`/`searchPeople` are spies over fixed answers, and whose `startDirect` is a resolvable promise the test controls. */
function fakeConnection(over: {
  rooms?: RoomSummary[];
  people?: Array<{ userId: string; name: string }>;
  startDirect?: (userId: string) => Promise<string>;
  getProfile?: (userId: string) => Promise<{ userId: string; name: string; avatarUrl: string | null } | null>;
}) {
  const rooms = over.rooms ?? ROOMS;
  const findRooms = vi.fn(async (query: string) => {
    const needle = query.trim().toLowerCase();
    if (needle === "") {
      return rooms;
    }
    return rooms.filter(
      (r) => (r.name ?? "").toLowerCase().includes(needle) || r.members.some((m) => (m.name ?? "").toLowerCase().includes(needle)),
    );
  });
  // The real directory matches on name, id and domain (client-server API
  // §User directory search), so the fake does too — a duo's own id
  // ("@duo-carol:…") is how it is found even though its display name lies.
  const searchPeople = vi.fn(async (query: string) => {
    const needle = query.toLowerCase();
    return (over.people ?? []).filter((p) => p.name.toLowerCase().includes(needle) || p.userId.toLowerCase().includes(needle));
  });
  const connection = {
    userId: "@ana:workspace.example",
    findRooms,
    searchPeople,
    startDirect: vi.fn(over.startDirect ?? (async (userId: string) => `!fresh-${userId}`)),
    getProfile: vi.fn(over.getProfile ?? (async () => null)),
    searchMessages: vi.fn(async () => ({ hits: [], next: null })),
  } as unknown as WorkspaceConnection;
  return { connection, findRooms, searchPeople };
}

function renderCommandSearch(props: Partial<Parameters<typeof CommandSearch>[0]> & { connection: WorkspaceConnection }) {
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
});

describe("#207 — conversations filter locally, on every keystroke, with no network", () => {
  it("calls findRooms again after each keystroke, synchronously with typing — never a debounce", async () => {
    const fake = fakeConnection({});
    renderCommandSearch({ connection: fake.connection });

    fireEvent.change(input(), { target: { value: "p" } });
    fireEvent.change(input(), { target: { value: "pr" } });
    fireEvent.change(input(), { target: { value: "pro" } });

    // Every keystroke asked findRooms with the query as it stood then — no
    // waiting for a pause, the way the debounced people search does.
    await waitFor(() => expect(fake.findRooms).toHaveBeenCalledWith("pro"));
    expect(fake.findRooms.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(["p", "pr", "pro"]));
  });

  it("an empty box, once opened, shows the member's conversations as Recent", async () => {
    const fake = fakeConnection({});
    renderCommandSearch({ connection: fake.connection });

    fireEvent.focus(input());

    expect(await screen.findByTestId("command-search-section-conversations")).toHaveTextContent("Recent");
    expect(screen.getAllByTestId("command-search-room")).toHaveLength(ROOMS.length);
  });

  it("matches a direct conversation by its partner's name, not just the room's own (nameless) title", async () => {
    const fake = fakeConnection({});
    renderCommandSearch({ connection: fake.connection });

    fireEvent.change(input(), { target: { value: "bose" } });

    const rows = await screen.findAllByTestId("command-search-room");
    expect(rows.map((row) => row.textContent)).toEqual(["Bose"]);
  });
});

describe("#207 — people come from the directory, debounced", () => {
  it("waits for a pause in typing before asking the directory", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fake = fakeConnection({ people: [{ userId: "@carol:workspace.example", name: "Carol" }] });
      renderCommandSearch({ connection: fake.connection });

      fireEvent.change(input(), { target: { value: "car" } });
      expect(fake.searchPeople).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(150);
      expect(fake.searchPeople).toHaveBeenCalledWith("car");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a person is found by name, under People", async () => {
    const fake = fakeConnection({ people: [{ userId: "@carol:workspace.example", name: "Carol" }] });
    renderCommandSearch({ connection: fake.connection });

    fireEvent.change(input(), { target: { value: "carol" } });

    expect(await screen.findByTestId("command-search-person")).toHaveTextContent("Carol");
  });

  it("a colleague's duo reads as their duo, from the id grammar — never the display name it claims", async () => {
    const fake = fakeConnection({ people: [{ userId: "@duo-carol:workspace.example", name: "Totally A Person" }] });
    renderCommandSearch({ connection: fake.connection });

    fireEvent.change(input(), { target: { value: "carol" } });

    const row = await screen.findByTestId("command-search-person");
    expect(row).toHaveTextContent("carol's duo");
    expect(row).not.toHaveTextContent("Totally A Person");
  });

  it("#247: when both carol and her duo match, only carol's row shows — her duo belongs to her, not a second result", async () => {
    const fake = fakeConnection({
      people: [
        { userId: "@carol:workspace.example", name: "Carol" },
        { userId: "@duo-carol:workspace.example", name: "duo-carol" },
      ],
    });
    renderCommandSearch({ connection: fake.connection });

    fireEvent.change(input(), { target: { value: "carol" } });

    const rows = await screen.findAllByTestId("command-search-person");
    expect(rows.map((row) => row.textContent)).toEqual(["Carol"]);
  });
});

describe("#207 — a person who already has a DM reads as that conversation, not twice", () => {
  it("Bose has a direct conversation already — searching 'bose' shows the conversation, and Bose is not also listed under People", async () => {
    const fake = fakeConnection({ people: [{ userId: "@bose:workspace.example", name: "Bose" }] });
    renderCommandSearch({ connection: fake.connection });

    fireEvent.change(input(), { target: { value: "bose" } });

    await screen.findAllByTestId("command-search-room");
    expect(screen.queryByTestId("command-search-person")).toBeNull();
  });
});

describe("#207 — choosing a suggestion", () => {
  it("a conversation opens it — the address the rest of the app already navigates by", async () => {
    const fake = fakeConnection({});
    renderCommandSearch({ connection: fake.connection });
    fireEvent.focus(input());
    const [first] = await screen.findAllByTestId("command-search-room");

    fireEvent.click(first!);

    expect(window.location.hash).toBe(`#chat/${encodeURIComponent(PROJECT)}`);
  });

  it("a person opens their profile, and Message starts (or reuses) the direct conversation", async () => {
    const onStartedConversation = vi.fn();
    const fake = fakeConnection({
      people: [{ userId: "@carol:workspace.example", name: "Carol" }],
      startDirect: async (userId) => {
        expect(userId).toBe("@carol:workspace.example");
        return "!with-carol:workspace.example";
      },
    });
    renderCommandSearch({ connection: fake.connection, onStartedConversation });

    fireEvent.change(input(), { target: { value: "carol" } });
    fireEvent.click(await screen.findByTestId("command-search-person"));

    expect(await screen.findByTestId("person-profile-name")).toHaveTextContent("Carol");
    fireEvent.click(screen.getByTestId("person-profile-message"));

    await waitFor(() => expect(onStartedConversation).toHaveBeenCalledWith("!with-carol:workspace.example"));
  });

  it("'Search messages for …' hands off to the message search, in place of the conversation list", async () => {
    const fake = fakeConnection({});
    renderCommandSearch({ connection: fake.connection });

    fireEvent.change(input(), { target: { value: "refund" } });
    fireEvent.click(await screen.findByTestId("command-search-messages"));

    expect(await screen.findByTestId("message-search-results")).toBeInTheDocument();
    expect(screen.queryByTestId("the-list")).toBeNull();
    expect(fake.connection.searchMessages).toHaveBeenCalledWith("refund", undefined);

    fireEvent.click(screen.getByTestId("message-search-clear"));
    expect(await screen.findByTestId("the-list")).toBeInTheDocument();
  });
});

describe("#207 — the keys move and choose, without a mouse", () => {
  it("↓ highlights the next suggestion, Enter opens it, and Esc closes the dropdown", async () => {
    const fake = fakeConnection({});
    renderCommandSearch({ connection: fake.connection });
    fireEvent.focus(input());
    await screen.findAllByTestId("command-search-room");

    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });

    // The second Recent row (index 1) is the direct conversation with Bose.
    expect(window.location.hash).toBe(`#chat/${encodeURIComponent(DIRECT_WITH_BOSE)}`);
  });

  it("Escape closes the suggestions and returns the list", async () => {
    const fake = fakeConnection({});
    renderCommandSearch({ connection: fake.connection });
    fireEvent.focus(input());
    await screen.findByTestId("command-search-listbox");

    fireEvent.keyDown(input(), { key: "Escape" });

    expect(screen.queryByTestId("command-search-listbox")).toBeNull();
    expect(screen.getByTestId("the-list")).toBeInTheDocument();
  });

  it("↑ from the top wraps to the last suggestion", async () => {
    const fake = fakeConnection({ people: [{ userId: "@carol:workspace.example", name: "Carol" }] });
    renderCommandSearch({ connection: fake.connection });

    fireEvent.change(input(), { target: { value: "carol" } });
    await screen.findByTestId("command-search-messages");

    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(await screen.findByTestId("message-search-results")).toBeInTheDocument();
  });
});

describe("#207 — another org's person never appears", () => {
  it("a name the directory and local membership both refuse (the org wall, #235) never surfaces, even as a suggestion", async () => {
    // The directory itself is the org wall's enforcement point (membership-
    // scoped search_all_users:false); the client adds no filtering of its
    // own, so a mocked directory that simply never answers for them is
    // exactly how the wall reads from here.
    const fake = fakeConnection({ people: [] });
    renderCommandSearch({ connection: fake.connection });

    fireEvent.change(input(), { target: { value: "stranger" } });

    await waitFor(() => expect(fake.searchPeople).toHaveBeenCalledWith("stranger"));
    expect(screen.queryByTestId("command-search-person")).toBeNull();
    expect(screen.getByTestId("command-search-empty")).toBeInTheDocument();
  });
});
