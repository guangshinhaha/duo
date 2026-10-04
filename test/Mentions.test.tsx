import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, signIn } from "../src/workspace/matrix.js";
import type { MentionHit, RoomSummary, WorkspaceConnection, WorkspaceSession } from "../src/workspace/matrix.js";
import { unreadCountOf, visibleMentions } from "../src/shell/mentions.js";

/*
 * #222: one place for every mention across conversations. This is the raw
 * `@mentions` of the member — the homeserver's own highlight notifications
 * — never "Waiting on you" (that is the duo's drafts awaiting the owner's
 * decision, a different queue for a different question). The decision this
 * feature makes: Mentions is its OWN nav item, reachable without a paired
 * duo (it is about the member's own workspace, not their duo), and never
 * folded into Waiting on you.
 *
 * The seam is mocked wholesale, as in the other workspace suites; its half
 * of the contract (the wire request, the projection, the sort) is pinned by
 * WorkspaceMentionsSeam.test.ts.
 */
vi.mock("../src/workspace/matrix.js", () => ({
  signIn: vi.fn(),
  connect: vi.fn(),
}));

const SESSION: WorkspaceSession = {
  homeserverUrl: "https://workspace.example",
  userId: "@ana:workspace.example",
  accessToken: "syt_workspace_token",
  deviceId: "YGBNAUIOMK",
};

const PROJECT = "!project-x:workspace.example";
const DIRECT = "!direct:workspace.example";

function roomsFixture(): RoomSummary[] {
  return [
    {
      roomId: DIRECT,
      kind: "direct",
      name: null,
      topic: null,
      avatarUrl: null,
      members: [{ userId: "@bose:workspace.example", name: "Bose" }],
      latest: { at: Date.now() - 3_600_000, body: "lunch?" },
      unread: { notifications: 0, mentions: 0 },
      muted: false,
      notifications: "all",
      canEdit: { name: false, topic: false, avatar: false },
    },
    {
      roomId: PROJECT,
      kind: "group",
      name: "project-x",
      topic: null,
      avatarUrl: null,
      members: [{ userId: "@bose:workspace.example", name: "Bose" }],
      latest: { at: Date.now() - 7_200_000, body: "ship it" },
      unread: { notifications: 0, mentions: 0 },
      muted: false,
      notifications: "all",
      canEdit: { name: false, topic: false, avatar: false },
    },
  ];
}

function hitFor(over: Partial<MentionHit> & Pick<MentionHit, "eventId" | "roomId" | "senderId" | "body" | "originServerTs">): MentionHit {
  return {
    senderName: "",
    read: false,
    threadRootEventId: null,
    ...over,
  };
}

const OLDER = hitFor({
  eventId: "$older",
  roomId: PROJECT,
  senderId: "@bose:workspace.example",
  senderName: "Bose",
  body: "@ana can you take a look at the project plan?",
  originServerTs: 1_700_000_000_000,
});

const NEWER = hitFor({
  eventId: "$newer",
  roomId: DIRECT,
  senderId: "@bose:workspace.example",
  senderName: "Bose",
  body: "@ana lunch today?",
  originServerTs: 1_700_000_500_000,
});

function fakeConnection(state: { rooms: RoomSummary[]; mentions: MentionHit[] }) {
  const connection = {
    userId: SESSION.userId,
    rooms: vi.fn(async () => state.rooms.map((room) => ({ ...room, members: [...room.members] }))),
    timeline: vi.fn(async () => []),
    timelineAt: vi.fn(async () => []),
    searchMessages: vi.fn(async () => ({ hits: [], next: null })),
    mentions: vi.fn(async () => [...state.mentions]),
    markRead: vi.fn(async () => {}),
    searchPeople: vi.fn(async () => []),
    findRooms: vi.fn(async () => []),
    getProfile: vi.fn(async () => null),
    subscribe: vi.fn(() => () => {}),
    stop: vi.fn(async () => {}),
  } as unknown as WorkspaceConnection;
  return connection;
}

