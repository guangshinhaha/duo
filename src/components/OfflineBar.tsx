import { useSyncStatus } from "../sync.js";

function timeOf(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * #58's bar: one line per down connection, each naming which server it
 * means and showing that one's last successful sync. The workspace is
 * expected to be up, so its line is the app's error voice (escalate
 * colour); the daemon going quiet is the owner's Mac being shut — an
 * expected state, so its line states the last-seen time and is
 * deliberately not error-coloured. Either line appears only after that
 * target has synced at least once — before the first sync there is no
 * cached view to speak about — and disappears on that target's next
 * successful response; nothing needs dismissing, because nothing was ever
 * hidden.
 */
export function OfflineBar() {
  const workspace = useSyncStatus("workspace");
  const daemon = useSyncStatus("daemon");

  // The ternary (not a boolean captured for the JSX below) so `lastSyncedAt`
  // narrows to non-null for `timeOf`.
  const workspaceTime = !workspace.reachable && workspace.lastSyncedAt !== null ? timeOf(workspace.lastSyncedAt) : null;
  const daemonTime = !daemon.reachable && daemon.lastSyncedAt !== null ? timeOf(daemon.lastSyncedAt) : null;
  if (workspaceTime === null && daemonTime === null) {
    return null;
  }

  return (
    <div data-testid="offline-bar" className="flex flex-col border-b border-[var(--edge)] bg-[var(--surface-2)]">
      {workspaceTime !== null && (
        <p data-testid="offline-bar-workspace" className="px-4 py-1 text-center type-provenance text-[var(--escalate)]">
          Last synced {workspaceTime}. The workspace is unreachable.
        </p>
      )}
      {daemonTime !== null && (
        <p data-testid="offline-bar-daemon" className="px-4 py-1 text-center type-provenance text-[var(--muted)]">
          Last seen {daemonTime}. Your duo is asleep — it answers when your Mac is back.
        </p>
      )}
    </div>
  );
}
