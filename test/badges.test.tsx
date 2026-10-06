import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { setDockBadgeCount } from "../src/dockBadge.js";
import type { DraftRecord } from "../src/api/types.js";
import { stubDesktop } from "./desktop.js";
import { inTauriShell, leaveTauriShell } from "./platformFakes.js";

/*
 * #22: the pending-draft count in two places — the chat list's "Waiting on
 * you" chip (§3.1: "badge = drafts where outcome is null", plus staged
 * confirmations) and the macOS dock badge
 * via Tauri's window API, which feature-detects and no-ops in a plain
 * browser tab exactly as src/notifications.ts does. Both follow the push
 * channel: a draft-ready push invalidates ["drafts"], the pending list
 * refetches, and the badges move without a manual refresh.
 */

const dock = vi.hoisted(() => ({ setBadgeCount: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setBadgeCount: dock.setBadgeCount }),
}));

/*
 * #320: these cases are the Mac app — mark the test DOM as a Tauri webview so
 * getPlatform() picks the Tauri adapter over the module mocks above.
 */
beforeEach(() => inTauriShell());
afterEach(() => leaveTauriShell());

const baseDraft: DraftRecord = {
  id: "d1",
  question: "What's our refund policy?",
  threadContext: null,
  draftText: "Refunds within 30 days.",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.8,
  sources: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.6,
  provenance: { origin: "unknown" },
  delivery: null,
};

function pendingDrafts(count: number): DraftRecord[] {
  return Array.from({ length: count }, (_, i) => ({ ...baseDraft, id: `d${i + 1}` }));
}

/**
 * A controllable fetch: drafts lists answer per `pendingNow`, everything
 * else 200-empty — the App-level tests drive the count by flipping the
 * variable, the way the daemon's answer changes between refetches.
 */
function mountApp(pendingNow: () => number, hash = "#duo") {
  stubDesktop();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/actions/t4/pending")
        ? new Response("[]", { status: 200 })
        : new Response(JSON.stringify(pendingDrafts(pendingNow())), { status: 200 }),
    ),
  );
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
  return render(<App />);
}

/** Stands in for the browser WebSocket the same way test/ws.test.tsx's does. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners = new Map<string, Array<(event: never) => void>>();
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  removeEventListener() {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  open() {
    this.listeners.get("open")?.forEach((cb) => cb(new Event("open") as never));
  }
  message(data: unknown) {
    this.listeners.get("message")?.forEach((cb) => cb({ data: JSON.stringify(data) } as never));
  }
}

describe("#22 — pending count in the chat list and the dock", () => {
  beforeEach(() => {
    dock.setBadgeCount.mockClear();
    FakeWebSocket.instances = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    window.location.hash = "";
  });

  it("the Waiting on you chip shows the count on any route, and nothing at all at zero", async () => {
    let pending = 2;
    const { unmount } = mountApp(() => pending, "#duo");
    await waitFor(() => expect(screen.getByTestId("waiting-badge")).toHaveTextContent("2"));

    // The count falls to zero on the next read of the list — here driven as
    // a relaunch (the in-session push path is the test below).
    pending = 0;
    unmount();
    mountApp(() => pending, "#duo");
    await waitFor(() => expect(screen.queryByTestId("waiting-badge")).toBeNull());
  });

  it("the dock badge mirrors the count and clears at zero", async () => {
    let pending = 3;
    const { unmount } = mountApp(() => pending, "#trust");
    await waitFor(() => expect(screen.getByTestId("waiting-badge")).toHaveTextContent("3"));
    await waitFor(() => expect(dock.setBadgeCount).toHaveBeenLastCalledWith(3));

    pending = 0;
    unmount();
    // Clear so the clearing read is the only call left to observe.
    dock.setBadgeCount.mockClear();
    mountApp(() => pending, "#trust");
    // The seam turns zero into `undefined` — "nothing waiting", not "zero".
    await waitFor(() => expect(dock.setBadgeCount).toHaveBeenLastCalledWith(undefined));
  });

  it("a draft-ready push moves both badges without a manual refresh", async () => {
    let pending = 1;
    // Stubbed before mount so the socket effect sees it on first render.
    vi.stubGlobal("WebSocket", FakeWebSocket);
    mountApp(() => pending, "#duo");
    await waitFor(() => expect(screen.getByTestId("waiting-badge")).toHaveTextContent("1"));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    act(() => FakeWebSocket.instances[FakeWebSocket.instances.length - 1].open());

    pending = 4;
    act(() => FakeWebSocket.instances[FakeWebSocket.instances.length - 1].message({ type: "draft-ready", draftId: "d-new" }));
    // No hashchange, no remount — the invalidation alone moves both badges.
    await waitFor(() => expect(screen.getByTestId("waiting-badge")).toHaveTextContent("4"));
    await waitFor(() => expect(dock.setBadgeCount).toHaveBeenLastCalledWith(4));
  });

  it("in a plain browser tab the dock call degrades quietly and the list still updates", async () => {
    dock.setBadgeCount.mockRejectedValue(new Error("no Tauri IPC in a browser tab"));
    mountApp(() => 2, "#duo");
    await waitFor(() => expect(screen.getByTestId("waiting-badge")).toHaveTextContent("2"));
    // setDockBadgeCount swallowed the rejection — the surface is unaffected.
    expect(dock.setBadgeCount).toHaveBeenCalled();
  });

  it("unpairing clears the dock — a stale count never outlives its pairing", async () => {
    mountApp(() => 2, "#duo");
    await waitFor(() => expect(dock.setBadgeCount).toHaveBeenLastCalledWith(2));

    fireEvent.click(screen.getByText("Forget this device"));
    // The unmount cleanup runs the seam, which renders zero as `undefined`.
    await waitFor(() => expect(dock.setBadgeCount).toHaveBeenLastCalledWith(undefined));
    expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toBeNull();
  });
});

describe("setDockBadgeCount — the feature-detecting seam", () => {
  it("passes the count through, and undefined to clear", async () => {
    await setDockBadgeCount(5);
    expect(dock.setBadgeCount).toHaveBeenLastCalledWith(5);
    await setDockBadgeCount(0);
    expect(dock.setBadgeCount).toHaveBeenLastCalledWith(undefined);
  });

  it("never throws when the shell is absent — the browser tab case", async () => {
    dock.setBadgeCount.mockRejectedValueOnce(new Error("no Tauri IPC"));
    await expect(setDockBadgeCount(7)).resolves.toBeUndefined();
  });
});
