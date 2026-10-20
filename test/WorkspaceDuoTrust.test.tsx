// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
import { act, configure, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/workspace/matrix.js";
import type { RoomMessage, RoomSummary, WorkspaceConnection, WorkspaceSession } from "../src/workspace/matrix.js";
import { escalationOf, plainPreview, readDuoAnswer } from "../src/workspace/duoAnswer.js";

/*
 * #67: asking somebody's duo shows trust, provenance, and escalation — the
 * part of the product that exists nowhere else. The wire is narrower than
 * the core knows (digital-duo org-read §5, #191): an answer travels as its
 * words and nothing else, so "why did it say that" reaches the asker only as
 * what the daemon composed INTO the words (public-answer.ts composes the
 * cited sources, the evidence age and the duo's confidence into the posted
 * text — the confidence as a number). The client reads that composition
 * back — never inventing a second channel for evidence — and shows it the
 * way the issue asks: the sources at zero clicks, the trust in plain words,
 * the pass-on as a state that resolves when the owner speaks, and the
 * refusal as the boundary it is.
 */
vi.mock("../src/workspace/matrix.js", () => ({
  signIn: vi.fn(),
  connect: vi.fn(),
}));

const SESSION: WorkspaceSession = {
  homeserverUrl: "https://workspace.example",
  userId: "@bose:workspace.example",
  accessToken: "syt_workspace_token",
  deviceId: "YGBNAUIOMK",
};

// One room id per test: the app persists its query cache to storage on a
// throttle, so a previous test's timeline can land in storage after this
// test's clear and hydrate into it. Query keys carry the room id, so a room
// no other test used has nothing stale to hydrate.
let ROOM_ID = "!project-x-0:workspace.example";
let roomSequence = 0;
const DUO = "@duo-carol:workspace.example";
const CAROL = "@carol:workspace.example";

// The daemon's own composed outcomes, byte for byte as digital-duo's
// public-answer.ts + attribution.ts produce them.
const PASSED_ON_MESSAGE = "I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.";
const REFUSAL_MESSAGE =
  "That's not something I speak for the owner on. I've passed it on to them, without saying anything more about it here.";
const IDENTITY = "— carol's duo speaking here, not carol directly.";
const PASSED_ON = `${PASSED_ON_MESSAGE}\n\n${IDENTITY}`;
const REFUSED = `${REFUSAL_MESSAGE}\n\n${IDENTITY}`;
const SOURCES =
  "Sources:\n" +
  "  - [the owner's own standing order] Refunds are 30 days, full amount\n" +
  "  - [a retrieved past exchange, not the owner speaking now] #support thread, March";
const answered = (score: string, age = "evidence up to 3 day(s) old", sources: string | null = SOURCES): string =>
  ["Refunds within 30 days, full amount.", ...(sources === null ? [] : [sources]), `${IDENTITY} Confidence: ${score}. Based on ${age}.`].join(
    "\n\n",
  );

function rooms(): RoomSummary[] {
  return [
    {
      roomId: ROOM_ID,
      kind: "group",
      name: "project-x",
      topic: null,
      avatarUrl: null,
      members: [
        { userId: CAROL, name: "Carol" },
        { userId: DUO, name: "duo-carol" },
      ],
      latest: null,
      unread: { notifications: 0, mentions: 0 },
      muted: false,
      notifications: "all",
      canEdit: { name: false, topic: false, avatar: false, pins: false },
    },
  ];
}

function message(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId" | "senderId" | "body">): RoomMessage {
  return {
    roomId: ROOM_ID,
    senderName: over.senderId === DUO ? "duo-carol" : over.senderId === CAROL ? "Carol" : "Bose",
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

/** A minimal held connection: a timeline the test moves, and a live arrival that re-reads it. */
function fakeConnection(timeline: RoomMessage[], roomList: RoomSummary[] = rooms()) {
  let listener: ((roomId: string) => void) | null = null;
  const connection: WorkspaceConnection = {
    userId: SESSION.userId,
    profile: vi.fn(async () => ({ name: null, avatarUrl: null })),
    setDisplayName: vi.fn(async () => {}),
    setAvatarUrl: vi.fn(async () => "mxc://workspace.example/avatar"),
    rooms: vi.fn(async () => roomList.map((room) => ({ ...room }))),
    timeline: vi.fn(async () => [...timeline]),
    timelineAt: vi.fn(async () => [...timeline]),
    // #211/#212: this file's ACs don't exercise scroll-back or the unread
    // line — RoomScrollback.test.tsx pins those. A fixed "already caught up"
    // answer keeps this a whole connection without inventing history.
    loadOlder: vi.fn(async () => ({ loadedMore: false, atStart: true })),
    readMarker: vi.fn(() => null),
    unreadBoundaryFrom: vi.fn(() => ({ kind: "none" as const })),
    advanceReadMarker: vi.fn(async () => {}),
    searchMessages: vi.fn(async () => ({ hits: [], next: null })),
    mentions: vi.fn(async () => []),
    send: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    unreact: vi.fn(async () => {}),
    pin: vi.fn(async () => {}),
    unpin: vi.fn(async () => {}),
    replyInThread: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    cancel: vi.fn(() => {}),
    markRead: vi.fn(async () => {}),
    markUnread: vi.fn(async () => {}),
    startDirect: vi.fn(async () => "!x:workspace.example"),
    createRoom: vi.fn(async () => "!x:workspace.example"),
    createChannel: vi.fn(async () => "!x:workspace.example"),
    channels: vi.fn(async () => []),
    joinChannel: vi.fn(async () => {}),
    invite: vi.fn(async () => {}),
    invites: vi.fn(async () => []),
    joinRoom: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    setNotificationMode: vi.fn(async () => {}),
    setRoomName: vi.fn(async () => {}),
    setRoomTopic: vi.fn(async () => {}),
    setRoomAvatar: vi.fn(async () => {}),
    uploadFile: vi.fn(async () => {
      throw new Error("not used here");
    }),
    sendFile: vi.fn(async () => {}),
    sendPoll: vi.fn(async () => {}),
    votePoll: vi.fn(async () => {}),
    endPoll: vi.fn(async () => {}),
    sendCardResponse: vi.fn(async () => {}),
    loadMedia: vi.fn(async () => null),
    getUrlPreview: vi.fn(async () => null),
    searchPeople: vi.fn(async () => []),
    findRooms: vi.fn(async () => []),
    getProfile: vi.fn(async () => null),
    subscribe: vi.fn((handler: (roomId: string) => void) => {
      listener = handler;
      return () => {
        listener = null;
      };
    }),
    stop: vi.fn(async () => {}),
  };
  return {
    connection,
    deliver: (arrival: RoomMessage) => {
      timeline.push(arrival);
      listener?.(arrival.roomId);
    },
  };
}

async function renderApp() {
  vi.resetModules();
  const { App } = await import("../src/App.js");
  return render(<App />);
}

function navigate(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
}

async function openRoom(timeline: RoomMessage[]) {
  localStorage.setItem("duo.workspace-session", JSON.stringify(SESSION));
  const fake = fakeConnection(timeline);
  vi.mocked(connect).mockResolvedValue(fake.connection);
  await renderApp();
  await screen.findByTestId("conversations-list");
  navigate(`#room/${encodeURIComponent(ROOM_ID)}`);
  await screen.findByTestId("room-timeline");
  return fake;
}

/** The duo-message row an event renders in — found by its raw text so a multi-line body is still findable. */
async function duoRow(fragment: string): Promise<HTMLElement> {
  return waitFor(() => {
    const row = screen.getAllByTestId("room-message").find((candidate) => candidate.textContent?.includes(fragment));
    expect(row, `no message row containing ${JSON.stringify(fragment)}`).toBeDefined();
    return row!;
  });
}

// The first import of the whole app is the slow one; pay it once, outside any test's clock.
// Each test re-imports the app under a fresh module registry and drives a
// full route through a query cache, so on a busy machine the defaults (5s a
// test, 1s a wait) are tighter than the work — widened here, in this file only.
beforeAll(async () => {
  configure({ asyncUtilTimeout: 8_000 });
  await import("../src/App.js");
}, 60_000);

beforeEach(() => {
  roomSequence += 1;
  ROOM_ID = `!project-x-${roomSequence}:workspace.example`;
  localStorage.clear();
  vi.mocked(connect).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

vi.setConfig({ testTimeout: 30_000 });

describe("#67 — reading a duo's composed answer (the pure half)", () => {
  it("reads an answer as words, sources, an evidence line and a trust — with no number left to show", () => {
    const reading = readDuoAnswer(answered("0.91"));
    expect(reading).toEqual({
      kind: "answered",
      answer: "Refunds within 30 days, full amount.",
      sources: [
        { kind: "standing-order", label: "Refunds are 30 days, full amount" },
        { kind: "past-exchange", label: "#support thread, March" },
      ],
      trust: "confident",
      evidence: "Evidence up to 3 days old",
      attribution: IDENTITY,
      away: null,
    });
    expect(JSON.stringify(reading)).not.toMatch(/0\.91|confidence/i);
  });

  // #270: the daemon opens every message with this line while the owner is away.
  const AWAY = "carol is away until Mon 12 Oct, 09:00 — carol's duo is answering.";

  it("reads an away line off the front of any composed outcome, keeping it out of the words (#270)", () => {
    expect(readDuoAnswer(`${AWAY}\n\n${answered("0.91")}`)).toMatchObject({
      kind: "answered",
      answer: "Refunds within 30 days, full amount.",
      away: { line: AWAY, until: "Mon 12 Oct, 09:00" },
    });
    expect(readDuoAnswer(`${AWAY}\n\n${PASSED_ON}`)).toEqual({ kind: "passed-on", body: PASSED_ON, away: { line: AWAY, until: "Mon 12 Oct, 09:00" } });
    expect(readDuoAnswer(`${AWAY}\n\n${REFUSED}`)).toMatchObject({ kind: "refused", away: { line: AWAY } });
  });

  it("an away line is not an outcome on its own, and two different names are not the daemon's line (#270)", () => {
    expect(readDuoAnswer(`${AWAY}\n\nRefunds within 30 days.`)).toBeNull();
    expect(readDuoAnswer(`${AWAY}\n\n${IDENTITY}`)).toBeNull();
    const mismatched = "carol is away until Mon 12 Oct, 09:00 — dave's duo is answering.";
    expect(readDuoAnswer(`${mismatched}\n\n${PASSED_ON}`)).toBeNull();
  });

  it("reads the trust the way the owner's own hairline does: hedging below the threshold plus its margin", () => {
    expect(readDuoAnswer(answered("0.69"))).toMatchObject({ kind: "answered", trust: "hedging" });
    expect(readDuoAnswer(answered("0.70"))).toMatchObject({ kind: "answered", trust: "confident" });
  });

  it("states the evidence age in plain words for every form the daemon composes", () => {
    expect(readDuoAnswer(answered("0.9", "evidence from today"))).toMatchObject({ evidence: "Evidence from today" });
    expect(readDuoAnswer(answered("0.9", "evidence up to 1 day(s) old"))).toMatchObject({ evidence: "Evidence up to 1 day old" });
    expect(readDuoAnswer(answered("0.9", "no dated evidence behind it"))).toMatchObject({ evidence: "No dated evidence behind it" });
  });

  it("reads an answer with no sources as one that named none", () => {
    expect(readDuoAnswer(answered("0.9", "evidence from today", null))).toMatchObject({ kind: "answered", sources: [] });
  });

  it("reads the two fixed outcomes only when the words are the daemon's exact words", () => {
    expect(readDuoAnswer(PASSED_ON)).toEqual({ kind: "passed-on", body: PASSED_ON, away: null });
    expect(readDuoAnswer(REFUSED)).toEqual({ kind: "refused", body: REFUSED, away: null });
    // A friendlier paraphrase is not the daemon's message and claims nothing.
    expect(readDuoAnswer(`I couldn't answer that, sorry — I've told the owner.\n\n${IDENTITY}`)).toBeNull();
  });

  it("degrades to plain words for anything it cannot read whole — never a half-parsed claim", () => {
    expect(readDuoAnswer("Refunds within 30 days.")).toBeNull();
    expect(readDuoAnswer("Something went wrong answering that.")).toBeNull();
    // A confidence with no attribution line before it is not the daemon's composition.
    expect(readDuoAnswer("Refunds within 30 days.\n\nConfidence: 0.9. Based on evidence from today.")).toBeNull();
    // An identity line naming one owner in one breath and another in the next is not a composition either.
    expect(readDuoAnswer("Words.\n\n— carol's duo speaking here, not dave directly. Confidence: 0.9. Based on evidence from today.")).toBeNull();
  });

  it("a preview of an answer is its words — the number never rides into a list row", () => {
    expect(plainPreview(answered("0.91"))).toBe("Refunds within 30 days, full amount.");
    expect(plainPreview("lunch?")).toBe("lunch?");
    expect(plainPreview(PASSED_ON)).toBe(PASSED_ON);
  });

  it("an escalation waits until the owner — by the id grammar — speaks after it", () => {
    const passed = message({ eventId: "$p", senderId: DUO, body: PASSED_ON });
    const before = message({ eventId: "$q", senderId: "@bose:workspace.example", body: "refund policy?" });
    expect(escalationOf(passed, [before, passed])).toBe("waiting");
    // Somebody else speaking is not the owner following up.
    const other = message({ eventId: "$o", senderId: "@dee:workspace.example", body: "same question here" });
    expect(escalationOf(passed, [before, passed, other])).toBe("waiting");
    // The owner speaking BEFORE the pass-on is not an answer to it.
    const early = message({ eventId: "$e", senderId: CAROL, body: "morning" });
    expect(escalationOf(passed, [early, before, passed])).toBe("waiting");
    const followUp = message({ eventId: "$f", senderId: CAROL, body: "30 days, but ask finance about VAT" });
    expect(escalationOf(passed, [before, passed, other, followUp])).toBe("followed-up");
    // A struck reply is no answer.
    expect(escalationOf(passed, [before, passed, { ...followUp, redacted: true, body: "" }])).toBe("waiting");
    // Only a passed-on duo message has an escalation state.
    expect(escalationOf(message({ eventId: "$r", senderId: DUO, body: REFUSED }), [followUp])).toBeNull();
    expect(escalationOf(message({ eventId: "$a", senderId: DUO, body: answered("0.9") }), [followUp])).toBeNull();
    expect(escalationOf(message({ eventId: "$x", senderId: "@bose:workspace.example", body: PASSED_ON }), [followUp])).toBeNull();
  });
});

describe("#67 AC1 — provenance rides with the answer", () => {
  it("what it drew on is on the answer at zero clicks, its kinds told apart, the owner named from the id", async () => {
    await openRoom([
      message({ eventId: "$1", senderId: "@bose:workspace.example", body: "what's our refund policy?" }),
      message({ eventId: "$2", senderId: DUO, body: answered("0.91") }),
    ]);
    const row = await duoRow("Refunds within 30 days, full amount.");
    const provenance = within(row).getByTestId("duo-provenance");
    const sources = within(provenance).getAllByTestId("duo-source");
    expect(sources).toHaveLength(2);
    expect(sources[0]).toHaveAttribute("data-source-kind", "standing-order");
    expect(sources[0]).toHaveTextContent("carol's own standing order");
    expect(sources[0]).toHaveTextContent("Refunds are 30 days, full amount");
    expect(sources[1]).toHaveAttribute("data-source-kind", "past-exchange");
    expect(sources[1]).toHaveTextContent("a past exchange, not carol speaking now");
    expect(sources[1]).toHaveTextContent("#support thread, March");
    // Zero clicks: it is not folded behind a disclosure, and nothing about
    // it is a control.
    expect(provenance.closest("details")).toBeNull();
    expect(provenance.querySelector("details, button, summary, a")).toBeNull();
    // The evidence's age rides with it.
    expect(within(row).getByTestId("duo-evidence")).toHaveTextContent("Evidence up to 3 days old");
  });

  it("the composed scaffolding does not repeat: the words are the answer, the sources are not also raw text", async () => {
    await openRoom([message({ eventId: "$2", senderId: DUO, body: answered("0.91") })]);
    const row = await duoRow("Refunds within 30 days, full amount.");
    expect(row.textContent).not.toContain("Sources:");
    expect(row.textContent).not.toContain("[the owner's own standing order]");
    // The identity line the daemon wrote stays as written — labelling is contract.
    expect(row.textContent).toContain(IDENTITY);
    expect(within(row).getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");
  });

  it("an answer that named nothing says so, rather than leaving the reader to wonder", async () => {
    await openRoom([message({ eventId: "$2", senderId: DUO, body: answered("0.9", "evidence from today", null) })]);
    const row = await duoRow("Refunds within 30 days, full amount.");
    expect(within(row).getByTestId("duo-provenance")).toHaveTextContent("named no sources");
    expect(within(row).queryAllByTestId("duo-source")).toHaveLength(0);
  });

  it("shows only what the words carried: no way to ask for more evidence exists on an asker's answer", async () => {
    await openRoom([message({ eventId: "$2", senderId: DUO, body: answered("0.91") })]);
    const row = await duoRow("Refunds within 30 days, full amount.");
    // The evidence itself never left the owner's machine (org-read §5), so
    // no affordance pretends otherwise: the duo's row offers reading, the
    // member's usual verbs, and nothing that says "show evidence".
    expect(within(row).queryByText(/show (the )?(evidence|sources)|view (the )?(evidence|sources)/i)).toBeNull();
  });

  it("reads the same in a thread as in the conversation", async () => {
    const root = message({ eventId: "$1", senderId: "@bose:workspace.example", body: "what's our refund policy?" });
    const reply = message({ eventId: "$r", senderId: DUO, body: answered("0.91"), threadRootEventId: "$1" });
    localStorage.setItem("duo.workspace-session", JSON.stringify(SESSION));
    const fake = fakeConnection([root, reply]);
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    await screen.findByTestId("conversations-list");
    navigate(`#thread/${encodeURIComponent(ROOM_ID)}/%241`);
    await screen.findByTestId("thread-timeline");
    const row = await duoRow("Refunds within 30 days, full amount.");
    expect(within(row).getAllByTestId("duo-source")).toHaveLength(2);
    expect(within(row).getByTestId("duo-trust")).toHaveAttribute("data-trust", "confident");
  });

  it("only a duo's message is read as an answer — a person writing the same words gets plain words, no borrowed trust", async () => {
    await openRoom([message({ eventId: "$1", senderId: "@bose:workspace.example", senderName: "Bose", body: answered("0.99") })]);
    const row = await duoRow("Refunds within 30 days, full amount.");
    expect(within(row).queryByTestId("duo-provenance")).toBeNull();
    expect(within(row).queryByTestId("duo-trust")).toBeNull();
    expect(within(row).getByTestId("room-person-message")).toBeInTheDocument();
  });
});

describe("#67 AC2 — trust is legible without jargon", () => {
  it("a confident answer says it is confident, in words, and shows no number anywhere", async () => {
    await openRoom([message({ eventId: "$2", senderId: DUO, body: answered("0.91") })]);
    const row = await duoRow("Refunds within 30 days, full amount.");
    const trust = within(row).getByTestId("duo-trust");
    expect(trust).toHaveAttribute("data-trust", "confident");
    expect(trust).toHaveTextContent(/confident/i);
    expect(trust).toHaveTextContent("carol has trusted this duo with this topic");
    expect(row.textContent).not.toMatch(/0\.91|confidence:|\d\s*%|percent/i);
  });

  it("a hedging answer says it is unsure and advises the reader, with no number either", async () => {
    await openRoom([message({ eventId: "$2", senderId: DUO, body: answered("0.6") })]);
    const row = await duoRow("Refunds within 30 days, full amount.");
    const trust = within(row).getByTestId("duo-trust");
    expect(trust).toHaveAttribute("data-trust", "hedging");
    expect(trust).toHaveTextContent(/hedging/i);
    expect(trust).toHaveTextContent(/less sure/i);
    expect(trust).toHaveTextContent(/starting point/i);
    expect(row.textContent).not.toMatch(/0\.6|confidence:|\d\s*%|percent/i);
  });

  it("a question outside what the duo answers on its own says exactly that, and names whose call it now is", async () => {
    await openRoom([message({ eventId: "$2", senderId: DUO, body: PASSED_ON })]);
    const row = await duoRow("passed it on to the owner");
    const trust = within(row).getByTestId("duo-trust");
    expect(trust).toHaveAttribute("data-trust", "outside");
    expect(trust).toHaveTextContent("Outside what this duo answers on its own");
    expect(trust).toHaveTextContent("passed your question to carol");
  });

  it("the three states are told apart by words, never by colour alone", async () => {
    await openRoom([
      message({ eventId: "$1", senderId: DUO, body: answered("0.9", "evidence from today", null) }),
      message({ eventId: "$2", senderId: DUO, body: answered("0.6", "evidence from today", null).replace("Refunds within", "Returns within") }),
      message({ eventId: "$3", senderId: DUO, body: PASSED_ON }),
    ]);
    await screen.findAllByTestId("duo-trust");
    const words = screen.getAllByTestId("duo-trust").map((node) => node.textContent);
    expect(new Set(words).size).toBe(3);
  });
});

describe("#67 AC3 — escalation is visible as a state", () => {
  it("a passed-on question reads as waiting on a person, in the daemon's own words, until the pass-on has arrived", async () => {
    const fake = await openRoom([message({ eventId: "$1", senderId: "@bose:workspace.example", body: "can we waive the VAT?" })]);
    // Nothing is synthesized before the duo has actually said it passed it on.
    expect(screen.queryByTestId("duo-escalation")).toBeNull();

    act(() => fake.deliver(message({ eventId: "$2", senderId: DUO, body: PASSED_ON, originServerTs: 1_700_000_001_000 })));
    const row = await duoRow("passed it on to the owner");
    const state = within(row).getByTestId("duo-escalation");
    expect(state).toHaveAttribute("data-state", "waiting");
    expect(state).toHaveTextContent("Waiting on carol");
    expect(state).toHaveTextContent(/person/i);
    // The fixed message is still there, verbatim, beside the state.
    expect(row.textContent).toContain(PASSED_ON);
  });

  it("the owner's answer arrives in the conversation as the owner — a person, never the duo — and the state resolves", async () => {
    const fake = await openRoom([
      message({ eventId: "$1", senderId: "@bose:workspace.example", body: "can we waive the VAT?" }),
      message({ eventId: "$2", senderId: DUO, body: PASSED_ON, originServerTs: 1_700_000_001_000 }),
    ]);
    const row = await duoRow("passed it on to the owner");
    expect(within(row).getByTestId("duo-escalation")).toHaveAttribute("data-state", "waiting");

    act(() =>
      fake.deliver(
        message({ eventId: "$3", senderId: CAROL, body: "Yes — VAT is waived on internal orders.", originServerTs: 1_700_000_002_000 }),
      ),
    );
    const reply = await duoRow("Yes — VAT is waived on internal orders.");
    // AR-13, at the moment it matters most: Carol's own words are Carol's,
    // in the person container, under her name — not in the duo's.
    expect(within(reply).getByTestId("room-person-message-author")).toHaveTextContent("Carol");
    expect(within(reply).queryByTestId("room-duo-message")).toBeNull();
    await waitFor(() => expect(within(row).getByTestId("duo-escalation")).toHaveAttribute("data-state", "followed-up"));
    expect(within(row).getByTestId("duo-escalation")).toHaveTextContent("carol has replied");
  });

  it("an answer in the pass-on's own thread resolves it and reads in the same thread", async () => {
    const fake = await openRoom([
      message({ eventId: "$1", senderId: "@bose:workspace.example", body: "can we waive the VAT?" }),
      message({
        eventId: "$2",
        senderId: DUO,
        body: PASSED_ON,
        originServerTs: 1_700_000_001_000,
        thread: null,
      }),
    ]);
    const row = await duoRow("passed it on to the owner");
    expect(within(row).getByTestId("duo-escalation")).toHaveAttribute("data-state", "waiting");

    act(() =>
      fake.deliver(
        message({ eventId: "$3", senderId: CAROL, body: "Yes, waived.", originServerTs: 1_700_000_002_000, threadRootEventId: "$2" }),
      ),
    );
    await waitFor(() => expect(within(row).getByTestId("duo-escalation")).toHaveAttribute("data-state", "followed-up"));

    // And the thread itself carries her answer, as her.
    navigate(`#thread/${encodeURIComponent(ROOM_ID)}/%242`);
    await screen.findByTestId("thread-timeline");
    const reply = await duoRow("Yes, waived.");
    expect(within(reply).getByTestId("room-person-message-author")).toHaveTextContent("Carol");
    const root = await duoRow("passed it on to the owner");
    expect(within(root).getByTestId("duo-escalation")).toHaveAttribute("data-state", "followed-up");
  });

  it("somebody else answering does not resolve it — only the duo's owner, by the id grammar", async () => {
    await openRoom([
      message({ eventId: "$2", senderId: DUO, body: PASSED_ON, originServerTs: 1_700_000_001_000 }),
      message({ eventId: "$3", senderId: "@dee:workspace.example", senderName: "Carol", body: "I'm Carol, honest", originServerTs: 1_700_000_002_000 }),
    ]);
    const row = await duoRow("passed it on to the owner");
    expect(within(row).getByTestId("duo-escalation")).toHaveAttribute("data-state", "waiting");
  });
});

describe("#67 AC4 — a refusal reads as the system working", () => {
  it("the fixed message renders verbatim, framed as a boundary its owner set", async () => {
    await openRoom([message({ eventId: "$2", senderId: DUO, body: REFUSED })]);
    const row = await duoRow("not something I speak for the owner on");
    // Byte-exact on raw textContent: no normalization stands in for verbatim.
    expect(row.textContent).toContain(REFUSED);
    const trust = within(row).getByTestId("duo-trust");
    expect(trust).toHaveAttribute("data-trust", "boundary");
    expect(trust).toHaveTextContent("A boundary carol set");
    expect(trust).toHaveTextContent(/working as designed|working as intended/i);
  });

  it("does not look like a failure: no alert, no retry, no error wording, no waiting state", async () => {
    await openRoom([message({ eventId: "$2", senderId: DUO, body: REFUSED })]);
    const row = await duoRow("not something I speak for the owner on");
    expect(within(row).queryByRole("alert")).toBeNull();
    expect(within(row).queryByText(/try again|error|failed|went wrong|couldn't/i)).toBeNull();
    expect(within(row).queryByTestId("duo-escalation")).toBeNull();
    expect(within(row).queryByTestId("duo-provenance")).toBeNull();
  });
});

describe("#67 — no number leaks through the surfaces that preview an answer", () => {
  it("the list preview and the thread preview carry the answer's words, not its composition", async () => {
    localStorage.setItem("duo.workspace-session", JSON.stringify(SESSION));
    const body = answered("0.91");
    const list = rooms().map((room) => ({ ...room, latest: { at: 1_700_000_000_000, body } }));
    const fake = fakeConnection(
      [
        message({
          eventId: "$1",
          senderId: "@bose:workspace.example",
          body: "what's our refund policy?",
          thread: { replyCount: 1, latestReply: { senderId: DUO, senderName: "duo-carol", body } },
        }),
        message({ eventId: "$r", senderId: DUO, body, threadRootEventId: "$1" }),
      ],
      list,
    );
    vi.mocked(connect).mockResolvedValue(fake.connection);
    await renderApp();
    // The list may show a hydrated earlier answer for a beat; wait for the
    // server's own.
    await waitFor(() => expect(screen.getByTestId("room-preview")).toHaveTextContent("Refunds within 30 days, full amount."));
    expect(screen.getByTestId("room-preview").textContent).not.toMatch(/0\.91|confidence/i);

    navigate(`#room/${encodeURIComponent(ROOM_ID)}`);
    const threadPreview = await screen.findByTestId("room-thread-preview");
    await waitFor(() => expect(threadPreview).toHaveTextContent("carol's duo: Refunds within 30 days, full amount."));
    expect(threadPreview.textContent).not.toMatch(/0\.91|confidence/i);
  });
});

describe("#67 — the docs say what the surface does", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (relative: string): string => readFileSync(join(root, relative), "utf8").replace(/\s+/g, " ");

  it("the tech design records the two halves: what travels, and how the surface reads it", () => {
    const doc = read("docs/client-tech-design.md");
    expect(doc).toContain("#67");
    expect(doc).toMatch(/composes? .* into the words|composed into the (text|words)/i);
    expect(doc).toMatch(/never a number|no number|never a percentage/i);
  });

  it("the vocabulary names the trust states and the escalation state", () => {
    const doc = read("docs/vocabulary.md");
    expect(doc).toMatch(/### trust reading/);
    expect(doc).toMatch(/waiting on/i);
    expect(doc).toMatch(/boundary/i);
  });
});

/*
 * #313 (S3, "Instant answer"): regression pins only — the daemon composes
 * an instant answer exactly as #67 above already covers, and this client's
 * `RoomDuoAnswer` already renders it. What's new for S3 is the daemon
 * widening the wire shape in a shared room to a plain reply relation
 * (`m.relates_to["m.in_reply_to"]`, no `rel_type` — the same shape #215's
 * quote already reads into `replyToEventId`). These pins exist so that
 * widening, and the card rendering W-S4-7..10 added since, can never
 * silently turn a composed answer back into unstyled words or a card.
 */
describe("#313 — the instant answer still renders as RoomDuoAnswer, reply-shaped or not", () => {
  it("a duo's m.text answer with sources still renders composed, sources and trust line intact", async () => {
    await openRoom([
      message({ eventId: "$1", senderId: "@bose:workspace.example", body: "what's our refund policy?" }),
      message({ eventId: "$2", senderId: DUO, body: answered("0.91") }),
    ]);
    const row = await duoRow("Refunds within 30 days, full amount.");
    const sources = within(row).getAllByTestId("duo-source");
    expect(sources).toHaveLength(2);
    expect(within(row).getByTestId("duo-trust")).toHaveAttribute("data-trust", "confident");
    expect(within(row).getByTestId("duo-evidence")).toHaveTextContent("Evidence up to 3 days old");
    // Still composed, not plain words: the scaffolding doesn't leak as raw text.
    expect(row.textContent).not.toContain("Sources:");
  });

  it("a reply-shaped duo answer (m.relates_to m.in_reply_to) still renders as RoomDuoAnswer, not plain words", async () => {
    await openRoom([
      message({ eventId: "$1", senderId: "@bose:workspace.example", body: "what's our refund policy?" }),
      message({ eventId: "$2", senderId: DUO, body: answered("0.91"), replyToEventId: "$1" }),
    ]);
    const row = await duoRow("Refunds within 30 days, full amount.");
    // The reply relation rides alongside the composed answer — the quote
    // above it, and the very same RoomDuoAnswer scaffolding below it.
    expect(within(row).getByTestId("reply-quote")).toHaveTextContent("what's our refund policy?");
    expect(within(row).getAllByTestId("duo-source")).toHaveLength(2);
    expect(within(row).getByTestId("duo-trust")).toHaveAttribute("data-trust", "confident");
    expect(within(row).getByTestId("duo-evidence")).toHaveTextContent("Evidence up to 3 days old");
    expect(within(row).queryByTestId("duo-card")).toBeNull();
  });

  it("no card renders for an instant answer — it is plain m.text, never duo.card", async () => {
    await openRoom([
      message({ eventId: "$1", senderId: "@bose:workspace.example", body: "what's our refund policy?" }),
      message({ eventId: "$2", senderId: DUO, body: answered("0.91"), replyToEventId: "$1" }),
    ]);
    const row = await duoRow("Refunds within 30 days, full amount.");
    expect(within(row).queryByTestId("duo-card")).toBeNull();
    expect(within(row).queryByTestId("duo-card-title")).toBeNull();
    // The answer's own trust line renders in its place — it's RoomDuoAnswer,
    // not a card's frame, that drew this row.
    expect(within(row).getByTestId("duo-trust")).toBeInTheDocument();
  });
});
