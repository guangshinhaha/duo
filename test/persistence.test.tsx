import { QueryClient, useQuery } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CACHE_KEY = "duo-cache-persistence-test";

/**
 * §3.3: "The query cache persists to storage and rehydrates at launch." A
 * launch is a mount with an empty QueryClient; the proof is that the
 * second mount renders cached data *while its queryFn is still pending* —
 * nothing but the persisted cache could be showing it.
 */
function Probe({ queryFn }: { queryFn: () => Promise<string> }) {
  const query = useQuery({ queryKey: ["probe"], queryFn });
  return <div data-testid="probe">{String(query.data)}</div>;
}

function mount(queryFn: () => Promise<string>) {
  // A fresh client + fresh provider per call: each mount is its own
  // "launch," sharing only the localStorage-backed persister.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const persister = createSyncStoragePersister({ storage: localStorage, key: CACHE_KEY });
  return render(
    <PersistQueryClientProvider client={client} persistOptions={{ persister }}>
      <Probe queryFn={queryFn} />
    </PersistQueryClientProvider>,
  );
}

describe("Cache persistence (§3.3) — cached views render at relaunch", () => {
  beforeEach(() => {
    localStorage.removeItem(CACHE_KEY);
  });
  afterEach(() => {
    localStorage.removeItem(CACHE_KEY);
  });

  it("rehydrates the previous session's data while the first fetch of the new session is still in flight", async () => {
    // Session 1: a normal fetch populates and persists the cache. The
    // persister throttles its writes (1s by default), so "the cache is in
    // data" is not yet "the cache is in storage" — wait for the write
    // itself, not just the render, before relaunching.
    const session1 = mount(async () => "synced-value");
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("synced-value"));
    await vi.waitFor(() => expect(localStorage.getItem(CACHE_KEY)).toContain("synced-value"), { timeout: 3000 });
    session1.unmount();

    // Session 2 ("relaunch"): the daemon never answers — yet the view renders.
    mount(() => new Promise<string>(() => {}));
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("synced-value"));
  });

  it("an emptied cache (Forget this device clears it) shows nothing stale at relaunch", async () => {
    const session1 = mount(async () => "synced-value");
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("synced-value"));
    session1.unmount();
    localStorage.removeItem(CACHE_KEY);

    mount(() => new Promise<string>(() => {}));
    // `query.data` is undefined, so the probe renders the string
    // "undefined" — the claim under test is that nothing *stale* appears.
    expect(screen.getByTestId("probe")).not.toHaveTextContent("synced-value");
  });
});
