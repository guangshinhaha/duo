import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncStatusProvider, useSyncStatus, type SyncTarget } from "../src/sync.js";
import { OfflineBar } from "../src/components/OfflineBar.js";
import { DraftCard } from "../src/components/DraftCard.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord } from "../src/api/types.js";

/*
 * #58: two connections, two health states. The workspace (messaging, always
 * up) and the owner's duo daemon (asleep whenever the Mac is) fail for
 * unrelated reasons, and one boolean for both was wrong in both directions.
 * The probes below label their queries with `meta.target` exactly the way
 * the workspace layer will when its queries exist — no workspace query is in
 * the app yet, so the probe *is* that contract, asserted against the same
 * provider the real queries run under.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

/**
 * A query whose refetch the test controls: first call succeeds (so there is
 * a lastSyncedAt and something cached), and only a refetch of a probe given
 * a `failRefetch` error fails — matching reality, where a server goes quiet
 * mid-session rather than before the first sync.
 */
const probeCalls = new Map<SyncTarget, number>();
function Probe({ target, failRefetch }: { target: SyncTarget; failRefetch?: Error }) {
  const query = useQuery({
    queryKey: ["probe", target],
    queryFn: () => {
      const n = (probeCalls.get(target) ?? 0) + 1;
      probeCalls.set(target, n);
      if (n === 1 || !failRefetch) {
        return Promise.resolve(`synced-${target}`);
      }
      return Promise.reject(failRefetch);
    },
    retry: false,
    meta: { target },
  });
  return <div data-testid={`probe-${target}`}>{String(query.data)}</div>;
}

function StatusReader() {
  // The no-arg call is the shape every AR-15 consumer uses (DraftCard,
  // Composer, RuleCard) — it must keep meaning "the daemon".
  const daemon = useSyncStatus();
  const workspace = useSyncStatus("workspace");
  const label = (health: { reachable: boolean; lastSyncedAt: number | null }) =>
    `${health.reachable ? "reachable" : "unreachable"}|${health.lastSyncedAt === null ? "never" : "synced"}`;
  return (
    <div data-testid="status-reader">
      daemon:{label(daemon)}|workspace:{label(workspace)}
    </div>
  );
}

function renderSync(probes: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <SyncStatusProvider>
        {probes}
        <StatusReader />
        <OfflineBar />
      </SyncStatusProvider>
    </QueryClientProvider>,
  );
  return { client, ...utils };
}

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
  provenance: { origin: "unknown" },
};

