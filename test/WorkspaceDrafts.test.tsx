import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/workspace/matrix.js";
import type { RoomMessage, RoomSummary, WorkspaceConnection, WorkspaceSession } from "../src/workspace/matrix.js";
import { conversationOf } from "../src/workspace/drafts.js";
import type { DraftProvenance, DraftRecord } from "../src/api/types.js";
import { stubDesktop } from "./desktop.js";

/*
 * #68: your duo drafts replies to the messages you get here. The drafting is
 * the daemon's (a message addressed to the owner arrives over its own
 * workspace connection, and a draft is written with the conversation and the
 * message as its channel provenance); delivery is the daemon's too (#170's
 * seam hands a sent draft's text back to where it came from). What this
 * client owns is the surface: the draft in Review with its provenance, the
 * same draft in the conversation it belongs to, and the discipline that
 * nothing is posted until the owner decides. So every test here plays the
 * daemon's side of the wire — the wire's own shapes, never a client-side
 * invention — and asserts what the surface does with it.
 *
 * The Matrix seam is mocked wholesale, as in the workspace suite: the seam's
 * own behaviour is pinned in WorkspaceMatrixSeam.test.ts.
 */
vi.mock("../src/workspace/matrix.js", () => ({
  signIn: vi.fn(),
  connect: vi.fn(),
}));

// Each test mounts the whole app on a fresh module registry (the first one
// also pays the app's dynamic imports), which a loaded machine stretches
// past vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

const SESSION: WorkspaceSession = {
  homeserverUrl: "https://workspace.example",
  userId: "@ana:workspace.example",
  accessToken: "syt_workspace_token",
  deviceId: "YGBNAUIOMK",
};

const PROJECT = "!project-x:workspace.example";
const ELSEWHERE = "!elsewhere:workspace.example";
/** The message the draft answers — Bose's, in project-x. */
const BOSE_EVENT = "$bose1";
const BOSE_QUESTION = "what's our refund policy?";
const DRAFT_TEXT = "Thirty days, full refund.";

/** The daemon's provenance for a message that arrived here: the channel kind is the daemon's own string, the permalink the message's own address. */
function hereProvenance(roomId = PROJECT, eventId = BOSE_EVENT): DraftProvenance {
  return {
    origin: "channel",
    channelKind: "native",
    askerRef: "@bose:workspace.example",
    threadId: null,
    permalink: `https://matrix.to/#/${roomId}/${eventId}?via=workspace.example`,
  };
}

function draftFor(over: Partial<DraftRecord> & Pick<DraftRecord, "id">): DraftRecord {
  return {
    question: BOSE_QUESTION,
    threadContext: null,
    draftText: DRAFT_TEXT,
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.8,
    sources: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    outcome: null,
    outcomeRecordedAt: null,
    sentText: null,
    refused: false,
    escalationThreshold: 0.55,
    provenance: hereProvenance(),
    delivery: null,
    ...over,
  };
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
    parts: null,
    ...over,
  };
}

const BOSE_MESSAGE = messageFor({ eventId: BOSE_EVENT, senderId: "@bose:workspace.example", senderName: "Bose", body: BOSE_QUESTION });

function roomsFixture(): RoomSummary[] {
  return [
    {
      roomId: PROJECT,
      kind: "group",
      name: "project-x",
      topic: null,
      avatarUrl: null,
      members: [{ userId: "@bose:workspace.example", name: "Bose" }],
      latest: { at: Date.now(), body: BOSE_QUESTION },
      unread: { notifications: 1, mentions: 0 },
      muted: false,
      notifications: "all",
      canEdit: { name: false, topic: false, avatar: false },
    },
  ];
}

