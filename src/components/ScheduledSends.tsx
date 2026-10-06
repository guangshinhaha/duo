import type { DuoApiConfig } from "../api/client.js";
import { useCancelScheduledSend, useScheduledSends } from "../api/queries.js";
import { useSyncStatus } from "../sync.js";
import { MutationError } from "./MutationError.js";
import { scheduledWords } from "./SendControls.js";

/**
 * #261: what the daemon is holding to send later, soonest first — each one
 * cancellable until it fires, which puts it back in Waiting on you. Nothing
 * at all renders when nothing is held: an empty Scheduled heading would only
 * be noise on the screen that answers "is there anything?".
 */
export function ScheduledSends({ api }: { api: DuoApiConfig }) {
  const scheduled = useScheduledSends(api);
  const cancel = useCancelScheduledSend(api);
  const { reachable } = useSyncStatus();
  // A daemon that predates #261 has no such route; anything but a list reads as nothing held.
  const sends = Array.isArray(scheduled.data) ? scheduled.data.filter((send) => send && typeof send.sendAt === "string" && send.draft && send.autonomous !== true) : [];
  if (sends.length === 0) {
    return null;
  }
  return (
    <section aria-label="Scheduled" className="shape-container mt-4 flex max-w-xl flex-col gap-2 p-4" data-testid="scheduled-sends">
      <h2 className="type-heading">Scheduled</h2>
      <p className="type-provenance text-[var(--muted)]">Your duo sends these at their time, even if this app is closed.</p>
      <ul className="flex flex-col gap-2">
        {sends.map((send) => (
          <li className="flex flex-col gap-1 border-t border-[var(--edge)] pt-2" data-testid="scheduled-send" key={send.draftId}>
            <span className="type-provenance text-[var(--muted)]">{scheduledWords(send.sendAt)}</span>
            <span className="type-body text-[var(--text)]">{send.sentText ?? send.draft.draftText}</span>
            <span className="type-provenance text-[var(--faint)]">In reply to: {send.draft.question}</span>
            <button
              className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 disabled:opacity-40"
              disabled={!reachable || cancel.isPending}
              onClick={() => cancel.mutate(send.draftId)}
              type="button"
            >
              Cancel
            </button>
          </li>
        ))}
      </ul>
      <MutationError error={cancel.error} />
    </section>
  );
}
