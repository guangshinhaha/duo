import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftRecord } from "../src/api/types.js";
import { DraftTray } from "../src/components/DraftTray.js";
import { SwipeRow } from "../src/shell/SwipeRow.js";
import { swipeActionsOf, type WaitingItem } from "../src/shell/waiting.js";
import { stubDesktop, stubPhone } from "./desktop.js";

const sync = vi.hoisted(() => ({ reachable: true }));
vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync.js")>();
  return { ...actual, useSyncStatus: () => ({ reachable: sync.reachable, lastSyncedAt: null }) };
});

/*
 * #153: the phone's one-handed way to clear what waits. A swipe is a
 * shortcut over buttons that always exist, so the rule for what may be
 * swiped is the strictest one: left sends only a confident draft.
 */

const draft = (id: string, over: Partial<DraftRecord> = {}): DraftRecord => ({
  id,
  question: `question ${id}`,
  threadContext: null,
  draftText: `answer ${id}`,
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.9,
  sources: [],
  createdAt: `2026-01-0${id.length}T00:00:00.000Z`,
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
  provenance: { origin: "channel", channelKind: "slack", askerRef: `asker-${id}`, threadId: null, permalink: null },
  delivery: null,
  ...over,
});

const item = (kind: WaitingItem["kind"], drafts: DraftRecord[]): Pick<WaitingItem, "kind" | "drafts"> => ({ kind, drafts });

describe("#153 — what a swipe may decide", () => {
  it("a confident draft can be sent and dismissed", () => {
    const d = draft("a");
    expect(swipeActionsOf(item("chat", [d]))).toEqual({ send: d, dismiss: d });
    expect(swipeActionsOf(item("bridged", [d]))).toEqual({ send: d, dismiss: d });
  });

  it("no swipe-send exists for anything but a confident draft — a hedged one and a passed-on question can only be dismissed, a refusal nothing", () => {
    const hedged = draft("h", { confidenceScore: 0.6 });
    const passed = draft("p", { draftText: null, escalated: true });
    const refused = draft("r", { draftText: null, escalated: true, refused: true });
    expect(swipeActionsOf(item("chat", [hedged]))).toEqual({ send: null, dismiss: hedged });
    expect(swipeActionsOf(item("chat", [passed]))).toEqual({ send: null, dismiss: passed });
    expect(swipeActionsOf(item("chat", [refused]))).toEqual({ send: null, dismiss: null });
  });

  it("a swipe decides exactly one draft: a row with several, your own duo, a bare draft page and confirmations have none", () => {
    expect(swipeActionsOf(item("chat", [draft("a"), draft("bb")]))).toEqual({ send: null, dismiss: null });
    expect(swipeActionsOf(item("duo", [draft("a")]))).toEqual({ send: null, dismiss: null });
    expect(swipeActionsOf(item("draft", [draft("a")]))).toEqual({ send: null, dismiss: null });
    expect(swipeActionsOf(item("confirmations", []))).toEqual({ send: null, dismiss: null });
  });

  it("an already-decided draft has nothing to swipe", () => {
    expect(swipeActionsOf(item("chat", [draft("a", { outcome: "sent" })]))).toEqual({ send: null, dismiss: null });
  });
});

function swipe(target: HTMLElement, dx: number, dy = 0): void {
  const base = { pointerId: 1, pointerType: "touch", button: 0 };
  fireEvent.pointerDown(target, { ...base, clientX: 300, clientY: 100 });
  fireEvent.pointerMove(target, { ...base, clientX: 300 + dx / 2, clientY: 100 + dy / 2 });
  fireEvent.pointerMove(target, { ...base, clientX: 300 + dx, clientY: 100 + dy });
  fireEvent.pointerUp(target, { ...base, clientX: 300 + dx, clientY: 100 + dy });
}

