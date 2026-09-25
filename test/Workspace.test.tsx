import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, signIn } from "../src/workspace/matrix.js";
import type { RoomMessage, RoomSummary, WorkspaceConnection, WorkspaceSession } from "../src/workspace/matrix.js";

/*
 * #62: the app's front door becomes two doors — a workspace sign-in (who you
 * are, in an org) and a duo pairing (which only you reach) — with separate
 * lifetimes. The Matrix seam (`src/workspace/matrix.ts`) is the one module
 * that would load matrix-js-sdk; it is mocked here wholesale, the same way
 * the Tauri seams are, so the ACs test the client's surfaces against the
 * wire contract the core's identity/directory work (digital-duo #187)
 * fixed: the person signs in as their own Matrix user, and a duo is its own
 * user (`@duo-<owner>`) the client recognizes structurally.
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

/**
 * #63: the list's raw material — one direct (members, no name), one group
 * (named, carrying a colleague's duo), one channel (named, public). The
 * seam orders by latest activity; the fixture is written in that order so
 * a shuffle inside a test would still be caught by the order assertions.
 */
function roomsFixture(): RoomSummary[] {
  const now = Date.now();
  const hour = 3_600_000;
  return [
    {
      roomId: "!direct:workspace.example",
      kind: "direct",
      name: null,
      members: [{ userId: "@bose:workspace.example", name: "Bose" }],
      latest: { at: now - hour, body: "lunch?" },
      unread: { notifications: 0, mentions: 0 },
      muted: false,
    },
    {
      roomId: "!project-x:workspace.example",
      kind: "group",
      name: "project-x",
      members: [
        { userId: "@bose:workspace.example", name: "Bose" },
        { userId: "@duo-carol:workspace.example", name: "duo-carol" },
      ],
      latest: { at: now - 2 * hour, body: "ship it" },
      unread: { notifications: 3, mentions: 0 },
      muted: false,
    },
    {
      roomId: "!announce:workspace.example",
      kind: "channel",
      name: "announce",
      members: [{ userId: "@dee:workspace.example", name: "Dee" }],
      latest: { at: now - 3 * hour, body: "all-hands friday" },
      unread: { notifications: 0, mentions: 0 },
      muted: false,
    },
  ];
}

/** The directory the new-conversation search reads (#63 AC3): one person, one duo. */
const PEOPLE = [
  { userId: "@carol:workspace.example", name: "Carol" },
  { userId: "@duo-carol:workspace.example", name: "duo-carol" },
];

function messageFor(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId" | "senderId" | "body">): RoomMessage {
  return {
    roomId: "!project-x:workspace.example",
    senderName: "",
    originServerTs: 1_700_000_000_000,
    edited: false,
    redacted: false,
    reactions: [],
    thread: null,
    threadRootEventId: null,
    ...over,
  };
}

const PROJECT_TIMELINE: RoomMessage[] = [
  messageFor({ eventId: "$1", senderId: "@bose:workspace.example", senderName: "Bose", body: "what's our refund policy?" }),
  messageFor({ eventId: "$2", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "Refunds within 30 days, full amount." }),
];

/**
 * #64's raw material: a root message with a colleague's-duo reply in its
 * thread (the reply itself carries `threadRootEventId`, so the main flow
 * filters it out and the preview carries it instead), beside a plain
 * unthreaded message.
 */
const THREADED_TIMELINE: RoomMessage[] = [
  messageFor({
    eventId: "$1",
    senderId: "@bose:workspace.example",
    senderName: "Bose",
    body: "what's our refund policy?",
    thread: {
      replyCount: 1,
      latestReply: { senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "np, 30 days" },
    },
  }),
  messageFor({ eventId: "$2", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "Refunds within 30 days, full amount." }),
  messageFor({ eventId: "$r1", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "np, 30 days", threadRootEventId: "$1" }),
];

/**
 * A fake connection the ACs drive: rooms and timelines resolve from
 * `state`, `deliver` plays a live arrival into the open subscription, and
 * the #63 verbs mutate `state` the way the homeserver's own state would
 * move under the same op — the list's reflection after a mutation is the
 * server's answer, not a local flag.
 */
