import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/workspace/matrix.js";
import type { RoomMessage, RoomSummary, UnreadBoundary, WorkspaceConnection, WorkspaceSession } from "../src/workspace/matrix.js";
import { stubDesktop } from "./desktop.js";

/*
 * #211/#212: scrolling back through older messages, and the "New messages"
 * line that shows where a member left off. The Matrix seam
 * (`src/workspace/matrix.ts`) is mocked wholesale here, same as
 * Workspace.test.tsx — these ACs are about Room.tsx's own behaviour against
 * the `WorkspaceConnection` contract (`loadOlder`, `readMarker`,
 * `unreadBoundaryFrom`, `advanceReadMarker`), which WorkspaceMatrixSeam.test.ts
 * pins against the real SDK shape separately.
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
 * (WorkspaceMatrixSeam.test.ts pins that projection). `heightOf` lets a test
 * say how tall the scroller should read after each page, since happy-dom
 * never lays anything out for real.
 */
function fakeConnection(options: {
  pages: readonly RoomMessage[][];
  loadOlderResults: ReadonlyArray<{ loadedMore: boolean; atStart: boolean }>;
  heightOf: readonly number[];
  readMarker?: string | null;
  unreadBoundary?: UnreadBoundary;
  /** A real (small) delay before `loadOlder` resolves, so a test can observe the "Loading older messages…" state in between — everything else here resolves same-tick, which would otherwise make it invisible. */
  loadOlderDelayMs?: number;
}) {
  let pageIndex = 0;
  let loadOlderCalls = 0;
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
    timeline: vi.fn(async () => {
      heightNow = options.heightOf[Math.min(pageIndex, options.heightOf.length - 1)]!;
      return [...options.pages[pageIndex]!];
    }),
    timelineAt: vi.fn(async () => []),
    loadOlder,
    readMarker: vi.fn(() => options.readMarker ?? null),
    unreadBoundaryFrom: vi.fn(() => options.unreadBoundary ?? { kind: "none" as const }),
    advanceReadMarker,
    markRead: vi.fn(async () => {}),
    loadMedia: vi.fn(async () => null),
    getUrlPreview: vi.fn(async () => null),
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
  return connection;
}

/** The height `HTMLElement.prototype.scrollHeight` answers with — a test-scoped mutable the fake connection's `timeline()` updates as pages load, standing in for happy-dom's own (nonexistent) layout. */
let heightNow = 0;

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

beforeEach(() => {
  localStorage.clear();
  vi.mocked(connect).mockReset();
  heightNow = 0;
  FakeIntersectionObserver.instances = [];
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => heightNow);
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  window.location.hash = "";
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("#211 — scrolling back through older messages", () => {
  it("scrolling to the top loads the previous page without losing the member's place", async () => {
    stubDesktop();
    seedSession();
    const olderPage = [messageFor({ eventId: "$older", body: "said earlier" }), ...Array.from({ length: 1 }, () => messageFor({ eventId: "$older2", body: "said earlier too" }))];
    const connection = fakeConnection({
      pages: [[messageFor({ eventId: "$1", body: "newest loaded" })], [...olderPage, messageFor({ eventId: "$1", body: "newest loaded" })]],
      loadOlderResults: [{ loadedMore: true, atStart: false }],
      heightOf: [1000, 1600],
      loadOlderDelayMs: 20,
    });
    vi.mocked(connect).mockResolvedValue(connection);

    await renderApp();
    navigate(`#chat/${encodeURIComponent(ROOM_ID)}`);
    const scroller = (await screen.findByTestId("room-timeline")).closest<HTMLElement>(".overflow-y-auto")!;
    await screen.findByText("newest loaded");

    // Scrolled near the top, part way down from a true 0 — the fix below
    // must preserve this offset, not just avoid a jump to the very top.
    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);

    expect(await screen.findByTestId("room-loading-older")).toBeInTheDocument();
    await screen.findByText("said earlier");
    expect(connection.loadOlder).toHaveBeenCalledWith(ROOM_ID);

    // scrollHeight grew by 600 (1000 → 1600); the member's own 40px offset
    // into the old content is preserved exactly, not reset to 0 or to the end.
    await waitFor(() => expect(scroller.scrollTop).toBe(600 + 40));
    expect(screen.queryByTestId("room-loading-older")).toBeNull();
  });

  it("reaching the very first message says so, and asks the homeserver no further", async () => {
    stubDesktop();
    seedSession();
    const only = [messageFor({ eventId: "$1", body: "the very first thing said" })];
    const connection = fakeConnection({
      pages: [only],
      loadOlderResults: [{ loadedMore: false, atStart: true }],
      heightOf: [1000],
    });
    vi.mocked(connect).mockResolvedValue(connection);

    await renderApp();
    navigate(`#chat/${encodeURIComponent(ROOM_ID)}`);
    const scroller = (await screen.findByTestId("room-timeline")).closest<HTMLElement>(".overflow-y-auto")!;
    await screen.findByText("the very first thing said");

    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    expect(await screen.findByTestId("room-beginning")).toHaveTextContent("beginning");
    expect(connection.loadOlder).toHaveBeenCalledTimes(1);

    // Scrolling to the top again costs nothing further — the homeserver's
    // own word already stands.
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(connection.loadOlder).toHaveBeenCalledTimes(1);
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
      heightOf: [1000],
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

    const jumpButton = await screen.findByTestId("jump-to-unread");
    fireEvent.click(jumpButton);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("pages backward (bounded) for an unread anchor older than what's loaded, falling back to the top", async () => {
    stubDesktop();
    seedSession();
    const timeline = [messageFor({ eventId: "$only", body: "only thing loaded" })];
    const connection = fakeConnection({
      pages: [timeline],
      // Every loadOlder call says "nothing more" — the anchor never turns up.
      loadOlderResults: [{ loadedMore: false, atStart: true }],
      heightOf: [1000],
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
