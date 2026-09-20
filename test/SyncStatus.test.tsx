import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncStatusProvider, useSyncStatus } from "../src/sync.js";
import { OfflineBar } from "../src/components/OfflineBar.js";
import { DraftCard } from "../src/components/DraftCard.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord } from "../src/api/types.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

/**
 * A query whose nth call the test controls: first call succeeds (so there
 * is a lastSyncedAt and something cached), and the *refetch* is where the
 * offline transition is exercised — matching reality, where the daemon
 * goes quiet mid-session rather than before the first sync.
 */
let probeCalls = 0;
function Probe({ failRefetchWith }: { failRefetchWith: Error }) {
  const query = useQuery({
    queryKey: ["probe"],
    queryFn: () => {
      if (probeCalls++ === 0) {
        return Promise.resolve("synced-value");
      }
      return Promise.reject(failRefetchWith);
    },
    retry: false,
  });
  return <div data-testid="probe">{String(query.data)}</div>;
}

function StatusReader() {
  const { reachable, lastSyncedAt } = useSyncStatus();
  return <div data-testid="status-reader">{reachable ? "reachable" : "unreachable"}|{lastSyncedAt === null ? "never" : "synced"}</div>;
}

function renderOffline(failRefetchWith: Error) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <SyncStatusProvider>
        <Probe failRefetchWith={failRefetchWith} />
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
};

describe("SyncStatus — §3.3 offline: the honest bar, and mutations disabled not queued (AR-15)", () => {
  beforeEach(() => {
    probeCalls = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a successful sync marks the daemon reachable and renders no bar", async () => {
    renderOffline(new TypeError("never thrown in this test"));
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("synced-value"));
    expect(screen.getByTestId("status-reader")).toHaveTextContent("reachable|synced");
    expect(screen.queryByTestId("offline-bar")).toBeNull();
  });

  it("a network-level failure flips to unreachable and shows the bar verbatim", async () => {
    const { client } = renderOffline(new TypeError("fetch failed"));
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("synced-value"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe"] });
    });
    expect(screen.getByTestId("status-reader")).toHaveTextContent("unreachable|synced");
    expect(screen.getByTestId("offline-bar")).toHaveTextContent("Last synced");
    expect(screen.getByTestId("offline-bar")).toHaveTextContent("Your Mac is unreachable.");
    // The cached view still renders underneath the bar — that is the whole point.
    expect(screen.getByTestId("probe")).toHaveTextContent("synced-value");
  });

  it("an HTTP error is NOT unreachable — the daemon answered, it just errored", async () => {
    const { client } = renderOffline(new Error("Request failed with status 500"));
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("synced-value"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe"] });
    });
    expect(screen.getByTestId("status-reader")).toHaveTextContent("reachable|synced");
    expect(screen.queryByTestId("offline-bar")).toBeNull();
  });

  it("disables every mutation control while unreachable (AR-15: disabled, not queued)", async () => {
    vi.stubGlobal("fetch", vi.fn()); // no mutation is fired in this test; the stub is belt-and-braces
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SyncStatusProvider>
          <Probe failRefetchWith={new TypeError("fetch failed")} />
          <DraftCard api={api} draft={draft} />
        </SyncStatusProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("synced-value"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["probe"] });
    });
    expect((screen.getByText("Send", { selector: "button" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Ignore", { selector: "button" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
