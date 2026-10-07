import type { DuoApiConfig } from "./api/client.js";

/**
 * #311: a second, same-origin resting place for this device's own daemon
 * credential — the exact pairing `{baseUrl, token}` `api/config.ts` already
 * keeps in `localStorage` — so `public/sw.js` can make ONE authenticated
 * call on the owner's behalf (Send, from a draft notification's own
 * action) while the app is fully closed. A service worker has no access to
 * `localStorage` (a different storage area entirely, even same-origin), but
 * it shares IndexedDB with the page that registered it, which is the one
 * door this exists to open.
 *
 * Nothing new is exposed past what this device already holds: the same
 * token, the same device, a second place it rests so the one context that
 * needs it while the app is shut can reach it. Mirrored only while push is
 * actually subscribed (`push.ts`'s `subscribeToPush`/`unsubscribeFromPush`)
 * — there is nothing for the service worker to act on from a notification
 * push never delivers in the first place, so an unsubscribed device keeps
 * no copy of its token here at all.
 *
 * Best-effort, like every other cache this app keeps: a failed write or
 * read here costs the service worker its notification actions, never a
 * broken Send — `public/sw.js`'s own read falls back to simply opening the
 * app when this has nothing (or stale, wrong, or unreadable data) to offer.
 */

const DB_NAME = "duo-sw-credential";
const STORE_NAME = "config";
const CREDENTIAL_KEY = "current";

function openDb(factory: IDBFactory): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      try {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      } catch {
        // Cannot create the store: the request still settles below, and
        // the write/delete that follows simply fails too.
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

/** This runtime's own `indexedDB`, or `undefined` where there isn't one (Node under test with nothing stubbed, a sandboxed webview) — never a thrown reference error for merely checking. */
function globalIndexedDb(): IDBFactory | undefined {
  return typeof indexedDB === "undefined" ? undefined : indexedDB;
}

/**
 * Mirrors (or, with `null`, clears) this device's own credential. Called
 * from `push.ts` right after a push subscription is registered or torn
 * down — never from `api/config.ts` itself, because the mirror only
 * matters for a device that can actually receive a closed-app push in the
 * first place.
 */
export async function mirrorCredentialForServiceWorker(
  config: DuoApiConfig | null,
  factory: IDBFactory | undefined = globalIndexedDb(),
): Promise<void> {
  if (!factory) {
    return;
  }
  try {
    const db = await openDb(factory);
    if (!db) {
      return;
    }
    await new Promise<void>((resolve) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(STORE_NAME, "readwrite");
      } catch {
        resolve();
        return;
      }
      if (config) {
        tx.objectStore(STORE_NAME).put({ baseUrl: config.baseUrl, token: config.token }, CREDENTIAL_KEY);
      } else {
        tx.objectStore(STORE_NAME).delete(CREDENTIAL_KEY);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
    db.close();
  } catch {
    // Best-effort mirror only — see this module's own doc comment.
  }
}
