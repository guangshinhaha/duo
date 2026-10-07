// duo's service worker (#308): delivers a web push while the app is fully
// closed — the one thing a tab, open or not, cannot do on its own — and
// opens the conversation a click is about.
//
// Deliberately a plain script, not a bundled module: `public/` is served
// to the browser verbatim (no Vite build step touches it), and a service
// worker registered with `{ type: "classic" }` (the default, and what
// `push.ts` registers with) cannot `import` anything anyway. Keeping this
// file self-contained is what lets `test/ServiceWorker.test.ts` execute
// the actual shipped bytes against a fake `self`, rather than testing a
// hand-kept copy that could silently drift from what ships.
//
// The payload: digital-duo#251's `notifyDraftWaiting` sends exactly
// `{ draftId }`, scrubbed of every other field on purpose (#256/#257/#258's
// "say only what a tool does" — a push service, and anything that can read
// its traffic, is never told what the draft is about, only that one
// exists). This worker shows the same fixed line the open-tab path already
// shows for the identical arrival (`notifyDraftReady`, `src/notifications.ts`)
// — one arrival, one sentence, regardless of which path delivered it.

const DRAFT_WAITING_BODY = "A new draft is waiting for your review.";
const DEFAULT_HASH = "#chats";

// #268: a reply your duo is about to send by itself, inside its undo window
// (`{ draftId, kind: "autonomous_hold", sendAt }`). The click opens Waiting on
// you, where the live strip has Stop and Edit. The notification itself
// carries no Stop button on purpose: stopping is a call to the daemon with
// this device's token, which this worker never holds — a lock-screen "Stop"
// that could not actually stop anything would be worse than none.
const AUTONOMOUS_HOLD_BODY = "Your duo is about to send a reply for you. Tap to stop or edit it.";
const AUTONOMOUS_HOLD_HASH = "#waiting";

// #311: Send and Edit, right on a draft's own notification — Chrome
// desktop and Android both render at most two `actions`, which is exactly
// how many a draft ever needs. `SEND_ACTION`/`EDIT_ACTION` are the ids
// `notificationclick` below branches on; the titles are what render on the
// buttons themselves.
const SEND_ACTION = "duo-send";
const EDIT_ACTION = "duo-edit";

// Same database/store/key names `src/credentialMirror.ts` writes — this
// worker reads that mirror directly (it cannot import the module: a plain,
// unbundled script, same reasoning as the rest of this file), under the
// SAME two names on both sides of the write/read seam.
const CREDENTIAL_DB_NAME = "duo-sw-credential";
const CREDENTIAL_STORE_NAME = "config";
const CREDENTIAL_KEY = "current";

// `score < threshold + HEDGE_MARGIN` is a hedged draft (`ConfidenceHairline.tsx`'s
// own `hairlineState`, `src/workspace/duoAnswer.ts`'s `HEDGE_MARGIN`) — mirrored
// here, not imported (this script cannot import), so AC3's "hedged drafts
// open the app instead" means exactly the same threshold the owner's own
// screen already draws its hairline at.
const HEDGE_MARGIN = 0.15;

