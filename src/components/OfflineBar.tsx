import { useSyncStatus } from "../sync.js";

/**
 * §3.3's persistent bar, verbatim: **"Last synced 14:32. Your Mac is
 * unreachable."** Rendered only when the daemon has gone quiet at the
 * network level *after* at least one successful sync — before the first
 * sync there is no cached view to apologize for, and the loading/error
 * states of the views themselves are the honest thing to show. It
 * disappears on the next successful response; nothing needs dismissing,
 * because nothing was ever hidden.
 */
export function OfflineBar() {
  const { reachable, lastSyncedAt } = useSyncStatus();
  if (reachable || lastSyncedAt === null) {
    return null;
  }
  const time = new Date(lastSyncedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div
      data-testid="offline-bar"
      className="border-b border-[var(--edge)] bg-[var(--surface-2)] px-4 py-1.5 text-center text-xs text-[var(--escalate)]"
    >
      Last synced {time}. Your Mac is unreachable.
    </div>
  );
}
