import type { MessageMention } from "./mentions.js";

/**
 * #289: a message's survival across a reload or app restart, from the
 * instant it is handed to matrix.ts's `send()` until the homeserver has
 * confirmed it. matrix.ts's own header is explicit that nothing persists
 * at the SDK layer (#62 AC4's "no store, no session store, no web
 * storage") — deliberately, so a workspace session leaves no warm SDK
 * state behind at sign-out. That means matrix-js-sdk's own pending-event
 * queue (#209's `PendingEventOrdering.Detached`) lives in memory only: a
 * message still `SENDING`/`NOT_SENT` when the page reloads is gone, not
 * merely unconfirmed — there is nowhere left in this app that remembers it
 * ever existed.
 *
 * This module is that "somewhere else": a small, device-local record of
 * what has been handed to `send()` but not yet confirmed sent, written
 * before the homeserver is even asked and erased the moment it answers.
 * It carries no SDK types and knows nothing about matrix-js-sdk — matrix.ts
 * is still the one module that imports the SDK (the Tauri-seam pattern,
 * pinned by `WorkspaceMatrixSeam.test.ts`'s scan) — so this stays a plain
 * read/write surface over `localStorage`, the same footing as
 * `session.ts`'s own credential record, and just as easy to move onto
 * #320's platform storage interface later without touching matrix.ts's
 * logic at all.
 */
export interface PendingOutgoingMessage {
  /**
   * This entry's own key — never a Matrix event id (a local echo's id
   * belongs to one session's in-memory SDK state and means nothing after a
   * reload). matrix.ts derives it from the txnId it generates for the
   * send, via `outboxKeyOf`, so the SAME key is still reachable from a live
   * pending event's `getTxnId()` within a session — which is what lets
   * `retry`/`cancel` (addressed by the SDK's own event id) keep this
   * record in lockstep without this module knowing anything about events.
   */
  readonly localId: string;
  readonly roomId: string;
  readonly body: string;
  readonly mentions: readonly MessageMention[];
  /** #215: the plain-reply target this send carried, or null for an ordinary message. */
  readonly replyToEventId: string | null;
  /** When this was first queued — never touched by a re-key, so a resend still sorts at its ORIGINAL place in line (#289 AC2). */
  readonly composedAt: number;
}

const STORAGE_KEY = "duo.workspace-outbox";

function isPendingMessage(value: unknown): value is PendingOutgoingMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { localId, roomId, body, mentions, replyToEventId, composedAt } = value as Record<string, unknown>;
  return (
    typeof localId === "string" &&
    localId.length > 0 &&
    typeof roomId === "string" &&
    typeof body === "string" &&
    Array.isArray(mentions) &&
    (replyToEventId === null || typeof replyToEventId === "string") &&
    typeof composedAt === "number"
  );
}

function readAll(): PendingOutgoingMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPendingMessage) : [];
  } catch {
    // A cache that can't be read is not a reason to lose the ability to
    // send — the composer still works, just without the survival this
    // module adds.
    return [];
  }
}

function writeAll(messages: readonly PendingOutgoingMessage[]): void {
  try {
    if (messages.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    }
  } catch {
    // Private window, full storage, etc. — the send this call was about
    // still goes out over the wire; it just won't survive a reload.
  }
}

/** matrix.ts's txnId (`client.makeTxnId()`) turned into this module's own key — deterministic, so the same send's later stages (a success, a retry, a cancel) always address the same record without either side holding a lookup table. */
export function outboxKeyOf(txnId: string): string {
  return `outbox:${txnId}`;
}

/** Queued the instant a send is attempted — before the homeserver has answered at all, so even a reload that lands mid-request still has this. */
export function enqueuePendingMessage(entry: Omit<PendingOutgoingMessage, "composedAt">): void {
  writeAll([...readAll(), { ...entry, composedAt: Date.now() }]);
}

/** Confirmed sent, or given up on (cancelled) — removed by the same key it was queued under. Costs nothing to call for a key that's already gone. */
export function dequeuePendingMessage(localId: string): void {
  const all = readAll();
  const next = all.filter((message) => message.localId !== localId);
  if (next.length !== all.length) {
    writeAll(next);
  }
}

/**
 * Re-addresses a queued entry under a new key, keeping its place in line
 * (`composedAt` untouched). A resend after reload generates a fresh txnId
 * — a fresh local-echo event, in a fresh client — so the record this
 * launch's own `retry`/`cancel` must reach has to carry THIS launch's key,
 * not the one from the session that queued it.
 */
export function rekeyPendingMessage(localId: string, nextLocalId: string): void {
  const all = readAll();
  const next = all.map((message) => (message.localId === localId ? { ...message, localId: nextLocalId } : message));
  writeAll(next);
}

/** Everything still unsent from a previous session, oldest first — the order it was originally composed in (#289 AC2), regardless of how many times a key has been re-addressed since. */
export function pendingMessagesInOrder(): readonly PendingOutgoingMessage[] {
  return [...readAll()].sort((a, b) => a.composedAt - b.composedAt);
}

/** A sign-out (or signing in as someone else on this device) leaves nothing queued behind — the same stance `session.ts`'s own record and the cached conversations (`App.tsx`'s `persister.removeClient()`) already take. */
export function clearPendingMessages(): void {
  writeAll([]);
}
