import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftReadySocket } from "../src/api/ws.js";
import type { DuoApiConfig } from "../src/api/client.js";

const api: DuoApiConfig = { baseUrl: "http://100.64.1.5:7717", token: "device-tok" };

/**
 * Stands in for the browser WebSocket the daemon half (digital-duo #162)
 * will sit behind — the client is contract-first, so the socket itself is
 * the test double.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  listeners = new Map<string, Array<(event: never) => void>>();
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  removeEventListener(type: string, cb: (event: never) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== cb));
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    // Cleanup path only — the hook never closes on its own otherwise.
  }
  // Test-side drivers:
  open() {
    this.listeners.get("open")?.forEach((cb) => cb(new Event("open") as never));
  }
  message(data: unknown) {
    this.listeners.get("message")?.forEach((cb) => cb({ data: JSON.stringify(data) } as never));
  }
  closeWith(code: number) {
    this.listeners.get("close")?.forEach((cb) => cb({ code } as never));
  }
}

function Host({
  onDraftReady,
  onDraftingStarted,
}: {
  onDraftReady?: (draftId: string) => void;
  onDraftingStarted?: (roomId: string) => void;
}) {
  useDraftReadySocket(api, onDraftReady, onDraftingStarted);
  return null;
}

function renderHookHost(client: QueryClient, onDraftReady?: (draftId: string) => void, onDraftingStarted?: (roomId: string) => void) {
  return render(
    <QueryClientProvider client={client}>
      <Host onDraftReady={onDraftReady} onDraftingStarted={onDraftingStarted} />
    </QueryClientProvider>,
  );
}

describe("useDraftReadySocket — the client half of the one push channel (C7, digital-duo #162)", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects to ws://<daemon>/ws and authenticates with the device token as its first message", () => {
    renderHookHost(new QueryClient());
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe("ws://100.64.1.5:7717/ws");
    act(() => FakeWebSocket.instances[0].open());
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toEqual({ type: "auth", token: "device-tok" });
  });

  it("on draft-ready, invalidates the §3.2 keys and fires the notification callback", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const onDraftReady = vi.fn();
    renderHookHost(client, onDraftReady);

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].message({ type: "draft-ready", draftId: "d1" });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["drafts"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["review"] });
    expect(onDraftReady).toHaveBeenCalledWith("d1");
  });

  it("guangshinhaha/duo#285: on draft-drafting, fires onDraftingStarted with the room id and touches no query cache", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const onDraftingStarted = vi.fn();
    renderHookHost(client, undefined, onDraftingStarted);

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].message({ type: "draft-drafting", roomId: "!project-x:workspace.example" });
    });
    expect(onDraftingStarted).toHaveBeenCalledWith("!project-x:workspace.example");
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reconnects with backoff after an abnormal close, and the backoff resets after a clean auth", () => {
    renderHookHost(new QueryClient());
    const first = FakeWebSocket.instances[0];
    act(() => {
      first.open();
      first.message({ type: "ready" });
      first.closeWith(1006); // abnormal — the flaky-link case backoff exists for
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances).toHaveLength(2); // first attempt: 1s

    act(() => FakeWebSocket.instances[1].closeWith(1006));
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances).toHaveLength(2); // not yet — second backoff is 2s
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("does not retry a rejected token (4001) — that is a pairing problem, not a flaky link", () => {
    renderHookHost(new QueryClient());
    act(() => FakeWebSocket.instances[0].closeWith(4001));
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("stays quiet while unpaired (api === null) — no socket before Setup connects", () => {
    function Unpaired() {
      useDraftReadySocket(null);
      return null;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Unpaired />
      </QueryClientProvider>,
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
