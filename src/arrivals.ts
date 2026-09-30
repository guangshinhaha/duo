import { useEffect, useState } from "react";

/**
 * Which drafts arrived while the owner was here (docs/motion-plan.md A5).
 * Only a draft the daemon pushed (`draft-ready`) is *arriving*: one that was
 * simply there when a chat opened, or that comes back when the owner
 * navigates away and returns, renders in place. A push is remembered for a
 * short window, so a draft the owner opens minutes later is not news.
 */
const ARRIVAL_WINDOW_MS = 10_000;

const pushed = new Map<string, number>();
const played = new Set<string>();

/** The daemon just told us this draft is ready. */
export function markDraftArrived(draftId: string): void {
  pushed.set(draftId, Date.now());
}

/** True once, for the first mount of a draft that arrived live. */
export function useArrival(draftId: string): boolean {
  const [arrived] = useState(() => {
    const at = pushed.get(draftId);
    return at !== undefined && Date.now() - at < ARRIVAL_WINDOW_MS && !played.has(draftId);
  });
  useEffect(() => {
    played.add(draftId);
  }, [draftId]);
  return arrived;
}
