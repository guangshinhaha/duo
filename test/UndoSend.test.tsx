import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord, ScheduledSend } from "../src/api/types.js";
import { DraftCard } from "../src/components/DraftCard.js";
import { DraftTray } from "../src/components/DraftTray.js";
import { ScheduledSends } from "../src/components/ScheduledSends.js";
import { SendingSettings } from "../src/components/SendingSettings.js";
import { tomorrowAtNine } from "../src/components/SendControls.js";
import { readUndoSendSeconds, UNDO_SEND_STORAGE_KEY } from "../src/undoSendPrefs.js";

vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync.js")>();
  return { ...actual, useSyncStatus: () => ({ reachable: true, lastSyncedAt: null }) };
});

/*
 * #260: undo after Send — the send is held on this device, and nothing is
 * posted to the daemon until the countdown ends. #261: send later — the
 * daemon holds it, and the Scheduled list can take it back.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

const draft: DraftRecord = {
  id: "d1",
  question: "How do I get read access to the prod deploy logs?",
  threadContext: null,
  draftText: "Request read-only through the deploy-access runbook.",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.9,
  sources: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
  provenance: { origin: "channel", channelKind: "matrix", askerRef: "@sam:example.org", threadId: "!r:example.org", permalink: null },
  delivery: null,
};
const selfAsked: DraftRecord = { ...draft, id: "d2", provenance: { origin: "owner" } };

const NEXT_START = "2026-10-07T01:00:00.000Z";

function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function calls(suffix: string) {
  return (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter((call) => String(call[0]).split("?")[0]!.endsWith(suffix))
    .map((call) => ({
      url: String(call[0]),
      method: (call[1] as RequestInit | undefined)?.method ?? "GET",
      body: (call[1] as RequestInit | undefined)?.body ? JSON.parse((call[1] as RequestInit).body as string) : undefined,
    }));
}

const scheduledRow: ScheduledSend = {
  draftId: "d1",
  outcome: "sent",
  sentText: null,
  sendAt: NEXT_START,
  scheduledAt: "2026-10-06T14:00:00.000Z",
  state: "scheduled",
  settledAt: null,
  failureReason: null,
  draft,
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace("http://test", "");
      if (path === "/settings/working-hours") {
        return new Response(JSON.stringify({ start: "09:00", end: "18:00", timezone: "Asia/Singapore", days: [1, 2, 3, 4, 5], nextStart: NEXT_START }), { status: 200 });
      }
      if (path === "/scheduled-sends") {
        return new Response(JSON.stringify([scheduledRow]), { status: 200 });
      }
      if (path.endsWith("/schedule") && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { sendAt?: string };
        return new Response(JSON.stringify({ ...scheduledRow, draft: undefined, sendAt: body.sendAt ?? NEXT_START }), { status: 201 });
      }
      if (path.endsWith("/schedule") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("#260 — undo after Send", () => {
  it("tapping Send starts a visible countdown and does NOT call the daemon", () => {
    vi.useFakeTimers();
    mount(<DraftTray api={api} draft={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByTestId("send-countdown")).toHaveTextContent("Sending in 10s — not sent yet.");
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.getByTestId("send-countdown")).toHaveTextContent("Sending in 6s");
    expect(calls("/outcome")).toEqual([]);
  });

  it("Undo within the window sends nothing, and the draft is still waiting with its actions back", () => {
    vi.useFakeTimers();
    mount(<DraftTray api={api} draft={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    act(() => vi.advanceTimersByTime(9_000));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    act(() => vi.advanceTimersByTime(30_000));
    expect(calls("/outcome")).toEqual([]);
    expect(screen.queryByTestId("send-window")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("⌘Z undoes too", () => {
    vi.useFakeTimers();
    mount(<DraftTray api={api} draft={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    act(() => vi.advanceTimersByTime(30_000));
    expect(calls("/outcome")).toEqual([]);
  });

  it("letting the countdown run sends normally, exactly once", async () => {
    vi.useFakeTimers();
    mount(<DraftTray api={api} draft={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit your duo's draft" }), { target: { value: "Ask in #platform-help." } });
    fireEvent.click(screen.getByRole("button", { name: "Send edited" }));
    act(() => vi.advanceTimersByTime(9_999));
    expect(calls("/outcome")).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    vi.useRealTimers();
    await waitFor(() => expect(calls("/outcome")).toEqual([{ url: "http://test/drafts/d1/outcome", method: "POST", body: { outcome: "edited", sentText: "Ask in #platform-help." } }]));
  });

  it("the window length is a setting — 5, 10, 20 seconds or off — and off sends straight away", async () => {
    mount(<SendingSettings api={null} />);
    const select = screen.getByRole("combobox", { name: "Time to undo" });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Off — send straight away",
      "5 seconds",
      "10 seconds",
      "20 seconds",
    ]);
    fireEvent.change(select, { target: { value: "0" } });
    expect(readUndoSendSeconds()).toBe(0);
    cleanup();

    mount(<DraftTray api={api} draft={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.queryByTestId("send-window")).toBeNull();
    await waitFor(() => expect(calls("/outcome")).toHaveLength(1));
  });

  it("honours a shorter window", () => {
    vi.useFakeTimers();
    localStorage.setItem(UNDO_SEND_STORAGE_KEY, "5");
    mount(<DraftCard api={api} draft={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByTestId("send-countdown")).toHaveTextContent("Sending in 5s");
    expect(calls("/outcome")).toEqual([]);
  });

  it("a self-asked Keep reaches nobody, so it is not held", async () => {
    mount(<DraftTray api={api} draft={selfAsked} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByTestId("send-window")).toBeNull();
    expect(screen.queryByTestId("send-later")).toBeNull();
    await waitFor(() => expect(calls("/outcome")).toHaveLength(1));
  });
});

describe("#261 — send later", () => {
  it("Tomorrow 9:00 hands the daemon that time, and says when it will go", async () => {
    mount(<DraftTray api={api} draft={draft} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Send later" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.replace(/\s+/g, " "))).toEqual([
      "Tomorrow 9:00",
      expect.stringContaining("Start of their working hours"),
      "Pick a time…",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Tomorrow 9:00" }));
    await waitFor(() => expect(calls("/schedule")).toHaveLength(1));
    const [call] = calls("/schedule");
    expect(call).toMatchObject({ url: "http://test/drafts/d1/schedule", method: "POST", body: { outcome: "sent" } });
    expect(new Date(call!.body.sendAt).getTime()).toBe(tomorrowAtNine().getTime());
    expect(await screen.findByTestId("scheduled-confirmation")).toHaveTextContent("even if this app is closed");
    expect(calls("/outcome")).toEqual([]);
  });

  it("start of their working hours is resolved by the daemon, from its own setting", async () => {
    mount(<DraftCard api={api} draft={draft} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Send later" }));
    const item = await screen.findByRole("menuitem", { name: /Start of their working hours/ });
    fireEvent.click(item);
    await waitFor(() => expect(calls("/schedule")[0]?.body).toEqual({ outcome: "sent", at: "working-hours" }));
  });

  it("⌘⇧⏎ opens it from the keyboard", async () => {
    mount(<DraftTray api={api} draft={draft} keyboard />);
    fireEvent.keyDown(window, { key: "Enter", metaKey: true, shiftKey: true });
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(calls("/outcome")).toEqual([]);
  });

  it("scheduled sends are listed and can be cancelled before they fire", async () => {
    mount(<ScheduledSends api={api} />);
    const row = await screen.findByTestId("scheduled-send");
    expect(row).toHaveTextContent("Request read-only through the deploy-access runbook.");
    expect(row).toHaveTextContent("In reply to: How do I get read access to the prod deploy logs?");
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls("/drafts/d1/schedule")).toEqual([{ url: "http://test/drafts/d1/schedule", method: "DELETE", body: undefined }]));
  });
});
