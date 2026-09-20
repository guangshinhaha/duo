import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "./client.js";

/**
 * #41: a revoked device token must not strand the owner on raw error
 * strings. Every request goes through `apiRequest`, so a 401 from *any* of
 * them means one thing — this device's token no longer authenticates
 * (revoked from the Mac via `duo pair revoke`, or a token that never
 * authenticated in the first place). A 401 is not a route-level problem and
 * not retryable, so this guard watches both caches from one place and hands
 * the event to `onRevoked`, which App answers by unpairing exactly as the
 * Settings screen does: connection, query cache and persisted blob all go,
 * and Setup explains what happened.
 *
 * Deliberately NOT network-level failures: those are §3.3's offline state —
 * the bar shows, the connection stays. Only an `ApiRequestError` with
 * `status === 401` unpairs.
 */
export function useRevokedTokenGuard(onRevoked: () => void): void {
  const queryClient = useQueryClient();
  const onRevokedRef = useRef(onRevoked);
  onRevokedRef.current = onRevoked;

  useEffect(() => {
    const isRevocation = (error: unknown): boolean => error instanceof ApiRequestError && error.status === 401;

    // Two subscriptions, one condition: queries and mutations fail through
    // different caches, and either one is enough to know the token is dead.
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error" && isRevocation(event.action.error)) {
        onRevokedRef.current();
      }
    });
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error" && isRevocation(event.action.error)) {
        onRevokedRef.current();
      }
    });
    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient]);
}
