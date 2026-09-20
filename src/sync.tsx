import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Sync status (#58, refining client-tech-design.md §3.3): the client talks
 * to two servers whose failure modes are unrelated — an org-hosted
 * workspace (messaging, up independently of any one person's hardware) and
 * this owner's duo daemon (asleep whenever the Mac is). One boolean for
 * both was wrong in both directions: a shut laptop read as an outage, and
 * a workspace outage would have read as the duo's fault. Health is tracked
 * per target, and no event on one target ever writes the other's half.
 *
 * The honest signal is the query cache itself — every successful fetch is a
 * "synced" moment for the target it talked to; a fetch that dies with a
 * network-level `TypeError` (connection refused / unreachable — `fetch`'s
 * own failure mode, not an HTTP status) is that target going quiet. An
 * `ApiRequestError` is deliberately NOT unreachability: a server that
 * answers with a 500 (or a 401 — see api/revocation.ts) was reached.
 */
export type SyncTarget = "workspace" | "daemon";

export interface TargetHealth {
  /** False only after a query to this target failed at the network level. */
  reachable: boolean;
  /** Epoch ms of this target's last successful response — null before its first sync. */
  lastSyncedAt: number | null;
}

export interface SyncStatus {
  workspace: TargetHealth;
  daemon: TargetHealth;
}

/** Default when no provider is mounted: components stay usable standalone (tests, storybook-shaped use). */
const defaultStatus: SyncStatus = {
  workspace: { reachable: true, lastSyncedAt: null },
  daemon: { reachable: true, lastSyncedAt: null },
};

const SyncStatusContext = createContext<SyncStatus>(defaultStatus);

/**
 * Health of one target. The no-arg call means `"daemon"` — every current
 * caller (DraftCard, Composer, RuleCard) gates a duo action, and AR-15
 * keeps those actions disabled while *the daemon* specifically is quiet.
 */
export function useSyncStatus(target: SyncTarget = "daemon"): TargetHealth {
  return useContext(SyncStatusContext)[target];
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
      // Which server this query talks to, from the query's own `meta`. No
      // query in the app talks to anything but the owner's daemon today, so
      // an absent label means daemon — the workspace layer will label its
      // queries, and until then only the probes in test/SyncStatus.test.tsx
      // carry the workspace label.
      const target: SyncTarget =
        (event.query.meta as { target?: SyncTarget } | undefined)?.target ?? "daemon";
      if (event.action.type === "success") {
        setStatus((prev) => ({ ...prev, [target]: { reachable: true, lastSyncedAt: Date.now() } }));
        return;
      }
      if (event.action.type === "error") {
        // Network-level failure only — see the doc comment above.
        if (event.action.error instanceof TypeError) {
          setStatus((prev) => ({ ...prev, [target]: { ...prev[target], reachable: false } }));
        }
      }
    });
    return unsubscribe;
  }, [queryClient]);

  return <SyncStatusContext.Provider value={status}>{children}</SyncStatusContext.Provider>;
}