describe("#58 — two connections, two health states", () => {
  beforeEach(() => {
    probeCalls.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a daemon network failure is tracked alone — the workspace keeps syncing", async () => {
    const { client } = renderSync(
      <>
        <Probe target="daemon" failRefetch={new TypeError("fetch failed")} />
        <Probe target="workspace" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-daemon")).toHaveTextContent("synced-daemon"));

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "daemon"] });
    });
    // The daemon's TypeError wrote only the daemon's half — the workspace,
    // which synced on mount, is untouched.
    expect(screen.getByTestId("status-reader")).toHaveTextContent("daemon:unreachable|synced|workspace:reachable|synced");

    // The workspace's own next sync updates only its half — the daemon's
    // unreachable state survives a healthy workspace, and vice versa.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "workspace"] });
    });
    expect(screen.getByTestId("status-reader")).toHaveTextContent("daemon:unreachable|synced|workspace:reachable|synced");
    expect(screen.getByTestId("probe-workspace")).toHaveTextContent("synced-workspace");
  });

  it("a workspace network failure is tracked alone — the daemon keeps syncing", async () => {
    vi.stubGlobal("fetch", vi.fn()); // no mutation is fired in this test; the stub is belt-and-braces
    const { client } = renderSync(
      <>
        <Probe target="workspace" failRefetch={new TypeError("fetch failed")} />
        <Probe target="daemon" />
        <DraftCard api={api} draft={draft} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-workspace")).toHaveTextContent("synced-workspace"));

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "workspace"] });
    });
    expect(screen.getByTestId("status-reader")).toHaveTextContent("daemon:reachable|synced|workspace:unreachable|synced");

    // AC2's other direction: the workspace being down must not touch
    // duo-dependent controls — only a daemon outage disables those.
    expect((screen.getByText("Send", { selector: "button" }) as HTMLButtonElement).disabled).toBe(false);

    // And the daemon's own next sync updates only its half.
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "daemon"] });
    });
    expect(screen.getByTestId("status-reader")).toHaveTextContent("daemon:reachable|synced|workspace:unreachable|synced");
    expect(screen.getByTestId("probe-daemon")).toHaveTextContent("synced-daemon");
  });

  it("only duo-dependent controls feel a daemon outage — the workspace surface keeps working", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { client } = renderSync(
      <>
        <Probe target="daemon" failRefetch={new TypeError("fetch failed")} />
        <Probe target="workspace" />
        <DraftCard api={api} draft={draft} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-daemon")).toHaveTextContent("synced-daemon"));

    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "daemon"] });
    });
    // AR-15: duo actions are disabled, not queued, while the daemon is quiet.
    expect((screen.getByText("Send", { selector: "button" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Ignore", { selector: "button" }) as HTMLButtonElement).disabled).toBe(true);

    // The workspace surface keeps working through the daemon outage…
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "workspace"] });
    });
    expect(screen.getByTestId("probe-workspace")).toHaveTextContent("synced-workspace");
    // …and its successful sync must NOT re-enable the duo controls — they
    // bind the daemon's health, not the app's global mood.
    expect((screen.getByText("Send", { selector: "button" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the daemon line names the duo and its last-seen time", async () => {
    const { client } = renderSync(<Probe target="daemon" failRefetch={new TypeError("fetch failed")} />);
    await waitFor(() => expect(screen.getByTestId("probe-daemon")).toHaveTextContent("synced-daemon"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "daemon"] });
    });

    expect(screen.getByTestId("offline-bar-daemon")).toHaveTextContent("Your duo is asleep");
    expect(screen.getByTestId("offline-bar-daemon")).toHaveTextContent("Last seen");
    // Names which: the workspace, which is fine, says nothing.
    expect(screen.queryByTestId("offline-bar-workspace")).toBeNull();
  });

  it("the workspace line names the workspace and its last successful sync", async () => {
    const { client } = renderSync(<Probe target="workspace" failRefetch={new TypeError("fetch failed")} />);
    await waitFor(() => expect(screen.getByTestId("probe-workspace")).toHaveTextContent("synced-workspace"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "workspace"] });
    });

    expect(screen.getByTestId("offline-bar-workspace")).toHaveTextContent("The workspace is unreachable.");
    expect(screen.getByTestId("offline-bar-workspace")).toHaveTextContent("Last synced");
    expect(screen.queryByTestId("offline-bar-daemon")).toBeNull();
  });

  it("a sleeping daemon is an expected state, not an error — a down workspace is", async () => {
    const { client } = renderSync(
      <>
        <Probe target="workspace" failRefetch={new TypeError("fetch failed")} />
        <Probe target="daemon" failRefetch={new TypeError("fetch failed")} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-daemon")).toHaveTextContent("synced-daemon"));
    await waitFor(() => expect(screen.getByTestId("probe-workspace")).toHaveTextContent("synced-workspace"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "workspace"] });
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "daemon"] });
    });

    // The daemon's Mac being shut is the expected case — muted, no alarm colour.
    const daemonLine = screen.getByTestId("offline-bar-daemon");
    expect(daemonLine.className).toContain("text-[var(--muted)]");
    expect(daemonLine.className).not.toContain("escalate");
    // The workspace is expected to be up — its line is the app's error voice.
    const workspaceLine = screen.getByTestId("offline-bar-workspace");
    expect(workspaceLine.className).toContain("text-[var(--escalate)]");
  });

  it("a successful sync of both renders no bar at all", async () => {
    renderSync(
      <>
        <Probe target="daemon" />
        <Probe target="workspace" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("status-reader")).toHaveTextContent("daemon:reachable|synced"));
    expect(screen.getByTestId("status-reader")).toHaveTextContent("workspace:reachable|synced");
    expect(screen.queryByTestId("offline-bar")).toBeNull();
  });

  it("an HTTP error is NOT unreachability — that server answered, it just errored", async () => {
    const { client } = renderSync(
      <>
        <Probe target="daemon" failRefetch={new Error("Request failed with status 500")} />
        <Probe target="workspace" failRefetch={new Error("Request failed with status 502")} />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("probe-daemon")).toHaveTextContent("synced-daemon"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "daemon"] });
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe", "workspace"] });
    });
    expect(screen.getByTestId("status-reader")).toHaveTextContent("daemon:reachable|synced|workspace:reachable|synced");
    expect(screen.queryByTestId("offline-bar")).toBeNull();
  });
});
