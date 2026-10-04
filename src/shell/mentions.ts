import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MentionHit, WorkspaceConnection } from "../workspace/matrix.js";

/**
 * #222: "one place for every mention across conversations" — the raw
 * `@mentions` of the member themselves, read from the workspace's own
 * highlight notifications (`WorkspaceConnection.mentions()`). This is
 * deliberately NOT folded into "Waiting on you" (shell/waiting.ts): that
 * list is the duo's drafts awaiting the owner's decision, one job, one
 * queue; a mention is something somebody said to the member directly, with
 * no draft and no decision attached. Keeping them apart means neither list
 * has to explain why a row doesn't behave like the other rows in it.
 *
 * The homeserver has no verb for "I've seen this one" at an arbitrary past
 * event (receipts move forward from the room's latest, #63's `markRead`) —
 * so a mention's `read` flag is informational (did a receipt already pass
 * it, from reading the room itself) and dismissing it from THIS list is a
 * separate, local, per-device choice, held here rather than asked of the
 * server.
 */

const DISMISSED_KEY = "duo.mentions-dismissed";

/** How many dismissed ids are kept — enough that re-opening the app doesn't resurrect everything just cleared, not an unbounded list. */
const DISMISSED_LIMIT = 500;

function readDismissed(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-DISMISSED_LIMIT)));
  } catch {
    // not remembered: a dismissal simply doesn't outlive this visit
  }
}

/** The mentions a dismissal has not cleared, still newest first — pure, so the filtering needs no DOM to test. */
export function visibleMentions(all: readonly MentionHit[], dismissed: ReadonlySet<string>): readonly MentionHit[] {
  return all.filter((hit) => !dismissed.has(hit.eventId));
}

/** How many of the visible mentions the member hasn't read yet (the server's own receipt-based record) — what a nav badge counts. */
export function unreadCountOf(mentions: readonly MentionHit[]): number {
  return mentions.filter((hit) => !hit.read).length;
}

/** Every mention across every conversation (#222), not yet dismissed from this device, newest first — and the means to dismiss one. */
export function useMentions(connection: WorkspaceConnection | null) {
  const query = useQuery({
    // Under the workspace's own key, so signing out (which clears the cache) treats this like the rest of the workspace.
    queryKey: ["workspace", "mentions"],
    queryFn: () => connection!.mentions(),
    enabled: connection !== null,
    meta: { target: "workspace" },
  });
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(readDismissed);
  const items = visibleMentions(query.data ?? [], dismissed);
  return {
    items,
    unreadCount: unreadCountOf(items),
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => void query.refetch(),
    dismiss: (eventId: string) => {
      setDismissed((previous) => {
        const next = new Set(previous);
        next.add(eventId);
        writeDismissed(next);
        return next;
      });
    },
  };
}
