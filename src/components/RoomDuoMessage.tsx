import type { ReactNode } from "react";
import { DuoAuthoredBoundary } from "./DuoMessage.js";

/**
 * A duo's message in a shared room (#60) — the multi-party half of AR-13,
 * where the stakes are highest: a colleague reading a channel has no
 * context, no Mirror, and no reason to be suspicious, and a duo's answer
 * carrying policy weight it was never given is exactly the failure
 * `concept.md` exists to prevent.
 *
 * Structurally distinct from `RoomPersonMessage` (§1.6: a different
 * container, not a badge on the same one): dashed border on surface-2,
 * where a person's message is a solid border on surface. There is no
 * `avatar` prop and no `authorName` prop — the author *is* the duo; the
 * owner's name appears only in the possessive attribution ("Ana's duo"),
 * which is what makes whose-duo-it-is unmissable without ever putting the
 * owner's name on the message as its author.
 */
export function RoomDuoMessage({ ownerName, children }: { ownerName: string; children: ReactNode }) {
  return (
    <div
      data-testid="room-duo-message"
      className="rounded-[var(--r-lg)] border border-dashed border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3 text-[var(--text)]"
    >
      <div
        className="mb-1 text-xs font-medium tracking-wide text-[var(--muted)]"
        data-testid="room-duo-message-attribution"
      >
        {ownerName}&#39;s duo
      </div>
      <DuoAuthoredBoundary>{children}</DuoAuthoredBoundary>
    </div>
  );
}
