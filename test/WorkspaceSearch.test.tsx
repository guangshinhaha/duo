// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, signIn } from "../src/workspace/matrix.js";
import type {
  MessageSearchHit,
  MessageSearchPage,
  RoomMessage,
  RoomSummary,
  WorkspaceConnection,
  WorkspaceSession,
} from "../src/workspace/matrix.js";

/*
 * #70: search conversations. There are two searches in this product and the
 * suite holds them apart from both ends: MESSAGES (what people and duos said,
 * on the workspace server — shared, membership-scoped, the homeserver's own
 * `/search`) and the CORPUS (what a duo knows, on its owner's Mac — #46,
 * private). The surface adds no search of its own: it asks the workspace, and
 * renders the answer — attributed the way every other message is (#60), from
 * the sender's id, never from a name.
 *
 * The seam is mocked wholesale, as in the other workspace suites; its half of
 * the contract (the wire body, the projection, the membership guard) is pinned
 * by WorkspaceSearchSeam.test.ts.
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
/** A room the member is NOT in — the workspace holds it, the member never sees it. */
const SECRET = "!leadership:workspace.example";

// #207: the sidebar box widened from message-only search to the one box
// (CommandSearch.tsx) that also finds people and conversations; its
// accessible name says so now. Typing and choosing "Search messages for
// '…'" still runs exactly this file's message search — `searchFor` drives
// that hand-off instead of a dedicated submit button.
const SEARCH_LABEL = "Search the workspace";

function roomsFixture(): RoomSummary[] {
  const now = Date.now();
  return [
    {
      roomId: DIRECT,
      kind: "direct",
      name: null,
      topic: null,
      avatarUrl: null,
      members: [{ userId: "@bose:workspace.example", name: "Bose" }],
      latest: { at: now - 3_600_000, body: "lunch?" },
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
      members: [
        { userId: "@bose:workspace.example", name: "Bose" },
        { userId: "@duo-carol:workspace.example", name: "duo-carol" },
      ],
      latest: { at: now - 7_200_000, body: "ship it" },
      unread: { notifications: 0, mentions: 0 },
      muted: false,
      notifications: "all",
      canEdit: { name: false, topic: false, avatar: false },
    },
  ];
}

function messageFor(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId" | "senderId" | "body">): RoomMessage {
  return {
    roomId: PROJECT,
    senderName: "",
    originServerTs: 1_700_000_000_000,
    edited: false,
    redacted: false,
    reactions: [],
    thread: null,
    threadRootEventId: null,
    replyToEventId: null,
    parts: null,
    ...over,
  };
}

function hitFor(over: Partial<MessageSearchHit> & Pick<MessageSearchHit, "eventId" | "senderId" | "body">): MessageSearchHit {
  return {
    roomId: PROJECT,
    senderName: "",
    originServerTs: 1_700_000_000_000,
    threadRootEventId: null,
    context: { before: [], after: [] },
    ...over,
  };
}

/** The hit the conversation-opening tests drive: a person's question with the duo's answer just after it. */
const QUESTION_HIT = hitFor({
  eventId: "$q",
  senderId: "@bose:workspace.example",
  senderName: "Bose",
  body: "what's our refund policy?",
  context: {
    before: [{ senderId: "@bose:workspace.example", senderName: "Bose", body: "quick one before standup" }],
    after: [{ senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "Refunds within 30 days, full amount." }],
  },
});

/** The duo's answer — its sender NAME lies (claims to be Carol herself); its ID is what says whose duo it is. */
const DUO_HIT = hitFor({
  eventId: "$a",
  senderId: "@duo-carol:workspace.example",
  senderName: "Carol",
  body: "Refunds within 30 days, full amount.",
  originServerTs: 1_700_000_000_500,
});

