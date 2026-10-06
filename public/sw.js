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

self.addEventListener("push", (event) => {
  let draftId = null;
  try {
    const data = event.data ? event.data.json() : null;
    if (data && typeof data.draftId === "string" && data.draftId.length > 0) {
      draftId = data.draftId;
    }
  } catch {
    // Not JSON, or not shaped as expected — never crash the push handler
    // over a payload this worker doesn't recognize.
    draftId = null;
  }

  // `userVisibleOnly: true` (the only way `PushManager.subscribe` is ever
  // called here) is a promise to the browser that EVERY push shows
  // something — skip it and Chrome shows its own "this site has been
  // updated in the background" notice instead, and a pattern of skipping
  // can get the subscription itself revoked. This daemon only ever sends
  // `{ draftId }` (digital-duo#251's `notifyDraftWaiting`), so the
  // fallback below is belt-and-braces for a payload shape nothing today
  // actually sends, not a real delivery path.
  const hash = draftId !== null ? `#draft/${encodeURIComponent(draftId)}` : DEFAULT_HASH;
  const body = draftId !== null ? DRAFT_WAITING_BODY : "You have a notification from Duo.";
  const tag = draftId !== null ? `duo-draft-${draftId}` : "duo-push";

  event.waitUntil(self.registration.showNotification("Duo", { body, tag, data: { hash } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const hash = (event.notification.data && event.notification.data.hash) || DEFAULT_HASH;

  event.waitUntil(
    (async () => {
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
    })(),
  );
});
