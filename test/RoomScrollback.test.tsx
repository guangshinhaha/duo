import { act, configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/workspace/matrix.js";
import type { RoomMessage, RoomSummary, UnreadBoundary, WorkspaceConnection, WorkspaceSession } from "../src/workspace/matrix.js";
import { stubDesktop } from "./desktop.js";
import { rowTopOnScreen, scrollTranscriptTo, stubTimelineLayout } from "./timelineLayout.js";
import { pressEnter, typeInto } from "./composerHelpers.js";

/*
 * #211/#212: scrolling back through older messages, and the "New messages"
 * line that shows where a member left off — and, since #248, the
 * virtualized transcript those both live in (TanStack Virtual). The Matrix
 * seam (`src/workspace/matrix.ts`) is mocked wholesale here, same as
 * Workspace.test.tsx — these ACs are about Room.tsx's own behaviour against
 * the `WorkspaceConnection` contract (`loadOlder`, `readMarker`,
 * `unreadBoundaryFrom`, `advanceReadMarker`), which WorkspaceMatrixSeam.test.ts
 * pins against the real SDK shape separately.
 *
 * happy-dom lays nothing out, so tests about where things sit on screen
 * stub a layout (`stubTimelineLayout`): a 300px viewport, 100px rows with
 * the 20px gap between them, the list 68px down the scroller.
 */
vi.mock("../src/workspace/matrix.js", () => ({
  signIn: vi.fn(),
  connect: vi.fn(),
}));

// The app boots, connects and lands before a row can be measured — more than
// testing-library's 1s default on a loaded machine.
configure({ asyncUtilTimeout: 3000 });

const SESSION: WorkspaceSession = {
  homeserverUrl: "https://workspace.example",
  userId: "@ana:workspace.example",
  accessToken: "syt_workspace_token",
  deviceId: "YGBNAUIOMK",
};

const ROOM_ID = "!project-x:workspace.example";

function roomsFixture(): RoomSummary[] {
  return [
    {
      roomId: ROOM_ID,
      kind: "group",
      name: "project-x",
      topic: null,
      avatarUrl: null,
      members: [{ userId: "@bose:workspace.example", name: "Bose" }],
      latest: { at: Date.now(), body: "ship it" },
      unread: { notifications: 0, mentions: 0 },
      muted: false,
      notifications: "all",
      canEdit: { name: false, topic: false, avatar: false },
    },
  ];
}

function messageFor(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId" | "body">): RoomMessage {
  return {
    roomId: ROOM_ID,
    senderId: "@bose:workspace.example",
    senderName: "Bose",
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

/** `count` messages, `$<prefix>1`… in order, each saying "<prefix> message N". */
function messages(prefix: string, count: number, over: Partial<RoomMessage> = {}): RoomMessage[] {
  return Array.from({ length: count }, (_, index) =>
    messageFor({ eventId: `$${prefix}${index + 1}`, body: `${prefix} message ${index + 1}`, ...over }),
  );
}

/** Controllable from a test: `trigger` plays the callback the way a real observer would, for whichever element it was asked to watch most recently. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly callback: IntersectionObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
  takeRecords = (): IntersectionObserverEntry[] => [];
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  trigger(isIntersecting: boolean): void {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

/**
 * A connection whose `timeline()` answers change as `loadOlder` is called —
 * each resolved page prepends to what's already "loaded", the way
 * `client.scrollback` folding into the live timeline does for real
 * (WorkspaceMatrixSeam.test.ts pins that projection) — and as `deliver`
 * appends a live arrival.
 */
function fakeConnection(options: {
  pages: readonly RoomMessage[][];
  loadOlderResults: ReadonlyArray<{ loadedMore: boolean; atStart: boolean }>;
  readMarker?: string | null;
  unreadBoundary?: UnreadBoundary;
  /** A real (small) delay before `loadOlder` resolves, so a test can observe the "Loading older messages…" state in between — everything else here resolves same-tick, which would otherwise make it invisible. */
  loadOlderDelayMs?: number;
  /** What `timelineAt` answers — the window around a search hit (#70). */
  around?: readonly RoomMessage[];
}) {
  let pageIndex = 0;
  let loadOlderCalls = 0;
  const arrived: RoomMessage[] = [];
  const listeners = new Set<(roomId: string) => void>();
  const advanceReadMarker = vi.fn(async () => {});
  const loadOlder = vi.fn(async () => {
    if (options.loadOlderDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.loadOlderDelayMs));
    }
    const result = options.loadOlderResults[Math.min(loadOlderCalls, options.loadOlderResults.length - 1)]!;
    loadOlderCalls += 1;
    if (result.loadedMore) {
      pageIndex = Math.min(pageIndex + 1, options.pages.length - 1);
    }
    return result;
  });
  const connection = {
    userId: SESSION.userId,
    rooms: vi.fn(async () => roomsFixture()),
    timeline: vi.fn(async () => [...options.pages[pageIndex]!, ...arrived]),
    timelineAt: vi.fn(async () => [...(options.around ?? [])]),
    loadOlder,
    readMarker: vi.fn(() => options.readMarker ?? null),
    unreadBoundaryFrom: vi.fn(() => options.unreadBoundary ?? { kind: "none" as const }),
    advanceReadMarker,
    markRead: vi.fn(async () => {}),
    loadMedia: vi.fn(async () => null),
    getUrlPreview: vi.fn(async () => null),
    edit: vi.fn(async () => {}),
    // #209: the SDK's local echo — the reply's own row, pending, the instant it's sent.
    replyInThread: vi.fn(async (_roomId: string, rootEventId: string, body: string) => {
      deliver(messageFor({ eventId: `~echo-${arrived.length}`, body, senderId: SESSION.userId, senderName: "Ana", threadRootEventId: rootEventId, pending: true }));
    }),
    // #207: CommandSearch renders alongside every route and calls these on
    // mount — minimal fakes, since none of these ACs drive the search box.
    searchMessages: vi.fn(async () => ({ hits: [], next: null })),
    mentions: vi.fn(async () => []),
    searchPeople: vi.fn(async () => []),
    findRooms: vi.fn(async () => roomsFixture()),
    getProfile: vi.fn(async () => null),
    subscribe: vi.fn((handler: (roomId: string) => void) => {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    }),
    stop: vi.fn(async () => {}),
  } as unknown as WorkspaceConnection;
  const deliver = (message: RoomMessage): void => {
    arrived.push(message);
    for (const listener of listeners) {
      listener(ROOM_ID);
    }
  };
  return Object.assign(connection, { deliver });
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

function seedSession(): void {
  localStorage.setItem("duo.workspace-session", JSON.stringify(SESSION));
}

async function openRoom(): Promise<HTMLElement> {
  await renderApp();
  navigate(`#chat/${encodeURIComponent(ROOM_ID)}`);
  return screen.findByTestId("room-scroller");
}

/** The row whose own words are `text` — never a reply's quote of them. */
function rowSaying(text: string): HTMLElement {
  const own = screen.getAllByText(text).filter((element) => element.closest('[data-testid="reply-quote"]') === null);
  if (own.length !== 1) {
    throw new Error(`expected one row saying "${text}", found ${own.length}`);
  }
  return own[0]!.closest<HTMLElement>('[data-testid="room-message"]')!;
}

function ownWordsShown(text: string): boolean {
  return screen.queryAllByText(text).some((element) => element.closest('[data-testid="reply-quote"]') === null);
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(connect).mockReset();
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  window.location.hash = "";
});

describe("#211 — scrolling back through older messages", () => {
  it("scrolling to the top loads the previous page without losing the member's place", async () => {
    stubDesktop();
    seedSession();
    const layout = stubTimelineLayout();
    const loaded = messages("loaded", 5);
    const connection = fakeConnection({
      pages: [loaded, [...messages("older", 3), ...loaded]],
      loadOlderResults: [{ loadedMore: true, atStart: false }],
      loadOlderDelayMs: 200,
    });
    vi.mocked(connect).mockResolvedValue(connection);

    const scroller = await openRoom();
    await screen.findByText("loaded message 5");

    // Scrolled near the top, part way down from a true 0 — the member's
    // place is "loaded message 1" sitting 36px down the viewport.
    scrollTranscriptTo(scroller, 40);
    await waitFor(() => expect(rowTopOnScreen(rowSaying("loaded message 1"), layout)).toBe(36));
    const before = rowTopOnScreen(rowSaying("loaded message 1"), layout);

    expect(await screen.findByTestId("room-loading-older")).toBeInTheDocument();
    await screen.findByText("older message 1");
    expect(connection.loadOlder).toHaveBeenCalledWith(ROOM_ID);

    // Three rows (100px + the 20px gap each) arrived above — the row the
    // member was reading hasn't moved on screen: the scroll offset moved
    // under it instead, by exactly what was added.
    await waitFor(() => expect(scroller.scrollTop).toBe(40 + 3 * 120));
    expect(rowTopOnScreen(rowSaying("loaded message 1"), layout)).toBe(before);
    expect(screen.queryByTestId("room-loading-older")).toBeNull();
  });

  it("reaching the very first message says so, and asks the homeserver no further", async () => {
    stubDesktop();
    seedSession();
    const only = [messageFor({ eventId: "$1", body: "the very first thing said" })];
    const connection = fakeConnection({
      pages: [only],
      loadOlderResults: [{ loadedMore: false, atStart: true }],
    });
    vi.mocked(connect).mockResolvedValue(connection);

    const scroller = await openRoom();
    await screen.findByText("the very first thing said");

    scrollTranscriptTo(scroller, 0);

    expect(await screen.findByTestId("room-beginning")).toHaveTextContent("beginning");
    expect(connection.loadOlder).toHaveBeenCalledTimes(1);

    // Scrolling to the top again costs nothing further — the homeserver's
    // own word already stands.
    scrollTranscriptTo(scroller, 0);
    expect(connection.loadOlder).toHaveBeenCalledTimes(1);
  });
});

describe("#248 — the transcript is virtualized", () => {
  it("opens at the end with only the rows near the viewport in the DOM", async () => {
    stubDesktop();
    seedSession();
    const layout = stubTimelineLayout();
    vi.mocked(connect).mockResolvedValue(fakeConnection({ pages: [messages("m", 60)], loadOlderResults: [{ loadedMore: false, atStart: true }] }));

    const scroller = await openRoom();
    await screen.findByText("m message 60");

    const rendered = screen.getAllByTestId("room-message");
    // A screenful plus the overscan either side — never all sixty.
    expect(rendered.length).toBeGreaterThan(2);
    expect(rendered.length).toBeLessThan(20);
    expect(screen.queryByText("m message 1")).toBeNull();
    // At the very end: the newest row's bottom is the viewport's bottom (less the footer).
    await waitFor(() => expect(scroller.scrollTop).toBe(scroller.scrollHeight - layout.viewport));
  });

  it("places rows of different heights by their measured heights — an image card, a reply quote, plain words", async () => {
    stubDesktop();
    seedSession();
    // Measured, not assumed: a row carrying a file card is 260px, a reply
    // (with its quote) 140px, plain words 100px.
    const layout = stubTimelineLayout({
      viewport: 2000,
      rowHeight: (row) => (row.querySelector('[data-testid="reply-quote"]') ? 140 : row.textContent?.includes("diagram.png") ? 260 : 100),
    });
    vi.mocked(connect).mockResolvedValue(
      fakeConnection({
        pages: [
          [
            messageFor({ eventId: "$a", body: "plain words" }),
            messageFor({
              eventId: "$b",
              body: "diagram.png",
              file: { name: "diagram.png", mimeType: "image/png", size: 2048, url: "mxc://workspace.example/d", image: true },
            }),
            messageFor({ eventId: "$c", body: "replying with a quote", replyToEventId: "$a" }),
            messageFor({ eventId: "$d", body: "after all of it" }),
          ],
        ],
        loadOlderResults: [{ loadedMore: false, atStart: true }],
      }),
    );

    await openRoom();
    await screen.findByText("after all of it");
    await waitFor(() => expect(rowTopOnScreen(rowSaying("after all of it"), layout)).toBe(layout.header + 8 + (100 + 20) + (260 + 20) + (140 + 20)));
    expect(rowTopOnScreen(rowSaying("replying with a quote"), layout)).toBe(layout.header + 8 + (100 + 20) + (260 + 20));
  });

  it("a message arriving while the member is at the end keeps them there; up in history, nothing moves", async () => {
    stubDesktop();
    seedSession();
    const layout = stubTimelineLayout();
    const connection = fakeConnection({ pages: [messages("m", 10)], loadOlderResults: [{ loadedMore: false, atStart: true }] });
    vi.mocked(connect).mockResolvedValue(connection);

    const scroller = await openRoom();
    await screen.findByText("m message 10");
    await waitFor(() => expect(scroller.scrollTop).toBe(scroller.scrollHeight - layout.viewport));

    act(() => connection.deliver(messageFor({ eventId: "$new1", body: "just arrived" })));
    await screen.findByText("just arrived");
    // Pinned: the new row is in view, the end is still the end.
    await waitFor(() => expect(scroller.scrollTop).toBe(scroller.scrollHeight - layout.viewport));

    // Reading history: an arrival doesn't drag the member down.
    scrollTranscriptTo(scroller, 200);
    await waitFor(() => expect(screen.getByText("m message 3")).toBeInTheDocument());
    const reading = rowTopOnScreen(rowSaying("m message 3"), layout);
    const readsBefore = vi.mocked(connection.timeline).mock.calls.length;
    act(() => connection.deliver(messageFor({ eventId: "$new2", body: "arrived while reading back" })));
    await waitFor(() => expect(vi.mocked(connection.timeline).mock.calls.length).toBeGreaterThan(readsBefore));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The row the member was reading is exactly where it was on screen.
    expect(rowTopOnScreen(rowSaying("m message 3"), layout)).toBe(reading);
    expect(scroller.scrollTop).toBeLessThan(scroller.scrollHeight - layout.viewport);
    // It's there, at the end, for when the member gets back down.
    scrollTranscriptTo(scroller, scroller.scrollHeight);
    expect(await screen.findByText("arrived while reading back")).toBeInTheDocument();
  });

  it("a row mid-edit stays mounted when scrolled far out of view — the half-typed edit survives", async () => {
    stubDesktop();
    seedSession();
    stubTimelineLayout();
    vi.mocked(connect).mockResolvedValue(
      fakeConnection({ pages: [messages("mine", 40, { senderId: SESSION.userId, senderName: "Ana" })], loadOlderResults: [{ loadedMore: false, atStart: true }] }),
    );

    const scroller = await openRoom();
    await screen.findByText("mine message 40");
    // Up to the top, open the first message's edit, and start typing.
    scrollTranscriptTo(scroller, 0);
    const first = await waitFor(() => rowSaying("mine message 1"));
    fireEvent.click(within(first).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(first).getByLabelText("Edit message"), { target: { value: "mine message 1, but better" } });

    // All the way back down: the first row is far outside the window.
    scrollTranscriptTo(scroller, scroller.scrollHeight);
    await waitFor(() => expect(screen.getByText("mine message 40")).toBeInTheDocument());
    expect(screen.queryByText("mine message 2")).toBeNull();
    // …yet the row being edited is still there, edit and all.
    expect(screen.getByLabelText("Edit message")).toHaveValue("mine message 1, but better");
  });
});

describe("#248 — landing on a message, wherever it is in the window", () => {
  it("a search hit opens centred on its message (#70), the rows around it rendered and nothing past them", async () => {
    stubDesktop();
    seedSession();
    const layout = stubTimelineLayout();
    const around = messages("w", 40);
    vi.mocked(connect).mockResolvedValue(fakeConnection({ pages: [[]], loadOlderResults: [{ loadedMore: false, atStart: true }], around }));

    await renderApp();
    navigate(`#chat/${encodeURIComponent(ROOM_ID)}/${encodeURIComponent("$w20")}`);
    await screen.findByTestId("room-scroller");
    await waitFor(() => expect(rowTopOnScreen(rowSaying("w message 20"), layout)).toBe((layout.viewport - 100) / 2));
    expect(rowSaying("w message 20")).toHaveAttribute("aria-current", "true");
    expect(screen.queryByText("w message 1")).toBeNull();
    expect(screen.queryByText("w message 40")).toBeNull();
  });

  it("a reply's quote brings its original into view even when that row isn't rendered (#215)", async () => {
    stubDesktop();
    seedSession();
    const layout = stubTimelineLayout();
    const page = [...messages("m", 39), messageFor({ eventId: "$reply", body: "answering the twentieth", replyToEventId: "$m20" })];
    vi.mocked(connect).mockResolvedValue(fakeConnection({ pages: [page], loadOlderResults: [{ loadedMore: false, atStart: true }] }));

    await openRoom();
    const reply = await waitFor(() => rowSaying("answering the twentieth"));
    // The original is twenty rows up — not in the DOM at all (only the quote's snippet of it is).
    expect(ownWordsShown("m message 20")).toBe(false);

    fireEvent.click(within(reply).getByTestId("reply-quote"));
    await waitFor(() => expect(rowTopOnScreen(rowSaying("m message 20"), layout)).toBe((layout.viewport - 100) / 2));
    expect(rowSaying("m message 20")).toHaveAttribute("aria-current", "true");
  });
});

describe("#248 — a thread's transcript is virtualized the same way", () => {
  function threadPage(): RoomMessage[] {
    return [messageFor({ eventId: "$root", body: "the thread starts here" }), ...messages("r", 30, { threadRootEventId: "$root" })];
  }

  it("opens at its latest reply with only the rows near the viewport in the DOM", async () => {
    stubDesktop();
    seedSession();
    const layout = stubTimelineLayout();
    vi.mocked(connect).mockResolvedValue(fakeConnection({ pages: [threadPage()], loadOlderResults: [{ loadedMore: false, atStart: true }] }));

    await renderApp();
    navigate(`#chat/${encodeURIComponent(ROOM_ID)}/thread/${encodeURIComponent("$root")}`);
    const scroller = await screen.findByTestId("thread-scroller");
    await screen.findByText("r message 30");
    await waitFor(() => expect(scroller.scrollTop).toBe(scroller.scrollHeight - layout.viewport));
    expect(screen.getAllByTestId("room-message").length).toBeLessThan(20);
    expect(screen.queryByText("the thread starts here")).toBeNull();
  });

  it("the member's own reply goes to the end, even from up in the thread", async () => {
    stubDesktop();
    seedSession();
    const layout = stubTimelineLayout();
    const connection = fakeConnection({ pages: [threadPage()], loadOlderResults: [{ loadedMore: false, atStart: true }] });
    vi.mocked(connect).mockResolvedValue(connection);

    await renderApp();
    navigate(`#chat/${encodeURIComponent(ROOM_ID)}/thread/${encodeURIComponent("$root")}`);
    const scroller = await screen.findByTestId("thread-scroller");
    await screen.findByText("r message 30");
    scrollTranscriptTo(scroller, 300);

    const field = screen.getByLabelText("Reply in thread");
    typeInto(field, "my own reply");
    pressEnter(field);
    await screen.findByText("my own reply");
    await waitFor(() => expect(scroller.scrollTop).toBe(scroller.scrollHeight - layout.viewport));
  });
});

describe("#212 — the 'New messages' line and jumping to it", () => {
  function unreadConnection(overrides: Partial<Parameters<typeof fakeConnection>[0]> = {}) {
    const timeline = [
      messageFor({ eventId: "$read", body: "already read this" }),
      messageFor({ eventId: "$unread1", body: "first unread message" }),
      messageFor({ eventId: "$unread2", body: "second unread message" }),
    ];
    return fakeConnection({
      pages: [timeline],
      loadOlderResults: [{ loadedMore: false, atStart: true }],
      readMarker: "$read",
      unreadBoundary: { kind: "found", eventId: "$unread1" },
      ...overrides,
    });
  }

  it("shows the line above the first unread message when opening a conversation with unread messages", async () => {
    stubDesktop();
    seedSession();
    const connection = unreadConnection();
    vi.mocked(connect).mockResolvedValue(connection);

    await renderApp();
    navigate(`#chat/${encodeURIComponent(ROOM_ID)}`);
    const line = await screen.findByTestId("room-unread-line");

    const rows = screen.getAllByTestId("room-message");
    // The line sits in the flow, right before the first unread row — not
    // merely present somewhere on the page.
    const firstUnreadRow = screen.getByText("first unread message").closest('[data-testid="room-message"]')!;
    // Row 0 is "already read this" — the line sits above the SECOND row.
    expect(rows.indexOf(firstUnreadRow as HTMLElement)).toBe(1);
    expect(line.compareDocumentPosition(firstUnreadRow)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText("already read this")).toBeInTheDocument();
  });

  it("advances the read marker and removes the line once the member actually dwells on it", async () => {
    stubDesktop();
    seedSession();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const connection = unreadConnection();
    vi.mocked(connect).mockResolvedValue(connection);

    await renderApp();
    navigate(`#chat/${encodeURIComponent(ROOM_ID)}`);
    await screen.findByTestId("room-unread-line");

    const observer = FakeIntersectionObserver.instances.at(-1)!;
    act(() => {
      observer.trigger(true);
    });
    // A glance isn't enough — the dwell hasn't elapsed yet.
    expect(connection.advanceReadMarker).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(900);
    });

    expect(connection.advanceReadMarker).toHaveBeenCalledWith(ROOM_ID, "$unread1");
    expect(screen.queryByTestId("room-unread-line")).toBeNull();
  });

  it("a glance that doesn't dwell never advances the marker", async () => {
    stubDesktop();
    seedSession();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const connection = unreadConnection();
    vi.mocked(connect).mockResolvedValue(connection);

    await renderApp();
    navigate(`#chat/${encodeURIComponent(ROOM_ID)}`);
    await screen.findByTestId("room-unread-line");

    const observer = FakeIntersectionObserver.instances.at(-1)!;
    act(() => {
      observer.trigger(true);
    });
    act(() => {
      observer.trigger(false);
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(connection.advanceReadMarker).not.toHaveBeenCalled();
    expect(screen.getByTestId("room-unread-line")).toBeInTheDocument();
  });

  it("the dwell keeps timing through re-renders — a refresh mid-dwell doesn't restart it", async () => {
    stubDesktop();
    seedSession();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const connection = unreadConnection();
    vi.mocked(connect).mockResolvedValue(connection);

    await renderApp();
    navigate(`#chat/${encodeURIComponent(ROOM_ID)}`);
    await screen.findByTestId("room-unread-line");
    const observers = FakeIntersectionObserver.instances.length;

    act(() => {
      FakeIntersectionObserver.instances.at(-1)!.trigger(true);
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    // Something re-renders the room mid-dwell (a live arrival refetch)…
    act(() => connection.deliver(messageFor({ eventId: "$late", body: "arrived mid-dwell" })));
    await screen.findByText("arrived mid-dwell");
    // …and the same observer is still the one watching: the dwell wasn't reset.
    expect(FakeIntersectionObserver.instances).toHaveLength(observers);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(connection.advanceReadMarker).toHaveBeenCalledWith(ROOM_ID, "$unread1");
  });

  it("opens on the line (not the end); scrolled away, the line's row leaves the DOM and 'Jump to first unread' brings it back", async () => {
    stubDesktop();
    seedSession();
    const layout = stubTimelineLayout();
    vi.mocked(connect).mockResolvedValue(
      fakeConnection({
        pages: [messages("m", 40)],
        loadOlderResults: [{ loadedMore: false, atStart: true }],
        readMarker: "$m9",
        unreadBoundary: { kind: "found", eventId: "$m10" },
      }),
    );

    const scroller = await openRoom();
    // Landed where the member stopped reading: the line's row is centred.
    await waitFor(() => expect(rowTopOnScreen(rowSaying("m message 10"), layout)).toBe((layout.viewport - 100) / 2));
    expect(screen.getByTestId("room-unread-line")).toBeInTheDocument();
    // A browser's observer reports a freshly watched line's visibility at
    // once; this fake waits to be told — tell it what the layout shows.
    act(() => FakeIntersectionObserver.instances.at(-1)!.trigger(true));
    expect(screen.queryByTestId("jump-to-unread")).toBeNull();

    // Down to the latest: the line's row is virtualized away — so it can't
    // be in view, and the jump is offered.
    scrollTranscriptTo(scroller, scroller.scrollHeight);
    await waitFor(() => expect(screen.queryByTestId("room-unread-line")).toBeNull());
    fireEvent.click(await screen.findByTestId("jump-to-unread"));

    await waitFor(() => expect(screen.getByTestId("room-unread-line")).toBeInTheDocument());
    await waitFor(() => expect(rowTopOnScreen(rowSaying("m message 10"), layout)).toBe((layout.viewport - 100) / 2));
    act(() => FakeIntersectionObserver.instances.at(-1)!.trigger(true));
    expect(screen.queryByTestId("jump-to-unread")).toBeNull();
  });

  it("offers 'Jump to first unread' once the line is scrolled out of view, and it scrolls back to it", async () => {
    stubDesktop();
    seedSession();
    const connection = unreadConnection();
    vi.mocked(connect).mockResolvedValue(connection);

    await renderApp();
    navigate(`#chat/${encodeURIComponent(ROOM_ID)}`);
    await screen.findByTestId("room-unread-line");
    expect(screen.queryByTestId("jump-to-unread")).toBeNull();

    const observer = FakeIntersectionObserver.instances.at(-1)!;
    act(() => {
      observer.trigger(false);
    });

    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
    const jumpButton = await screen.findByTestId("jump-to-unread");
    fireEvent.click(jumpButton);
    expect(scrollTo).toHaveBeenCalled();
  });

  it("pages backward (bounded) for an unread anchor older than what's loaded, falling back to the top", async () => {
    stubDesktop();
    seedSession();
    const timeline = [messageFor({ eventId: "$only", body: "only thing loaded" })];
    const connection = fakeConnection({
      pages: [timeline],
      // Every loadOlder call says "nothing more" — the anchor never turns up.
      loadOlderResults: [{ loadedMore: false, atStart: true }],
      readMarker: "$somewhere-older",
      unreadBoundary: { kind: "unknown" },
    });
    vi.mocked(connect).mockResolvedValue(connection);

    await renderApp();
    navigate(`#chat/${encodeURIComponent(ROOM_ID)}`);
    const jumpButton = await screen.findByTestId("jump-to-unread");

    fireEvent.click(jumpButton);

    await waitFor(() => expect(connection.loadOlder).toHaveBeenCalled());
    // Exhausted (the homeserver said "beginning" on the very first try) —
    // falls back to a plain scroll-to-top rather than hanging.
    await waitFor(() => expect(screen.queryByTestId("room-loading-older")).toBeNull());
  });
});
