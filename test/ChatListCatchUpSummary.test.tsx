import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { ChatList } from "../src/shell/ChatList.js";
import { writeCatchUpEnabled } from "../src/catchUpPrefs.js";
import { SIDEBAR_SUMMARY_UNREAD_THRESHOLD } from "../src/catchUpThresholds.js";
import type { RoomSummary, WorkspaceConnection } from "../src/workspace/matrix.js";

/*
 * duo#281: the sidebar's one-line gist replaces the ordinary preview line
 * once a room's unread count crosses the threshold — same conventions as
 * ChatList.test.tsx's own fixtures, kept in their own file so this
 * feature's setup (the global toggle, the threshold) doesn't crowd that
 * file's already-large suite.
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
    findRooms: async () => rooms,
    searchPeople: async () => [],
    getProfile: async () => null,
  } as unknown as WorkspaceConnection;
}

function renderList(connection: WorkspaceConnection) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <ChatList api={api} connection={connection} onPairDuo={() => {}} onSignIn={() => {}} onSignOutWorkspace={() => {}} route="chats" session={{} as never} workspaceError={null} />
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

describe("duo#281 — ChatList's sidebar catch-up summary", () => {
  it("shows the ordinary preview below the threshold", async () => {
    renderList(connectionWith([room("!r:w", { unread: { notifications: SIDEBAR_SUMMARY_UNREAD_THRESHOLD - 1, mentions: 0 } })]));
    const link = await screen.findByTestId("conversations-room");
    await waitFor(() => expect(within(link).getByTestId("room-preview")).toHaveTextContent("lunch?"));
    expect(within(link).queryByTestId("room-unread-summary")).toBeNull();
  });

  it("replaces the preview with a labelled summary past the threshold", async () => {
    renderList(
      connectionWith([
        room("!r:w", {
          unread: { notifications: SIDEBAR_SUMMARY_UNREAD_THRESHOLD, mentions: 0 },
          latest: { at: Date.now(), body: "let's ship Friday", senderId: "@bose:workspace.example" },
        }),
      ]),
    );
    const link = await screen.findByTestId("conversations-room");
    const summary = await within(link).findByTestId("room-unread-summary");
    expect(summary).toHaveTextContent("✦ Summary:");
    expect(summary).toHaveTextContent("let's ship Friday");
  });

  it("falls back to the ordinary preview when the global setting is off, even past the threshold", async () => {
    writeCatchUpEnabled(false);
    renderList(connectionWith([room("!r:w", { unread: { notifications: SIDEBAR_SUMMARY_UNREAD_THRESHOLD, mentions: 0 } })]));
    const link = await screen.findByTestId("conversations-room");
    await waitFor(() => expect(within(link).getByTestId("room-preview")).toBeInTheDocument());
    expect(within(link).queryByTestId("room-unread-summary")).toBeNull();
  });
});
