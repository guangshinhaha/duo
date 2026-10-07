import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { LaterItem, WorkspaceConnection } from "../workspace/matrix.js";

/**
 * duo#299: "Later" — save a message, or the words you were writing instead
 * of sending them, with an optional reminder. Held as this account's own
 * data (`duo.later.items`, `matrix.ts`), the same door `duo.sidebar.sections`
 * already stands behind, so a save made on one device — and any reminder,
 * snooze, or "done" — reads the same on every other (#296's own reasoning,
 * cited in this issue). This module is the CRUD half: pure functions over a
 * `LaterItem[]`, so every edit is one easily-tested transform with no I/O
 * of its own; `loadLater`/`saveLater`/`watchLater` below are the thin
 * binding onto `matrix.ts`'s door, tolerant of a connection built before
 * #299 (`later`/`setLater`/`subscribeLater` are optional on
 * `WorkspaceConnection`, the same reasoning `sections`/`setSections` give).
 */

let localSeq = 0;
function newLaterId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  localSeq += 1;
  return `later-${Date.now()}-${localSeq}`;
}

/** A preview is a snapshot, not a live copy — capped so Later never carries a whole essay someone pasted into a message. */
const PREVIEW_LIMIT = 500;

export function laterPreview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PREVIEW_LIMIT ? `${trimmed.slice(0, PREVIEW_LIMIT)}…` : trimmed;
}

/** Appends a new saved item. `remindAt` is an ISO string, or null for "just save it, no reminder". */
export function addLaterItem(
  items: readonly LaterItem[],
  saved: {
    kind: "message" | "note";
    roomId: string;
    eventId: string | null;
    senderId: string | null;
    senderName: string | null;
    preview: string;
    remindAt: string | null;
  },
): readonly LaterItem[] {
  return [
    ...items,
    {
      id: newLaterId(),
      kind: saved.kind,
      roomId: saved.roomId,
      eventId: saved.eventId,
      senderId: saved.senderId,
      senderName: saved.senderName,
      preview: laterPreview(saved.preview),
      createdAt: new Date().toISOString(),
      remindAt: saved.remindAt,
      done: false,
      firedAt: null,
    },
  ];
}

/** Marks a saved item done — it stays in the record, filtered out of the default view, same as a resolved rule staying in the audit trail. */
export function markLaterDone(items: readonly LaterItem[], id: string, done = true): readonly LaterItem[] {
  return items.map((item) => (item.id === id ? { ...item, done } : item));
}

/** Changes (or clears, with `null`) when a saved item reminds — a fresh reminder time clears any earlier fire, since a snooze means "tell me again". */
export function snoozeLaterItem(items: readonly LaterItem[], id: string, remindAt: string | null): readonly LaterItem[] {
  return items.map((item) => (item.id === id ? { ...item, remindAt, firedAt: null } : item));
}

/** Removes a saved item outright. */
export function removeLaterItem(items: readonly LaterItem[], id: string): readonly LaterItem[] {
  return items.filter((item) => item.id !== id);
}

/** Records that a reminder has been shown for this item — so a second device open at the same moment, or a missed poll catching up, never shows it twice. */
export function markLaterFired(items: readonly LaterItem[], id: string, firedAt: string = new Date().toISOString()): readonly LaterItem[] {
  return items.map((item) => (item.id === id ? { ...item, firedAt } : item));
}

/** What the list shows by default: not done, oldest reminder first, then the undated ones in the order they were saved. */
export function activeLaterItems(items: readonly LaterItem[]): readonly LaterItem[] {
  return [...items.filter((item) => !item.done)].sort((a, b) => {
    if (a.remindAt !== null && b.remindAt !== null) {
      return a.remindAt.localeCompare(b.remindAt);
    }
    if (a.remindAt !== null) {
      return -1;
    }
    if (b.remindAt !== null) {
      return 1;
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Saved items whose reminder has come due and hasn't fired yet — what the reminder watcher (`App.tsx`) and the sidebar's count both read. */
export function dueLaterItems(items: readonly LaterItem[], now: Date = new Date()): readonly LaterItem[] {
  return items.filter((item) => !item.done && item.remindAt !== null && item.firedAt === null && item.remindAt <= now.toISOString());
}

/** This account's saved items, as the workspace currently has them. `null` (no connection yet) and a connection built before #299 (no `later` door) both answer the same way as an account that has simply never saved one: an empty list, never a throw the caller would need to guard against. */
export async function loadLater(connection: WorkspaceConnection | null): Promise<readonly LaterItem[]> {
  if (!connection?.later) {
    return [];
  }
  return connection.later();
}

/** Writes the whole set back. A connection with no `setLater` door silently keeps the edit in memory only — same "degrade, don't throw" stance as `loadLater`. */
export async function saveLater(connection: WorkspaceConnection | null, items: readonly LaterItem[]): Promise<void> {
  if (!connection?.setLater) {
    return;
  }
  await connection.setLater(items);
}

/** Hears this account's saved items change on another device. Returns a no-op unsubscribe where the connection (or an older one) has no such door. */
export function watchLater(connection: WorkspaceConnection | null, handler: (items: readonly LaterItem[]) => void): () => void {
  if (!connection?.subscribeLater) {
    return () => {};
  }
  return connection.subscribeLater(handler);
}

const LATER_QUERY_KEY = ["workspace", "later"];

/**
 * The owner's saved items, read once and then kept current by
 * `watchLater` — the same "subscribe, never poll" shape every other piece
 * of this account's own data already takes in this app (`sections`,
 * `m.direct`). `update` applies a transform optimistically (the screen
 * changes the instant the owner acts) and persists it right after, the
 * same shape `ChatList.tsx`'s `updateSections` already takes; a write that
 * doesn't land is re-read from the account rather than left showing an
 * edit the account never actually agreed to.
 */
export function useLaterItems(connection: WorkspaceConnection | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: LATER_QUERY_KEY,
    queryFn: () => loadLater(connection),
    enabled: connection !== null,
    meta: { target: "workspace" },
  });
  useEffect(() => {
    return watchLater(connection, (next) => {
      queryClient.setQueryData(LATER_QUERY_KEY, next);
    });
  }, [connection, queryClient]);
  const items = query.data ?? [];
  const update = (next: readonly LaterItem[], onError?: () => void): void => {
    queryClient.setQueryData(LATER_QUERY_KEY, next);
    saveLater(connection, next).catch(() => {
      onError?.();
      void queryClient.invalidateQueries({ queryKey: LATER_QUERY_KEY });
    });
  };
  return { items, isLoading: query.isLoading, update };
}
