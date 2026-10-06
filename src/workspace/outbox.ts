import { getPlatform } from "../platform/index.js";
import { workspaceCacheName } from "./cache.js";
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
 * pinned by `WorkspaceMatrixSeam.test.ts`'s scan).
 *
 * Two choices this module makes on purpose, both learned from #288's own
 * cache (`cache.ts`), which this module deliberately mirrors rather than
 * reinventing:
 *
 * - **#320's platform storage, not `localStorage` directly.** #289's own
 *   acceptance criteria are web, Mac AND phone; `getPlatform().storage` is
 *   the one seam that already has a real adapter for all three (a Tauri
 *   host gets its own backend later without this module changing at all).
 * - **One queue per account, named exactly like #288 names its cache**
 *   (`workspaceCacheName` — homeserver, user id, device). Nothing here
 *   re-enables matrix-js-sdk's own generic `mx_pending_events_<roomId>`
 *   persistence, which #288's header explains was deliberately left off
 *   because those keys name neither the account nor the device: two
 *   accounts on one machine would read each other's queued drafts, and the
 *   keys would outlive #288's own account-scoped cache wipe. A queue keyed
 *   by account identity, wiped from the exact call sites that already wipe
 *   that account's cache, is the fix rather than a second copy of that bug.
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

/** The same per-account identity #288's cache is keyed by — one outbox per account, on the same footing as `workspaceCacheName`'s own parameter. */
export type OutboxAccount = Parameters<typeof workspaceCacheName>[0];

/** Our part of every storage key, so a sweep can tell our queues from anything else a platform's storage holds. */
const STORAGE_PREFIX = "duo.workspace-outbox|";

/** This account's own key — reuses #288's exact naming convention, so the same account always lands on the same queue and no two accounts ever land on the same one. */
function storageKeyFor(account: OutboxAccount): string {
  return STORAGE_PREFIX + workspaceCacheName(account);
}

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

async function readAll(account: OutboxAccount): Promise<PendingOutgoingMessage[]> {
  try {
    const raw = await getPlatform().storage.get(storageKeyFor(account));
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

async function writeAll(account: OutboxAccount, messages: readonly PendingOutgoingMessage[]): Promise<void> {
  const storage = getPlatform().storage;
  try {
    if (messages.length === 0) {
      await storage.remove(storageKeyFor(account));
    } else {
      await storage.set(storageKeyFor(account), JSON.stringify(messages));
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

/** Queued the instant a send is attempted — before the homeserver has answered at all, so even a reload that lands mid-request still has this. Awaiting this (matrix.ts does, before the send it describes) is what makes that guarantee real rather than a race. */
export async function enqueuePendingMessage(account: OutboxAccount, entry: Omit<PendingOutgoingMessage, "composedAt">): Promise<void> {
  const all = await readAll(account);
  await writeAll(account, [...all, { ...entry, composedAt: Date.now() }]);
}

/** Confirmed sent, or given up on (cancelled) — removed by the same key it was queued under. Costs nothing to call for a key that's already gone. */
export async function dequeuePendingMessage(account: OutboxAccount, localId: string): Promise<void> {
  const all = await readAll(account);
  const next = all.filter((message) => message.localId !== localId);
  if (next.length !== all.length) {
    await writeAll(account, next);
  }
}

/**
 * Re-addresses a queued entry under a new key, keeping its place in line
 * (`composedAt` untouched). A resend after reload generates a fresh txnId
 * — a fresh local-echo event, in a fresh client — so the record this
 * launch's own `retry`/`cancel` must reach has to carry THIS launch's key,
 * not the one from the session that queued it.
 */
export async function rekeyPendingMessage(account: OutboxAccount, localId: string, nextLocalId: string): Promise<void> {
  const all = await readAll(account);
  const next = all.map((message) => (message.localId === localId ? { ...message, localId: nextLocalId } : message));
  await writeAll(account, next);
}

/** Everything still unsent from a previous session, oldest first — the order it was originally composed in (#289 AC2), regardless of how many times a key has been re-addressed since. */
export async function pendingMessagesInOrder(account: OutboxAccount): Promise<readonly PendingOutgoingMessage[]> {
  const all = await readAll(account);
  return [...all].sort((a, b) => a.composedAt - b.composedAt);
}

/**
 * A sign-out (or signing in as someone else on this device) leaves nothing
 * queued behind for THAT account — the same stance `session.ts`'s own
 * record and #288's cache (`forgetWorkspaceCache`) already take. Called
 * from the exact spots `forgetWorkspaceCache` is (App.tsx's `setSession`
 * and `setApi`), never a second, parallel sign-out path.
 */
export async function clearPendingMessages(account: OutboxAccount): Promise<void> {
  await writeAll(account, []);
}

/**
 * The belt to `clearPendingMessages`'s braces, mirroring #288's own
 * `sweepWorkspaceCaches`: deletes every OTHER account's leftover queue on
 * this device, keeping only `keep`'s (or none at all, when `keep` is
 * null). Catches a queue whose sign-out never got to run — the tab closed
 * first, a crash, a hosted session whose credential was already gone.
 * Only one workspace session is ever active on a device, so any other
 * account's queue is stale by definition. Called from `connect()`,
 * alongside `sweepWorkspaceCaches`.
 */
export async function sweepPendingMessages(keep: OutboxAccount | null): Promise<void> {
  const storage = getPlatform().storage;
  let keys: string[];
  try {
    keys = await storage.keys(STORAGE_PREFIX);
  } catch {
    return;
  }
  const kept = keep ? storageKeyFor(keep) : null;
  await Promise.all(
    keys
      .filter((key) => key !== kept)
      .map((key) => storage.remove(key).catch(() => undefined)),
  );
}