/** What the window around the question holds: history the live timeline never carried. */
const AROUND_QUESTION: RoomMessage[] = [
  messageFor({ eventId: "$before", senderId: "@bose:workspace.example", senderName: "Bose", body: "quick one before standup" }),
  messageFor({ eventId: "$q", senderId: "@bose:workspace.example", senderName: "Bose", body: "what's our refund policy?" }),
  messageFor({ eventId: "$a", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "Refunds within 30 days, full amount." }),
];

const LIVE_PROJECT: RoomMessage[] = [
  messageFor({ eventId: "$recent", senderId: "@bose:workspace.example", senderName: "Bose", body: "ship it" }),
];

/**
 * A fake connection that plays the WORKSPACE's half of search: `index` is
 * everything the homeserver has indexed across ALL its rooms, and
 * `searchMessages` answers the way the server's contract does — scoped to
 * the rooms the caller is in, matched on the words, paged by a token. The
 * client never sees a message the server didn't hand it, which is exactly
 * what the membership ACs are about. Only the members the surface reaches
 * are modelled; the cast keeps this file independent of every other verb the
 * connection grows.
 */
function searchConnection(state: {
  rooms: RoomSummary[];
  live?: Record<string, RoomMessage[]>;
  around?: Record<string, RoomMessage[]>;
  index: MessageSearchHit[];
  pageSize?: number;
  failWith?: Error;
}) {
  let listener: ((roomId: string) => void) | null = null;
  const searchMessages = vi.fn(async (query: string, next?: string): Promise<MessageSearchPage> => {
    if (state.failWith) {
      throw state.failWith;
    }
    const memberOf = new Set(state.rooms.map((room) => room.roomId));
    const matching = state.index.filter(
      (hit) => memberOf.has(hit.roomId) && hit.body.toLowerCase().includes(query.trim().toLowerCase()),
    );
    const size = state.pageSize ?? 50;
    const from = next === undefined ? 0 : Number(next);
    const hits = matching.slice(from, from + size);
    return { hits, next: from + size < matching.length ? String(from + size) : null };
  });
  const connection = {
    userId: SESSION.userId,
    rooms: vi.fn(async () => state.rooms.map((room) => ({ ...room, members: [...room.members] }))),
    timeline: vi.fn(async (roomId: string) => [...(state.live?.[roomId] ?? [])]),
    timelineAt: vi.fn(async (_roomId: string, eventId: string) => [...(state.around?.[eventId] ?? [])]),
    searchMessages,
    markRead: vi.fn(async () => {}),
    // #207: CommandSearch's local filter runs on every mount/keystroke, and
    // its people section debounces — this file is about message search
    // (and the two searches staying apart), so these are minimal fakes; the
    // matching rules themselves are pinned at the seam and in
    // CommandSearch.test.tsx.
    findRooms: vi.fn(async (query: string) => {
      const needle = query.trim().toLowerCase();
      return needle === "" ? state.rooms : state.rooms.filter((room) => (room.name ?? "").toLowerCase().includes(needle));
    }),
    searchPeople: vi.fn(async () => []),
    getProfile: vi.fn(async () => null),
    subscribe: vi.fn((handler: (roomId: string) => void) => {
      listener = handler;
      return () => {
        listener = null;
      };
    }),
    stop: vi.fn(async () => {}),
  } as unknown as WorkspaceConnection;
  return { connection, searchMessages, arrive: (roomId: string) => listener?.(roomId) };
}

function navigate(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
}

/** Fresh module registry per render: the app's module-level QueryClient must not carry cache across tests. */
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

async function openConversations(fake: ReturnType<typeof searchConnection>) {
  seedSession();
  vi.mocked(connect).mockResolvedValue(fake.connection);
  await renderApp();
  await screen.findByTestId("conversations-list");
}

/**
 * #207: the box now suggests as you type rather than searching messages on
 * every submit — running a message search is choosing the explicit
 * "Search messages for '…'" row (CommandSearch.tsx). A blank or
 * whitespace-only term never gets that far (there is nothing to hand off
 * to), matching the old "an empty box asks nothing of the workspace" rule.
 */
