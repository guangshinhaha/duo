/**
 * #324: the client half of the Web Share Target handoff. `public/sw.js`
 * catches the OS share sheet's POST to `/share-target` (`public/
 * manifest.json`'s own `share_target.action`) and writes what it read into
 * this origin's own IndexedDB — a page may not even be open yet when that
 * happens, so a worker is the one thing that can catch it at all. This
 * reads it back, once, the same "mirror, read once, gone" shape
 * `credentialMirror.ts` keeps for the opposite direction (a page writing
 * for a worker to read later): `readPendingShare` is what the picker
 * (`ShareTargetSheet.tsx`) calls on mount, and a second visit to `#share`
 * — a reload, a back-then-forward — finds nothing, rather than replaying a
 * share already handed to a conversation.
 *
 * `stashShareForRoom`/`takeShareForRoom` carry the picker's choice the rest
 * of the way, from the moment a conversation is picked into that room's own
 * composer (`RoomComposer` in `src/routes/Room.tsx`) — in memory only,
 * never persisted, the same "a thought in progress, not a record" stance
 * `composerBuffer.ts` already takes for the half-typed question it holds
 * across a route switch.
 */

const DB_NAME = "duo-sw-share-target";
const STORE_NAME = "pending";
const SHARE_KEY = "current";

/** One file the OS's share sheet carried — the bytes, and the facts `stageFile` (`workspace/sharing.ts`) needs to put it through the normal upload path once a conversation is picked. */
export interface SharedFile {
  readonly name: string;
  readonly type: string;
  readonly blob: Blob;
}

/** What `public/sw.js` wrote: the three text fields `public/manifest.json`'s `share_target.params` names, and whatever files rode along. Every field present, even empty — the worker always writes this shape. */
export interface PendingShare {
  readonly title: string;
  readonly text: string;
  readonly url: string;
  readonly files: readonly SharedFile[];
}

function isSharedFileShape(value: unknown): value is SharedFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  // Duck-typed, never `instanceof Blob`: the blob crossed from the service
  // worker's own realm through structured clone, and a cross-realm clone
  // isn't guaranteed to share this page's `Blob` constructor even though
  // it behaves exactly like one.
  const blob = candidate.blob as { arrayBuffer?: unknown; size?: unknown; type?: unknown } | undefined;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.type === "string" &&
    typeof blob === "object" &&
    blob !== null &&
    typeof blob.arrayBuffer === "function" &&
    typeof blob.size === "number"
  );
}

function isPendingShareShape(value: unknown): value is PendingShare {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.title === "string" &&
    typeof candidate.text === "string" &&
    typeof candidate.url === "string" &&
    Array.isArray(candidate.files) &&
    candidate.files.every(isSharedFileShape)
  );
}

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
        // The request still settles below either way.
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
 * The share `public/sw.js` caught, if any — read and cleared in the same
 * transaction, so two readers racing (two tabs, both landing on `#share`)
 * can never both claim it. Null for every way there isn't one: nothing
 * shared this session, a blocked or absent IndexedDB, a read that failed,
 * or something there that doesn't read as a share at all.
 */
export async function readPendingShare(factory: IDBFactory | undefined = globalIndexedDb()): Promise<PendingShare | null> {
  if (!factory) {
    return null;
  }
  try {
    const db = await openDb(factory);
    if (!db) {
      return null;
    }
    const value = await new Promise<unknown>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const getRequest = store.get(SHARE_KEY);
        getRequest.onsuccess = () => store.delete(SHARE_KEY);
        tx.oncomplete = () => resolve(getRequest.result);
        tx.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
    db.close();
    return isPendingShareShape(value) ? value : null;
  } catch {
    return null;
  }
}

/** The per-room handoff from the picker's choice to that room's composer — session-only, taken exactly once. */
const pendingRoomShares = new Map<string, { readonly text: string; readonly files: readonly File[] }>();

/** Called by the picker the instant a conversation is chosen (`ShareTargetSheet.tsx`), right before it navigates there. */
export function stashShareForRoom(roomId: string, share: { readonly text: string; readonly files: readonly File[] }): void {
  pendingRoomShares.set(roomId, share);
}

/** Called once by that room's own composer, on mount — a second mount (leaving and returning without sharing anything new) finds nothing waiting. */
export function takeShareForRoom(roomId: string): { readonly text: string; readonly files: readonly File[] } | null {
  const share = pendingRoomShares.get(roomId);
  pendingRoomShares.delete(roomId);
  return share ?? null;
}
