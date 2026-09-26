import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, signIn } from "../src/workspace/matrix.js";
import type { LiveArrival, NotificationMode, RoomMessage, RoomSummary, SharedFile, WorkspaceConnection, WorkspaceSession } from "../src/workspace/matrix.js";
import { WorkspaceSignInDialog } from "../src/components/WorkspaceSignInDialog.js";
import type { StagedShare } from "../src/workspace/sharing.js";

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

/*
 * #69: the notification plugin, mocked the same way — with browser-parity
 * defaults (every call rejects, permission resolves "denied"), so the
 * suite's existing behavior is exactly what a plain tab produces. The
 * dispatch tests flip the permission to granted and read the posted
 * notifications off `sendNotification`.
 */
const notificationPlugin = {
  isPermissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<string>>(),
  sendNotification: vi.fn<(options: { id?: number; title: string; body: string }) => void>(),
  onAction: vi.fn<(cb: (notification: { id?: number }) => void) => Promise<{ unregister: () => void }>>(),
};

vi.mock("@tauri-apps/plugin-notification", () => notificationPlugin);

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
      notifications: "all",
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
      notifications: "all",
    },
    {
      roomId: "!announce:workspace.example",
      kind: "channel",
      name: "announce",
      members: [{ userId: "@dee:workspace.example", name: "Dee" }],
      latest: { at: now - 3 * hour, body: "all-hands friday" },
      unread: { notifications: 0, mentions: 0 },
      muted: false,
      notifications: "all",
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
    parts: null,
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
  // Every surface that subscribes hears every arrival — the way the real
  // seam's client.on does. (#69's dispatcher subscribes beside the list
  // and the room, so a single stored listener would no longer model it.)
  const listeners = new Set<(roomId: string, arrival?: LiveArrival) => void>();
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
    // #66's share half: the upload resolves the staged bytes to the stable
    // reference (reporting full progress, the honest single-chunk case),
    // sendFile is the wire act, and loadMedia is the member's own
    // authenticated fetch of a reference's bytes (the token rides a header;
    // an <img> or <a> cannot send one).
    uploadFile: vi.fn(async (staged: StagedShare, onProgress?: (sent: number, total: number) => void) => {
      onProgress?.(staged.size, staged.size);
      return {
        name: staged.name,
        mimeType: staged.mimeType,
        size: staged.size,
        url: `mxc://workspace.example/${encodeURIComponent(staged.name)}`,
        image: staged.mimeType.startsWith("image/"),
      };
    }),
    sendFile: vi.fn(async () => {}),
    loadMedia: vi.fn(async (url: string): Promise<Blob | null> => new Blob([`bytes of ${url}`], { type: "application/octet-stream" })),
    subscribe: vi.fn((handler: (roomId: string, arrival?: LiveArrival) => void) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
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
        notifications: "all",
      });
      return roomId;
    }),
    leave: vi.fn(async (roomId: string) => {
      const at = state.rooms.findIndex((room) => room.roomId === roomId);
      if (at >= 0) {
        state.rooms.splice(at, 1);
      }
    }),
    // #69: the tri-state the surfaces write — the homeserver's own state
    // moves under it the way another device would see it move. ("nothing"
    // IS the mute #63 wrote; one verb now, for one action.)
    setNotificationMode: vi.fn(async (roomId: string, mode: NotificationMode) => {
      const at = roomAt(roomId);
      if (at >= 0) {
        state.rooms[at] = { ...state.rooms[at]!, notifications: mode, muted: mode === "nothing" };
      }
    }),
    searchPeople: vi.fn(async (query: string) =>
      (state.people ?? []).filter((person) => person.name.toLowerCase().includes(query.toLowerCase())),
    ),
    // #70: search and landing at a hit are pinned by WorkspaceSearch.test.tsx;
    // this fake only has to be a whole connection.
    searchMessages: vi.fn(async () => ({ hits: [], next: null })),
    timelineAt: vi.fn(async (roomId: string) => [...(state.timelines[roomId] ?? [])]),
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
    // The arrival half (#69) says who spoke and whether it mentioned the
    // member — what a notification decides on.
    deliver: (message: RoomMessage, mentionsMe = false) => {
      const list = timelineOf(message.roomId);
      const at = list.findIndex((existing) => existing.eventId === message.eventId);
      if (at >= 0) {
        list[at] = message;
      } else {
        list.push(message);
        // #65: a first-time arrival that mentions this user moves the
        // homeserver's mention accounting with it (the spec's
        // `.m.rule.is_user_mention` reading `m.mentions.user_ids` — the
        // badge is the server's count, not something the client tallies),
        // and a mention is a notification too. An edit never re-counts.
        if (
          message.senderId !== SESSION.userId &&
          message.parts?.some((part) => part.kind === "mention" && part.userId === SESSION.userId)
        ) {
          const roomIndex = roomAt(message.roomId);
          if (roomIndex >= 0) {
            const unread = state.rooms[roomIndex]!.unread;
            state.rooms[roomIndex] = {
              ...state.rooms[roomIndex]!,
              unread: { notifications: unread.notifications + 1, mentions: unread.mentions + 1 },
            };
          }
        }
      }
      const arrival: LiveArrival = { senderId: message.senderId, senderName: message.senderName, body: message.body, mentionsMe };
      for (const listener of listeners) {
        listener(message.roomId, arrival);
      }
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
  // Browser parity by default (#69): the shell's plugin calls reject the
  // way they do in a plain tab, so nothing notifies unless a test grants it.
  notificationPlugin.isPermissionGranted.mockReset();
  notificationPlugin.requestPermission.mockReset();
  notificationPlugin.sendNotification.mockReset();
  notificationPlugin.onAction.mockReset();
  notificationPlugin.isPermissionGranted.mockRejectedValue(new Error("window.__TAURI_INTERNALS__ is undefined"));
  notificationPlugin.requestPermission.mockResolvedValue("denied");
  notificationPlugin.onAction.mockRejectedValue(new Error("window.__TAURI_INTERNALS__ is undefined"));
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
    // The route's own panel and the sidebar's condensed one both offer it (#68 made #review a real address for a member, so both stand).
    expect(screen.getAllByTestId("no-duo-pair")[0]).toHaveTextContent("Pair your duo");
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
  it("a paired member signed in opens on Conversations, the first section above the duo's", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();

    // Conversations is the default space, and #129's first section: people
    // come before the duo's own screens, Review among them.
    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    const entries = [...screen.getByRole("navigation", { name: "Surfaces" }).querySelectorAll("a")].map((a) => a.textContent);
    expect(entries.indexOf("Conversations")).toBeGreaterThan(-1);
    expect(entries.indexOf("Conversations")).toBeLessThan(entries.findIndex((text) => text?.startsWith("Review")));
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

  it("the notification setting is the server's fact — nothing mutes as before, both directions read back (#69 AC1)", async () => {
    seedSession();
    const rooms = roomsFixture();
    const fake = fakeConnection({ rooms, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    const beforeKeys = JSON.stringify(Object.keys(localStorage).sort());

    const setting = within(entryFor("project-x")).getByTestId("room-notifications");
    expect(setting).toHaveValue("all");

    fireEvent.change(setting, { target: { value: "nothing" } });

    await waitFor(() => expect(fake.connection.setNotificationMode).toHaveBeenCalledWith("!project-x:workspace.example", "nothing"));
    // The reflection is the connection's next answer — what any of the
    // member's devices would render from the same server-side rule.
    await waitFor(() => expect(within(entryFor("project-x")).getByTestId("room-muted")).toBeInTheDocument());
    await waitFor(() => expect(within(entryFor("project-x")).getByTestId("room-notifications")).toHaveValue("nothing"));

    fireEvent.change(within(entryFor("project-x")).getByTestId("room-notifications"), { target: { value: "mentions" } });

    await waitFor(() => expect(fake.connection.setNotificationMode).toHaveBeenCalledWith("!project-x:workspace.example", "mentions"));
    await waitFor(() => expect(within(entryFor("project-x")).queryByTestId("room-muted")).toBeNull());
    await waitFor(() => expect(within(entryFor("project-x")).getByTestId("room-notifications")).toHaveValue("mentions"));
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
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

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

/*
 * #65: mentioning — the product's central gesture, done the Matrix way: the
 * composer offers the room's members (people and the duos present, told
 * apart by the user-id grammar, never by a chosen name), the pick rides the
 * wire as `m.mentions.user_ids` (what the homeserver's push rules read —
 * AC4's "notified according to their settings" is server state, and the
 * client's whole duty is the correct wire shape), and the duo's answer —
 * arrived through its owner's daemon, late if the Mac was asleep — renders
 * in the conversation like any duo message, with its permissions outcome in
 * the daemon's own words, verbatim.
 */

describe("#65 AC1 — people and duos are both mentionable", () => {
  it("typing @ offers the people and the duos present, clearly distinguished", async () => {
    seedSession();
    // project-x's members are one person (Bose) and one duo (duo-carol) —
    // the fixture's order is the offer's order.
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    const composer = screen.getByLabelText("Message project-x");
    fireEvent.change(composer, { target: { value: "@" } });

    const offer = await screen.findByTestId("mention-offer");
    const options = within(offer).getAllByTestId("mention-option");
    expect(options).toHaveLength(2);
    // The person is offered by their name; the duo by whose it is — the
    // same structural grammar every attribution uses.
    expect(within(options[0]!).getByTestId("mention-kind").textContent).toBe("person");
    expect(options[0]).toHaveTextContent("Bose");
    expect(within(options[1]!).getByTestId("mention-kind").textContent).toBe("duo");
    expect(options[1]).toHaveTextContent("carol's duo");

    // The typed fragment narrows the offer, the way an address bar does.
    fireEvent.change(composer, { target: { value: "@bo" } });
    await waitFor(() =>
      expect(within(screen.getByTestId("mention-offer")).getAllByTestId("mention-option")).toHaveLength(1),
    );
    expect(within(screen.getByTestId("mention-offer")).getAllByTestId("mention-option")[0]).toHaveTextContent("Bose");
  });

  it("a mention deleted from the text doesn't ride the wire", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    const composer = screen.getByLabelText("Message project-x");
    fireEvent.change(composer, { target: { value: "@ca" } });
    fireEvent.click((await screen.findByTestId("mention-offer")).querySelector('[data-testid="mention-option"]')!);

    // The pick landed in the text — then the sender thought better of it
    // and wrote something else. What the message doesn't say, the wire
    // doesn't claim: no m.mentions for a mention no longer in the body.
    fireEvent.change(composer, { target: { value: "never mind" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(fake.connection.send).toHaveBeenCalledWith("!project-x:workspace.example", "never mind");
  });
});

describe("#65 AC2 — mentioning a duo asks it", () => {
  it("a mention of a duo rides the wire to it, and its answer renders in the conversation", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    const composer = screen.getByLabelText("Message project-x");
    fireEvent.change(composer, { target: { value: "@ca" } });
    // "@ca" narrows the offer to the duo alone — the person's label doesn't
    // begin with it.
    const offerEl = await screen.findByTestId("mention-offer");
    const duoOption = [...offerEl.querySelectorAll('[data-testid="mention-option"]')].find((option) =>
      option.textContent?.includes("carol's duo"),
    )!;
    fireEvent.click(duoOption);
    // Picking closes the offer and leaves the addressed words in the text.
    await waitFor(() => expect(screen.queryByTestId("mention-offer")).toBeNull());
    expect(composer).toHaveValue("@carol's duo ");

    fireEvent.change(composer, { target: { value: "@carol's duo what's our refund policy?" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    // The mention rode the wire: the body says it in words people read,
    // m.mentions says it in ids the homeserver's push rules read, and the
    // pick's id+label pair is what the seam anchors the pill from.
    expect(fake.connection.send).toHaveBeenCalledWith(
      "!project-x:workspace.example",
      "@carol's duo what's our refund policy?",
      [{ userId: "@duo-carol:workspace.example", label: "carol's duo" }],
    );

    // The answer arrives — here, one that was held while its owner's Mac
    // was asleep (#186's held-not-lost) and landed when it woke. The client
    // renders it when it arrives and synthesizes nothing before: no local
    // "the duo is thinking", no invented "will answer later".
    const LATE_ANSWER = "Refunds within 30 days, full amount. (I was asleep — this was waiting for me.)";
    act(() =>
      fake.deliver(
        messageFor({ eventId: "$9", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: LATE_ANSWER }),
      ),
    );
    const row = await waitFor(() => messageRow(LATE_ANSWER));
    expect(within(row).getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");
  });
});

describe("#65 AC3 — a duo that may not answer says so", () => {
  it("the permissions outcome renders verbatim — passed on or declined, in the daemon's own words", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    // The daemon's own composed outcomes (digital-duo public-answer.ts:
    // withPublicAttribution wraps PUBLIC_PASSED_ON_MESSAGE /
    // PUBLIC_REFUSAL_MESSAGE with the identity line) — the exact bytes the
    // client must show as-is. The comparison is on textContent directly:
    // no matcher's whitespace normalization may stand in for "verbatim".
    const attribution = "— carol's duo speaking here, not carol directly.";
    const passedOn = `I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.\n\n${attribution}`;
    const declined = `That's not something I speak for the owner on. I've passed it on to them, without saying anything more about it here.\n\n${attribution}`;

    act(() =>
      fake.deliver(messageFor({ eventId: "$p", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: passedOn })),
    );
    // Multi-line bodies never match queryByText (its matcher normalizes the
    // node's text but not the expected string), so the row is found by a
    // raw-substring probe and "verbatim" is pinned on raw textContent —
    // byte-exact by construction, no normalization standing in for it.
    const passedRow = await waitFor(() => {
      const row = screen
        .getAllByTestId("room-message")
        .find((candidate) => candidate.textContent?.includes("passed it on to the owner, and they'll follow up."));
      expect(row).toBeDefined();
      return row!;
    });
    expect(passedRow.textContent).toContain(passedOn);
    expect(within(passedRow).getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");

    act(() =>
      fake.deliver(messageFor({ eventId: "$d", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: declined })),
    );
    const declinedRow = await waitFor(() => {
      const row = screen
        .getAllByTestId("room-message")
        .find((candidate) => candidate.textContent?.includes("not something I speak for the owner on"));
      expect(row).toBeDefined();
      return row!;
    });
    expect(declinedRow.textContent).toContain(declined);
  });
});

/*
 * #65's receiving half: a mentioning message arrives carrying its parts
 * (the seam's projection of the formatted body's anchors), and the client
 * renders each mention as the mention it is — the pill. A duo's pill IS
 * the duo: its label is re-derived from the user id at the render site, so
 * a display name a sender claimed for it can never put the owner's name on
 * somebody's duo.
 */
describe("#65 — a delivered mention renders as the mention it is", () => {
  it("person and duo pills render from the parts, the duo's label from its id, never a claimed name", async () => {
    seedSession();
    // Bose's message mentions a person and a duo. The duo's part carries a
    // lying label — a display name somebody chose — and the pill must not
    // believe it: the grammar says whose duo it is, the same structural
    // rule message attribution has always followed.
    const fake = fakeConnection({
      rooms: roomsFixture(),
      timelines: {
        "!project-x:workspace.example": [
          messageFor({
            eventId: "$m1",
            senderId: "@bose:workspace.example",
            senderName: "Bose",
            body: "@Carol, @carol's duo — what's our refund policy?",
            parts: [
              { kind: "mention", userId: "@carol:workspace.example", label: "Carol" },
              { kind: "text", text: ", " },
              { kind: "mention", userId: "@duo-carol:workspace.example", label: "The Refund Bot" },
              { kind: "text", text: " — what's our refund policy?" },
            ],
          }),
        ],
      },
    });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    const pills = await screen.findAllByTestId("room-mention");
    expect(pills).toHaveLength(2);
    // The person's pill: their resolved label, the accent's solid border.
    expect(pills[0]).toHaveTextContent("@Carol");
    expect(pills[0].dataset.mentionedUser).toBe("@carol:workspace.example");
    expect(pills[0].className).toContain("border-[var(--accent)]");
    // The duo's pill: "carol's duo" from `@duo-carol` — not "The Refund
    // Bot" — wearing the dashed idiom the duo's own messages wear.
    expect(pills[1]).toHaveTextContent("@carol's duo");
    expect(pills[1].dataset.mentionedUser).toBe("@duo-carol:workspace.example");
    expect(pills[1].className).toContain("border-dashed");
    // The pill said the words; the body's plain text no longer repeats them.
    expect(screen.queryByText("@Carol, @carol's duo — what's our refund policy?")).toBeNull();
  });
});

/*
 * #65's badge: a mention of you is not just any unread — the list's entry
 * for that conversation carries the mention badge beside the unread count,
 * the client-visible receipt of the homeserver's push accounting (the
 * spec's `.m.rule.is_user_mention` reading `m.mentions.user_ids` — #65
 * AC4's "notified according to their settings" lands as server state; this
 * is the count arriving back).
 */
describe("#65 — a mention of you marks the conversation in the list", () => {
  it("a delivered mention-of-you raises the mention badge beside the unread count", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // project-x starts at 3 unread, no mentions — the badge isn't there.
    expect(within(entryFor("project-x")).getByTestId("room-unread").textContent).toBe("3 unread");
    expect(within(entryFor("project-x")).queryByTestId("room-mentions")).toBeNull();

    // Bose mentions ana; the arrival moves the server's counts — a mention
    // is also a notification — and the entry shows both.
    act(() =>
      fake.deliver(
        messageFor({
          eventId: "$m2",
          senderId: "@bose:workspace.example",
          senderName: "Bose",
          body: "@ana — can you look at this?",
          parts: [
            { kind: "mention", userId: "@ana:workspace.example", label: "ana" },
            { kind: "text", text: " — can you look at this?" },
          ],
        }),
      ),
    );

    await waitFor(() => expect(within(entryFor("project-x")).getByTestId("room-mentions").textContent).toBe("@ 1"));
    expect(within(entryFor("project-x")).getByTestId("room-unread").textContent).toBe("4 unread");
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

/*
 * #69: what interrupts the member becomes a setting with three voices —
 * the per-conversation mode (server-side, so every device answers the
 * same), do-not-disturb (this device's own rule, holding everything back
 * and recording what it held), and the duo's own acts as a category no
 * conversation setting can silence. The dispatch lives in the app shell:
 * it hears the same live arrivals every surface hears and decides, before
 * the shell posts anything, whether this arrival interrupts.
 */
describe("#69 AC1 — an arrival interrupts by the conversation's setting", () => {
  it("all lets everything through, mentions holds the plain, nothing holds all", async () => {
    seedSession();
    const rooms = roomsFixture();
    rooms[1] = { ...rooms[1]!, notifications: "mentions" };
    rooms[2] = { ...rooms[2]!, muted: true, notifications: "nothing" };
    const fake = fakeConnection({ rooms, timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // project-x is mentions-only: plain words never interrupt…
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$n1", senderId: "@bose:workspace.example", senderName: "Bose", body: "plain words" }));
    });
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();
    // …a mention does, under the app's name, saying who, where, and what.
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$n2", senderId: "@bose:workspace.example", senderName: "Bose", body: "@ana — ping" }), true);
    });
    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Duo", body: "Bose in project-x: @ana — ping" }),
      ),
    );

    // announce is nothing: not even a mention interrupts.
    await act(async () => {
      fake.deliver(
        messageFor({ eventId: "$n3", roomId: "!announce:workspace.example", senderId: "@dee:workspace.example", senderName: "Dee", body: "@ana, all-hands" }),
        true,
      );
    });
    expect(notificationPlugin.sendNotification).toHaveBeenCalledTimes(1);

    // direct is all (the default): plain words interrupt.
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$n4", roomId: "!direct:workspace.example", senderId: "@bose:workspace.example", senderName: "Bose", body: "lunch?" }));
    });
    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Bose in Bose: lunch?" }),
      ),
    );
  });

  it("the member's own words never interrupt, and an open conversation is not interrupted about itself", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // Own words — sent from this device or any other — are not news.
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$o1", senderId: SESSION.userId, senderName: "ana", body: "from my other device" }));
    });
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();

    // The room the member is looking at does not interrupt about itself —
    // a notification for what the open window already shows is noise.
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$n5", senderId: "@bose:workspace.example", senderName: "Bose", body: "while you watch" }), true);
    });
    await waitFor(() => expect(messageRow("while you watch")).toBeInTheDocument());
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();
  });
});

describe("#69 AC2 — do not disturb holds everything back, visibly", () => {
  it("a manual do-not-disturb keeps the interruption off and keeps the record for afterwards", async () => {
    seedSession();
    localStorage.setItem("duo.dnd", JSON.stringify({ manual: true, from: null, to: null }));
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");

    await act(async () => {
      fake.deliver(messageFor({ eventId: "$m1", senderId: "@bose:workspace.example", senderName: "Bose", body: "held words" }), true);
    });
    // Nothing interrupts — not the mention the setting would otherwise let through.
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();

    // What was missed is visible afterwards, in the place the member set the rule.
    navigate("#settings");
    const missed = await screen.findByTestId("missed-list");
    const entry = within(missed).getByTestId("missed-entry");
    expect(entry).toHaveTextContent("Bose in project-x: held words");
    // The record points back at where it happened — the entry itself is the
    // link. ("!" is one of encodeURIComponent's unreserved characters; ":" is
    // not — the same address the conversations list links with.)
    expect(entry.getAttribute("href")).toBe("#room/!project-x%3Aworkspace.example");

    fireEvent.click(screen.getByTestId("missed-clear"));
    await waitFor(() => expect(screen.queryByTestId("missed-entry")).toBeNull());
    expect(localStorage.getItem("duo.missed")).toBe("[]");
  });

  it("do not disturb turns on and off here, and quiet hours persist on this device", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#settings");

    expect(await screen.findByTestId("dnd-toggle")).toHaveTextContent("Turn on do not disturb");
    fireEvent.click(screen.getByTestId("dnd-toggle"));
    await waitFor(() => expect(screen.getByTestId("dnd-status")).toHaveTextContent("Do not disturb is on."));
    expect(JSON.parse(localStorage.getItem("duo.dnd")!)).toEqual({ manual: true, from: null, to: null });

    fireEvent.change(screen.getByTestId("dnd-from"), { target: { value: "22:00" } });
    fireEvent.change(screen.getByTestId("dnd-to"), { target: { value: "07:00" } });
    expect(JSON.parse(localStorage.getItem("duo.dnd")!)).toEqual({ manual: true, from: "22:00", to: "07:00" });

    fireEvent.click(screen.getByTestId("dnd-toggle"));
    await waitFor(() => expect(screen.getByTestId("dnd-status")).toHaveTextContent("Do not disturb is off."));
  });
});