/** A fake workspace connection — only what these ACs touch is real, and every write it could make is a spy. */
function fakeConnection(timelines: Record<string, RoomMessage[]>) {
  // Every surface that subscribes hears every arrival (the shell's notification dispatcher subscribes beside the room).
  const listeners = new Set<(roomId: string) => void>();
  const connection = {
    userId: SESSION.userId,
    rooms: vi.fn(async () => roomsFixture()),
    timeline: vi.fn(async (roomId: string) => [...(timelines[roomId] ?? [])]),
    send: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    unreact: vi.fn(async () => {}),
    replyInThread: vi.fn(async () => {}),
    subscribe: vi.fn((handler: (roomId: string) => void) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    }),
    stop: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}),
    // #207: the sidebar's CommandSearch renders alongside every route and
    // calls these on mount — minimal fakes, since none of these ACs drive
    // the search box itself.
    findRooms: vi.fn(async () => roomsFixture()),
    searchPeople: vi.fn(async () => []),
    getProfile: vi.fn(async () => null),
  } as unknown as WorkspaceConnection;
  return {
    connection,
    /** The homeserver's own word arriving over the live subscription. */
    deliver: (message: RoomMessage) => {
      const list = (timelines[message.roomId] ??= []);
      list.push(message);
      listeners.forEach((listener) => listener(message.roomId));
    },
  };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

/**
 * The daemon, stateful the way the real one is: a draft log, the pending
 * list read off it, the newest-window feed, and an outcome POST that
 * records the decision (and, for a decision that sends, the delivery the
 * seam would record next).
 */
function fakeDaemon(initial: DraftRecord[], delivery: DraftRecord["delivery"] = { state: "delivered" }) {
  let log = [...initial];
  const outcomes: Array<{ id: string; body: { outcome: string; sentText?: string } }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const outcome = /\/drafts\/([^/]+)\/outcome$/.exec(url);
    if (outcome && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { outcome: string; sentText?: string };
      outcomes.push({ id: outcome[1]!, body });
      log = log.map((draft) =>
        draft.id === outcome[1]
          ? {
              ...draft,
              outcome: body.outcome as DraftRecord["outcome"],
              outcomeRecordedAt: new Date().toISOString(),
              sentText: body.sentText ?? draft.draftText,
              delivery: body.outcome === "discarded" ? null : delivery,
            }
          : draft,
      );
      return json({});
    }
    const single = /\/drafts\/([^/?]+)$/.exec(url);
    if (single && (init?.method ?? "GET") === "GET") {
      const found = log.find((draft) => draft.id === single[1]);
      return found ? json(found) : json({ error: { code: "not_found", message: "no such draft" } }, 404);
    }
    if (url.includes("/drafts?outcome=pending")) {
      return json(log.filter((draft) => draft.outcome === null));
    }
    if (url.includes("/drafts?limit=")) {
      return json([...log].reverse());
    }
    return json([]);
  });
  return { fetchMock, outcomes, log: () => log };
}

/** Fresh module registry per render: the app's module-level QueryClient must not carry cache across tests. */
async function renderApp() {
  vi.resetModules();
  const { App } = await import("../src/App.js");
  return render(<App />);
}

function navigate(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
}

const ROOM_HASH = `#chat/${encodeURIComponent(PROJECT)}`;

