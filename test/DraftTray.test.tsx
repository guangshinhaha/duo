import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord } from "../src/api/types.js";
import { IGNORE_UNDO_WINDOW_MS } from "../src/components/DraftCard.js";
import { DraftTray } from "../src/components/DraftTray.js";

const sync = vi.hoisted(() => ({ reachable: true }));
vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync.js")>();
  return { ...actual, useSyncStatus: () => ({ reachable: sync.reachable, lastSyncedAt: null }) };
});

/*
 * The draft tray (#142): your duo's draft above the composer of the chat it
 * answers — the Review card's decision logic in a compact, in-context form.
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
  sources: [
    { kind: "rule", id: "r1", label: "Deploy access: point to the runbook" },
    { kind: "evidence", id: "e1", label: "#platform-help · 14 Aug" },
    { kind: "evidence", id: "e2", label: "runbook.md" },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
  provenance: { origin: "unknown" },
  delivery: null,
};
const hedged: DraftRecord = { ...draft, id: "d2", confidenceScore: 0.6 };
const passedOn: DraftRecord = { ...draft, id: "d3", draftText: null, escalated: true, escalationReason: "No rule covers this." };
const refused: DraftRecord = { ...passedOn, id: "d4", refused: true, escalationReason: "A boundary you set." };

function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function posted() {
  return (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter((call) => String(call[0]).endsWith("/outcome"))
    .map((call) => ({ url: String(call[0]), body: JSON.parse((call[1] as RequestInit).body as string) }));
}

beforeEach(() => {
  sync.reachable = true;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("#142 — the tray says whose it is, how sure it is, and who can see it", () => {
  it("is the duo's own block behind its line, attributed, and says only the owner sees it", () => {
    mount(<DraftTray api={api} draft={draft} />);
    const attribution = screen.getByTestId("draft-tray-attribution");
    expect(attribution).toHaveTextContent("Your duo");
    expect(attribution).toHaveTextContent("draft");
    expect(attribution).toHaveTextContent("only you can see this");
    expect(screen.getByTestId("draft-tray-line")).toHaveAttribute("data-duo-line", "confident");
    expect(screen.getByTestId("draft-tray-line")).toHaveTextContent("Request read-only through the deploy-access runbook.");
    // The question is the transcript's, not the tray's.
    expect(screen.queryByTestId("owner-message")).toBeNull();
  });

  it("states its hairline in words — confident, hedging, passed to you, refused — never a number", () => {
    const words: Array<[DraftRecord, string, string]> = [
      [draft, "confident", "draft"],
      [hedged, "hedged", "draft · hedging"],
      [passedOn, "escalated", "passed to you"],
      [refused, "refused", "refused"],
    ];
    for (const [record, state, text] of words) {
      const view = mount(<DraftTray api={api} draft={record} />);
      expect(screen.getByTestId("draft-tray-line")).toHaveAttribute("data-duo-line", state);
      expect(screen.getByTestId("draft-tray-attribution")).toHaveTextContent(text);
      expect(view.container.textContent).not.toMatch(/\d+%/);
      cleanup();
    }
  });

  it("shows why at zero clicks: the standing order it applied and how many sources it drew on", () => {
    mount(<DraftTray api={api} draft={draft} />);
    expect(screen.getByTestId("draft-tray-why")).toHaveTextContent("Standing order: Deploy access: point to the runbook");
    expect(screen.getByTestId("draft-tray-why")).toHaveTextContent("Drew on 2 sources");
  });

  it("a passed-on question reads in the vocabulary's words and offers to be answered; a refusal offers nothing", () => {
    mount(<DraftTray api={api} draft={passedOn} />);
    expect(screen.getByTestId("draft-tray-line")).toHaveTextContent("Your duo escalated a question to you.");
    expect(screen.getByTestId("escalation-reason")).toHaveTextContent("No rule covers this.");
    expect(screen.getByRole("button", { name: "Answer it" })).toBeDisabled(); // nothing typed yet
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    cleanup();

    mount(<DraftTray api={api} draft={refused} />);
    expect(screen.getByTestId("draft-tray-line")).toHaveTextContent("Your duo refused this one.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("#142 — Send, Edit and Dismiss decide it, exactly as they did in Review", () => {
  it("Send posts \"sent\"; Edit then Send edited posts the owner's words; an unchanged edit is a plain Send", async () => {
    mount(<DraftTray api={api} draft={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posted()).toEqual([{ url: "http://test/drafts/d1/outcome", body: { outcome: "sent" } }]));
    cleanup();

    vi.mocked(fetch).mockClear();
    mount(<DraftTray api={api} draft={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit your duo's draft" }), { target: { value: "Ask in #platform-help." } });
    fireEvent.click(screen.getByRole("button", { name: "Send edited" }));
    await waitFor(() => expect(posted()[0]?.body).toEqual({ outcome: "edited", sentText: "Ask in #platform-help." }));
    cleanup();

    vi.mocked(fetch).mockClear();
    mount(<DraftTray api={api} draft={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posted()[0]?.body).toEqual({ outcome: "sent" }));
  });

  it("Dismiss holds the undo window, records nothing until it lapses, and Undo restores the actions", async () => {
    vi.useFakeTimers();
    mount(<DraftTray api={api} draft={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByTestId("ignore-window")).toHaveTextContent("Dismissing — not sent yet.");
    expect(posted()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(IGNORE_UNDO_WINDOW_MS + 100));
    expect(posted()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IGNORE_UNDO_WINDOW_MS + 100);
    });
    expect(posted()[0]?.body).toEqual({ outcome: "discarded" });
  });

  it("answering a passed-on question queues a standing-order candidate", async () => {
    mount(<DraftTray api={api} draft={passedOn} />);
    fireEvent.change(screen.getByRole("textbox", { name: /answer it yourself/i }), { target: { value: "No — use the change calendar." } });
    fireEvent.click(screen.getByRole("button", { name: "Answer it" }));
    await waitFor(() => expect(screen.getByTestId("answer-confirmation")).toHaveTextContent("Queued as a standing-order candidate."));
  });
});

describe("#142 — offline, decisions wait; they are never queued (AR-15)", () => {
  it("disables Send and Dismiss and says why, while the local editing buffer stays available", () => {
    sync.reachable = false;
    mount(<DraftTray api={api} draft={draft} />);
    expect(screen.getByTestId("draft-tray-offline")).toHaveTextContent("nothing can be decided right now");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled(); // an unchanged edit is a plain Send — still waiting
    expect(posted()).toEqual([]);
  });

  it("disables Answer it too", () => {
    sync.reachable = false;
    mount(<DraftTray api={api} draft={passedOn} />);
    fireEvent.change(screen.getByRole("textbox", { name: /answer it yourself/i }), { target: { value: "No." } });
    expect(screen.getByRole("button", { name: "Answer it" })).toBeDisabled();
  });
});

describe("#142 — the keyboard decides it, only when asked and only when nothing is being typed", () => {
  it("⏎ sends, E edits, X dismisses — with hints on the buttons", async () => {
    mount(<DraftTray api={api} draft={draft} keyboard />);
    expect(within(screen.getByRole("button", { name: "Send" })).getByText("⏎")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "e" });
    expect(screen.getByRole("textbox", { name: "Edit your duo's draft" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "x" });
    expect(screen.getByTestId("ignore-window")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(posted()[0]?.body).toEqual({ outcome: "sent" }));
  });

  it("does nothing without the flag, in a field, on a button, or with a modifier", () => {
    mount(<DraftTray api={api} draft={draft} />);
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "e" });
    expect(posted()).toEqual([]);
    expect(screen.queryByRole("textbox")).toBeNull();
    cleanup();

    mount(<DraftTray api={api} draft={draft} keyboard />);
    const field = document.createElement("textarea");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "x" });
    field.remove();
    fireEvent.keyDown(screen.getByRole("button", { name: "Dismiss" }), { key: "Enter" });
    fireEvent.keyDown(window, { key: "e", metaKey: true });
    expect(posted()).toEqual([]);
    expect(screen.queryByTestId("ignore-window")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("never fires on a refusal, and offline ⏎ sends nothing", () => {
    mount(<DraftTray api={api} draft={refused} keyboard />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(posted()).toEqual([]);
    cleanup();

    sync.reachable = false;
    mount(<DraftTray api={api} draft={draft} keyboard />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(posted()).toEqual([]);
  });
});
