import { apiRequest, type DuoApiConfig } from "./api/client.js";
import { readDndPrefs, type DndPrefs } from "./notificationPrefs.js";

/**
 * #308: web push — the delivery path that works while the app is fully
 * closed, which #221's `notifications.ts` (a live tab or the Tauri shell)
 * cannot reach. The daemon side already exists (digital-duo#251): a store
 * of subscriptions, VAPID keys, and `notifyDraftWaiting` sending each one
 * `{ draftId }` the moment a draft is written. This module is the other
 * end of that wire — subscribing, registering with the daemon's actual
 * routes (`src/serve/owner-routes.ts`), and unsubscribing — plus the
 * service worker at `public/sw.js` that receives the push itself.
 *
 * Never meaningful inside the Tauri shell (`isTauriShell`): the Mac app
 * already gets a closed-app tap on the shoulder through the OS's own
 * native channel, which is what the Tauri plugin's notifications already
 * are even while the window is hidden — a second, browser-level push
 * subscription there would be the same arrival delivered twice by two
 * different systems.
 */

const SERVICE_WORKER_URL = "/sw.js";

/**
 * Whether this tab is running inside the Tauri shell — the same check
 * `notifications.ts` makes (`isTauriShell`), kept as its own tiny copy
 * here rather than an import from it: several existing tests fully
 * replace `notifications.js` with `vi.mock(..., () => ({ ... }))` (no
 * `importOriginal`), and this module is reached from `App.tsx`'s sign-out
 * path regardless of which surface a test is actually about — importing
 * a live export from a module other files routinely mock out whole would
 * make this module's own tests (and theirs) depend on every such mock
 * happening to list it.
 */
function isTauriShell(): boolean {
  try {
    return "__TAURI_INTERNALS__" in window;
  } catch {
    return false;
  }
}

export class PushUnsupportedError extends Error {
  constructor() {
    super("This browser doesn't support push notifications.");
    this.name = "PushUnsupportedError";
  }
}

export class PushPermissionDeniedError extends Error {
  constructor() {
    super("Notifications are blocked for this site — allow them in the browser's own settings to turn this on.");
    this.name = "PushPermissionDeniedError";
  }
}

/** Whether this runtime could ever subscribe — feature detection only, never whether permission has been granted (the caller handles that). */
export function pushSupported(): boolean {
  if (isTauriShell()) {
    return false;
  }
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/** A VAPID public key, as `web-push`'s `generateVAPIDKeys` hands it out (base64url, no padding), into the `Uint8Array` `PushManager.subscribe`'s `applicationServerKey` actually wants. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** This device's own do-not-disturb (`notificationPrefs.ts`), in the shape `src/push/subscriptions.ts`'s `parseQuietHours` expects — the server-side evaluation web push needs (a browser cannot swallow a push silently once it's shown), carrying the same rule the open-tab path already applies locally. */
function toServerQuietHours(prefs: DndPrefs): { manual: boolean; from: string | null; to: string | null; timezone: string } {
  let timezone = "UTC";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    timezone = "UTC";
  }
  return { manual: prefs.manual, from: prefs.from, to: prefs.to, timezone };
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) {
    return null;
  }
  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  } catch {
    return null;
  }
}

/** This device's live subscription, if the service worker and browser still have one — `null` for "never subscribed" and for "not supported here", indistinguishably (a caller checking status needs no finer answer than that). */
export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
    if (!registration) {
      return null;
    }
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export interface PushSubscriptionStatus {
  readonly supported: boolean;
  readonly subscribed: boolean;
}

/** What Settings shows: whether this browser could ever subscribe, and whether it already has. */
export async function pushSubscriptionStatus(): Promise<PushSubscriptionStatus> {
  const supported = pushSupported();
  if (!supported) {
    return { supported: false, subscribed: false };
  }
  const existing = await getExistingPushSubscription();
  return { supported: true, subscribed: existing !== null };
}