function fakeConnection(state: {
  rooms: RoomSummary[];
  timelines: Record<string, RoomMessage[]>;
  people?: Array<{ userId: string; name: string }>;
}) {
  let listener: ((roomId: string) => void) | null = null;
  const roomAt = (roomId: string): number => state.rooms.findIndex((room) => room.roomId === roomId);
  const timelineOf = (roomId: string): RoomMessage[] => (state.timelines[roomId] ??= []);
  const messageAt = (roomId: string, eventId: string): number => timelineOf(roomId).findIndex((message) => message.eventId === eventId);
  const connection: WorkspaceConnection = {
    userId: SESSION.userId,
    rooms: vi.fn(async () =>
      // A fresh array of fresh objects per call, like the real seam's
      // projection: TanStack's structural sharing would otherwise see the
      // same instance and skip the re-render an invalidation asked for.
      state.rooms.map((room) => ({ ...room, members: [...room.members] })),
    ),
    timeline: vi.fn(async (roomId: string) => [...(state.timelines[roomId] ?? [])]),
    send: vi.fn(async () => {}),
    subscribe: vi.fn((handler: (roomId: string) => void) => {
      listener = handler;
      return () => {
        listener = null;
      };
    }),
    stop: vi.fn(async () => {}),
    // The homeserver's own read accounting moves — what another device
    // would also see on its next sync.
    markRead: vi.fn(async (roomId: string) => {
      const at = roomAt(roomId);
      if (at >= 0) {
        state.rooms[at] = { ...state.rooms[at]!, unread: { notifications: 0, mentions: 0 } };
      }
    }),
    startDirect: vi.fn(async (userId: string) => {
      const roomId = `!fresh-${userId.slice(1).replace(/[^a-z0-9-]/gi, "")}:workspace.example`;
      state.rooms.push({
        roomId,
        kind: "direct",
        name: null,
        members: [{ userId, name: null }],
        latest: null,
        unread: { notifications: 0, mentions: 0 },
        muted: false,
      });
      return roomId;
    }),
    leave: vi.fn(async (roomId: string) => {
      const at = state.rooms.findIndex((room) => room.roomId === roomId);
      if (at >= 0) {
        state.rooms.splice(at, 1);
      }
    }),
    setMuted: vi.fn(async (roomId: string, muted: boolean) => {
      const at = roomAt(roomId);
      if (at >= 0) {
        state.rooms[at] = { ...state.rooms[at]!, muted };
      }
    }),
    searchPeople: vi.fn(async (query: string) =>
      (state.people ?? []).filter((person) => person.name.toLowerCase().includes(query.toLowerCase())),
    ),
    // #64's message verbs — each one moves the timeline the way the
    // homeserver's own state would move under the same op, so the
    // surface's reflection is always the server's next answer.
    edit: vi.fn(async (roomId: string, eventId: string, body: string) => {
      const at = messageAt(roomId, eventId);
      if (at >= 0) {
        timelineOf(roomId)[at] = { ...timelineOf(roomId)[at]!, body, edited: true };
      }
    }),
    delete: vi.fn(async (roomId: string, eventId: string) => {
      const at = messageAt(roomId, eventId);
      if (at >= 0) {
        timelineOf(roomId)[at] = { ...timelineOf(roomId)[at]!, body: "", redacted: true };
      }
    }),
    react: vi.fn(async (roomId: string, eventId: string, key: string) => {
      const at = messageAt(roomId, eventId);
      if (at < 0) {
        return;
      }
      const message = timelineOf(roomId)[at]!;
      const existing = message.reactions.find((reaction) => reaction.key === key);
      timelineOf(roomId)[at] = {
        ...message,
        reactions: existing
          ? message.reactions.map((reaction) => (reaction.key === key ? { ...reaction, count: reaction.count + 1, mine: true } : reaction))
          : [...message.reactions, { key, count: 1, mine: true }],
      };
    }),
    unreact: vi.fn(async (roomId: string, eventId: string, key: string) => {
      const at = messageAt(roomId, eventId);
      if (at < 0) {
        return;
      }
      const message = timelineOf(roomId)[at]!;
      timelineOf(roomId)[at] = {
        ...message,
        reactions: message.reactions
          .map((reaction) => (reaction.key === key ? { ...reaction, count: reaction.count - 1, mine: false } : reaction))
          .filter((reaction) => reaction.count > 0),
      };
    }),
    replyInThread: vi.fn(async (roomId: string, rootEventId: string, body: string) => {
      const list = timelineOf(roomId);
      const at = messageAt(roomId, rootEventId);
      const reply = messageFor({ eventId: `$t${list.length + 1}`, senderId: SESSION.userId, senderName: "ana", body, threadRootEventId: rootEventId });
      list.push(reply);
      if (at >= 0) {
        const root = list[at]!;
        list[at] = {
          ...root,
          thread: {
            replyCount: (root.thread?.replyCount ?? 0) + 1,
            latestReply: { senderId: SESSION.userId, senderName: "ana", body },
          },
        };
      }
    }),
  };
  return {
    connection,
    // A live arrival: an unseen event id appends, a seen one replaces —
    // exactly what a homeserver sync does with an edit or a redaction.
    deliver: (message: RoomMessage) => {
      const list = timelineOf(message.roomId);
      const at = list.findIndex((existing) => existing.eventId === message.eventId);
      if (at >= 0) {
        list[at] = message;
      } else {
        list.push(message);
      }
      listener?.(message.roomId);
    },
  };
}

