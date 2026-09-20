import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { OutboxProvider, useOutbox, type OutboxMessage, type OutboxSender } from "../src/outbox.js";
import { QueuedMessages } from "../src/components/QueuedMessages.js";
import { SyncStatusProvider, useSyncStatus, type SyncTarget } from "../src/sync.js";
import { OfflineBar } from "../src/components/OfflineBar.js";
import { DraftCard } from "../src/components/DraftCard.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord } from "../src/api/types.js";

/*
 * #61: two rules for two different objects. Ordinary messages queue and
 * deliver on reconnect — that is simply what a messaging app does. Drafts
 * and duo actions (Send / Edit / Ignore / escalation answer / rule
 * disposition / anything irreversible) are disabled, never queued — a Send
 * firing hours later against moved context is worse than no Send (AR-15,
 * now scoped by digital-duo#193). These tests assert each rule, and one
 * test asserts both at once, so the split can't silently collapse.
 *
 * The workspace has no message surface in the app yet (that layer is
 * post-#185), so delivery runs against an injected sender and reachability
 * against the same meta-labelled workspace queries the real layer will
 * send — contract-first, exactly like test/SyncStatus.test.tsx.
 */

/**
 * A workspace-labelled probe the test flips between healthy and
 * network-dead, the same mid-session transition a train ride produces.
 * `probeState.fail` is read at call time so flipping it + invalidating is
 * enough to move health.
 */
const probeState: Record<SyncTarget, { fail: boolean; calls: number }> = {
  workspace: { fail: false, calls: 0 },
  daemon: { fail: false, calls: 0 },
};
function Probe({ target }: { target: SyncTarget }) {
  const query = useQuery({
    queryKey: ["probe", target],
    queryFn: () => {
      const state = probeState[target];
      state.calls += 1;
      if (state.calls > 1 && state.fail) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return Promise.resolve(`synced-${target}`);
    },
    retry: false,
    meta: { target },
  });
  return <div data-testid={`probe-${target}`}>{query.data ? "synced" : "syncing"}</div>;
}

function HealthReader() {
  const workspace = useSyncStatus("workspace");
  const daemon = useSyncStatus("daemon");
  return (
    <div data-testid="health-reader">
      workspace:{workspace.reachable ? "reachable" : "unreachable"}|daemon:{daemon.reachable ? "reachable" : "unreachable"}
    </div>
  );
}

/** Types a message the way the future conversation composer will. */
function SendBox({ text }: { text: string }) {
  const { send } = useOutbox();
  return (
    <button data-testid="send-box" onClick={() => send(text)}>
      send
    </button>
  );
}

function renderOutbox(nodes: ReactNode, sender: OutboxSender) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <SyncStatusProvider>
        <OutboxProvider sender={sender}>
          {nodes}
          <QueuedMessages />
          <OfflineBar />
          <HealthReader />
        </OutboxProvider>
      </SyncStatusProvider>
    </QueryClientProvider>,
  );
  return { client, ...utils };
}

/** Takes both probes through mount → offline, so messages enqueue against an unreachable workspace. */
async function goOffline(client: QueryClient, target: SyncTarget) {
  await waitFor(() => expect(screen.getByTestId(`probe-${target}`)).toHaveTextContent("synced"));
  probeState[target].fail = true;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["probe", target] });
  });
  await waitFor(() =>
    expect(screen.getByTestId("health-reader")).toHaveTextContent(`${target}:unreachable`),
  );
}

async function goOnline(client: QueryClient, target: SyncTarget) {
  probeState[target].fail = false;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["probe", target] });
  });
  await waitFor(() => expect(screen.getByTestId("health-reader")).toHaveTextContent(`${target}:reachable`));
}

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

const draft: DraftRecord = {
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
};