async function searchFor(term: string) {
  fireEvent.change(screen.getByRole("combobox", { name: SEARCH_LABEL }), { target: { value: term } });
  if (term.trim() === "") {
    return;
  }
  fireEvent.click(await screen.findByTestId("command-search-messages"));
}

// The app's first import is the slow one (the whole route tree); pay it
// before the clock starts on any one test.
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

describe("#70 AC1 — messages are searchable", () => {
  it("matching messages return with their conversation and their author", async () => {
    const fake = searchConnection({ rooms: roomsFixture(), index: [QUESTION_HIT, DUO_HIT] });
    await openConversations(fake);

    await searchFor("refund");

    const hits = await screen.findAllByTestId("message-search-hit");
    expect(hits).toHaveLength(2);
    expect(within(hits[0]!).getByTestId("message-search-hit-room")).toHaveTextContent("project-x");
    expect(within(hits[0]!).getByTestId("room-person-message-author")).toHaveTextContent("Bose");
    expect(within(hits[0]!).getByText("what's our refund policy?")).toBeInTheDocument();
    // The search asked the workspace, with the words as typed — the client
    // ranks, filters and scopes nothing itself.
    expect(fake.searchMessages).toHaveBeenCalledWith("refund", undefined);
  });

  it("a hit in a conversation without a name reads under its members, the way the list does", async () => {
    const fake = searchConnection({
      rooms: roomsFixture(),
      index: [hitFor({ eventId: "$l", roomId: DIRECT, senderId: "@bose:workspace.example", senderName: "Bose", body: "lunch at noon?" })],
    });
    await openConversations(fake);

    await searchFor("lunch");

    const [hit] = await screen.findAllByTestId("message-search-hit");
    expect(within(hit!).getByTestId("message-search-hit-room")).toHaveTextContent("Bose");
  });

  it("a hit carries the words around it, each line attributed by its sender's id", async () => {
    const fake = searchConnection({ rooms: roomsFixture(), index: [QUESTION_HIT] });
    await openConversations(fake);

    await searchFor("refund");

    const [hit] = await screen.findAllByTestId("message-search-hit");
    const lines = within(hit!).getAllByTestId("message-search-context");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("Bose: quick one before standup");
    // The duo's line is labelled from the id grammar — "carol's duo", never the claimed "duo-carol".
    expect(lines[1]).toHaveTextContent("carol's duo: Refunds within 30 days, full amount.");
  });

  it("opening a hit lands at that message in its conversation, in context — history the live timeline never carried", async () => {
    // #248: the transcript is virtualized — landing is the virtualizer scrolling its own container to the row.
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
    try {
      const fake = searchConnection({
        rooms: roomsFixture(),
        live: { [PROJECT]: LIVE_PROJECT },
        around: { $q: AROUND_QUESTION },
        index: [QUESTION_HIT],
      });
      await openConversations(fake);
      await searchFor("refund");
      const [hit] = await screen.findAllByTestId("message-search-hit");
      const open = within(hit!).getByTestId("message-search-hit-open");
      expect(open).toHaveAttribute("href", `#chat/${encodeURIComponent(PROJECT)}/${encodeURIComponent("$q")}`);

      navigate(open.getAttribute("href")!);

      expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
      expect(fake.connection.timelineAt).toHaveBeenCalledWith(PROJECT, "$q");
      // The window around the hit is what renders: the message before it, the message itself, the answer after.
      expect(await screen.findByText("quick one before standup")).toBeInTheDocument();
      expect(screen.getByText("Refunds within 30 days, full amount.")).toBeInTheDocument();
      // And the hit is marked, and brought into view.
      const focused = screen.getAllByTestId("room-message").filter((row) => row.getAttribute("data-focused") === "true");
      expect(focused).toHaveLength(1);
      expect(within(focused[0]!).getByText("what's our refund policy?")).toBeInTheDocument();
      await waitFor(() => expect(scrollTo).toHaveBeenCalled());
      // The window is not the room's latest: nothing pretends the member read up to here (#63's receipt is for reading the latest).
      expect(fake.connection.markRead).not.toHaveBeenCalled();
      // The way back to the live conversation is one link away.
      expect(screen.getByTestId("room-back-to-latest")).toHaveAttribute("href", `#chat/${encodeURIComponent(PROJECT)}`);
    } finally {
      scrollTo.mockRestore();
    }
  });

  it("an address to a message the workspace no longer returns says so, rather than landing somewhere else quietly", async () => {
    const fake = searchConnection({ rooms: roomsFixture(), live: { [PROJECT]: LIVE_PROJECT }, around: {}, index: [] });
    await openConversations(fake);

    navigate(`#chat/${encodeURIComponent(PROJECT)}/${encodeURIComponent("$gone")}`);

    expect(await screen.findByTestId("room-at-missing")).toHaveTextContent("isn't in what the workspace returned");
    expect(screen.queryByTestId("room-empty")).toBeNull();
    expect(screen.getByTestId("room-back-to-latest")).toBeInTheDocument();
  });

  it("a hit inside a thread opens that thread with the reply marked", async () => {
    const reply = hitFor({
      eventId: "$r1",
      senderId: "@duo-carol:workspace.example",
      senderName: "duo-carol",
      body: "np, 30 days for refunds",
      threadRootEventId: "$q",
    });
    const fake = searchConnection({
      rooms: roomsFixture(),
      live: {
        [PROJECT]: [
          messageFor({
            eventId: "$q",
            senderId: "@bose:workspace.example",
            senderName: "Bose",
            body: "what's our refund policy?",
            thread: { replyCount: 1, latestReply: { senderId: reply.senderId, senderName: "duo-carol", body: reply.body } },
          }),
          messageFor({ eventId: "$r1", senderId: reply.senderId, senderName: "duo-carol", body: reply.body, threadRootEventId: "$q" }),
        ],
      },
      around: { $r1: [messageFor({ eventId: "$r1", senderId: reply.senderId, senderName: "duo-carol", body: reply.body, threadRootEventId: "$q" })] },
      index: [reply],
    });
    await openConversations(fake);
    await searchFor("30 days");
    const [hit] = await screen.findAllByTestId("message-search-hit");
    const open = within(hit!).getByTestId("message-search-hit-open");
    expect(open).toHaveAttribute(
      "href",
      `#chat/${encodeURIComponent(PROJECT)}/thread/${encodeURIComponent("$q")}/${encodeURIComponent("$r1")}`,
    );

    navigate(open.getAttribute("href")!);

    expect(await screen.findByTestId("thread-timeline")).toBeInTheDocument();
    // The root and the reply both read, and the reply is the marked one.
    expect(await screen.findByText("what's our refund policy?")).toBeInTheDocument();
    const focused = screen.getAllByTestId("room-message").filter((row) => row.getAttribute("data-focused") === "true");
    expect(focused).toHaveLength(1);
    expect(within(focused[0]!).getByText("np, 30 days for refunds")).toBeInTheDocument();
    expect(fake.connection.markRead).not.toHaveBeenCalled();
  });

  it("more results load on ask, from the token the workspace gave", async () => {
    const many = ["one", "two", "three"].map((word, index) =>
      hitFor({ eventId: `$m${index}`, senderId: "@bose:workspace.example", senderName: "Bose", body: `refund ${word}` }),
    );
    const fake = searchConnection({ rooms: roomsFixture(), index: many, pageSize: 2 });
    await openConversations(fake);

    await searchFor("refund");
    await screen.findAllByTestId("message-search-hit");
    expect(screen.getAllByTestId("message-search-hit")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("message-search-more"));

    await waitFor(() => expect(screen.getAllByTestId("message-search-hit")).toHaveLength(3));
    expect(fake.searchMessages).toHaveBeenLastCalledWith("refund", "2");
    expect(screen.queryByTestId("message-search-more")).toBeNull();
  });

  it("nothing matching says so, and an empty box asks nothing of the workspace", async () => {
    const fake = searchConnection({ rooms: roomsFixture(), index: [QUESTION_HIT] });
    await openConversations(fake);

    await searchFor("   ");
    expect(fake.searchMessages).not.toHaveBeenCalled();

    await searchFor("gelato");
    expect(await screen.findByTestId("message-search-empty")).toHaveTextContent("Nothing said in your conversations matches that.");
    expect(screen.queryByTestId("message-search-hit")).toBeNull();
  });

  it("a search the workspace fails names the workspace, and clearing returns to the list", async () => {
    const state = { rooms: roomsFixture(), index: [QUESTION_HIT], failWith: new Error("boom") as Error | undefined };
    const fake = searchConnection(state);
    await openConversations(fake);

    await searchFor("refund");
    expect(await screen.findByTestId("message-search-error")).toHaveTextContent("The workspace didn't search — try again.");

    fireEvent.click(screen.getByTestId("message-search-clear"));
    expect(screen.getByTestId("conversations-list")).toBeInTheDocument();
    expect(screen.queryByTestId("message-search-error")).toBeNull();
  });
});