/** The list entry for a room, by the title it renders under. */
function entryFor(title: string): HTMLElement {
  const entry = screen
    .getAllByTestId("conversations-entry")
    .find((candidate) => within(candidate).getByTestId("room-title").textContent === title);
  expect(entry, `no conversations entry titled ${JSON.stringify(title)}`).toBeDefined();
  return entry!;
}

/** The rendered message row containing a body — the timeline's and the thread view's rows share the testid. */
function messageRow(body: string): HTMLElement {
  const row = screen.getAllByTestId("room-message").find((candidate) => within(candidate).queryByText(body) !== null);
  expect(row, `no message row containing ${JSON.stringify(body)}`).toBeDefined();
  return row!;
}

/** Navigate the way the browser would follow an in-app hash link (happy-dom doesn't follow anchors). */
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

/** Daemon answers for the queries a paired shell runs (roster, pending drafts): empty and successful. */
function stubDaemonFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
  );
}

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

describe("#62 AC1 — signing in to the workspace works", () => {
  it("the front door offers the workspace sign-in, with duo pairing still there beside it", async () => {
    await renderApp();

    expect(screen.getByRole("heading", { name: "Sign in to your workspace" })).toBeInTheDocument();
    // The pairing path keeps its own fields — a reasonable front door for one
    // person pairing their phone, still one form away.
    expect(screen.getByPlaceholderText("100.64.1.5:7717")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /token/i })).toBeInTheDocument();
  });

  it("signing in reaches conversations, with no duo pairing having happened", async () => {
    vi.mocked(signIn).mockResolvedValue(SESSION);
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    // URL normalization (https, trailing slash) is the seam's rule and the
    // seam suite pins it; here the form hands the address through as typed.
    fireEvent.change(screen.getByLabelText("Homeserver"), { target: { value: "https://workspace.example" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ana" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    expect(screen.getByText("project-x")).toBeInTheDocument();
    expect(screen.getByText("Bose")).toBeInTheDocument();
    expect(signIn).toHaveBeenCalledWith("https://workspace.example", "ana", "correct horse");
    // No pairing happened: the duo credential store is untouched.
    expect(localStorage.getItem("duo.api-config")).toBeNull();
  });

  it("rejected credentials stay on the door, saying the homeserver refused them", async () => {
    vi.mocked(signIn).mockRejectedValue(new Error("The workspace refused these sign-in details."));

    await renderApp();
    fireEvent.change(screen.getByLabelText("Homeserver"), { target: { value: "https://workspace.example" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ana" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByTestId("setup-workspace-error")).toHaveTextContent("The workspace refused these sign-in details.");
    expect(screen.queryByTestId("conversations-list")).toBeNull();
    expect(localStorage.getItem("duo.workspace-session")).toBeNull();
  });
});

describe("#62 AC2 — pairing a duo is a separate, later step", () => {
  it("an unpaired member lands on Conversations, reads a room, and a colleague's duo is labelled structurally", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();

    // The empty hash is Conversations for a signed-in member — the default
    // space, not a duo surface demanding pairing.
    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    // The entry is a real link to the room's own address; happy-dom's click
    // doesn't follow hashes, so the test drives the same navigation the
    // browser would.
    // #63's entry markup puts the title in its own element inside the link;
    // the destination is the link's, resolved by role.
    expect(screen.getByRole("link", { name: /project-x/ })).toHaveAttribute("href", "#room/!project-x%3Aworkspace.example");
    window.location.hash = "#room/!project-x%3Aworkspace.example";
    window.dispatchEvent(new Event("hashchange"));

    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("room-person-message-author")).toHaveTextContent("Bose");
    // The duo's message carries whose it is from the structural id
    // (`@duo-carol` → carol), never from a display name the sender chose.
    expect(screen.getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");
  });

  it("messaging works fully: sending posts through the connection, and a live arrival renders", async () => {
    seedSession();
    const state = { rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } };
    const fake = fakeConnection(state);
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#room/!project-x%3Aworkspace.example";
    window.dispatchEvent(new Event("hashchange"));
    await screen.findByTestId("room-timeline");

    fireEvent.change(screen.getByLabelText("Message project-x"), { target: { value: "thanks all" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fake.connection.send).toHaveBeenCalledWith("!project-x:workspace.example", "thanks all"));
    // The composer clears on a successful send — the room is the record.
    await waitFor(() => expect(screen.getByLabelText("Message project-x")).toHaveValue(""));

    // A live arrival (someone else's message, or ours echoed back by the
    // homeserver) renders without a manual refresh.
    const reply = messageFor({ eventId: "$3", senderId: "@carol:workspace.example", senderName: "Carol", body: "np" });
    act(() => fake.deliver(reply));
    await waitFor(() => expect(screen.getByText("np")).toBeInTheDocument());
  });

  it("duo surfaces explain that no duo is connected, and pairing is offered rather than demanded", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // A duo surface, navigated directly: the explanation, and the offer.
    window.location.hash = "#review";
    window.dispatchEvent(new Event("hashchange"));
    const noDuo = await screen.findByTestId("no-duo");
    expect(noDuo).toHaveTextContent("No duo is connected on this device.");
    expect(screen.getByTestId("no-duo-pair")).toHaveTextContent("Pair your duo");
    // Offered, not demanded: nothing modal is in the way.
    expect(screen.queryByTestId("pair-duo-dialog")).toBeNull();
  });

  it("pairing from the offer pairs the duo, and the member shell gains its duo surfaces", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    stubDaemonFetch();

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#review";
    window.dispatchEvent(new Event("hashchange"));
    fireEvent.click(await screen.findByTestId("no-duo-pair"));

    fireEvent.change(await screen.findByLabelText("Daemon address"), { target: { value: "100.64.1.5:7717" } });
    fireEvent.change(screen.getByRole("textbox", { name: /token/i }), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
    // The dialog closes behind the pairing, and the duo's own surface takes over.
    await waitFor(() => expect(screen.queryByTestId("pair-duo-dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("link", { name: /Review/ })).toBeInTheDocument());
    expect(screen.queryByTestId("no-duo")).toBeNull();
  });
});

describe("#62 AC3 — both credentials are managed", () => {
  it("settings shows both connections, and signing out ends only the workspace one", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#settings";
    window.dispatchEvent(new Event("hashchange"));

    const workspace = await screen.findByTestId("settings-workspace");
    expect(workspace).toHaveTextContent("@ana:workspace.example");
    expect(workspace).toHaveTextContent("https://workspace.example");
    // The duo connection is shown beside it, in effect.
    expect(screen.getByTestId("settings-address")).toHaveTextContent("http://100.64.1.5:7717");

    fireEvent.click(screen.getByTestId("settings-sign-out"));

    await waitFor(() => expect(localStorage.getItem("duo.workspace-session")).toBeNull());
    // The pairing survives: the two connections end independently.
    await waitFor(() => expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
    // Still the owner's shell — the duo surfaces stand without the workspace.
    await waitFor(() => expect(screen.getByRole("link", { name: /Review/ })).toBeInTheDocument());
  });

  it("forgetting the duo keeps the workspace session, and the member shell stands", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#settings";
    window.dispatchEvent(new Event("hashchange"));
    fireEvent.click((await screen.findAllByTestId("settings-unpair"))[0]);
    fireEvent.click(screen.getByTestId("settings-unpair-confirm"));

    await waitFor(() => expect(localStorage.getItem("duo.api-config")).toBeNull());
    expect(JSON.parse(localStorage.getItem("duo.workspace-session") ?? "null")).toEqual(SESSION);
    // Conversations is still the member's default space — the unpaired
    // member's shell stands on the workspace alone. (#settings stays
    // mounted — the member's own navigation keeps standing — so walk to
    // Conversations the way the sidebar's link would.)
    window.location.hash = "#conversations";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(screen.getByTestId("conversations-list")).toBeInTheDocument());
  });
});

describe("#62 AC4 — signing out leaves nothing behind", () => {
  it("clears cached messages and cached duo data, while the pairing itself survives", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    // A persisted cache blob from before: what signing out must not leave readable.
    localStorage.setItem("duo-cache", JSON.stringify({ clientState: {}, buster: "delivery" }));

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#settings";
    window.dispatchEvent(new Event("hashchange"));
    fireEvent.click(await screen.findByTestId("settings-sign-out"));

    await waitFor(() => {
      expect(localStorage.getItem("duo-cache")).toBeNull();
      expect(localStorage.getItem("duo.workspace-session")).toBeNull();
    });
    expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({ baseUrl: "http://100.64.1.5:7717", token: "tok" });
  });
});

describe("#62 — the both-credentials shell and the failing-connection edge", () => {
  it("a paired member signed in opens on Conversations, with Review still above it", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();

    // Conversations is the default space; Review — the thing the app exists
    // to open — keeps its place above it in the sidebar.
    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    const entries = [...screen.getByRole("navigation", { name: "Surfaces" }).querySelectorAll("a")].map((a) => a.textContent);
    expect(entries.indexOf("Conversations")).toBeGreaterThan(-1);
    expect(entries.indexOf("Review")).toBeLessThan(entries.indexOf("Conversations"));
  });

  it("a connection that cannot be established says so and offers the way out", async () => {
    seedSession();
    vi.mocked(connect).mockRejectedValue(new Error("The workspace didn't answer."));

    await renderApp();

    const failure = await screen.findByTestId("workspace-error");
    expect(failure).toHaveTextContent("The workspace didn't answer.");
    fireEvent.click(screen.getByTestId("workspace-error-sign-out"));
    await waitFor(() => expect(localStorage.getItem("duo.workspace-session")).toBeNull());
  });
});

describe("#63 AC1 — the list triages without opening anything", () => {
  it("shows each conversation's name or members, the latest word, and unread — newest first", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // Recency order: the room that spoke last leads, whatever kind it is.
    expect(screen.getAllByTestId("room-title").map((title) => title.textContent)).toEqual(["Bose", "project-x", "announce"]);

    // A direct conversation has no name to show: its members are the title.
    const direct = entryFor("Bose");
    expect(within(direct).getByTestId("room-preview")).toHaveTextContent("lunch?");
    expect(within(direct).getByTestId("timestamp")).toBeInTheDocument();
    expect(within(direct).queryByTestId("room-unread")).toBeNull();

    // A named room shows the name, the latest word, its age, and the badge.
    const group = entryFor("project-x");
    expect(within(group).getByTestId("room-preview")).toHaveTextContent("ship it");
    expect(within(group).getByTestId("timestamp")).toBeInTheDocument();
    expect(within(group).getByTestId("room-unread")).toHaveTextContent("3 unread");

    // A channel reads by its name too — one list, three kinds, no opening.
    const channel = entryFor("announce");
    expect(within(channel).getByTestId("room-preview")).toHaveTextContent("all-hands friday");
    expect(within(channel).queryByTestId("room-unread")).toBeNull();
  });
});