/** The push channel's client half: a socket the test opens and speaks for. */
function stubDraftPushSocket() {
  class FakeSocket {
    static instances: FakeSocket[] = [];
    listeners = new Map<string, Array<(event: unknown) => void>>();
    sent: string[] = [];
    constructor() {
      FakeSocket.instances.push(this);
    }
    addEventListener(type: string, cb: (event: unknown) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
    }
    removeEventListener() {}
    send(data: string) {
      this.sent.push(data);
    }
    close() {}
    open() {
      this.listeners.get("open")?.forEach((cb) => cb(new Event("open")));
    }
    message(data: unknown) {
      this.listeners.get("message")?.forEach((cb) => cb({ data: JSON.stringify(data) }));
    }
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  return FakeSocket;
}

describe("#69 AC3 — the owner's duo acting on their behalf is its own category", () => {
  it("the member's own duo answering in a conversation says so, in words no message uses", async () => {
    seedSession();
    const rooms = roomsFixture();
    rooms[1] = {
      ...rooms[1]!,
      members: [...rooms[1]!.members, { userId: "@duo-ana:workspace.example", name: "duo-ana" }],
    };
    const fake = fakeConnection({ rooms, timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // The member's own duo (@duo-ana — the id grammar says whose) speaks in
    // the room: neither "a message" nor "a draft" — the duo acted.
    await act(async () => {
      fake.deliver(
        messageFor({ eventId: "$duo1", senderId: "@duo-ana:workspace.example", senderName: "duo-ana", body: "Answered on the owner's behalf: 30 days." }),
      );
    });
    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Your duo answered on your behalf in project-x." }),
      ),
    );

    // A colleague's duo is a participant, not the member's own — its words
    // are a message like any person's, governed by the room's setting.
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$duo2", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "carol's duo speaks" }));
    });
    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "carol's duo in project-x: carol's duo speaks" }),
      ),
    );
  });

  it("an escalation arriving from the daemon notifies as the duo's own act, not as a waiting draft", async () => {
    seedSession();
    seedPairing();
    // The daemon's answer for the one draft the push names: an escalation.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/drafts/d1")) {
          return new Response(JSON.stringify({ id: "d1", escalated: true, refused: false }), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    const FakeSocket = stubDraftPushSocket();

    await renderApp();
    await screen.findByTestId("conversations-list");
    await act(async () => {
      FakeSocket.instances[0].open();
      FakeSocket.instances[0].message({ type: "draft-ready", draftId: "d1" });
    });

    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Your duo escalated a question to you." }),
      ),
    );
    // It never said the draft copy — the two categories cannot blur.
    const bodies = notificationPlugin.sendNotification.mock.calls.map((call) => call[0].body);
    expect(bodies).not.toContain("A new draft is waiting for your review.");
  });
});

