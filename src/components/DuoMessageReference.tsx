import type { ReactNode } from "react";
import { DuoAuthoredBoundary } from "./DuoMessage.js";

/**
 * A reference to a duo's message from another context (#60): a quote block,
 * a reply header, a notification, a search hit. One component for all of
 * them, because a label that survives only in the main timeline is not a
 * label — wherever a duo's text is shown, the attribution travels with it,
 * in the same possessive form as `RoomDuoMessage` ("Ana's duo").
 *
 * It sets the same `DuoAuthoredBoundary` as the timeline rendering, so a
 * person-identity component can no more hide inside a quote of a duo's
 * message than inside the message itself.
 */
export function DuoMessageReference({ ownerName, children }: { ownerName: string; children: ReactNode }) {
  return (
    <div
      data-testid="duo-message-reference"
      className="rounded-[var(--r-md)] border border-dashed border-[var(--edge)] bg-[var(--surface-2)] px-3 py-2 text-[var(--text)]"
    >
      <div
        className="mb-1 type-provenance text-[var(--muted)]"
        data-testid="duo-message-reference-attribution"
      >
        {ownerName}&#39;s duo
      </div>
      <DuoAuthoredBoundary>{children}</DuoAuthoredBoundary>
    </div>
  );
}