describe("#61 — messages queue and deliver; drafts and duo actions do not", () => {
  beforeEach(() => {
    probeState.workspace = { fail: false, calls: 0 };
    probeState.daemon = { fail: false, calls: 0 };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("a message sent while the workspace is unreachable is held as pending, not refused", async () => {
    const sender = vi.fn(async () => {});
    const { client } = renderOutbox(
      <>
        <Probe target="workspace" />
        <SendBox text="on the train" />
      </>,
      sender,
    );
    await goOffline(client, "workspace");

    fireEvent.click(screen.getByTestId("send-box"));
    const queued = await screen.findByTestId("queued-message");
    expect(queued).toHaveTextContent("on the train");
    expect(queued).toHaveAttribute("data-state", "pending");
    expect(screen.getByTestId("queued-pending")).toHaveTextContent("Sending when the workspace is back");
    // Held, not attempted — nothing fires while there is nobody to receive it.
    expect(sender).not.toHaveBeenCalled();
  });

  it("queued messages deliver on reconnect, in order", async () => {
    const sent: string[] = [];
    const sender = vi.fn(async (message: OutboxMessage) => {
      sent.push(message.text);
    });
    const { client } = renderOutbox(
      <>
        <Probe target="workspace" />
        <SendBox text="first" />
        <SendBox text="second" />
      </>,
      sender,
    );
    await goOffline(client, "workspace");
    fireEvent.click(screen.getAllByTestId("send-box")[0]);
    // A second message queues behind the first — the order they were typed.
    fireEvent.click(screen.getAllByTestId("send-box")[1]);
    expect(screen.getAllByTestId("queued-message")).toHaveLength(2);

    await goOnline(client, "workspace");
    await waitFor(() => expect(screen.queryByTestId("queued-message")).toBeNull());
    expect(sent).toEqual(["first", "second"]);
  });

  it("a message sent while reachable delivers immediately", async () => {
    const sender = vi.fn(async () => {});
    renderOutbox(
      <>
        <Probe target="workspace" />
        <SendBox text="quick one" />
      </>,
      sender,
    );
    await waitFor(() => expect(screen.getByTestId("health-reader")).toHaveTextContent("workspace:reachable"));
    fireEvent.click(screen.getByTestId("send-box"));
    await waitFor(() => expect(sender).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("queued-message")).toBeNull();
  });

  it("a failed delivery tells the owner, keeps the text, and retries only by choice", async () => {
    const sent: string[] = [];
    let failFirst = true;
    const sender = vi.fn(async (message: OutboxMessage) => {
      if (failFirst) {
        throw new Error("the workspace answered 503");
      }
      sent.push(message.text);
    });
    const { client } = renderOutbox(
      <>
        <Probe target="workspace" />
        <SendBox text="please survive" />
      </>,
      sender,
    );
    await goOffline(client, "workspace");
    fireEvent.click(screen.getByTestId("send-box"));
    await goOnline(client, "workspace");

    const failed = await screen.findByTestId("queued-message");
    expect(failed).toHaveAttribute("data-state", "failed");
    expect(screen.getByTestId("queued-error")).toHaveTextContent("the workspace answered 503");
    expect(failed).toHaveTextContent("please survive"); // the text is not lost
    expect(sender).toHaveBeenCalledTimes(1);
    // No automatic retry — it stays failed until the owner chooses.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sender).toHaveBeenCalledTimes(1);

    failFirst = false;
    fireEvent.click(screen.getByTestId("queued-retry"));
    await waitFor(() => expect(screen.queryByTestId("queued-message")).toBeNull());
    expect(sent).toEqual(["please survive"]);
  });

  it("a failed message blocks the ones behind it — in order means in order", async () => {
    const sent: string[] = [];
    const sender = vi.fn(async (message: OutboxMessage) => {
      if (message.text === "first") {
        throw new Error("head of line failed");
      }
      sent.push(message.text);
    });
    const { client } = renderOutbox(
      <>
        <Probe target="workspace" />
        <SendBox text="first" />
        <SendBox text="second" />
      </>,
      sender,
    );
    await goOffline(client, "workspace");
    fireEvent.click(screen.getAllByTestId("send-box")[0]);
    fireEvent.click(screen.getAllByTestId("send-box")[1]);
    await goOnline(client, "workspace");

    const messages = await screen.findAllByTestId("queued-message");
    expect(messages[0]).toHaveAttribute("data-state", "failed");
    // The second message was never attempted — it waits behind the failure.
    expect(sender).toHaveBeenCalledTimes(1);
    expect(messages[1]).toHaveAttribute("data-state", "pending");
  });

  it("a queued message survives a reload — held locally, on the device", async () => {
    const sender = vi.fn(async () => {});
    const { client, unmount } = renderOutbox(
      <>
        <Probe target="workspace" />
        <SendBox text="still here" />
      </>,
      sender,
    );
    await goOffline(client, "workspace");
    fireEvent.click(screen.getByTestId("send-box"));
    expect(await screen.findByTestId("queued-message")).toHaveTextContent("still here");

    unmount();
    // A fresh provider — the next launch of the app — reads the same outbox.
    // The fresh workspace probe syncs on mount, so this launch is online and
    // tries to deliver; a sender that still fails proves the message itself
    // was on the device all along, not just in the dead session's memory.
    const stubbornSender = vi.fn(async () => {
      throw new Error("no route to the workspace");
    });
    renderOutbox(
      <>
        <Probe target="workspace" />
      </>,
      stubbornSender,
    );
    const revived = await screen.findByTestId("queued-message");
    expect(revived).toHaveTextContent("still here");
    expect(revived).toHaveAttribute("data-state", "failed");
    expect(stubbornSender).toHaveBeenCalledTimes(1);
  });

  it("the split, in one render: the same outage queues a message and disables a duo action", async () => {
    vi.stubGlobal("fetch", vi.fn()); // no mutation is fired in this test; the stub is belt-and-braces
    const sender = vi.fn(async () => {});
    const { client } = renderOutbox(
      <>
        <Probe target="workspace" />
        <Probe target="daemon" />
        <SendBox text="queued, not refused" />
        <DraftCard api={api} draft={draft} />
      </>,
      sender,
    );
    await goOffline(client, "workspace");
    await goOffline(client, "daemon");

    // The message: held locally, shown pending, sender untouched.
    fireEvent.click(screen.getByTestId("send-box"));
    expect(await screen.findByTestId("queued-message")).toHaveAttribute("data-state", "pending");
    expect(sender).not.toHaveBeenCalled();
    // The duo actions on the very same screen: disabled, never queued (AR-15).
    expect((screen.getByText("Send", { selector: "button" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Ignore", { selector: "button" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