describe("#70 AC2 — results respect membership", () => {
  const SECRET_TEXT = "the reorg lands in March; nobody outside leadership knows the refund budget";

  it("messages from conversations the member does not belong to never appear", async () => {
    const fake = searchConnection({
      rooms: roomsFixture(),
      index: [
        QUESTION_HIT,
        hitFor({ eventId: "$s", roomId: SECRET, senderId: "@dee:workspace.example", senderName: "Dee", body: SECRET_TEXT }),
      ],
    });
    await openConversations(fake);

    await searchFor("refund");

    const hits = await screen.findAllByTestId("message-search-hit");
    expect(hits).toHaveLength(1);
    expect(within(hits[0]!).getByTestId("message-search-hit-room")).toHaveTextContent("project-x");
    expect(document.body.textContent).not.toContain("the reorg lands in March");
    expect(document.body.textContent).not.toContain("Dee");
  });

  it("a search whose only matches are in other people's conversations finds nothing", async () => {
    const fake = searchConnection({
      rooms: roomsFixture(),
      index: [hitFor({ eventId: "$s", roomId: SECRET, senderId: "@dee:workspace.example", senderName: "Dee", body: SECRET_TEXT })],
    });
    await openConversations(fake);

    await searchFor("reorg");

    expect(await screen.findByTestId("message-search-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("message-search-hit")).toBeNull();
    expect(document.body.textContent).not.toContain("March");
  });

  it("a conversation the member has left stops appearing in what they find", async () => {
    const state = { rooms: roomsFixture(), index: [QUESTION_HIT] };
    const fake = searchConnection(state);
    await openConversations(fake);
    await searchFor("refund");
    expect(await screen.findAllByTestId("message-search-hit")).toHaveLength(1);

    // The workspace drops the membership (the member leaves on another device); the next search is its next answer.
    state.rooms = state.rooms.filter((room) => room.roomId !== PROJECT);
    await searchFor("refund policy");

    expect(await screen.findByTestId("message-search-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("message-search-hit")).toBeNull();
  });
});

describe("#70 AC2 — nothing of a search rests on this device", () => {
  it("a search's answer is never written to the persisted cache, though the rest of the workspace's is", async () => {
    // Words no other fixture in this file says: a persister write left over
    // from an earlier test can't be mistaken for this search's.
    const probe = hitFor({
      eventId: "$probe",
      senderId: "@bose:workspace.example",
      senderName: "Bose",
      body: "the gelato budget was approved",
      context: { before: [{ senderId: "@bose:workspace.example", senderName: "Bose", body: "pistachio or lemon" }], after: [] },
    });
    const fake = searchConnection({ rooms: roomsFixture(), index: [probe] });
    await openConversations(fake);
    await searchFor("gelato");
    await screen.findAllByTestId("message-search-hit");

    // The persister writes on a throttle; wait it out, then read what rests.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const resting = localStorage.getItem("duo-cache") ?? "";
    expect(resting).toContain("project-x"); // the persisted cache is live: the list rests there
    expect(resting).not.toContain("gelato");
    expect(resting).not.toContain("pistachio");
  });
});

describe("#70 AC3 — the two searches are distinguishable", () => {
  it("the conversations search says it searches what was said, on the workspace — and never claims to be the duo's knowledge", async () => {
    const fake = searchConnection({ rooms: roomsFixture(), index: [] });
    await openConversations(fake);

    const scope = screen.getByTestId("command-search-scope");
    expect(scope).toHaveTextContent(/people, conversations/i);
    expect(scope).toHaveTextContent(/workspace/i);
    expect(scope).not.toHaveTextContent(/your duo knows|corpus|private/i);
    expect(screen.getByRole("search", { name: SEARCH_LABEL })).toBeInTheDocument();
  });

  it("the corpus search says it searches what the duo knows — private, on the owner's Mac, and not the workspace", async () => {
    seedSession();
    seedPairing();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    const fake = searchConnection({ rooms: roomsFixture(), index: [] });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    await screen.findByTestId("conversations-list");

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const overlay = await screen.findByTestId("search-overlay");
    const scope = within(overlay).getByTestId("search-scope");
    expect(scope).toHaveTextContent(/your duo/i);
    expect(scope).toHaveTextContent(/private/i);
    expect(scope).toHaveTextContent(/your mac/i);
    expect(scope).not.toHaveTextContent(/conversations|what was said/i);
    expect(within(overlay).getByLabelText("Search what your duo knows")).toBeInTheDocument();
  });

  it("using either never reaches the other: message search asks only the workspace, corpus search asks only the daemon, and corpus records never render as messages", async () => {
    const CORPUS_SECRET = "Leave policy: five days per quarter carry over — an internal note that lives only on the owner's Mac.";
    seedSession();
    seedPairing();
    const daemonCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        daemonCalls.push(String(url));
        if (String(url).includes("/search")) {
          return new Response(
            JSON.stringify({
              results: [
                {
                  rank: 1,
                  record: {
                    id: "r1", source: "notes", sourceRef: null, kind: "decision", author: "me", text: CORPUS_SECRET,
                    timestamp: "2026-09-01T10:00:00.000Z", threadId: null, audience: "channel", classification: "unknown", topics: [],
                  },
                },
              ],
              usedEmbeddings: true,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    const fake = searchConnection({ rooms: roomsFixture(), index: [QUESTION_HIT] });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    await screen.findByTestId("conversations-list");

    // 1. A message search: the workspace is asked, the daemon is not.
    await searchFor("refund");
    await screen.findAllByTestId("message-search-hit");
    expect(fake.searchMessages).toHaveBeenCalledTimes(1);
    expect(daemonCalls.filter((url) => url.includes("/search"))).toEqual([]);

    // 2. A corpus search: the daemon is asked, the workspace is not.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const overlay = await screen.findByTestId("search-overlay");
    fireEvent.change(within(overlay).getByLabelText("Search what your duo knows"), { target: { value: "leave" } });
    fireEvent.click(within(overlay).getByRole("button", { name: /search/i }));
    expect(await within(overlay).findAllByTestId("search-result")).toHaveLength(1);
    expect(daemonCalls.filter((url) => url.includes("/search"))).toHaveLength(1);
    expect(fake.searchMessages).toHaveBeenCalledTimes(1);

    // 3. The corpus record lives in the overlay alone — the messages' results never carry it.
    expect(within(screen.getByTestId("message-search-results")).queryByText(/Leave policy/)).toBeNull();
    expect(fake.connection.timelineAt).not.toHaveBeenCalled();
  });

  it("holds structurally: nothing the message search runs on reads the daemon's api, and the corpus search never reads the workspace", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const read = (relative: string): string => readFileSync(join(root, relative), "utf8");
    // Value imports only: a type can carry no record from one store to another.
    const importsOf = (source: string): string[] =>
      [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gms)].map((match) => match[1]!);
    const resolve = (from: string, specifier: string): string | null => {
      if (!specifier.startsWith(".")) {
        return null;
      }
      const base = join(dirname(from), specifier).replace(/\.js$/, "");
      const found = [`${base}.ts`, `${base}.tsx`].find((candidate) => {
        try {
          read(candidate);
          return true;
        } catch {
          return false;
        }
      });
      return found ?? null;
    };
    /** Every source file an entry reaches through value imports, entry included. */
    const closureOf = (entries: string[]): string[] => {
      const seen = new Set<string>();
      const queue = [...entries];
      while (queue.length > 0) {
        const file = queue.pop()!;
        if (seen.has(file)) {
          continue;
        }
        seen.add(file);
        for (const specifier of importsOf(read(file))) {
          const next = resolve(file, specifier);
          if (next !== null) {
            queue.push(next);
          }
        }
      }
      return [...seen];
    };

    // The message search's road: its surface and the seam. Neither reaches the daemon's api — corpus results can't reach it.
    const messageRoad = closureOf(["src/components/ConversationSearch.tsx", "src/workspace/matrix.ts"]);
    expect(messageRoad).toContain("src/workspace/matrix.ts");
    for (const file of messageRoad) {
      expect(file, "the message search must not reach the daemon's api").not.toMatch(/^src\/api\//);
    }
    // The corpus search's road: its overlay and the daemon's api. Neither reaches the workspace — it can't fall back to shared messages.
    const corpusRoad = closureOf(["src/components/SearchOverlay.tsx", "src/api/queries.ts"]);
    expect(corpusRoad).toContain("src/api/queries.ts");
    for (const file of corpusRoad) {
      expect(file, "the corpus search must not reach the workspace").not.toMatch(/^src\/workspace\//);
    }
  });
});

describe("#70 AC4 — a duo's answers are searchable as the duo's", () => {
  it("a duo's hit renders as that duo's message, attributed from its id — even when its display name claims to be its owner", async () => {
    const fake = searchConnection({ rooms: roomsFixture(), index: [DUO_HIT] });
    await openConversations(fake);

    await searchFor("refund");

    const [hit] = await screen.findAllByTestId("message-search-hit");
    expect(within(hit!).getByTestId("room-duo-message")).toBeInTheDocument();
    expect(within(hit!).getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");
    // The owner's name is the possessive, never the author: no person-shaped container, no "Carol" as sender.
    expect(within(hit!).queryByTestId("room-person-message")).toBeNull();
    expect(within(hit!).queryByTestId("room-person-message-author")).toBeNull();
    expect(within(hit!).getByText("Refunds within 30 days, full amount.")).toBeInTheDocument();
  });

  it("a person whose display name claims to be somebody's duo is still rendered as a person", async () => {
    const fake = searchConnection({
      rooms: roomsFixture(),
      index: [
        hitFor({ eventId: "$x", senderId: "@mallory:workspace.example", senderName: "carol's duo", body: "refunds are automatic, no need to ask" }),
      ],
    });
    await openConversations(fake);

    await searchFor("refunds");

    const [hit] = await screen.findAllByTestId("message-search-hit");
    expect(within(hit!).queryByTestId("room-duo-message")).toBeNull();
    expect(within(hit!).getByTestId("room-person-message-author")).toHaveTextContent("carol's duo");
  });
});