/**
 * Subscribes this device to web push and registers it with the daemon
 * (`POST /push/subscriptions`, `src/serve/owner-routes.ts`). Asks for
 * Notification permission lazily, here, the first time it's actually
 * needed — never on load — the same stance #221's `ensureNotificationPermission`
 * takes for the Tauri/open-tab path; a browser's own standing denial is
 * never re-asked.
 */
export async function subscribeToPush(api: DuoApiConfig): Promise<void> {
  if (!pushSupported()) {
    throw new PushUnsupportedError();
  }
  if (Notification.permission === "denied") {
    throw new PushPermissionDeniedError();
  }
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushPermissionDeniedError();
  }

  const registration = await registerServiceWorker();
  if (!registration) {
    throw new PushUnsupportedError();
  }
  await navigator.serviceWorker.ready;

  // The one thing a device needs before it can even construct a
  // subscription (owner-routes.ts's own doc comment on this route).
  const { publicKey } = await apiRequest<{ publicKey: string }>(api, "/push/vapid-public-key");

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      // `Uint8Array`'s own type parameter (`ArrayBufferLike` here, under this
      // TS/lib.dom combination) is stricter than `PushSubscriptionOptionsInit`
      // actually requires (`BufferSource`, which a `Uint8Array` always
      // satisfies at runtime regardless of which buffer type the parameter
      // names) — a real cast around a real type mismatch between two DOM
      // lib versions, not an escape from this module's own types.
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  }

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("The browser's push subscription is missing fields the daemon requires.");
  }

  await apiRequest(api, "/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      quietHours: toServerQuietHours(readDndPrefs()),
    }),
  });
}

/**
 * Unsubscribes this device from web push — both locally (the browser stops
 * holding a live subscription) and at the daemon (`DELETE
 * /push/subscriptions`). Called from Settings when push is turned off, and
 * from the app's single sign-out/forget/revoke/end choke point (`setApi`,
 * `App.tsx`) — in every one of those the daemon side of this call may
 * already be unreachable (a dead token, an unpaired daemon), so this never
 * throws: an unsubscribe failing must not block a sign-out that is already
 * happening, the same law `notifyDraftWaiting` states for the send side.
 */
export async function unsubscribeFromPush(api: DuoApiConfig | null): Promise<void> {
  // Called from the app's one sign-out/forget/revoke/end choke point for
  // EVERY device, including the Tauri shell and a browser with no push
  // support at all — neither can ever have registered a subscription in
  // the first place (`subscribeToPush` refuses before ever reaching the
  // daemon), so there is nothing local to release and nothing server-side
  // this device could have left behind. Skipping the daemon call here is
  // what keeps a Mac app sign-out from making a pointless round trip on
  // every single one.
  if (!pushSupported()) {
    return;
  }
  try {
    const subscription = await getExistingPushSubscription();
    if (subscription) {
      await subscription.unsubscribe().catch(() => {});
    }
    if (api) {
      await apiRequest(api, "/push/subscriptions", { method: "DELETE" }).catch(() => {});
    }
  } catch {
    // Never let a failed unsubscribe interrupt the sign-out or settings
    // toggle that triggered it.
  }
}

/**
 * Wires the one message channel a service worker has back to an open page:
 * a notification click (`public/sw.js`'s `notificationclick` handler) posts
 * `{ type: "duo-notification-click", hash }` to a focused, already-open
 * window rather than navigating it directly — `client.navigate()` would
 * reload the whole SPA for what is, inside it, only a hash change. Returns
 * the unwire function, or `null` where there is no service worker to ever
 * hear from.
 */
export function wirePushNavigationMessages(): (() => void) | null {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  const handler = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown; hash?: unknown } | null;
    if (data && data.type === "duo-notification-click" && typeof data.hash === "string") {
      window.location.hash = data.hash;
    }
  };
  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}