/** This device's mirrored `{baseUrl, token}` (`credentialMirror.ts`), or `null` for every way there isn't one — no mirror written yet, a blocked/absent IndexedDB, a read that failed. Never throws. */
function readCredential() {
  return new Promise((resolve) => {
    if (!self.indexedDB) {
      resolve(null);
      return;
    }
    let request;
    try {
      request = self.indexedDB.open(CREDENTIAL_DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      // A fresh, empty database (this device never mirrored anything) —
      // the store this worker expects doesn't exist yet. Create it so the
      // open still succeeds; the read just below finds nothing in it.
      try {
        if (!request.result.objectStoreNames.contains(CREDENTIAL_STORE_NAME)) {
          request.result.createObjectStore(CREDENTIAL_STORE_NAME);
        }
      } catch {
        // Falls through to onsuccess/onerror below either way.
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      try {
        const tx = db.transaction(CREDENTIAL_STORE_NAME, "readonly");
        const getRequest = tx.objectStore(CREDENTIAL_STORE_NAME).get(CREDENTIAL_KEY);
        getRequest.onsuccess = () => {
          const value = getRequest.result;
          const credential =
            value && typeof value.baseUrl === "string" && typeof value.token === "string" ? value : null;
          resolve(credential);
          db.close();
        };
        getRequest.onerror = () => {
          resolve(null);
          db.close();
        };
      } catch {
        resolve(null);
      }
    };
    request.onerror = () => resolve(null);
  });
}

/**
 * Whether a fetched `DraftRecord` (`src/api/types.ts`) is one Send/Edit can
 * act on from the notification itself: not already decided elsewhere, not
 * an escalation or a refusal (nothing to "send" there — that's a question
 * passed on, answered in the room itself), not text-less, and — the
 * confidence check AC3 asks for — not hedged. Anything this returns false
 * for falls back to the plain, action-less notification, same as before
 * #311: the owner opens the app and decides there instead.
 */
function canActFromNotification(record) {
  if (!record || typeof record !== "object") {
    return false;
  }
  if (record.outcome) {
    return false; // already decided — nothing left to act on
  }
  if (record.escalated) {
    return false; // a passed-on question or a refusal, never a sendable draft
  }
  if (typeof record.draftText !== "string" || record.draftText.length === 0) {
    return false;
  }
  const score = typeof record.confidenceScore === "number" ? record.confidenceScore : 0;
  const threshold = typeof record.escalationThreshold === "number" ? record.escalationThreshold : Infinity;
  return score >= threshold + HEDGE_MARGIN;
}

/** Shows the one notification a draft arrival has always shown — no actions, open the app on click. The shared fallback every "can't tell, or isn't eligible" branch below takes. */
function showPlainDraftNotification(draftId) {
  const hash = `#draft/${encodeURIComponent(draftId)}`;
  return self.registration.showNotification("Duo", { body: DRAFT_WAITING_BODY, tag: `duo-draft-${draftId}`, data: { hash } });
}

/**
 * #311: the draft-ready push's own notification, now asking — once, best
 * effort — whether THIS draft is confident enough to act on right from
 * here. No credential mirrored, no answer from the daemon, or a draft
 * that isn't eligible (escalated, hedged, already decided): the exact
 * same notification this worker has always shown, since #308. The
 * credential itself never rides the notification's own `data` — read
 * fresh from IndexedDB again on the click below, so it rests in exactly
 * one place.
 */
async function showDraftNotification(draftId) {
  const hash = `#draft/${encodeURIComponent(draftId)}`;
  const tag = `duo-draft-${draftId}`;
  const credential = await readCredential();
  if (!credential) {
    return showPlainDraftNotification(draftId);
  }
  try {
    const response = await self.fetch(`${credential.baseUrl}/drafts/${encodeURIComponent(draftId)}`, {
      headers: { Authorization: `Bearer ${credential.token}` },
    });
    if (!response.ok) {
      return showPlainDraftNotification(draftId);
    }
    const record = await response.json();
    if (!canActFromNotification(record)) {
      return showPlainDraftNotification(draftId);
    }
    return self.registration.showNotification("Duo", {
      body: DRAFT_WAITING_BODY,
      tag,
      data: { hash, draftId },
      actions: [
        { action: SEND_ACTION, title: "Send" },
        { action: EDIT_ACTION, title: "Edit" },
      ],
    });
  } catch {
    // Offline, CORS, an unreachable daemon — the plain notification is
    // always the safe fallback, never nothing.
    return showPlainDraftNotification(draftId);
  }
}

self.addEventListener("push", (event) => {
  let draftId = null;
  let autonomous = false;
  try {
    const data = event.data ? event.data.json() : null;
    if (data && typeof data.draftId === "string" && data.draftId.length > 0) {
      draftId = data.draftId;
      autonomous = data.kind === "autonomous_hold";
    }
  } catch {
    // Not JSON, or not shaped as expected — never crash the push handler
    // over a payload this worker doesn't recognize.
    draftId = null;
  }

  if (draftId !== null && autonomous) {
    event.waitUntil(
      self.registration.showNotification("Duo", {
        body: AUTONOMOUS_HOLD_BODY,
        tag: `duo-autonomous-${draftId}`,
        requireInteraction: true,
        data: { hash: AUTONOMOUS_HOLD_HASH },
      }),
    );
    return;
  }

  if (draftId !== null) {
    event.waitUntil(showDraftNotification(draftId));
    return;
  }

  // `userVisibleOnly: true` (the only way `PushManager.subscribe` is ever
  // called here) is a promise to the browser that EVERY push shows
  // something — skip it and Chrome shows its own "this site has been
  // updated in the background" notice instead, and a pattern of skipping
  // can get the subscription itself revoked. This daemon only ever sends
  // `{ draftId }` (digital-duo#251's `notifyDraftWaiting`), so the
  // fallback below is belt-and-braces for a payload shape nothing today
  // actually sends, not a real delivery path.
  const hash = DEFAULT_HASH;
  const body = "You have a notification from Duo.";
  const tag = "duo-push";

  event.waitUntil(self.registration.showNotification("Duo", { body, tag, data: { hash } }));
});

/** Brings an already-open same-origin window forward and hands it `hash` to navigate to; opens a fresh one at that address when nothing is open. Shared by a plain click, Edit, and Send's own fallback — all three want exactly this. */
async function focusOrOpen(hash) {
  const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of allClients) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(client.url).origin === self.location.origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      continue;
    }
    // An already-open window: bring it forward and hand it the hash to
    // navigate to itself (`postMessage`, picked up by
    // `wirePushNavigationMessages` in `push.ts`) — `client.navigate()`
    // would reload the whole app for what is, inside an open SPA, just
    // a hash change.
    if ("focus" in client) {
      await client.focus();
    }
    client.postMessage({ type: "duo-notification-click", hash });
    return;
  }
  // Nothing open: a fresh window starts right at the address the
  // notification was about.
  await self.clients.openWindow(`/${hash}`);
}