describe("#63 AC2 — mentions outrank unread", () => {
  it("a conversation that mentioned the member is distinguishable from merely unread", async () => {
    seedSession();
    const rooms = roomsFixture();
    // project-x mentioned the member twice among five unread; Bose is
    // merely unread — same list, different demands.
    rooms[1] = { ...rooms[1]!, unread: { notifications: 5, mentions: 2 } };
    rooms[0] = { ...rooms[0]!, unread: { notifications: 3, mentions: 0 } };
    const fake = fakeConnection({ rooms, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    const mentioned = entryFor("project-x");
    expect(within(mentioned).getByTestId("room-mentions")).toHaveTextContent("2");
    expect(within(mentioned).getByTestId("room-unread")).toHaveTextContent("5 unread");

    const merelyUnread = entryFor("Bose");
    expect(within(merelyUnread).queryByTestId("room-mentions")).toBeNull();
    expect(within(merelyUnread).getByTestId("room-unread")).toHaveTextContent("3 unread");
  });
});

describe("#63 AC3 — conversations can be started, left and muted", () => {
  it("starting a conversation searches the workspace's people and opens the room it creates", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {}, people: PEOPLE });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    fireEvent.click(await screen.findByTestId("conversations-new"));

    fireEvent.change(await screen.findByLabelText("Search people"), { target: { value: "carol" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    // The directory answers people AND duos; a duo is addressed by what its
    // id says it is, structurally — never by the display name it chose.
    const results = await screen.findAllByTestId("new-conversation-person");
    expect(results.map((result) => result.textContent)).toEqual(["Carol", "carol's duo"]);
    fireEvent.click(screen.getByRole("button", { name: /^Carol/ }));

    await waitFor(() => expect(fake.connection.startDirect).toHaveBeenCalledWith("@carol:workspace.example"));
    // The conversation opens: the new room is the surface, not a closed dialog.
    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
    expect(screen.queryByTestId("new-conversation-dialog")).toBeNull();
  });

  it("muting is the server's fact — the badge changes shape on the list, both directions", async () => {
    seedSession();
    const rooms = roomsFixture();
    const fake = fakeConnection({ rooms, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    const beforeKeys = JSON.stringify(Object.keys(localStorage).sort());

    fireEvent.click(screen.getByRole("button", { name: "Mute project-x" }));

    await waitFor(() => expect(fake.connection.setMuted).toHaveBeenCalledWith("!project-x:workspace.example", true));
    // The reflection is the connection's next answer — what any of the
    // member's devices would render from the same server-side rule.
    await waitFor(() => expect(within(entryFor("project-x")).getByTestId("room-muted")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Unmute project-x" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Unmute project-x" }));

    await waitFor(() => expect(fake.connection.setMuted).toHaveBeenCalledWith("!project-x:workspace.example", false));
    await waitFor(() => expect(within(entryFor("project-x")).queryByTestId("room-muted")).toBeNull());
    // Cross-device is server-side by construction: no local store appeared.
    expect(JSON.stringify(Object.keys(localStorage).sort())).toBe(beforeKeys);
  });

  it("leaving a conversation asks first, then removes it from the list", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    fireEvent.click(screen.getByRole("button", { name: "Leave announce" }));
    fireEvent.click(await screen.findByTestId("leave-conversation-confirm"));

    await waitFor(() => expect(fake.connection.leave).toHaveBeenCalledWith("!announce:workspace.example"));
    await waitFor(() => expect(screen.queryByText("announce")).toBeNull());
    // The others stand: leaving one conversation leaves the rest of the list.
    expect(screen.getAllByTestId("room-title").map((title) => title.textContent)).toEqual(["Bose", "project-x"]);
  });
});

describe("#63 AC4 — a duo in a conversation is visible from the list", () => {
  it("a conversation carrying a colleague's duo says so before it's opened", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // Whose duo it is comes from the member id's grammar, not a name.
    expect(within(entryFor("project-x")).getAllByTestId("room-duo").map((chip) => chip.textContent)).toEqual(["carol's duo"]);
    expect(within(entryFor("Bose")).queryByTestId("room-duo")).toBeNull();
  });
});

describe("#63 — read state is durable, not local", () => {
  it("opening a conversation marks it read over the connection, and the badge clears on return", async () => {
    seedSession();
    const rooms = roomsFixture();
    rooms[1] = { ...rooms[1]!, unread: { notifications: 3, mentions: 0 } };
    const fake = fakeConnection({ rooms, timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    expect(within(entryFor("project-x")).getByTestId("room-unread")).toHaveTextContent("3 unread");

    window.location.hash = "#room/!project-x%3Aworkspace.example";
    window.dispatchEvent(new Event("hashchange"));
    await screen.findByTestId("room-timeline");

    // The read marker went to the server — the receipt is the record, so
    // every other device reads the conversation as read too.
    await waitFor(() => expect(fake.connection.markRead).toHaveBeenCalledWith("!project-x:workspace.example"));

    window.location.hash = "#conversations";
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(within(entryFor("project-x")).queryByTestId("room-unread")).toBeNull());
  });
});

describe("#64 AC1 — messages send and arrive", () => {
  it("a sent message renders immediately for its sender, and the homeserver's echo confirms it", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.change(screen.getByLabelText("Message project-x"), { target: { value: "thanks all" } });
    // The async act lets the cache's microtask-batched notification flush —
    // the row renders from the click alone, before anything arrives.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    // Immediately — nothing has arrived from anywhere yet; the row is this
    // device's own optimistic copy, marked as on its way. The waitFor only
    // rides out the cache's microtask flush: no arrival is coming (deliver
    // is the only arrival path, and it hasn't run), so the row can owe to
    // the click alone.
    const optimistic = await waitFor(() => messageRow("thanks all"));
    expect(within(optimistic).getByTestId("room-message-pending")).toBeInTheDocument();
    expect(fake.connection.send).toHaveBeenCalledWith("!project-x:workspace.example", "thanks all");

    // The homeserver's echo — a real event id — replaces the optimistic
    // copy; the words stand without the marker.
    act(() => fake.deliver(messageFor({ eventId: "$echo", senderId: SESSION.userId, senderName: "ana", body: "thanks all" })));
    await waitFor(() => expect(screen.queryByTestId("room-message-pending")).toBeNull());
    expect(screen.getByText("thanks all")).toBeInTheDocument();
  });
});

describe("#64 AC2 — editing and deleting are honest", () => {
  it("an edit replaces the words and is marked as an edit; a delete strikes the message, behind a confirm", async () => {
    seedSession();
    const own = messageFor({ eventId: "$mine", senderId: SESSION.userId, senderName: "ana", body: "the policy doc says 30 days" });
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE, own] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("the policy doc says 30 days")).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit message"), { target: { value: "the policy doc says 30 days, no exceptions" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fake.connection.edit).toHaveBeenCalledWith("!project-x:workspace.example", "$mine", "the policy doc says 30 days, no exceptions"));
    // The homeserver's next answer carries the new words and the mark.
    await waitFor(() => expect(within(messageRow("the policy doc says 30 days, no exceptions")).getByTestId("room-message-edited")).toBeInTheDocument());

    fireEvent.click(within(messageRow("the policy doc says 30 days, no exceptions")).getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByTestId("delete-message-confirm"));

    await waitFor(() => expect(fake.connection.delete).toHaveBeenCalledWith("!project-x:workspace.example", "$mine"));
    // The words go; the place stays honest — a struck message says so, it
    // doesn't silently vanish and reshuffle the room.
    await waitFor(() => expect(screen.getByTestId("room-message-deleted")).toHaveTextContent("Message deleted"));
  });

  it("another member's edit arrives without a refresh, marked as an edit", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    // Bose amends their own message: the same event id comes back with new
    // words and the edit mark — a sync, not a refresh.
    act(() =>
      fake.deliver(messageFor({ eventId: "$1", senderId: "@bose:workspace.example", senderName: "Bose", body: "what IS our refund policy?", edited: true })),
    );

    // The refetch the arrival kicked off is async; waitFor polls the same
    // mounted DOM — no manual refresh, no remount.
    const row = await waitFor(() => messageRow("what IS our refund policy?"));
    expect(within(row).getByTestId("room-message-edited")).toBeInTheDocument();
    expect(within(row).queryByText("what's our refund policy?")).toBeNull();
  });
});