function navigate(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
}

async function renderApp() {
  vi.resetModules();
  const { App } = await import("../src/App.js");
  return render(<App />);
}

function seedSession() {
  localStorage.setItem("duo.workspace-session", JSON.stringify(SESSION));
}

function seedPairing() {
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
}

beforeAll(async () => {
  await import("../src/App.js");
}, 30_000);

beforeEach(() => {
  localStorage.clear();
  vi.mocked(signIn).mockReset();
  vi.mocked(connect).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

describe("#222 — the pure half: which mentions show, and what the badge counts", () => {
  it("dismissed mentions drop out of the visible list, in the order they were given", () => {
    const visible = visibleMentions([NEWER, OLDER], new Set(["$newer"]));
    expect(visible.map((hit) => hit.eventId)).toEqual(["$older"]);
  });

  it("nothing dismissed is everything visible", () => {
    expect(visibleMentions([NEWER, OLDER], new Set())).toEqual([NEWER, OLDER]);
  });

  it("the unread count is the visible mentions the homeserver hasn't recorded a receipt past", () => {
    const read = hitFor({ ...OLDER, read: true });
    expect(unreadCountOf([NEWER, read])).toBe(1);
    expect(unreadCountOf([read])).toBe(0);
    expect(unreadCountOf([])).toBe(0);
  });
});

describe("#222 AC1 — a Mentions view lists messages that mention me, newest first, across conversations", () => {
  it("is reachable from navigation, beside Settings — its own nav item, not a filter of the chat list", async () => {
    const connection = fakeConnection({ rooms: roomsFixture(), mentions: [NEWER, OLDER] });
    seedSession();
    vi.mocked(connect).mockResolvedValue(connection);
    await renderApp();
    await screen.findByTestId("conversations-list");

    const link = screen.getByTestId("chat-list-mentions");
    expect(link).toHaveAttribute("href", "#mentions");

    navigate(link.getAttribute("href")!);

    expect(await screen.findByTestId("mentions-page")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Mentions" })).toBeInTheDocument();
  });

  it("lists mentions from multiple conversations, newest first", async () => {
    const connection = fakeConnection({ rooms: roomsFixture(), mentions: [NEWER, OLDER] });
    seedSession();
    vi.mocked(connect).mockResolvedValue(connection);
    await renderApp();
    await screen.findByTestId("conversations-list");

    navigate("#mentions");

    const items = await screen.findAllByTestId("mention-item");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("@ana lunch today?")).toBeInTheDocument();
    expect(within(items[0]!).getByTestId("mention-room")).toHaveTextContent("Bose");
    expect(within(items[1]!).getByText("@ana can you take a look at the project plan?")).toBeInTheDocument();
    expect(within(items[1]!).getByTestId("mention-room")).toHaveTextContent("project-x");
  });

  it("an empty workspace reads as an empty state, not a blank page", async () => {
    const connection = fakeConnection({ rooms: roomsFixture(), mentions: [] });
    seedSession();
    vi.mocked(connect).mockResolvedValue(connection);
    await renderApp();
    await screen.findByTestId("conversations-list");

    navigate("#mentions");

    expect(await screen.findByTestId("mentions-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("mention-item")).toBeNull();
  });
});

describe("#222 AC2 — each item opens the message in its conversation", () => {
  it("opens the room at that exact message (#70's scroll-to-message mechanism)", async () => {
    const connection = fakeConnection({ rooms: roomsFixture(), mentions: [OLDER] });
    seedSession();
    vi.mocked(connect).mockResolvedValue(connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#mentions");

    const [item] = await screen.findAllByTestId("mention-item");
    const open = within(item!).getByTestId("mention-open");
    expect(open).toHaveAttribute("href", `#chat/${encodeURIComponent(PROJECT)}/${encodeURIComponent("$older")}`);

    navigate(open.getAttribute("href")!);

    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
    expect(connection.timelineAt).toHaveBeenCalledWith(PROJECT, "$older");
  });

  it("a mention inside a thread opens that thread, with the mention marked", async () => {
    const threaded = hitFor({
      eventId: "$reply",
      roomId: PROJECT,
      senderId: "@bose:workspace.example",
      senderName: "Bose",
      body: "@ana answering in-thread",
      originServerTs: 1_700_000_900_000,
      threadRootEventId: "$root",
    });
    const connection = fakeConnection({ rooms: roomsFixture(), mentions: [threaded] });
    seedSession();
    vi.mocked(connect).mockResolvedValue(connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#mentions");

    const [item] = await screen.findAllByTestId("mention-item");
    const open = within(item!).getByTestId("mention-open");
    expect(open).toHaveAttribute(
      "href",
      `#chat/${encodeURIComponent(PROJECT)}/thread/${encodeURIComponent("$root")}/${encodeURIComponent("$reply")}`,
    );
  });
});

describe("#222 — dismissing a mention", () => {
  it("dismiss removes it from the list, and it stays dismissed across a refresh of this device", async () => {
    const connection = fakeConnection({ rooms: roomsFixture(), mentions: [NEWER, OLDER] });
    seedSession();
    vi.mocked(connect).mockResolvedValue(connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#mentions");

    const items = await screen.findAllByTestId("mention-item");
    expect(items).toHaveLength(2);
    fireEvent.click(within(items[0]!).getByTestId("mention-dismiss"));

    await waitFor(() => expect(screen.getAllByTestId("mention-item")).toHaveLength(1));
    expect(screen.queryByText("@ana lunch today?")).toBeNull();
    expect(screen.getByText("@ana can you take a look at the project plan?")).toBeInTheDocument();

    // Dismissal is this device's own bookkeeping — a fresh mount reads it back.
    cleanup();
    await renderApp();
    vi.mocked(connect).mockResolvedValue(connection);
    navigate("#mentions");
    await screen.findByTestId("mentions-page");
    await waitFor(() => expect(screen.getAllByTestId("mention-item")).toHaveLength(1));
  });
});

describe("#222 — Mentions is separate from Waiting on you", () => {
  it("works without a paired duo — it is the member's own workspace, not their duo's drafts", async () => {
    const connection = fakeConnection({ rooms: roomsFixture(), mentions: [OLDER] });
    seedSession();
    // No seedPairing(): no duo is paired on this device.
    vi.mocked(connect).mockResolvedValue(connection);
    await renderApp();
    await screen.findByTestId("conversations-list");

    navigate("#mentions");

    // The sidebar may offer to pair a duo (it has no duo row to show) — that is
    // not this assertion. The PANE — what #mentions actually renders — must
    // be the Mentions page itself, not a "pair your duo" refusal.
    const pane = await screen.findByTestId("pane");
    expect(within(pane).getByTestId("mentions-page")).toBeInTheDocument();
    expect(within(pane).queryByTestId("no-duo")).toBeNull();
    expect(await screen.findAllByTestId("mention-item")).toHaveLength(1);
  });

  it("the nav badge counts unread mentions, the same 'what's new' idiom as every other badge — and is distinct from the Waiting badge", async () => {
    const unread = hitFor({ ...OLDER, read: false });
    const connection = fakeConnection({ rooms: roomsFixture(), mentions: [unread] });
    seedSession();
    seedPairing();
    vi.mocked(connect).mockResolvedValue(connection);
    await renderApp();
    await screen.findByTestId("conversations-list");

    expect(await screen.findByTestId("chat-list-mentions-badge")).toHaveTextContent("1");
    // Waiting's own badge is a different element entirely, and reads zero here (no drafts, no confirmations fixture).
    expect(screen.queryByTestId("waiting-badge")).toBeNull();
  });
});
