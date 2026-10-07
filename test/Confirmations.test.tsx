// @ts-expect-error no node types by design
import { readFileSync, readdirSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { App } from "../src/App.js";
import { Confirmations } from "../src/routes/Confirmations.js";
import { ConfirmationWatcher } from "../src/components/ConfirmationWatcher.js";
import { useConfirmT4, usePendingT4, queryKeys } from "../src/api/queries.js";
import { SyncStatusProvider } from "../src/sync.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { PendingT4RequestForJudgement, RegisteredAction } from "../src/api/types.js";

// The shell's notification side effects are Tauri's; that the client asks
// for one, exactly once per arrival, is what this file pins. The native
// half is pinned in notifications.test.ts.
vi.mock("../src/notifications.js", () => ({
  draftArrivalBody: vi.fn(() => null),
  draftArrivalCategory: vi.fn(() => "draftsReady"),
  notifyDraftReady: vi.fn(),
  notifyConfirmationWaiting: vi.fn(),
  postNotification: vi.fn(),
  wireNotificationClicks: vi.fn(() => Promise.resolve(() => {})),
}));
import { notifyConfirmationWaiting } from "../src/notifications.js";

/*
 * #52: confirm an irreversible action from the app. `concept.md` §6 asks
 * for a separate, explicit human confirmation at the moment a T4 action
 * executes, and the owner is not sitting where the daemon's stdin is. The
 * daemon serves the moment (digital-duo #180: GET /actions/t4/pending,
 * POST /actions/t4/:id/confirm); this surface adds no behaviour to it — it
 * notifies, states the consequence, takes a deliberate yes, and refuses
 * when the daemon cannot be reached.
 */

const api: DuoApiConfig = { baseUrl: "http://test:7717", token: "tok" };

const action: RegisteredAction = {
  id: "file-court-response",
  description: "File a response with the court on the owner's behalf",
  reversible: false,
  obligates: true,
  audience: "external",
  topicIds: ["evictions"],
  tier: "T4",
  registeredAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function pendingFor(id: string, overrides: Partial<PendingT4RequestForJudgement> = {}): PendingT4RequestForJudgement {
  return {
    id,
    actionId: action.id,
    topicId: "evictions",
    reasoning: "the filing deadline is tomorrow and the owner said to handle it",
    createdAt: "2026-01-02T00:00:00.000Z",
    executedAt: null,
    action,
    ...overrides,
  };
}

type Call = { url: string; method: string };

/**
 * A daemon stand-in: the pending list is whatever `state.pending` holds
 * (mutable, so a test can move the world between polls), a confirm POST is
 * recorded and — unless the test says otherwise — removes that request from
 * the list the way the daemon does. `calls` is every request made, so "no
 * POST happened" is an assertion on the wire, not on a mock's internals.
 */
function stubDaemon(initial: PendingT4RequestForJudgement[], options: { confirmStatus?: number; confirmBody?: unknown } = {}) {
  const state = { pending: initial, unreachable: false };
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(url), method });
    if (state.unreachable) {
      return Promise.reject(new TypeError("fetch failed"));
    }
    if (String(url).endsWith("/actions/t4/pending")) {
      return Promise.resolve(new Response(JSON.stringify(state.pending), { status: 200 }));
    }
    const confirm = /\/actions\/t4\/([^/]+)\/confirm$/.exec(String(url));
    if (confirm && method === "POST") {
      if (options.confirmStatus && options.confirmStatus >= 400) {
        return Promise.resolve(new Response(JSON.stringify(options.confirmBody), { status: options.confirmStatus }));
      }
      const id = decodeURIComponent(confirm[1]!);
      const found = state.pending.find((request) => request.id === id);
      state.pending = state.pending.filter((request) => request.id !== id);
      return Promise.resolve(new Response(JSON.stringify({ ...found, executedAt: "2026-01-02T01:00:00.000Z" }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { state, calls, fetchMock, posts: () => calls.filter((call) => call.method === "POST") };
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderRoute(ui: ReactElement, client: QueryClient = newClient()) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <SyncStatusProvider>{ui}</SyncStatusProvider>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.mocked(notifyConfirmationWaiting).mockClear();
  localStorage.clear();
  window.location.hash = "";
  onlineManager.setOnline(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  onlineManager.setOnline(true);
});

describe("#52 AC1 — a pending confirmation reaches the owner", () => {
  it("the request is visible in the app, on its own surface", async () => {
    stubDaemon([pendingFor("req-1"), pendingFor("req-2", { reasoning: "the second one" })]);
    renderRoute(<Confirmations api={api} />);

    const cards = await screen.findAllByTestId("confirmation-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByTestId("confirmation-action")).toHaveTextContent("File a response with the court on the owner's behalf");
  });

  it("an empty list says nothing is waiting, and offers nothing to confirm", async () => {
    stubDaemon([]);
    renderRoute(<Confirmations api={api} />);

    expect(await screen.findByTestId("confirmations-empty")).toHaveTextContent("Nothing is waiting for your confirmation.");
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });

  it("the app asks for a native notification when a request arrives — once per request, never again on a re-read", async () => {
    const daemon = stubDaemon([]);
    const client = newClient();
    render(
      <QueryClientProvider client={client}>
        <ConfirmationWatcher api={api} onArrived={() => {}} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(daemon.calls.length).toBeGreaterThan(0));
    expect(notifyConfirmationWaiting).not.toHaveBeenCalled();

    daemon.state.pending = [pendingFor("req-1")];
    await act(() => client.refetchQueries({ queryKey: queryKeys.t4Pending }));
    await waitFor(() => expect(notifyConfirmationWaiting).toHaveBeenCalledTimes(1));

    // The same request seen again is not news.
    await act(() => client.refetchQueries({ queryKey: queryKeys.t4Pending }));
    expect(notifyConfirmationWaiting).toHaveBeenCalledTimes(1);

    // A different one is.
    daemon.state.pending = [pendingFor("req-1"), pendingFor("req-2")];
    await act(() => client.refetchQueries({ queryKey: queryKeys.t4Pending }));
    await waitFor(() => expect(notifyConfirmationWaiting).toHaveBeenCalledTimes(2));
  });

  it("a request already waiting when the app opens still notifies — the owner was not there when it was raised", async () => {
    stubDaemon([pendingFor("req-1")]);
    const onArrived = vi.fn();
    const client = newClient();
    render(
      <QueryClientProvider client={client}>
        <ConfirmationWatcher api={api} onArrived={onArrived} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(notifyConfirmationWaiting).toHaveBeenCalledTimes(1));
    expect(onArrived).toHaveBeenCalledTimes(1);
  });

  it("the daemon has no push for this, so the client reads on an interval — even while the window is not focused", async () => {
    vi.useFakeTimers();
    const daemon = stubDaemon([]);
    const client = newClient();
    render(
      <QueryClientProvider client={client}>
        <ConfirmationWatcher api={api} onArrived={() => {}} />
      </QueryClientProvider>,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    const first = daemon.calls.length;
    expect(first).toBe(1);
    daemon.state.pending = [pendingFor("req-1")];
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(daemon.calls.length).toBeGreaterThan(first);
    expect(notifyConfirmationWaiting).toHaveBeenCalledTimes(1);
  });

  it("the whole app: an arrival lights the Confirmations entry, notifies, and announces politely", async () => {
    stubDaemon([pendingFor("req-1")]);
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    render(<App />);

    // The chat list carries its own count for what waits on an explicit yes — no
    // push reaches a browser tab (AR-15) — and it is counted in Waiting on you too.
    const badge = await screen.findByTestId("confirmations-badge");
    expect(badge).toHaveTextContent("1");
    expect(screen.getByTestId("waiting-badge")).toHaveTextContent("1");
    await waitFor(() => expect(notifyConfirmationWaiting).toHaveBeenCalledTimes(1));
    // The polite live region carries it for a screen reader, without moving focus.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("waiting for your confirmation"));
    expect(document.activeElement).toBe(document.body);

    // …and the chip leads to the request itself.
    const link = screen.getByTestId("confirmations-chip");
    expect(link).toHaveAttribute("href", "#confirmations");
    window.location.hash = "#confirmations";
    expect(await screen.findByTestId("confirmation-card")).toBeInTheDocument();
  });
});

describe("#52 AC2 — the request states the consequence, before any affirmative control is reachable", () => {
  it("says what will happen, to what, and that it cannot be undone — in the daemon's own words", async () => {
    stubDaemon([pendingFor("req-1")]);
    renderRoute(<Confirmations api={api} />);
    const card = await screen.findByTestId("confirmation-card");

    expect(within(card).getByTestId("confirmation-action")).toHaveTextContent("File a response with the court on the owner's behalf");
    expect(within(card).getByTestId("confirmation-topic")).toHaveTextContent("evictions");
    expect(within(card).getByTestId("confirmation-undo")).toHaveTextContent("This cannot be undone.");
  });

  it("says plainly when it can be undone, rather than defaulting to alarm", async () => {
    stubDaemon([pendingFor("req-1", { action: { ...action, reversible: true } })]);
    renderRoute(<Confirmations api={api} />);
    const card = await screen.findByTestId("confirmation-card");
    expect(within(card).getByTestId("confirmation-undo")).toHaveTextContent("This can be undone.");
    expect(within(card).getByTestId("confirmation-undo")).not.toHaveTextContent("cannot");
  });

  it("the duo's reasoning is labelled as the duo's, never the owner's (AR-13)", async () => {
    stubDaemon([pendingFor("req-1")]);
    renderRoute(<Confirmations api={api} />);
    const card = await screen.findByTestId("confirmation-card");
    const reasoning = within(card).getByTestId("duo-message");
    expect(reasoning).toHaveTextContent("the filing deadline is tomorrow and the owner said to handle it");
    expect(within(reasoning).getByTestId("duo-message-attribution")).toHaveTextContent("Your duo");
  });

  it("every consequence line precedes the control that confirms — in the document, so a reader meets them first", async () => {
    stubDaemon([pendingFor("req-1")]);
    renderRoute(<Confirmations api={api} />);
    const card = await screen.findByTestId("confirmation-card");
    const trigger = await within(card).findByTestId("confirmation-review");

    for (const id of ["confirmation-action", "confirmation-topic", "confirmation-undo"]) {
      const line = within(card).getByTestId(id);
      expect(line.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING, `${id} precedes the control`).toBeTruthy();
    }
    // And the only control on the card opens a question; it is not itself the confirmation.
    expect(within(card).queryByTestId("confirmation-confirm")).toBeNull();
  });

  it("the question itself restates the consequence before its affirmative control", async () => {
    stubDaemon([pendingFor("req-1")]);
    renderRoute(<Confirmations api={api} />);
    fireEvent.click(await screen.findByTestId("confirmation-review"));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveAccessibleName(/confirm/i);
    expect(dialog).toHaveAccessibleDescription(/File a response with the court on the owner's behalf/);
    expect(dialog).toHaveAccessibleDescription(/evictions/);
    expect(dialog).toHaveAccessibleDescription(/cannot be undone/);
    const description = within(dialog).getByTestId("confirmation-question");
    const confirm = within(dialog).getByTestId("confirmation-confirm");
    expect(description.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a request whose action the daemon can no longer describe cannot be confirmed — it cannot say what would happen", async () => {
    stubDaemon([pendingFor("req-1", { action: null })]);
    renderRoute(<Confirmations api={api} />);
    const card = await screen.findByTestId("confirmation-card");

    expect(within(card).getByTestId("confirmation-undescribed")).toHaveTextContent("can't say what this would do");
    expect(within(card).queryByTestId("confirmation-review")).toBeNull();
    expect(within(card).queryByRole("button")).toBeNull();
  });
});

describe("#52 AC3 — confirming is deliberate, and nothing else confirms it", () => {
  it("nothing is posted by looking: rendering, focusing, clicking the words, pressing Enter or Space on the card", async () => {
    const daemon = stubDaemon([pendingFor("req-1")]);
    renderRoute(<Confirmations api={api} />);
    const card = await screen.findByTestId("confirmation-card");

    fireEvent.click(within(card).getByTestId("confirmation-action"));
    fireEvent.click(card);
    fireEvent.doubleClick(card);
    fireEvent.keyDown(card, { key: "Enter" });
    fireEvent.keyDown(card, { key: " " });
    fireEvent.keyDown(document.body, { key: "Enter" });
    await act(async () => {});

    expect(daemon.posts()).toEqual([]);
  });

  it("opening the question posts nothing, and the safe answer is the one focused — Enter on open cannot confirm", async () => {
    const daemon = stubDaemon([pendingFor("req-1")]);
    renderRoute(<Confirmations api={api} />);
    fireEvent.click(await screen.findByTestId("confirmation-review"));

    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByTestId("confirmation-cancel")));
    expect(daemon.posts()).toEqual([]);
  });

  it("Cancel, Escape and a click outside each leave it exactly as it was — no POST, still pending", async () => {
    const daemon = stubDaemon([pendingFor("req-1")]);
    renderRoute(<Confirmations api={api} />);
    const trigger = await screen.findByTestId("confirmation-review");

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("confirmation-cancel"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    fireEvent.click(trigger);
    const second = await screen.findByRole("alertdialog");
    fireEvent.keyDown(second, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    fireEvent.click(trigger);
    await screen.findByRole("alertdialog");
    // The scrim is outside the panel: a press there is not an answer. (The
    // alert-dialog primitive's own refusal of outside pointer-downs is
    // pinned in Primitives.test.tsx; happy-dom cannot synthesise the pointer
    // event Radix listens for, so this holds what it can — the press lands
    // and nothing is answered.)
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    expect(daemon.posts()).toEqual([]);
    expect(screen.getByTestId("confirmation-card")).toBeInTheDocument();
  });

  it("the explicit control posts exactly once, to that request's own confirm route", async () => {
    const daemon = stubDaemon([pendingFor("req-1")]);
    renderRoute(<Confirmations api={api} />);
    fireEvent.click(await screen.findByTestId("confirmation-review"));
    const confirm = await screen.findByTestId("confirmation-confirm");

    fireEvent.click(confirm);
    fireEvent.click(confirm); // an impatient second press
    await waitFor(() => expect(daemon.posts()).toHaveLength(1));
    expect(daemon.posts()[0]).toEqual({ url: "http://test:7717/actions/t4/req-1/confirm", method: "POST" });
  });

  it("confirming one request never confirms another — each is its own question", async () => {
    const daemon = stubDaemon([pendingFor("req-1"), pendingFor("req-2", { reasoning: "the other one" })]);
    renderRoute(<Confirmations api={api} />);
    const cards = await screen.findAllByTestId("confirmation-card");

    fireEvent.click(within(cards[1]!).getByTestId("confirmation-review"));
    fireEvent.click(await screen.findByTestId("confirmation-confirm"));

    await waitFor(() => expect(daemon.posts()).toHaveLength(1));
    expect(daemon.posts()[0]!.url).toContain("/actions/t4/req-2/confirm");
    // The untouched one is still waiting, still unconfirmed.
    await waitFor(() => expect(screen.getAllByTestId("confirmation-card")).toHaveLength(1));
    expect(within(screen.getByTestId("confirmation-card")).getByTestId("duo-message")).toHaveTextContent("the filing deadline");
  });

  it("what happened is said afterwards — the request leaves the waiting list and the confirmation is recorded on screen", async () => {
    stubDaemon([pendingFor("req-1")]);
    renderRoute(<Confirmations api={api} />);
    fireEvent.click(await screen.findByTestId("confirmation-review"));
    fireEvent.click(await screen.findByTestId("confirmation-confirm"));

    const done = await screen.findByTestId("confirmation-done");
    expect(done).toHaveTextContent("Confirmed");
    expect(done).toHaveTextContent("File a response with the court on the owner's behalf");
    expect(done).toHaveAttribute("role", "status");
    await waitFor(() => expect(screen.queryByTestId("confirmation-card")).toBeNull());
  });

  it("a refusal from the daemon (already confirmed elsewhere) is shown in its own words, and the list is re-read", async () => {
    const daemon = stubDaemon([pendingFor("req-1")], {
      confirmStatus: 409,
      confirmBody: { error: { code: "T4RequestAlreadyExecutedError", message: 'T4 request "req-1" was already executed and cannot run again.' } },
    });
    renderRoute(<Confirmations api={api} />);
    fireEvent.click(await screen.findByTestId("confirmation-review"));
    fireEvent.click(await screen.findByTestId("confirmation-confirm"));

    expect(await screen.findByTestId("mutation-error")).toHaveTextContent('T4 request "req-1" was already executed and cannot run again.');
    expect(screen.queryByTestId("confirmation-done")).toBeNull();
    // Not retried into a second execution: the daemon saw it once.
    expect(daemon.posts()).toHaveLength(1);
    // (one read to show it, at least one more after the refusal)
    await waitFor(() => expect(daemon.calls.filter((call) => call.method === "GET").length).toBeGreaterThanOrEqual(2));
  });

  it("the notification path only ever navigates — no route of arrival confirms (the watcher holds no confirm)", async () => {
    const daemon = stubDaemon([pendingFor("req-1")]);
    const client = newClient();
    render(
      <QueryClientProvider client={client}>
        <ConfirmationWatcher api={api} onArrived={() => {}} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(notifyConfirmationWaiting).toHaveBeenCalled());
    expect(daemon.posts()).toEqual([]);
  });

  it("structurally: the confirm route is spelled in one module and used by one component", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const sources = (readdirSync(root, { recursive: true }) as string[])
      .filter((entry) => /\.[cm]?tsx?$/.test(String(entry)))
      .map((entry) => ({ path: String(entry), content: readFileSync(join(root, String(entry)), "utf8") }));

    const spellsConfirmRoute = sources.filter((file) => /actions\/t4\/[^`"']*confirm/.test(file.content)).map((file) => file.path);
    expect(spellsConfirmRoute).toEqual([join("api", "queries.ts")]);

    const usesConfirm = sources.filter((file) => file.content.includes("useConfirmT4")).map((file) => file.path);
    expect(usesConfirm.sort()).toEqual([join("api", "queries.ts"), join("routes", "Confirmations.tsx")].sort());
  });
});

describe("#52 AC4 — offline refuses rather than queues (AR-15)", () => {
  it("a confirmation shown from cache while the daemon has not answered cannot be confirmed", async () => {
    // Rehydrated from the persisted cache, the daemon not yet heard from —
    // the window in which a cached irreversible action is most dangerous.
    const client = newClient();
    client.setQueryData(queryKeys.t4Pending, [pendingFor("req-1")]);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    renderRoute(<Confirmations api={api} />, client);

    const card = await screen.findByTestId("confirmation-card");
    expect(within(card).getByTestId("confirmation-action")).toBeInTheDocument();
    expect(within(card).getByTestId("confirmation-review")).toBeDisabled();
    expect(within(card).getByTestId("confirmation-unavailable")).toHaveTextContent("Checking with your duo");
  });

  it("an unreachable daemon leaves the cached request readable, and says why it cannot be confirmed", async () => {
    const client = newClient();
    client.setQueryData(queryKeys.t4Pending, [pendingFor("req-1")]);
    const daemon = stubDaemon([pendingFor("req-1")]);
    daemon.state.unreachable = true;
    renderRoute(<Confirmations api={api} />, client);

    const card = await screen.findByTestId("confirmation-card");
    await waitFor(() => expect(within(card).getByTestId("confirmation-unavailable")).toHaveTextContent("Your duo is asleep"));
    expect(within(card).getByTestId("confirmation-review")).toBeDisabled();
    fireEvent.click(within(card).getByTestId("confirmation-review"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(daemon.posts()).toEqual([]);
  });

  it("the daemon going quiet after the request was read disables the control", async () => {
    const daemon = stubDaemon([pendingFor("req-1")]);
    const { client } = renderRoute(<Confirmations api={api} />);
    const trigger = await screen.findByTestId("confirmation-review");
    await waitFor(() => expect(trigger).toBeEnabled());

    daemon.state.unreachable = true;
    await act(() => client.refetchQueries({ queryKey: queryKeys.t4Pending }));

    await waitFor(() => expect(screen.getByTestId("confirmation-review")).toBeDisabled());
    expect(screen.getByTestId("confirmation-unavailable")).toHaveTextContent("Your duo is asleep");
  });

  it("going quiet with the question already open disables its affirmative control too", async () => {
    const daemon = stubDaemon([pendingFor("req-1")]);
    const { client } = renderRoute(<Confirmations api={api} />);
    const trigger = await screen.findByTestId("confirmation-review");
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.click(trigger);
    const confirm = await screen.findByTestId("confirmation-confirm");

    daemon.state.unreachable = true;
    await act(() => client.refetchQueries({ queryKey: queryKeys.t4Pending }));

    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(confirm);
    expect(daemon.posts()).toEqual([]);
  });

  it("the confirm call is never held for later: with the browser offline it is attempted now and fails, not paused", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    vi.stubGlobal("fetch", fetchMock);
    onlineManager.setOnline(false);
    const client = newClient();
    const { result } = renderHook(() => useConfirmT4(api), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    act(() => {
      result.current.mutate("req-1");
    });

    // The default network mode would park this until the connection came
    // back and then fire it — a confirmation firing later against moved
    // context is exactly what this guard exists to prevent.
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isPaused).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("usePendingT4 reads the daemon's own route", async () => {
    const daemon = stubDaemon([pendingFor("req-1")]);
    const client = newClient();
    const { result } = renderHook(() => usePendingT4(api), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(daemon.calls[0]).toEqual({ url: "http://test:7717/actions/t4/pending", method: "GET" });
  });
});
