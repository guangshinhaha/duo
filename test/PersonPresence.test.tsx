import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { ChatList } from "../src/shell/ChatList.js";
import { Room } from "../src/routes/Room.js";
import { StatusAndPresence } from "../src/components/StatusAndPresence.js";
import type { OwnStatus, PresenceState, RoomSummary, WorkspaceConnection } from "../src/workspace/matrix.js";

/*
 * #287: presence (online/away/offline) on people and DM rows, a status
 * with an end time, and hiding presence altogether.
 */

afterEach(() => {
  cleanup();
});

const api: DuoApiConfig = { baseUrl: "http://d:7717", token: "t" };

const directRoom = (overrides: Partial<RoomSummary> = {}): RoomSummary => ({
  roomId: "!direct:workspace.example",
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

describe("the chat list's presence dot and badge (#287 AC1)", () => {
  function renderList(rooms: RoomSummary[], presenceByUser: ReadonlyMap<string, { presence: PresenceState; statusMessage: string | null }>) {
    const connection = {
      rooms: async () => rooms,
      subscribe: () => () => {},
      findRooms: async () => rooms,
      searchPeople: async () => [],
      getProfile: async () => null,
      presenceOf: (userId: string) => presenceByUser.get(userId)?.presence ?? null,
      statusMessageOf: (userId: string) => presenceByUser.get(userId)?.statusMessage ?? null,
      subscribePresence: () => () => {},
    } as unknown as WorkspaceConnection;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const ui: ReactElement = (
      <QueryClientProvider client={client}>
        <ChatList api={api} connection={connection} onPairDuo={() => {}} onSignIn={() => {}} onSignOutWorkspace={() => {}} route="chats" session={null} workspaceError={null} />
      </QueryClientProvider>
    );
    return render(ui);
  }

  it("shows a dot and 'Online' beside a direct row whose other person is online", async () => {
    renderList([directRoom()], new Map([["@bose:workspace.example", { presence: "online", statusMessage: null }]]));
    const entry = await screen.findByTestId("conversations-entry");
    expect(within(entry).getByTestId("chat-avatar-presence")).toHaveAttribute("data-presence", "online");
    expect(within(entry).getByTestId("room-presence")).toHaveTextContent("Online");
  });

  it("shows 'Away' for unavailable", async () => {
    renderList([directRoom()], new Map([["@bose:workspace.example", { presence: "away", statusMessage: null }]]));
    const entry = await screen.findByTestId("conversations-entry");
    expect(within(entry).getByTestId("chat-avatar-presence")).toHaveAttribute("data-presence", "away");
    expect(within(entry).getByTestId("room-presence")).toHaveTextContent("Away");
  });

  it("draws no dot and no badge for offline, or for a person this account has never heard about — quiet until it matters", async () => {
    renderList([directRoom()], new Map([["@bose:workspace.example", { presence: "offline", statusMessage: null }]]));
    const entry = await screen.findByTestId("conversations-entry");
    expect(within(entry).queryByTestId("chat-avatar-presence")).toBeNull();
    expect(within(entry).queryByTestId("room-presence")).toBeNull();
    cleanup();

    renderList([directRoom()], new Map());
    const second = await screen.findByTestId("conversations-entry");
    expect(within(second).queryByTestId("chat-avatar-presence")).toBeNull();
  });

  it("never draws a presence dot for a group conversation", async () => {
    const group: RoomSummary = {
      ...directRoom({ kind: "group", name: "project-x", members: [{ userId: "@bose:workspace.example", name: "Bose" }] }),
    };
    renderList([group], new Map([["@bose:workspace.example", { presence: "online", statusMessage: null }]]));
    const entry = await screen.findByTestId("conversations-entry");
    expect(within(entry).queryByTestId("chat-avatar-presence")).toBeNull();
  });
});

describe("a direct room's header reads the other person's state and status (#287 AC1, AC2)", () => {
  function renderRoom(rooms: RoomSummary[], presenceByUser: ReadonlyMap<string, { presence: PresenceState; statusMessage: string | null }>) {
    const connection = {
      userId: "@ana:workspace.example",
      rooms: async () => rooms,
      timeline: async () => [],
      subscribe: () => () => {},
      readMarker: () => null,
      unreadBoundaryFrom: () => ({ kind: "none" as const }),
      markRead: async () => undefined,
      advanceReadMarker: async () => undefined,
      presenceOf: (userId: string) => presenceByUser.get(userId)?.presence ?? null,
      statusMessageOf: (userId: string) => presenceByUser.get(userId)?.statusMessage ?? null,
      subscribePresence: () => () => {},
    } as unknown as WorkspaceConnection;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <Room connection={connection} roomId={rooms[0]!.roomId} />
      </QueryClientProvider>,
    );
  }

  it("shows 'Online' when the other person is online, with their custom status appended", async () => {
    renderRoom([directRoom()], new Map([["@bose:workspace.example", { presence: "online", statusMessage: "In a meeting" }]]));
    const line = await screen.findByTestId("room-partner-presence");
    expect(line).toHaveTextContent("Online — In a meeting");
  });

  it("shows 'Offline' too — the open conversation is the one place that's worth saying, unlike a list row", async () => {
    renderRoom([directRoom()], new Map([["@bose:workspace.example", { presence: "offline", statusMessage: null }]]));
    const line = await screen.findByTestId("room-partner-presence");
    expect(line).toHaveTextContent("Offline");
  });

  it("shows nothing at all when this account has never heard any presence for them", async () => {
    renderRoom([directRoom()], new Map());
    await screen.findByTestId("room-header");
    expect(screen.queryByTestId("room-partner-presence")).toBeNull();
  });

  it("shows nothing in a group room's header — presence is a person concept here, not a room's", async () => {
    const group: RoomSummary = { ...directRoom({ kind: "group", name: "project-x" }) };
    renderRoom([group], new Map([["@bose:workspace.example", { presence: "online", statusMessage: null }]]));
    await screen.findByTestId("room-header");
    expect(screen.queryByTestId("room-partner-presence")).toBeNull();
  });
});

describe("Status & presence settings (#287 AC2, AC3)", () => {
  function fakeConnection(initial: { status: OwnStatus | null; hidden: boolean }) {
    let status = initial.status;
    let hidden = initial.hidden;
    const statusHandlers = new Set<(status: OwnStatus | null) => void>();
    const connection: WorkspaceConnection = {
      status: vi.fn(async () => status),
      setStatus: vi.fn(async (next: OwnStatus | null) => {
        status = next;
        for (const handler of statusHandlers) {
          handler(status);
        }
      }),
      subscribeStatus: vi.fn((handler: (status: OwnStatus | null) => void) => {
        statusHandlers.add(handler);
        return () => statusHandlers.delete(handler);
      }),
      presenceHidden: vi.fn(async () => hidden),
      setPresenceHidden: vi.fn(async (next: boolean) => {
        hidden = next;
      }),
    } as unknown as WorkspaceConnection;
    return connection;
  }

  function renderSettings(connection: WorkspaceConnection) {
    return render(<StatusAndPresence connection={connection} />);
  }

  it("with nothing set, offers the form; setting one shows it active with its end time in words", async () => {
    const connection = fakeConnection({ status: null, hidden: false });
    renderSettings(connection);

    expect(await screen.findByTestId("status-form")).toBeInTheDocument();
    const until = new Date(Date.now() + 60 * 60 * 1000);
    const pad = (n: number): string => String(n).padStart(2, "0");

    fireEvent.change(screen.getByTestId("status-message-input"), { target: { value: "In a meeting" } });
    fireEvent.change(screen.getByTestId("status-until-input"), {
      target: { value: `${until.getFullYear()}-${pad(until.getMonth() + 1)}-${pad(until.getDate())}T${pad(until.getHours())}:${pad(until.getMinutes())}` },
    });
    fireEvent.click(screen.getByTestId("status-set"));

    expect(await screen.findByTestId("status-active")).toBeInTheDocument();
    expect(connection.setStatus).toHaveBeenCalledWith({ message: "In a meeting", until: expect.any(String) });
  });

  it("an already-set status shows active, with 'Clear status' to remove it", async () => {
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const connection = fakeConnection({ status: { message: "In a meeting", until }, hidden: false });
    renderSettings(connection);

    expect(await screen.findByTestId("status-active-message")).toHaveTextContent("In a meeting");
    fireEvent.click(screen.getByTestId("status-clear"));

    await waitFor(() => expect(connection.setStatus).toHaveBeenCalledWith(null));
  });

  it("toggles hidden presence, reading the daemon-free, Matrix-only choice back from the connection", async () => {
    const connection = fakeConnection({ status: null, hidden: false });
    renderSettings(connection);

    const toggle = await screen.findByTestId("presence-hidden-toggle");
    expect(toggle).toHaveTextContent("Hide my presence");
    fireEvent.click(toggle);

    await waitFor(() => expect(connection.setPresenceHidden).toHaveBeenCalledWith(true));
  });
});