/*
 * #69's product rule: the owner's duo answering, escalating, or refusing on
 * their behalf is the one notification that can never be fully turned off.
 * "Fully" is the point — a conversation set to nothing, and a do-not-disturb
 * that holds everything, both leave it standing: the first cannot reach it
 * (the act belongs to no conversation), the second only defers it into the
 * record Settings shows. And no control anywhere offers to silence it.
 */
describe("#69 AC3 — the duo's own acts can never be fully turned off", () => {
  function roomsWithOwnDuoIn(notifications: "nothing" | "mentions") {
    const rooms = roomsFixture();
    rooms[1] = {
      ...rooms[1]!,
      muted: notifications === "nothing",
      notifications,
      members: [...rooms[1]!.members, { userId: "@duo-ana:workspace.example", name: "duo-ana" }],
    };
    return rooms;
  }

  it.each(["nothing", "mentions"] as const)("a conversation set to %s still announces the member's own duo answering", async (mode) => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsWithOwnDuoIn(mode), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // A person in the same room stays governed by the setting…
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$s1", senderId: "@bose:workspace.example", senderName: "Bose", body: "plain words" }));
    });
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();
    // …the duo's act on the member's behalf is not a message and is not silenced by it.
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$s2", senderId: "@duo-ana:workspace.example", senderName: "duo-ana", body: "30 days." }));
    });
    await waitFor(() =>
      expect(notificationPlugin.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Your duo answered on your behalf in project-x." }),
      ),
    );
  });

  it("do not disturb defers it into the record instead of dropping it", async () => {
    seedSession();
    localStorage.setItem("duo.dnd", JSON.stringify({ manual: true, from: null, to: null }));
    const fake = fakeConnection({ rooms: roomsWithOwnDuoIn("nothing"), timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);

    await renderApp();
    await screen.findByTestId("conversations-list");
    await act(async () => {
      fake.deliver(messageFor({ eventId: "$d1", senderId: "@duo-ana:workspace.example", senderName: "duo-ana", body: "30 days." }));
    });
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();

    navigate("#settings");
    const entry = within(await screen.findByTestId("missed-list")).getByTestId("missed-entry");
    expect(entry).toHaveTextContent("Your duo answered on your behalf in project-x.");
    expect(entry.getAttribute("href")).toBe("#room/!project-x%3Aworkspace.example");
  });

  it("an escalation is held by do not disturb the same way, and waits in the record", async () => {
    seedSession();
    seedPairing();
    localStorage.setItem("duo.dnd", JSON.stringify({ manual: true, from: null, to: null }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/drafts/d2")) {
          return new Response(JSON.stringify({ id: "d2", escalated: true, refused: true }), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    notificationPlugin.isPermissionGranted.mockResolvedValue(true);
    const FakeSocket = stubDraftPushSocket();

    await renderApp();
    await screen.findByTestId("conversations-list");
    await act(async () => {
      FakeSocket.instances[0].open();
      FakeSocket.instances[0].message({ type: "draft-ready", draftId: "d2" });
    });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("duo.missed") ?? "[]")).toHaveLength(1));
    expect(notificationPlugin.sendNotification).not.toHaveBeenCalled();

    navigate("#settings");
    const entry = within(await screen.findByTestId("missed-list")).getByTestId("missed-entry");
    expect(entry).toHaveTextContent("Your duo refused to answer for you.");
    expect(entry.getAttribute("href")).toBe("#draft/d2");
  });

  it("no setting offers to silence the category — do not disturb defers, and that is all the member is given", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate("#settings");
    const section = await screen.findByTestId("settings-notifications");

    // The only switches are this device's do-not-disturb and its window; the
    // words for turning off "duo" / "on your behalf" appear nowhere here.
    expect(within(section).getAllByRole("button").map((b) => b.textContent)).toEqual(["Turn on do not disturb"]);
    expect(section.textContent ?? "").not.toMatch(/on your behalf|mute (my )?duo|turn off duo/i);
  });
});