/**
 * #311: Send, tapped right on the notification — the one action this
 * worker can complete without ever opening the app. Reads the mirrored
 * credential fresh (never from the notification's own `data`) and POSTs
 * exactly what `useRecordOutcome`'s plain Send already does in-app
 * (`src/api/queries.ts`): `{ outcome: "sent" }`, no edited text, because
 * a notification has no editor to have changed it in. Anything that isn't
 * a clean success — no credential, a network failure, a non-2xx answer —
 * falls back to opening the app at the draft, so the owner always has a
 * way to finish deciding; it never fails silently.
 */
async function sendDraftFromNotification(draftId, hash) {
  const credential = await readCredential();
  if (!credential) {
    return focusOrOpen(hash);
  }
  try {
    const response = await self.fetch(`${credential.baseUrl}/drafts/${encodeURIComponent(draftId)}/outcome`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "sent" }),
    });
    if (!response.ok) {
      return focusOrOpen(hash);
    }
    return self.registration.showNotification("Duo", { body: "Sent.", tag: `duo-draft-${draftId}`, data: { hash } });
  } catch {
    return focusOrOpen(hash);
  }
}

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  const hash = data.hash || DEFAULT_HASH;
  const draftId = data.draftId || null;
  const action = event.action;
  event.notification.close();

  if (action === SEND_ACTION && draftId) {
    event.waitUntil(sendDraftFromNotification(draftId, hash));
    return;
  }
  // Edit (#311: "open the app focused on that draft, ready to edit" — a
  // service worker cannot show an editor of its own) and a plain tap on
  // the notification's body both land exactly here, unchanged from #308.
  event.waitUntil(focusOrOpen(hash));
});