describe("#64 AC3 — threads and reactions work", () => {
  it("a reaction renders under its message — in the conversation and inside the thread view — and the chip is a toggle", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...THREADED_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("what's our refund policy?")).getByRole("button", { name: "React" }));
    fireEvent.click(within(await screen.findByTestId("reaction-picker")).getByRole("button", { name: "React 👍" }));

    await waitFor(() => expect(fake.connection.react).toHaveBeenCalledWith("!project-x:workspace.example", "$1", "👍"));
    await waitFor(() => expect(within(messageRow("what's our refund policy?")).getByTestId("room-reaction")).toHaveTextContent("👍 1"));

    // The reaction follows the message into its thread view.
    navigate("#thread/!project-x%3Aworkspace.example/%241");
    expect(await screen.findByTestId("thread-timeline")).toBeInTheDocument();
    expect(within(messageRow("what's our refund policy?")).getByTestId("room-reaction")).toHaveTextContent("👍 1");

    // Back in the conversation, the chip takes the reaction back.
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");
    fireEvent.click(within(messageRow("what's our refund policy?")).getByTestId("room-reaction"));
    await waitFor(() => expect(fake.connection.unreact).toHaveBeenCalledWith("!project-x:workspace.example", "$1", "👍"));
    await waitFor(() => expect(within(messageRow("what's our refund policy?")).queryByTestId("room-reaction")).toBeNull());
  });

  it("a thread renders in the conversation as a preview and in the thread view as replies; posting into it works", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...THREADED_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    // In the conversation: the thread's existence, its count, and its
    // latest word — attributed to whose it IS (the id grammar, not a name).
    const preview = within(messageRow("what's our refund policy?")).getByTestId("room-thread-preview");
    expect(preview).toHaveTextContent("carol's duo");
    expect(preview).toHaveTextContent("np, 30 days");
    expect(preview).toHaveTextContent("1 reply");
    expect(screen.getByTestId("open-thread")).toHaveAttribute("href", "#thread/!project-x%3Aworkspace.example/%241");
    // The reply itself is not a row of the main flow — it lives behind the preview.
    expect(screen.queryByText("np, 30 days")).toBeNull();

    navigate("#thread/!project-x%3Aworkspace.example/%241");
    expect(await screen.findByTestId("thread-timeline")).toBeInTheDocument();
    // The thread view: the root, and the reply — a duo's, labelled structurally (#60's rule).
    expect(screen.getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");
    expect(screen.getByText("np, 30 days")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Reply in thread"), { target: { value: "thanks!" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fake.connection.replyInThread).toHaveBeenCalledWith("!project-x:workspace.example", "$1", "thanks!"));
    await waitFor(() => expect(screen.getByText("thanks!")).toBeInTheDocument());

    // Back in the conversation, the preview carries the new latest word and count.
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");
    const updated = within(messageRow("what's our refund policy?")).getByTestId("room-thread-preview");
    await waitFor(() => expect(updated).toHaveTextContent("2 replies"));
    expect(updated).toHaveTextContent("thanks!");
  });
});

