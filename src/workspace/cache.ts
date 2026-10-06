import type { WorkspaceSession } from "./matrix.js";

/**
 * #288: where the workspace's local cache lives, and how it goes away.
 *
 * `matrix.ts` (the one module that speaks matrix-js-sdk) keeps the room list,
 * room state and recent timeline in the SDK's own `IndexedDBStore`, so a cold
 * open renders the last-known conversations before the homeserver answers.
 * This module names that database and deletes it. It deliberately imports
 * nothing from the SDK: signing out must be able to wipe the cache without
 * loading the SDK, the same way the daemon-only flows never load it.
 *
 * One database per account: the homeserver, the member's user id and the
 * sign-in's device (a hosted session has none, #127). Two accounts on one
 * machine never read each other's cache, and a fresh sign-in starts clean.
 */

/** Our part of every database name, so a sweep can tell our caches from anything else on this origin. */
const CACHE_PREFIX = "duo-workspace|";

/** matrix-js-sdk's `LocalIndexedDBStoreBackend` puts this in front of the `dbName` it is given. */
const SDK_DB_PREFIX = "matrix-js-sdk:";

type CacheIdentity = Pick<WorkspaceSession, "homeserverUrl" | "userId" | "deviceId">;

/** The `dbName` handed to the SDK's `IndexedDBStore` for this account. */
export function workspaceCacheName(session: CacheIdentity): string {
  return `${CACHE_PREFIX}${session.homeserverUrl}|${session.userId}|${session.deviceId ?? "hosted"}`;
}

/** This environment's IndexedDB, or null where there is none (some private windows, a test DOM): then nothing is cached. */
export function workspaceIndexedDB(): IDBFactory | null {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    // Some browsers throw on the very read when storage is blocked.
    return null;
  }
}

function deleteDatabase(factory: IDBFactory, fullName: string): Promise<void> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.deleteDatabase(fullName);
    } catch {
      resolve();
      return;
    }
    // An open connection (the client still winding down) is asked to close by
    // the browser's `versionchange` event, which the SDK's backend answers by
    // closing — so `blocked` is a wait, not a failure. Success and failure
    // both end the wait: there is nothing more this device could do.
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

/**
 * Deletes this account's cache — the room list, room state and recent
 * messages it held. Called when the session ends (sign-out, or a different
 * account signs in) so nothing is left behind for the next person on a shared
 * machine. Best-effort and safe to call when there is no cache.
 */
export async function forgetWorkspaceCache(session: CacheIdentity): Promise<void> {
  const factory = workspaceIndexedDB();
  if (!factory) {
    return;
  }
  await deleteDatabase(factory, SDK_DB_PREFIX + workspaceCacheName(session));
}

/**
 * Deletes every workspace cache on this device except `keep`'s: the belt to
 * `forgetWorkspaceCache`'s braces, for a cache whose sign-out never got to
 * wipe it (the tab closed first, the session was forgotten in another tab, a
 * hosted session that had already let go of its credential). Only one
 * workspace session is ever active on a device, so any other cache is stale
 * by definition. Where the browser cannot list its databases, it does nothing.
 */
export async function sweepWorkspaceCaches(keep: CacheIdentity | null): Promise<void> {
  const factory = workspaceIndexedDB();
  if (!factory || typeof factory.databases !== "function") {
    return;
  }
  let names: string[];
  try {
    names = (await factory.databases()).map((info) => info.name ?? "");
  } catch {
    return;
  }
  const kept = keep ? SDK_DB_PREFIX + workspaceCacheName(keep) : null;
  await Promise.all(
    names
      .filter((name) => name.startsWith(SDK_DB_PREFIX + CACHE_PREFIX) && name !== kept)
      .map((name) => deleteDatabase(factory, name)),
  );
}