describe("#153 — the swipe row", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("a full swipe left sends; a short one and a scroll do not", async () => {
    const send = vi.fn(async () => {});
    render(
      <SwipeRow dismiss={null} send={send}>
        <a data-testid="link" href="#x">
          row
        </a>
      </SwipeRow>,
    );
    const surface = screen.getByTestId("swipe-surface");
    swipe(surface, -40);
    swipe(surface, -60, 80); // mostly vertical: the page's scroll
    expect(send).not.toHaveBeenCalled();
    swipe(surface, -200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Sent")).toBeInTheDocument();
  });

  it("toward a side with nothing to reveal the row does not move", () => {
    render(
      <SwipeRow dismiss={null} send={async () => {}}>
        <span>row</span>
      </SwipeRow>,
    );
    const surface = screen.getByTestId("swipe-surface");
    fireEvent.pointerDown(surface, { pointerId: 1, pointerType: "touch", button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 1, pointerType: "touch", button: 0, clientX: 160, clientY: 100 });
    fireEvent.pointerMove(surface, { pointerId: 1, pointerType: "touch", button: 0, clientX: 260, clientY: 100 });
    expect(surface.style.transform).toBe("");
    expect(screen.queryByTestId("swipe-reveal-dismiss")).toBeNull();
    expect(screen.getByTestId("swipe-reveal-send")).toHaveTextContent("Send");
  });

  it("a row with neither action is not swipeable at all", () => {
    render(
      <SwipeRow dismiss={null} send={null}>
        <span>row</span>
      </SwipeRow>,
    );
    const surface = screen.getByTestId("swipe-surface");
    swipe(surface, -300);
    expect(screen.getByTestId("swipe-surface")).toBeInTheDocument();
    expect(screen.queryByTestId("swipe-status")).toBeNull();
  });

  it("the tap that ends a swipe is not a tap on the link under it, but a plain tap still is", () => {
    const onClick = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
      <SwipeRow dismiss={null} send={async () => {}}>
        <a data-testid="link" href="#x" onClick={onClick}>
          row
        </a>
      </SwipeRow>,
    );
    fireEvent.click(screen.getByTestId("link"));
    expect(onClick).toHaveBeenCalledTimes(1);

    swipe(screen.getByTestId("swipe-surface"), -20); // a swipe that did not commit
    // The row snapped back; the release that ended the swipe swallows its click.
    fireEvent.click(screen.getByTestId("link"));
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("link"));
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("a full swipe right dismisses only after the undo window, and Undo inside it means it never happened", async () => {
    vi.useFakeTimers();
    const dismiss = vi.fn(async () => {});
    render(
      <SwipeRow dismiss={dismiss} send={null}>
        <span>row</span>
      </SwipeRow>,
    );
    swipe(screen.getByTestId("swipe-surface"), 200);
    expect(screen.getByTestId("swipe-status")).toHaveTextContent("Dismissed");
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("swipe-undo"));
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(dismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("swipe-surface")).toBeInTheDocument();

    swipe(screen.getByTestId("swipe-surface"), 200);
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("a dismissal still lands when the row is gone before the window ends — walking away is not an undo", async () => {
    vi.useFakeTimers();
    const dismiss = vi.fn(async () => {});
    const view = render(
      <SwipeRow dismiss={dismiss} send={null}>
        <span>row</span>
      </SwipeRow>,
    );
    swipe(screen.getByTestId("swipe-surface"), 200);
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("respects prefers-reduced-motion, and its buttons are real touch targets", async () => {
    render(
      <SwipeRow dismiss={async () => {}} send={null}>
        <span>row</span>
      </SwipeRow>,
    );
    // Drag follows the finger with no transition; the snap back has one, which reduced motion turns off.
    expect(screen.getByTestId("swipe-surface").className).toContain("motion-reduce:transition-none");
    swipe(screen.getByTestId("swipe-surface"), 200);
    expect(screen.getByTestId("swipe-undo").className).toContain("min-h-11");
  });

  it("a send the daemon refuses says so and lets the row come back", async () => {
    render(
      <SwipeRow dismiss={null} send={async () => Promise.reject(new Error("store locked"))}>
        <span>row</span>
      </SwipeRow>,
    );
    swipe(screen.getByTestId("swipe-surface"), -200);
    expect(await screen.findByRole("alert")).toHaveTextContent("store locked");
    fireEvent.click(screen.getByTestId("swipe-retry"));
    expect(screen.getByTestId("swipe-surface")).toBeInTheDocument();
  });
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

function fakeDaemon(initial: DraftRecord[]) {
  let log = [...initial];
  const outcomes: Array<{ id: string; body: { outcome: string } }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const outcome = /\/drafts\/([^/]+)\/outcome$/.exec(url);
    if (outcome && init?.method === "POST") {
      outcomes.push({ id: outcome[1]!, body: JSON.parse(String(init.body)) as { outcome: string } });
      log = log.map((d) => (d.id === outcome[1] ? { ...d, outcome: JSON.parse(String(init.body)).outcome } : d));
      return json({});
    }
    if (url.includes("/drafts?outcome=pending")) {
      return json(log.filter((d) => d.outcome === null));
    }
    if (url.includes("/drafts?limit=")) {
      return json([...log].reverse());
    }
    return json([]);
  });
  return { fetchMock, outcomes };
}

async function renderApp() {
  vi.resetModules();
  const { App } = await import("../src/App.js");
  return render(<App />);
}

describe("#153 — the phone's waiting list", () => {
  beforeEach(() => {
    sync.reachable = true;
    localStorage.clear();
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
    window.location.hash = "#waiting";
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
    window.location.hash = "";
  });

  it("clearing three confident drafts takes three gestures from the list", async () => {
    stubPhone();
    const daemon = fakeDaemon([draft("a"), draft("bb"), draft("ccc")]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    await renderApp();

    const rows = await screen.findAllByTestId("swipe-surface");
    expect(rows).toHaveLength(3);
    // What would be sent is on the row, behind the duo's line.
    expect(screen.getAllByTestId("waiting-draft-attribution")).toHaveLength(3);
    expect(screen.getAllByTestId("waiting-draft-text").map((el) => el.textContent)).toEqual(["answer a", "answer bb", "answer ccc"]);
    for (const row of rows) {
      swipe(row, -220);
    }
    await waitFor(() => expect(daemon.outcomes).toHaveLength(3));
    expect(daemon.outcomes.map((o) => o.body)).toEqual([{ outcome: "sent" }, { outcome: "sent" }, { outcome: "sent" }]);
    await waitFor(() => expect(screen.getByTestId("waiting-empty")).toBeInTheDocument());
  });

  it("a hedged draft and a passed-on question have no swipe-send, and their words are not shown on the list", async () => {
    stubPhone();
    const daemon = fakeDaemon([
      draft("a", { confidenceScore: 0.6 }),
      draft("bb", { draftText: null, escalated: true, escalationReason: "No rule covers this." }),
    ]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    await renderApp();

    const rows = await screen.findAllByTestId("swipe-surface");
    expect(screen.queryAllByTestId("swipe-reveal-send")).toHaveLength(0);
    expect(screen.queryByTestId("waiting-draft-text")).toBeNull();
    for (const row of rows) {
      swipe(row, -300);
    }
    expect(daemon.outcomes).toEqual([]);
    // Dismissing is still there, with its undo window: nothing is written yet.
    swipe(rows[0]!, 300);
    expect(daemon.outcomes).toEqual([]);
    expect(screen.getByTestId("swipe-undo")).toBeInTheDocument();
  });

  it("offline, nothing on the list is swipeable — a decision is never queued", async () => {
    stubPhone();
    sync.reachable = false;
    vi.stubGlobal("fetch", fakeDaemon([draft("a")]).fetchMock);
    await renderApp();

    await screen.findByTestId("waiting-list");
    expect(screen.queryByTestId("swipe-surface")).toBeNull();
    // The row is still a row: it opens its chat, where the tray says the same thing.
    expect(screen.getAllByTestId("waiting-link")).toHaveLength(1);
  });

  it("on a desktop window nothing is swipeable: the list is just a list", async () => {
    stubDesktop();
    const daemon = fakeDaemon([draft("a")]);
    vi.stubGlobal("fetch", daemon.fetchMock);
    await renderApp();

    await screen.findByTestId("waiting-list");
    expect(screen.queryByTestId("swipe-surface")).toBeNull();
    expect(screen.queryByTestId("waiting-draft-text")).toBeNull();
  });
});

describe("#153 — the back gesture closes the sheet first", () => {
  const api = { baseUrl: "http://test", token: "tok" };
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => json([]))));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <DraftTray api={api} draft={draft("a")} />
      </QueryClientProvider>,
    );
  }

  it("Why? takes a history entry; going back closes the sheet and stays in the chat", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("tray-why"));
    expect(await screen.findByTestId("why-sheet")).toBeInTheDocument();
    expect((window.history.state as { duoSheet?: boolean } | null)?.duoSheet).toBe(true);

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.queryByTestId("why-sheet")).toBeNull());
    expect(screen.getByTestId("draft-tray")).toBeInTheDocument();
  });

  it("closing it any other way gives its history entry back", async () => {
    const back = vi.spyOn(window.history, "back");
    mount();
    fireEvent.click(await screen.findByTestId("tray-why"));
    fireEvent.click(await screen.findByTestId("why-close"));
    await waitFor(() => expect(screen.queryByTestId("why-sheet")).toBeNull());
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });
});