describe("#64 AC4 — read state is maintained", () => {
  it("opening a thread directly receipts the room — the read position holds on the thread route too", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...THREADED_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    // The member lands on the list — no room was opened — and jumps
    // straight into a thread by its address.
    await screen.findByTestId("conversations-list");
    expect(fake.connection.markRead).not.toHaveBeenCalled();

    navigate("#thread/!project-x%3Aworkspace.example/%241");
    expect(await screen.findByTestId("thread-timeline")).toBeInTheDocument();
    await waitFor(() => expect(fake.connection.markRead).toHaveBeenCalledWith("!project-x:workspace.example"));
  });
});

describe("#64 — a refused verb says so, honestly (failed paths)", () => {
  it("a send the workspace refuses takes the optimistic copy back, keeps the words, and says why", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    vi.mocked(fake.connection.send).mockRejectedValueOnce(new Error("offline"));

    await renderApp();
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.change(screen.getByLabelText("Message project-x"), { target: { value: "thanks all" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    // The optimistic copy is gone — a refused send must not stand in the
    // room as if it were said. (Scoped to the timeline: the composer's
    // textarea keeps the words, which is the point below.)
    await waitFor(() => expect(within(screen.getByTestId("room-timeline")).queryByText("thanks all")).toBeNull());
    expect(screen.getByTestId("room-composer-error")).toHaveTextContent("Couldn't send — try again.");
    // The words stay with their author, not lost to the refusal.
    expect(screen.getByLabelText("Message project-x")).toHaveValue("thanks all");
  });

  it("an edit the workspace refuses leaves the words standing and says so", async () => {
    seedSession();
    const own = messageFor({ eventId: "$mine", senderId: SESSION.userId, senderName: "ana", body: "the policy doc says 30 days" });
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE, own] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    vi.mocked(fake.connection.edit).mockRejectedValueOnce(new Error("refused"));

    await renderApp();
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("the policy doc says 30 days")).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit message"), { target: { value: "changed words" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The refusal is said, and the server's next answer keeps the base's
    // words — the edit never happened, and the row doesn't pretend it did.
    await waitFor(() => expect(screen.getByTestId("room-message-error")).toHaveTextContent("The workspace didn't take that — try again."));
    await waitFor(() => expect(screen.getByText("the policy doc says 30 days")).toBeInTheDocument());
    expect(screen.queryByText("changed words")).toBeNull();
  });

  it("a delete the workspace refuses keeps the message, keeps the ask open, and says so", async () => {
    seedSession();
    const own = messageFor({ eventId: "$mine", senderId: SESSION.userId, senderName: "ana", body: "the policy doc says 30 days" });
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE, own] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    vi.mocked(fake.connection.delete).mockRejectedValueOnce(new Error("refused"));

    await renderApp();
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("the policy doc says 30 days")).getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByTestId("delete-message-confirm"));

    // The confirm doesn't close behind a refused delete — the words still
    // stand, and the ask stays with its answer.
    await waitFor(() => expect(screen.getByTestId("delete-message-error")).toHaveTextContent("The workspace didn't take that — try again."));
    expect(screen.getByTestId("delete-message-dialog")).toBeInTheDocument();
    expect(screen.getByText("the policy doc says 30 days")).toBeInTheDocument();
    expect(screen.queryByTestId("room-message-deleted")).toBeNull();
  });

  it("a reaction the workspace refuses says so and never shows the chip", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    vi.mocked(fake.connection.react).mockRejectedValueOnce(new Error("refused"));

    await renderApp();
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    fireEvent.click(within(messageRow("what's our refund policy?")).getByRole("button", { name: "React" }));
    fireEvent.click(within(await screen.findByTestId("reaction-picker")).getByRole("button", { name: "React 👍" }));

    await waitFor(() => expect(screen.getByTestId("room-message-error")).toHaveTextContent("The workspace didn't take that — try again."));
    expect(screen.queryByTestId("room-reaction")).toBeNull();
  });

  it("a thread reply the workspace refuses takes the optimistic copy back and says so", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...THREADED_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    vi.mocked(fake.connection.replyInThread).mockRejectedValueOnce(new Error("refused"));

    await renderApp();
    navigate("#thread/!project-x%3Aworkspace.example/%241");
    await screen.findByTestId("thread-timeline");

    fireEvent.change(screen.getByLabelText("Reply in thread"), { target: { value: "thanks!" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    // Scoped to the thread's rows — the composer's textarea keeps the
    // words for the retry.
    await waitFor(() => expect(within(screen.getByTestId("thread-timeline")).queryByText("thanks!")).toBeNull());
    expect(screen.getByTestId("thread-composer-error")).toHaveTextContent("Couldn't send — try again.");
    expect(screen.getByLabelText("Reply in thread")).toHaveValue("thanks!");
  });
});