/** #66: one share's facts as a timeline row carries them. */
function sharedMessageFor(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId" | "senderId"> & { file: SharedFile }): RoomMessage {
  return messageFor({ ...over, body: over.file.name });
}

describe("#66 — sharing files and images in a conversation", () => {
  const ROOM = "!project-x:workspace.example";
  const PDF_SHARE: SharedFile = { name: "refund-policy.pdf", mimeType: "application/pdf", size: 48_000, url: "mxc://workspace.example/policy1", image: false };
  const IMAGE_SHARE: SharedFile = { name: "whiteboard.png", mimeType: "image/png", size: 204_800, url: "mxc://workspace.example/img1", image: true };

  // jsdom has neither object URLs nor navigation: the blob URLs are numbered
  // stand-ins, and a download is the anchor click the card makes — captured.
  const downloads: { download: string; href: string }[] = [];
  let anchorClick: { mockRestore: () => void } | undefined;
  beforeEach(() => {
    downloads.length = 0;
    let sequence = 0;
    Object.assign(URL, { createObjectURL: () => `blob:mock/${(sequence += 1)}`, revokeObjectURL: () => {} });
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ download: this.download, href: this.href });
    });
  });
  afterEach(() => {
    anchorClick?.mockRestore();
  });

  /** Opens project-x (Bose, carol's duo) with the given timelines. */
  async function openRoom(timelines: Record<string, RoomMessage[]> = { [ROOM]: [...PROJECT_TIMELINE] }) {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-timeline");
    return fake;
  }

  /** Puts files in the member's hand and picks them, the way the input does — settled when each is a chip or a refusal naming it. */
  async function pick(files: File[]): Promise<void> {
    fireEvent.change(screen.getByTestId("attach-file-input"), { target: { files } });
    await waitFor(() => {
      for (const file of files) {
        const staged = screen.queryAllByTestId("attachment-chip").some((chip) => chip.textContent?.includes(file.name));
        const refused = screen.queryByTestId("room-composer-error")?.textContent?.includes(file.name) ?? false;
        expect(staged || refused).toBe(true);
      }
    });
  }

  it("a shared file renders an honest card — name, size, type, download — and an image renders a thumbnail", async () => {
    const fake = await openRoom({
      [ROOM]: [
        ...PROJECT_TIMELINE,
        sharedMessageFor({ eventId: "$f1", senderId: "@bose:workspace.example", senderName: "Bose", file: PDF_SHARE }),
        sharedMessageFor({ eventId: "$f2", senderId: "@carol:workspace.example", senderName: "Carol", file: IMAGE_SHARE }),
      ],
    });

    const shares = await screen.findAllByTestId("room-file");
    expect(shares).toHaveLength(2);

    const fileShare = within(shares[0]!);
    expect(fileShare.queryByTestId("room-file-image")).toBeNull(); // a PDF is not previewed — no preview is faked
    expect(fileShare.getByTestId("room-file-name")).toHaveTextContent("refund-policy.pdf");
    expect(fileShare.getByTestId("room-file-facts")).toHaveTextContent("47 KiB");
    expect(fileShare.getByTestId("room-file-facts")).toHaveTextContent("application/pdf");
    // Nothing is fetched until the member asks: a 16 MiB file is not
    // pulled into every reader's browser just for being in the flow.
    expect(fake.connection.loadMedia).not.toHaveBeenCalledWith("mxc://workspace.example/policy1");
    await act(async () => {
      fireEvent.click(fileShare.getByTestId("room-file-download"));
    });
    await waitFor(() => expect(downloads).toEqual([{ download: "refund-policy.pdf", href: expect.stringMatching(/^blob:mock\//) }]));
    expect(fake.connection.loadMedia).toHaveBeenCalledWith("mxc://workspace.example/policy1");

    // The stack makes thumbnails cheap: the img is the thumbnail, its bytes
    // loaded through the member's own authenticated fetch.
    const imageShare = within(shares[1]!);
    await waitFor(() => expect(imageShare.getByTestId("room-file-image")).toHaveAttribute("src", expect.stringMatching(/^blob:mock\//)));
    expect(imageShare.getByTestId("room-file-image")).toHaveAttribute("alt", "whiteboard.png");
    expect(fake.connection.loadMedia).toHaveBeenCalledWith("mxc://workspace.example/img1");
    expect(imageShare.getByTestId("room-file-download")).toBeInTheDocument();
  });

  it("bytes this member can't load keep the facts and say so — no broken thumbnail, no silent dead link", async () => {
    seedSession();
    const fake = fakeConnection({
      rooms: roomsFixture(),
      timelines: { [ROOM]: [...PROJECT_TIMELINE, sharedMessageFor({ eventId: "$f1", senderId: "@bose:workspace.example", senderName: "Bose", file: IMAGE_SHARE })] },
    });
    vi.mocked(fake.connection.loadMedia).mockResolvedValue(null);
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#room/!project-x%3Aworkspace.example");
    await screen.findByTestId("room-file");

    await waitFor(() => expect(fake.connection.loadMedia).toHaveBeenCalled());
    expect(screen.queryByTestId("room-file-image")).toBeNull(); // no bytes, no thumbnail — the card, honestly
    expect(screen.getByTestId("room-file-facts")).toHaveTextContent("whiteboard.png");
    expect(screen.getByTestId("room-file-facts")).toHaveTextContent("image/png");
    // The download says why it did nothing, and can be tried again.
    await act(async () => {
      fireEvent.click(screen.getByTestId("room-file-download"));
    });
    expect(await screen.findByTestId("room-file-error")).toHaveTextContent("Couldn't load whiteboard.png");
    expect(downloads).toEqual([]);
  });

  it("a duo's share is attributed to its owner in the duo's own container — a file is a message, and AR-13 holds for it", async () => {
    await openRoom({
      [ROOM]: [...PROJECT_TIMELINE, sharedMessageFor({ eventId: "$f1", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", file: PDF_SHARE })],
    });
    const share = await screen.findByTestId("room-file");
    const container = share.closest('[data-testid="room-duo-message"]');
    expect(container).not.toBeNull();
    expect(within(container as HTMLElement).getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");
    expect(share.closest('[data-testid="room-person-message"]')).toBeNull();
  });

  it("a share offers a download and nothing that imports it — importing is another act, owned and labelled elsewhere", async () => {
    await openRoom({
      [ROOM]: [...PROJECT_TIMELINE, sharedMessageFor({ eventId: "$f1", senderId: "@bose:workspace.example", senderName: "Bose", file: PDF_SHARE })],
    });
    const share = await screen.findByTestId("room-file");
    expect(within(share).queryAllByRole("button").map((button) => button.textContent)).toEqual(["Download"]);
    expect(within(share).queryByText(/import|corpus|learn/i)).toBeNull();
  });

  it("attaching and sending shares the file: upload through the seam, m.file on the wire, the share in the flow", async () => {
    const fake = await openRoom();

    await pick([new File([new Uint8Array([104, 101, 108, 108, 111])], "notes.txt", { type: "text/plain" })]);
    expect(screen.getByTestId("attachment-chip")).toHaveTextContent("notes.txt");
    expect(screen.getByTestId("attachment-chip")).toHaveTextContent("5 B");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    expect(fake.connection.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "notes.txt", mimeType: "text/plain", size: 5 }),
      expect.any(Function),
    );
    await waitFor(() =>
      expect(fake.connection.sendFile).toHaveBeenCalledWith(ROOM, {
        name: "notes.txt",
        mimeType: "text/plain",
        size: 5,
        url: "mxc://workspace.example/notes.txt",
        image: false,
      }),
    );
    // The share renders at once as this member's marked copy.
    expect(await screen.findByTestId("room-file")).toBeInTheDocument();
    // And the composer lets go of it — the room is the record.
    await waitFor(() => expect(screen.queryByTestId("attachment-chip")).toBeNull());
  });

  it("attach, then ask: the files ride immediately before the question — the association convention the backend reads", async () => {
    const fake = await openRoom();

    await pick([
      new File([new Uint8Array([1])], "one.txt", { type: "text/plain" }),
      new File([new Uint8Array([2])], "two.txt", { type: "text/plain" }),
    ]);
    // The room has a duo member, and the composer says what that means.
    const note = screen.getByTestId("attachment-note");
    expect(note).toHaveTextContent("carol's duo");
    expect(note).toHaveTextContent("32 KiB");
    expect(note).toHaveTextContent("can't read images yet — an open provider decision");
    expect(note).toHaveTextContent("never imports");

    fireEvent.change(screen.getByLabelText("Message project-x"), { target: { value: "what do these say?" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    // Contiguous, same sender, same room: upload → m.file → m.file → the
    // question, in exactly the order the wire carries them.
    const [uploadOne, uploadTwo] = vi.mocked(fake.connection.uploadFile).mock.invocationCallOrder;
    const [fileOne, fileTwo] = vi.mocked(fake.connection.sendFile).mock.invocationCallOrder;
    const [question] = vi.mocked(fake.connection.send).mock.invocationCallOrder;
    expect(fileOne).toBeGreaterThan(uploadOne);
    expect(uploadTwo).toBeGreaterThan(fileOne);
    expect(fileTwo).toBeGreaterThan(uploadTwo);
    expect(question).toBeGreaterThan(fileTwo);
    expect(fake.connection.send).toHaveBeenCalledWith(ROOM, "what do these say?");
    // Both shares and the question left the composer.
    await waitFor(() => expect(screen.queryByTestId("attachment-chip")).toBeNull());
    expect(screen.getByLabelText("Message project-x")).toHaveValue("");
  });

  it("the upload's progress is visible while it runs, and the composer rests when it ends", async () => {
    const fake = await openRoom();
    let report: (sent: number, total: number) => void = () => {};
    let finish: (shared: SharedFile) => void = () => {};
    vi.mocked(fake.connection.uploadFile).mockImplementationOnce(
      (_staged, onProgress) =>
        new Promise<SharedFile>((resolve) => {
          report = onProgress ?? (() => {});
          finish = resolve;
        }),
    );

    await pick([new File([new Uint8Array(1000)], "report.pdf", { type: "application/pdf" })]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    expect(screen.getByTestId("room-composer-status")).toHaveTextContent("Uploading report.pdf…");

    act(() => report(250, 1000));
    expect(screen.getByTestId("room-composer-status")).toHaveTextContent("Uploading report.pdf… 25%");
    act(() => report(1000, 1000));
    expect(screen.getByTestId("room-composer-status")).toHaveTextContent("Uploading report.pdf… 100%");

    await act(async () => {
      finish({ name: "report.pdf", mimeType: "application/pdf", size: 1000, url: "mxc://workspace.example/report", image: false });
    });
    await waitFor(() => expect(screen.queryByTestId("room-composer-status")).toBeNull());
    expect(fake.connection.sendFile).toHaveBeenCalled();
  });

  it("a room with no duo says so — the share is for the people here", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: roomsFixture(), timelines: { "!announce:workspace.example": [] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate("#room/!announce%3Aworkspace.example");
    await screen.findByTestId("room-timeline");

    await pick([new File([new Uint8Array([1])], "announce.txt", { type: "text/plain" })]);
    expect(screen.getByTestId("attachment-note")).toHaveTextContent("no duo is here");
    expect(screen.getByTestId("attachment-note")).toHaveTextContent("never imports");
  });

  it("share limits refuse by naming the limit, and keep the message", async () => {
    await openRoom();

    // A 9 MiB image against this app's 8 MiB image limit.
    await pick([new File([new Uint8Array(9 * 1024 * 1024)], "big.png", { type: "image/png" })]);
    expect(screen.getByTestId("room-composer-error")).toHaveTextContent("big.png is 9 MiB — conversation image shares cap at 8 MiB.");
    expect(screen.queryByTestId("attachment-chip")).toBeNull();

    // A 17 MiB file against this app's 16 MiB file limit — and the refusal
    // names THIS limit, not the duo's 32 KiB reading cap.
    await pick([new File([new Uint8Array(17 * 1024 * 1024)], "deck.pdf", { type: "application/pdf" })]);
    expect(screen.getByTestId("room-composer-error")).toHaveTextContent("deck.pdf is 17 MiB — conversation file shares cap at 16 MiB.");
    expect(screen.getByTestId("room-composer-error").textContent).not.toContain("32 KiB");

    // A fourth attachment names the count — the door a duo grounds by.
    await pick([
      new File([new Uint8Array([1])], "one.txt", { type: "text/plain" }),
      new File([new Uint8Array([1])], "two.txt", { type: "text/plain" }),
      new File([new Uint8Array([1])], "three.txt", { type: "text/plain" }),
    ]);
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(3);
    await pick([new File([new Uint8Array([1])], "four.txt", { type: "text/plain" })]);
    expect(screen.getByTestId("room-composer-error")).toHaveTextContent("four.txt wasn't added — a message carries at most 3 attachments.");
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(3);
    expect(screen.getAllByTestId("attachment-chip").some((chip) => chip.textContent?.includes("four.txt"))).toBe(false);
  });

  it("an upload the workspace refuses states the file, keeps the attachment, and never sends the question past it", async () => {
    const fake = await openRoom();
    vi.mocked(fake.connection.uploadFile).mockRejectedValueOnce(new Error("notes.txt is over the workspace's own upload limit."));

    await pick([new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" })]);
    fireEvent.change(screen.getByLabelText("Message project-x"), { target: { value: "what does this say?" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    // The reason the workspace gave is the reason stated — not a bare "failed".
    await waitFor(() => expect(screen.getByTestId("room-composer-error")).toHaveTextContent("The workspace didn't take notes.txt"));
    expect(screen.getByTestId("room-composer-error")).toHaveTextContent("notes.txt is over the workspace's own upload limit.");
    // Nothing is lost: the file stays attached, the words stay typed, and
    // the question was not sent riding the wrong (empty) set of files.
    expect(screen.getByTestId("attachment-chip")).toHaveTextContent("notes.txt");
    expect(screen.getByLabelText("Message project-x")).toHaveValue("what does this say?");
    expect(fake.connection.sendFile).not.toHaveBeenCalled();
    expect(fake.connection.send).not.toHaveBeenCalled();
  });
});

/*
 * #127 (hide-the-form half): a hosted build (VITE_DUO_DAEMON_URL set) never
 * shows the homeserver form — its workspace is the operator's, not something
 * the person types an address for. Until auto-connect lands, Conversations
 * and Settings say the workspace isn't set up instead. A personal daemon
 * (no env var) keeps the manual form, exactly as #62 built it.
 */
describe("#127 — hosted builds never show the homeserver form", () => {
  const HOSTED_ORIGIN = "https://duo-daemon.example.org";

  async function goTo(hash: string) {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
  }

  /** A hosted sign-in leaves this record beside the pairing; `connectManually` (Advanced) clears it. */
  function seedHostedAccount() {
    localStorage.setItem("duo.hosted-account", JSON.stringify({ origin: HOSTED_ORIGIN, ownerName: "Ada", isAdmin: false }));
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Conversations says the workspace isn't set up, with no sign-in button", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    seedPairing();
    seedHostedAccount();
    stubDaemonFetch();
    window.location.hash = "#conversations";

    await renderApp();

    expect(await screen.findByTestId("workspace-not-set-up")).toHaveTextContent("Workspace isn't set up yet");
    expect(screen.queryByTestId("conversations-signin")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in to a workspace" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Homeserver")).not.toBeInTheDocument();
  });

  it("Settings says the same, and never opens the sign-in dialog", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    seedPairing();
    seedHostedAccount();
    stubDaemonFetch();
    window.location.hash = "#settings";

    await renderApp();

    const workspace = await screen.findByTestId("settings-workspace");
    expect(within(workspace).getByTestId("workspace-not-set-up")).toHaveTextContent("Workspace isn't set up yet");
    expect(screen.queryByTestId("settings-workspace-signin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-signin-dialog")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Homeserver")).not.toBeInTheDocument();
  });

  it("the front door's Advanced (address) screen offers pairing, not a homeserver form", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    // Arrive at the front door itself (#signin), not the bare root, which
    // redirects a signed-out visitor to the landing page.
    window.location.hash = "#signin";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ googleClientId: "abc" }), { status: 200 })));

    await renderApp();
    fireEvent.click(await screen.findByTestId("landing-advanced"));

    expect(await screen.findByRole("heading", { name: "Pair a duo instead" })).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-not-set-up")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Homeserver")).not.toBeInTheDocument();
  });

  it("a hosted server without Google sign-in leads with pairing, with no workspace note above it", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    // Arrive at the front door itself (#signin), not the bare root, which
    // redirects a signed-out visitor to the landing page.
    window.location.hash = "#signin";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ googleClientId: null }), { status: 200 })));

    await renderApp();

    expect(await screen.findByRole("heading", { name: "Pair a duo instead" })).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-not-set-up")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Homeserver")).not.toBeInTheDocument();
  });

  it("a hosted build paired to a personal daemon via Advanced keeps the manual form (AC 4)", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    window.location.hash = "#signin";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        return new Response(JSON.stringify(url.endsWith("/hosted/config") ? { googleClientId: "abc" } : []), { status: 200 });
      }),
    );
    await renderApp();

    // The front door's Advanced door: pair by address, no hosted sign-in.
    fireEvent.click(await screen.findByTestId("landing-advanced"));
    fireEvent.change(await screen.findByLabelText("Daemon address"), { target: { value: "http://100.64.1.5:7717" } });
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    window.location.hash = "#settings";
    window.dispatchEvent(new Event("hashchange"));
    expect(await screen.findByTestId("settings-workspace-signin")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-not-set-up")).not.toBeInTheDocument();
    expect(localStorage.getItem("duo.hosted-account")).toBeNull();
  });

  it("a stored session still connecting is not told the workspace isn't set up", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    seedPairing();
    seedHostedAccount();
    seedSession();
    stubDaemonFetch();
    vi.mocked(connect).mockReturnValue(new Promise(() => {})); // never resolves: stays connecting
    window.location.hash = "#conversations";

    await renderApp();

    await waitFor(() => expect(vi.mocked(connect)).toHaveBeenCalled());
    expect(screen.queryByTestId("workspace-not-set-up")).not.toBeInTheDocument();
  });

  it("the sign-in dialog renders nothing for a hosted device, even when asked to open", () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOSTED_ORIGIN);
    seedHostedAccount();

    render(<WorkspaceSignInDialog open onOpenChange={() => {}} onSession={() => {}} />);

    expect(screen.queryByTestId("workspace-signin-dialog")).not.toBeInTheDocument();
  });

  it("a personal daemon keeps the manual form: Conversations and Settings both offer the sign-in", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", "");
    seedPairing();
    stubDaemonFetch();
    window.location.hash = "#conversations";

    await renderApp();

    fireEvent.click(await screen.findByTestId("conversations-signin"));
    expect(await screen.findByTestId("workspace-signin-dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Homeserver")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-not-set-up")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId("workspace-signin-dialog"), { key: "Escape" });
    await goTo("#settings");
    expect(await screen.findByTestId("settings-workspace-signin")).toHaveTextContent("Sign in to a workspace");
  });
});
