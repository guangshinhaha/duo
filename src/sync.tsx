import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Sync status (client-tech-design.md §3.3): *is the daemon answering right
 * now*, and when did it last answer? The honest signal is the query cache
 * itself — every successful fetch is a "synced" moment; a fetch that dies
 * with a network-level `TypeError` (connection refused / unreachable —
 * `fetch`'s own failure mode, not an HTTP status) is "unreachable". An
 * `ApiRequestError` is deliberately NOT unreachable: a daemon that answers
 * with a 500 was reached, and lying "Your Mac is unreachable" at it would
 * be a worse lie than no bar at all.
 */
export interface SyncStatus {
  /** False only after a query failed at the network level. */
  reachable: boolean;
  /** Epoch ms of the last successful query response — null before the first sync. */
  lastSyncedAt: number | null;
}

/** Default when no provider is mounted: components stay usable standalone (tests, storybook-shaped use). */
const defaultStatus: SyncStatus = { reachable: true, lastSyncedAt: null };

const SyncStatusContext = createContext<SyncStatus>(defaultStatus);

export function useSyncStatus(): SyncStatus {
  return useContext(SyncStatusContext);
}

export function SyncStatusProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SyncStatus>(defaultStatus);

  useEffect(() => {
    // One subscription to the whole cache: `event.type === "updated"` fires
    // on every state transition of any query, and `action.type === "success"`
    // / `"error"` name the two transitions that matter here.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") {
        return;
      }
      if (event.action.type === "success") {
        setStatus({ reachable: true, lastSyncedAt: Date.now() });
        return;
      }
      if (event.action.type === "error") {
        // Network-level failure only — see the doc comment above.
        if (event.action.error instanceof TypeError) {
          setStatus((prev) => ({ ...prev, reachable: false }));
        }
      }
    });
    return unsubscribe;
  }, [queryClient]);

  return <SyncStatusContext.Provider value={status}>{children}</SyncStatusContext.Provider>;
}