function seed({ paired = true }: { paired?: boolean } = {}) {
  localStorage.setItem("duo.workspace-session", JSON.stringify(SESSION));
  if (paired) {
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
  }
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(connect).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

describe("#68 AC1 — a message here produces a draft, and it is waiting on you in the chat it answers", () => {
  it("the draft carries the conversation and the message as its provenance, rendered as the daemon sent them", async () => {
    // A draft page is where provenance reads in full — the daemon's strings, verbatim.
    // (A draft for a conversation you hold opens that chat instead, below.)
    seed();
    const daemon = fakeDaemon([draftFor({ id: "d1", provenance: hereProvenance(ELSEWHERE) })]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate("#draft/d1");

    const page = await screen.findByTestId("draft-page");
    expect(within(page).getByTestId("duo-message")).toHaveTextContent(DRAFT_TEXT);
    // Who asked and where — the daemon's strings, verbatim; the kind is
    // whatever the daemon calls it, never mapped here.
    expect(within(page).getByTestId("draft-origin")).toHaveTextContent("Asked by @bose:workspace.example in native");
    // The message itself, addressed: the permalink the daemon recorded.
    expect(within(page).getByTestId("origin-permalink")).toHaveAttribute(
      "href",
      `https://matrix.to/#/${ELSEWHERE}/${BOSE_EVENT}?via=workspace.example`,
    );
  });

  it("places the draft in its chat: in Waiting on you the row is the conversation, and it leads into it", async () => {
    seed();
    vi.stubGlobal("fetch", fakeDaemon([draftFor({ id: "d1" })]).fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate("#waiting");

    const row = await screen.findByTestId("waiting-link");
    expect(row).toHaveAttribute("href", ROOM_HASH);
    expect(within(row).getByTestId("waiting-title")).toHaveTextContent("project-x");
    expect(within(row).getByTestId("waiting-preview")).toHaveTextContent("Draft ready");
  });

  it("offers no conversation link for a room the member is not in", async () => {
    // A draft whose permalink names a room this session doesn't hold: the
    // provenance still shows, but the link would lead nowhere real.
    seed();
    vi.stubGlobal("fetch", fakeDaemon([draftFor({ id: "d1", provenance: hereProvenance(ELSEWHERE) })]).fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({}).connection);

    await renderApp();
    navigate("#draft/d1");
    await screen.findByTestId("draft-origin");
    // Let the rooms read settle before asserting an absence.
    await waitFor(() => expect(vi.mocked(connect)).toHaveBeenCalled());
    expect(screen.queryByTestId("open-conversation")).toBeNull();
  });

  it("the Waiting on you count follows the draft, like any draft", async () => {
    seed();
    vi.stubGlobal("fetch", fakeDaemon([draftFor({ id: "d1" }), draftFor({ id: "d2" })]).fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();

    expect(await screen.findByTestId("waiting-badge")).toHaveTextContent("2");
  });
});

describe("#68 AC1 — the conversation is read off the provenance, structurally", () => {
  it("resolves a room and an event from a matrix.to permalink, plain or percent-encoded", () => {
    expect(conversationOf(hereProvenance())).toEqual({ roomId: PROJECT, eventId: BOSE_EVENT });
    expect(
      conversationOf({
        origin: "channel",
        channelKind: "native",
        askerRef: "@bose:workspace.example",
        threadId: null,
        permalink: `https://matrix.to/#/${encodeURIComponent(PROJECT)}/${encodeURIComponent(BOSE_EVENT)}`,
      }),
    ).toEqual({ roomId: PROJECT, eventId: BOSE_EVENT });
  });

  it("a permalink to a room alone names the conversation with no message", () => {
    expect(
      conversationOf({
        origin: "channel",
        channelKind: "native",
        askerRef: "@bose:workspace.example",
        threadId: null,
        permalink: `https://matrix.to/#/${PROJECT}`,
      }),
    ).toEqual({ roomId: PROJECT, eventId: null });
  });

  it("reads nothing from what is not a conversation address — owner, unknown, no permalink, an alias, another site", () => {
    const channel = (permalink: string | null): DraftProvenance => ({
      origin: "channel",
      channelKind: "native",
      askerRef: "x",
      threadId: null,
      permalink,
    });
    expect(conversationOf({ origin: "owner" })).toBeNull();
    expect(conversationOf({ origin: "unknown" })).toBeNull();
    expect(conversationOf(undefined)).toBeNull();
    expect(conversationOf(channel(null))).toBeNull();
    expect(conversationOf(channel("https://matrix.to/#/#ops:workspace.example/$e"))).toBeNull();
    expect(conversationOf(channel(`https://example.com/#/${PROJECT}/$e`))).toBeNull();
    expect(conversationOf(channel("not a url"))).toBeNull();
    expect(conversationOf(channel("https://matrix.to/#/%E0%A4%A"))).toBeNull();
  });
});

describe("#68 AC2 — sending replies in the conversation, and delivery is visible", () => {
  it("Send records the outcome with the daemon and posts nothing itself — the delivery is the daemon's, and the words arrive from the workspace as the owner's", async () => {
    seed();
    const daemon = fakeDaemon([draftFor({ id: "d1" })], { state: "delivered" });
    vi.stubGlobal("fetch", daemon.fetchMock);
    const fake = fakeConnection({ [PROJECT]: [BOSE_MESSAGE] });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate(ROOM_HASH);
    const drafts = await screen.findByTestId("room-drafts");
    fireEvent.click(await within(drafts).findByRole("button", { name: "Send" }));

    await waitFor(() => expect(daemon.outcomes).toEqual([{ id: "d1", body: { outcome: "sent" } }]));
    // The client is not a second sender: a client-side post would duplicate
    // what the daemon's delivery seam already puts in the conversation.
    expect(fake.connection.send).not.toHaveBeenCalled();
    expect(fake.connection.replyInThread).not.toHaveBeenCalled();

    // The daemon's delivery lands in the conversation as the homeserver's
    // record — the owner's own message, attributed as a person, never a duo.
    fake.deliver(messageFor({ eventId: "$own1", senderId: SESSION.userId, senderName: "ana", body: DRAFT_TEXT }));
    const timeline = await screen.findByTestId("room-timeline");
    await waitFor(() => expect(within(timeline).getByText(DRAFT_TEXT)).toBeInTheDocument());
    const sent = within(timeline)
      .getAllByTestId("room-person-message")
      .find((row) => within(row).queryByText(DRAFT_TEXT) !== null);
    expect(sent).toBeDefined();
    expect(within(sent!).getByTestId("room-person-message-author")).toHaveTextContent("ana");
    expect(within(timeline).queryByTestId("duo-message")).toBeNull();
  });

  it("Send edited carries the owner's words to the daemon as the edit", async () => {
    seed();
    const daemon = fakeDaemon([draftFor({ id: "d1" })]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    const fake = fakeConnection({ [PROJECT]: [BOSE_MESSAGE] });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate(ROOM_HASH);
    const drafts = await screen.findByTestId("room-drafts");
    fireEvent.click(await within(drafts).findByRole("button", { name: "Edit" }));
    fireEvent.change(within(drafts).getByRole("textbox"), { target: { value: "Thirty days, full refund, no questions." } });
    fireEvent.click(within(drafts).getByRole("button", { name: "Send edited" }));

    await waitFor(() =>
      expect(daemon.outcomes).toEqual([{ id: "d1", body: { outcome: "edited", sentText: "Thirty days, full refund, no questions." } }]),
    );
    expect(fake.connection.send).not.toHaveBeenCalled();
  });

  it("a sent draft's delivery state reads in its conversation — in flight, just delivered, or failed with the daemon's reason; an old delivery is not news", async () => {
    seed();
    const sent = (id: string, delivery: DraftRecord["delivery"], at = "2026-01-02T00:00:00.000Z") =>
      draftFor({ id, outcome: "sent", outcomeRecordedAt: at, sentText: DRAFT_TEXT, delivery });
    const daemon = fakeDaemon([
      sent("d1", { state: "pending" }),
      sent("d2", { state: "delivered" }, new Date().toISOString()),
      sent("d3", { state: "failed", reason: "the homeserver said no" }),
      // Delivered long ago: already in the transcript as the owner's own message.
      sent("d4", { state: "delivered" }),
    ]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate(ROOM_HASH);

    const drafts = await screen.findByTestId("room-drafts");
    await waitFor(() => expect(within(drafts).getAllByTestId("room-draft-outcome")).toHaveLength(3));
    const lines = within(drafts)
      .getAllByTestId("delivery-state")
      .map((line) => line.textContent);
    expect(lines).toEqual(expect.arrayContaining(["In flight.", "Delivered.", "Couldn’t deliver — the homeserver said no"]));
    // Nothing waiting: a decided draft offers no controls.
    expect(within(drafts).queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("the draft leaves the waiting list once decided, the room's own reading of the daemon's next answer", async () => {
    seed();
    const daemon = fakeDaemon([draftFor({ id: "d1" })]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate(ROOM_HASH);
    const drafts = await screen.findByTestId("room-drafts");
    fireEvent.click(await within(drafts).findByRole("button", { name: "Send" }));

    await waitFor(() => expect(within(drafts).queryByTestId("draft-tray")).toBeNull());
    expect(await within(drafts).findByTestId("delivery-state")).toHaveTextContent("Delivered.");
  });
});

describe("#68 AC3 — the owner is never pre-empted", () => {
  it("a pending draft posts nothing: no send, no thread reply, no outcome — and its words are not in the conversation", async () => {
    seed();
    const daemon = fakeDaemon([draftFor({ id: "d1" })]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    const fake = fakeConnection({ [PROJECT]: [BOSE_MESSAGE] });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate(ROOM_HASH);
    const drafts = await screen.findByTestId("room-drafts");
    await within(drafts).findByTestId("draft-tray");
    // Give any eager behaviour every chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fake.connection.send).not.toHaveBeenCalled();
    expect(fake.connection.edit).not.toHaveBeenCalled();
    expect(fake.connection.replyInThread).not.toHaveBeenCalled();
    expect(daemon.outcomes).toEqual([]);
    // The transcript is what the room's members read: the draft is not in it.
    const timeline = screen.getByTestId("room-timeline");
    expect(within(timeline).queryByText(DRAFT_TEXT)).toBeNull();
    expect(timeline.contains(drafts)).toBe(false);
  });

  it("the draft is labelled as the duo's, and as visible only to its owner", async () => {
    seed();
    vi.stubGlobal("fetch", fakeDaemon([draftFor({ id: "d1" })]).fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate(ROOM_HASH);
    const drafts = await screen.findByTestId("room-drafts");
    const card = await within(drafts).findByTestId("draft-tray");

    // Structurally the duo's (AR-13): the generated text sits in the duo's
    // own container, attributed, never in a person's.
    expect(within(card).getByTestId("draft-tray-attribution")).toHaveTextContent("Your duo");
    expect(within(card).getByTestId("draft-tray-attribution")).toHaveTextContent("only you can see this");
    expect(within(card).getByTestId("draft-tray-line")).toHaveTextContent(DRAFT_TEXT);
    expect(within(card).getByTestId("draft-tray-line")).toHaveAttribute("data-duo-line", "confident");
    // #183: inline, at the end of the owner's own view, visibly unsent.
    expect(within(card).getByTestId("draft-tray-attribution")).toHaveTextContent("not sent");
    expect(card).toHaveAttribute("data-unsent", "true");
    expect(within(screen.getByTestId("room-timeline")).queryByTestId("draft-tray")).toBeNull();
  });

  it("only the owner has drafts to see: a member with no paired duo gets no draft surface, and asks the daemon nothing", async () => {
    seed({ paired: false });
    const daemon = fakeDaemon([draftFor({ id: "d1" })]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate(ROOM_HASH);
    await screen.findByTestId("room-timeline");

    expect(screen.queryByTestId("room-drafts")).toBeNull();
    expect(daemon.fetchMock).not.toHaveBeenCalled();
  });

  it("a draft that is not for this conversation is not shown in it — nor is an owner-asked one, nor an unreadable origin", async () => {
    seed();
    vi.stubGlobal(
      "fetch",
      fakeDaemon([
        draftFor({ id: "here", draftText: "For project-x." }),
        draftFor({ id: "elsewhere", provenance: hereProvenance(ELSEWHERE), draftText: "For another room." }),
        draftFor({ id: "mine", provenance: { origin: "owner" }, draftText: "I asked this myself." }),
        draftFor({ id: "old", provenance: { origin: "unknown" }, draftText: "Predates provenance." }),
      ]).fetchMock,
    );
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate(ROOM_HASH);
    const drafts = await screen.findByTestId("room-drafts");

    await waitFor(() => expect(within(drafts).getAllByTestId("draft-tray")).toHaveLength(1));
    expect(within(drafts).getByTestId("draft-tray-line")).toHaveTextContent("For project-x.");
  });
});

describe("#68 AC4 — dispositioning from the conversation, with Waiting on you the durable count", () => {
  it("a pending draft for the conversation shows there, as a tray, with Send, Edit and Dismiss", async () => {
    seed();
    vi.stubGlobal("fetch", fakeDaemon([draftFor({ id: "d1" })]).fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate(ROOM_HASH);
    const drafts = await screen.findByTestId("room-drafts");

    expect(await within(drafts).findByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(within(drafts).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(drafts).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    // It answers a message that is right above it in the conversation, so the
    // tray does not repeat the question or who asked it: the transcript has both.
    expect(within(drafts).queryByTestId("owner-message")).toBeNull();
    expect(within(drafts).queryByTestId("draft-origin")).toBeNull();
    expect(within(await screen.findByTestId("room-timeline")).getByText(BOSE_QUESTION)).toBeInTheDocument();
  });

  it("opening the conversation dispositions nothing: the draft is still waiting on you, untouched", async () => {
    seed();
    const daemon = fakeDaemon([draftFor({ id: "d1" })]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate(ROOM_HASH);
    await within(await screen.findByTestId("room-drafts")).findByTestId("draft-tray");
    expect(daemon.outcomes).toEqual([]);

    navigate("#waiting");
    expect(await screen.findByTestId("waiting-link")).toHaveAttribute("href", ROOM_HASH);
    expect(screen.getByTestId("waiting-badge")).toHaveTextContent("1");
    // Reading is not deciding — nothing in the daemon moved.
    expect(daemon.log()[0]!.outcome).toBeNull();
  });

  it("deciding it in the conversation clears it from Waiting on you too — one draft, one decision", async () => {
    seed();
    const daemon = fakeDaemon([draftFor({ id: "d1" })]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate(ROOM_HASH);
    const drafts = await screen.findByTestId("room-drafts");
    fireEvent.click(await within(drafts).findByRole("button", { name: "Send" }));
    await waitFor(() => expect(daemon.outcomes).toHaveLength(1));

    navigate("#waiting");
    await waitFor(() => expect(screen.getByText("Nothing waiting on you.")).toBeInTheDocument());
  });

  it("Dismiss holds the same undo window it did in Review, and records the discard only when it ends", async () => {
    seed();
    const daemon = fakeDaemon([draftFor({ id: "d1" })]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate(ROOM_HASH);
    const drafts = await screen.findByTestId("room-drafts");
    fireEvent.click(await within(drafts).findByRole("button", { name: "Dismiss" }));

    expect(within(drafts).getByTestId("ignore-window")).toHaveTextContent("Dismissing — not sent yet.");
    expect(daemon.outcomes).toEqual([]);
    fireEvent.click(within(drafts).getByRole("button", { name: "Undo" }));
    expect(within(drafts).getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(daemon.outcomes).toEqual([]);
  });

  it("an escalation for a message here surfaces in its conversation too, answerable where the card allows", async () => {
    seed();
    vi.stubGlobal(
      "fetch",
      fakeDaemon([
        draftFor({ id: "e1", escalated: true, draftText: null, escalationReason: "No rule covers refunds over 90 days." }),
      ]).fetchMock,
    );
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate(ROOM_HASH);
    const drafts = await screen.findByTestId("room-drafts");

    // Plain words first; the daemon's own reasoning is one tap away, behind Why? (#185).
    expect(await within(drafts).findByTestId("draft-tray-words")).toHaveTextContent("passing it to you");
    fireEvent.click(within(drafts).getByTestId("tray-why"));
    expect(await screen.findByTestId("escalation-reason")).toHaveTextContent("No rule covers refunds over 90 days.");
  });
});

describe("#142 — an old draft address opens the chat the draft belongs to", () => {
  it("#draft/:id for a message that arrived in a conversation you hold lands in that chat, on its tray", async () => {
    seed();
    vi.stubGlobal("fetch", fakeDaemon([draftFor({ id: "d1" })]).fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate("#draft/d1");

    const tray = await within(await screen.findByTestId("room-drafts")).findByTestId("draft-tray");
    expect(tray).toHaveTextContent(DRAFT_TEXT);
    expect(window.location.hash).toBe(ROOM_HASH);
  });

  it("a question you asked your own duo opens in Your duo, on its tray", async () => {
    seed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    const daemon = fakeDaemon([draftFor({ id: "d1", provenance: { origin: "owner" } })]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate("#draft/d1");

    expect(await within(await screen.findByTestId("duo-thread")).findByTestId("draft-tray")).toHaveTextContent(DRAFT_TEXT);
    expect(window.location.hash).toBe("#duo");
  });

  it("a question bridged from another platform opens its own chat (#150)", async () => {
    seed();
    vi.stubGlobal(
      "fetch",
      fakeDaemon([draftFor({ id: "d1", provenance: { origin: "channel", channelKind: "slack", askerRef: "U1", threadId: null, permalink: null } })]).fetchMock,
    );
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate("#draft/d1");

    expect(await screen.findByTestId("bridged-chat")).toBeInTheDocument();
    expect(window.location.hash).toBe(`#chat/${encodeURIComponent("bridge:slack:U1")}`);
  });
});

describe("#183, #184 — a person's chat, Telegram-style", () => {
  it("the draft sits after the last message, in the same scroll as the transcript, and nothing is posted", async () => {
    stubDesktop();
    seed();
    vi.stubGlobal("fetch", fakeDaemon([draftFor({ id: "d1" })]).fetchMock);
    const fake = fakeConnection({ [PROJECT]: [BOSE_MESSAGE] });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate(ROOM_HASH);
    const card = await within(await screen.findByTestId("room-drafts")).findByTestId("draft-tray");
    const timeline = screen.getByTestId("room-timeline");
    // One scroll: the draft and the transcript share a scrolling parent, and the draft follows the last message.
    expect(card.closest(".overflow-y-auto")).toBe(timeline.closest(".overflow-y-auto"));
    expect(timeline.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fake.connection.send).not.toHaveBeenCalled();
  });

  it("the header's info button opens who is in the conversation", async () => {
    stubDesktop();
    seed();
    vi.stubGlobal("fetch", fakeDaemon([]).fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);

    await renderApp();
    navigate(ROOM_HASH);
    expect(await within(await screen.findByTestId("room-header")).findByRole("heading", { name: "project-x" })).toBeInTheDocument();
    expect(screen.queryByTestId("inspector")).toBeNull();
    fireEvent.click(await screen.findByTestId("info-toggle"));
    expect(await within(await screen.findByTestId("inspector")).findByTestId("room-info")).toHaveTextContent("project-x");
  });
});

describe("#186 review — the draft is where the owner will see it", () => {
  it("a conversation opens at its end, so the draft ⏎/E/X act on is on screen", async () => {
    stubDesktop();
    seed();
    vi.stubGlobal("fetch", fakeDaemon([draftFor({ id: "d1" })]).fetchMock);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ [PROJECT]: [BOSE_MESSAGE] }).connection);
    // happy-dom lays nothing out; give the transcript's scroller a height to scroll through.
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(4000);

    await renderApp();
    navigate(ROOM_HASH);
    const card = await within(await screen.findByTestId("room-drafts")).findByTestId("draft-tray");
    const scroller = card.closest<HTMLElement>(".overflow-y-auto")!;
    await waitFor(() => expect(scroller.scrollTop).toBe(4000));
    height.mockRestore();
  });

  it("a view opened at an older message shows no draft: newer messages come after it", async () => {
    stubDesktop();
    seed();
    vi.stubGlobal("fetch", fakeDaemon([draftFor({ id: "d1" })]).fetchMock);
    const fake = fakeConnection({ [PROJECT]: [BOSE_MESSAGE] });
    // Opened at a message, the workspace returns the window around it.
    (fake.connection as unknown as { timelineAt: unknown }).timelineAt = vi.fn(async () => [BOSE_MESSAGE]);
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    navigate(`${ROOM_HASH}/${encodeURIComponent(BOSE_EVENT)}`);
    await screen.findByTestId("room-timeline");
    expect(screen.queryByTestId("draft-tray")).toBeNull();
  });
});
