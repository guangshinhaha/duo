// @ts-expect-error no node types by design (this app's tsconfig has none — see test/Installable.test.ts's own precedent)
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { mirrorCredentialForServiceWorker } from "../src/credentialMirror.js";

/*
 * #308: `public/sw.js` is a plain script, never bundled — this loads and
 * runs the actual shipped bytes against a fake `self`, the only way to test
 * a service worker's own `addEventListener` handlers without a real
 * browser. A hand-kept duplicate of its logic would drift from what ships
 * the first time either copy changed; this never can.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SW_SOURCE = readFileSync(join(root, "public/sw.js"), "utf8") as string;

interface FakeSelf {
  addEventListener(type: string, handler: (event: unknown) => void): void;
  listeners: Record<string, ((event: unknown) => void)[]>;
  registration: { showNotification: ReturnType<typeof vi.fn> };
  clients: { matchAll: ReturnType<typeof vi.fn>; openWindow: ReturnType<typeof vi.fn> };
  location: { origin: string };
  // #311: a real (if freshly-empty, per test) IndexedDB — `IDBFactory` from
  // `fake-indexeddb`, the same package `test/WorkspaceCache.test.ts` already
  // drives the real matrix-js-sdk store over — so `readCredential`'s own
  // IndexedDB calls in `public/sw.js` run against faithful behaviour, never
  // a hand-rolled stand-in that could drift from what a browser actually
  // does. `fetch` is the one network call this worker makes once it has a
  // credential to use.
  indexedDB: IDBFactory;
  fetch: ReturnType<typeof vi.fn>;
}

function createFakeSelf(): FakeSelf {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  return {
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
    listeners,
    registration: { showNotification: vi.fn() },
    clients: { matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => null) },
    location: { origin: "https://duo.example" },
    indexedDB: new IDBFactory(),
    fetch: vi.fn(),
  };
}

function loadServiceWorker(): FakeSelf {
  const fakeSelf = createFakeSelf();
  // The script only ever reads/writes `self` — no `import`/`export`, exactly
  // like the real registration (`{ type: "classic" }`, the default) — so
  // running it as a plain function body against a stand-in is faithful to
  // how a browser actually executes it.
  new Function("self", SW_SOURCE)(fakeSelf);
  return fakeSelf;
}

/** Seeds the fake's own IndexedDB exactly the way `src/credentialMirror.ts` would, for a test that wants `readCredential` to find something. */
async function mirrorCredential(fakeSelf: FakeSelf, credential: { baseUrl: string; token: string } | null): Promise<void> {
  await mirrorCredentialForServiceWorker(credential, fakeSelf.indexedDB);
}

/**
 * `event.waitUntil(promise)` is how a real service worker event tells the
 * browser "stay alive until this settles" — it doesn't return anything the
 * listener itself hands back, and `public/sw.js`'s listeners don't return
 * their `waitUntil` argument either (a real browser never looks at a
 * listener's return value for this). So a test can't just `await
 * handler(event)`: that resolves the instant the synchronous part of the
 * listener returns, before the work `waitUntil` was given has necessarily
 * finished. This captures that promise on the event itself, so a test can
 * await the real thing: `handler(event); await event.settled;`.
 */
interface SettlingEvent {
  waitUntil(promise: Promise<unknown>): void;
  settled?: Promise<unknown>;
}

function pushEvent(data: unknown): SettlingEvent & { data: { json(): unknown } | null } {
  const event = {
    data: data === undefined ? null : { json: () => data },
    settled: undefined as Promise<unknown> | undefined,
    waitUntil(promise: Promise<unknown>) {
      event.settled = promise;
    },
  };
  return event;
}

describe("public/sw.js — the push handler (#308)", () => {
  let fakeSelf: FakeSelf;
  beforeEach(() => {
    fakeSelf = loadServiceWorker();
  });

  it("parses {draftId} and shows the same fixed line the open-tab path uses, tagged with the draft's hash", async () => {
    const [handler] = fakeSelf.listeners.push!;
    const event = pushEvent({ draftId: "draft-42" });
    handler!(event);
    await event.settled;

    expect(fakeSelf.registration.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = fakeSelf.registration.showNotification.mock.calls[0]!;
    expect(title).toBe("Duo");
    expect(options).toMatchObject({
      body: "A new draft is waiting for your review.",
      tag: "duo-draft-draft-42",
      data: { hash: "#draft/draft-42" },
    });
  });

  it("#268: an autonomous reply's undo window says so and opens Waiting on you, where Stop and Edit are", async () => {
    const [handler] = fakeSelf.listeners.push!;
    const event = pushEvent({ draftId: "draft-7", kind: "autonomous_hold", sendAt: "2026-10-06T12:00:30.000Z" });
    handler!(event);
    await event.settled;
    expect(fakeSelf.registration.showNotification).toHaveBeenCalledTimes(1);
    const [title, options] = fakeSelf.registration.showNotification.mock.calls[0]!;
    expect(title).toBe("Duo");
    expect(options).toMatchObject({
      body: "Your duo is about to send a reply for you. Tap to stop or edit it.",
      tag: "duo-autonomous-draft-7",
      data: { hash: "#waiting" },
    });
  });

  it("percent-encodes a draft id that needs it", async () => {
    const [handler] = fakeSelf.listeners.push!;
    const event = pushEvent({ draftId: "has space" });
    handler!(event);
    await event.settled;
    const [, options] = fakeSelf.registration.showNotification.mock.calls[0]!;
    expect((options as { data: { hash: string } }).data.hash).toBe("#draft/has%20space");
  });

  it("still shows something for a payload it doesn't recognize, never nothing (a browser penalizes a push that shows no notification)", async () => {
    const [handler] = fakeSelf.listeners.push!;
    const event = pushEvent({ somethingElse: true });
    handler!(event);
    await event.settled;
    expect(fakeSelf.registration.showNotification).toHaveBeenCalledTimes(1);
    const [, options] = fakeSelf.registration.showNotification.mock.calls[0]!;
    expect((options as { data: { hash: string } }).data.hash).toBe("#chats");
  });

  it("never throws on an unparseable payload", async () => {
    const [handler] = fakeSelf.listeners.push!;
    const event: SettlingEvent & { data: { json(): unknown } } = {
      data: {
        json: () => {
          throw new Error("not json");
        },
      },
      settled: undefined,
      waitUntil(promise) {
        event.settled = promise;
      },
    };
    expect(() => handler!(event)).not.toThrow();
    await event.settled;
    expect(fakeSelf.registration.showNotification).toHaveBeenCalledTimes(1);
  });
});

/*
 * #311: Send and Edit actions on a draft's own notification — only when
 * this device has a mirrored credential AND the fetched record is one
 * worth acting on from here (confident, not already decided, not an
 * escalation). Every other case is the exact #308 notification, unchanged.
 */
function jsonResponse(body: unknown, ok = true): { ok: boolean; json(): Promise<unknown> } {
  return { ok, json: async () => body };
}

function draftRecord(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    outcome: null,
    escalated: false,
    draftText: "Sounds good, see you then.",
    confidenceScore: 0.9,
    escalationThreshold: 0.6,
    ...overrides,
  };
}

const CREDENTIAL = { baseUrl: "https://daemon.example", token: "device-token-1" };

describe("public/sw.js — the draft push, with Send/Edit actions (#311)", () => {
  let fakeSelf: FakeSelf;
  beforeEach(() => {
    fakeSelf = loadServiceWorker();
  });

  it("adds Send and Edit when this device holds a credential and the draft is confident", async () => {
    await mirrorCredential(fakeSelf, CREDENTIAL);
    fakeSelf.fetch.mockResolvedValue(jsonResponse(draftRecord()));

    const [handler] = fakeSelf.listeners.push!;
    const event = pushEvent({ draftId: "draft-1" });
    handler!(event);
    await event.settled;

    expect(fakeSelf.fetch).toHaveBeenCalledWith("https://daemon.example/drafts/draft-1", {
      headers: { Authorization: "Bearer device-token-1" },
    });
    const [, options] = fakeSelf.registration.showNotification.mock.calls[0]!;
    expect(options).toMatchObject({
      body: "A new draft is waiting for your review.",
      data: { hash: "#draft/draft-1", draftId: "draft-1" },
      actions: [
        { action: "duo-send", title: "Send" },
        { action: "duo-edit", title: "Edit" },
      ],
    });
  });

  it("no credential mirrored — the plain notification, no actions, no fetch attempted", async () => {
    const [handler] = fakeSelf.listeners.push!;
    const event = pushEvent({ draftId: "draft-1" });
    handler!(event);
    await event.settled;

    expect(fakeSelf.fetch).not.toHaveBeenCalled();
    const [, options] = fakeSelf.registration.showNotification.mock.calls[0]!;
    expect((options as { actions?: unknown }).actions).toBeUndefined();
  });

  it("a hedged draft (score within the margin of its threshold) gets no actions", async () => {
    await mirrorCredential(fakeSelf, CREDENTIAL);
    fakeSelf.fetch.mockResolvedValue(jsonResponse(draftRecord({ confidenceScore: 0.65, escalationThreshold: 0.6 })));

    const [handler] = fakeSelf.listeners.push!;
    const event = pushEvent({ draftId: "draft-1" });
    handler!(event);
    await event.settled;

    const [, options] = fakeSelf.registration.showNotification.mock.calls[0]!;
    expect((options as { actions?: unknown }).actions).toBeUndefined();
  });

  it("an escalated question gets no actions — there is nothing here to 'send'", async () => {
    await mirrorCredential(fakeSelf, CREDENTIAL);
    fakeSelf.fetch.mockResolvedValue(jsonResponse(draftRecord({ escalated: true, draftText: null })));

    const [handler] = fakeSelf.listeners.push!;
    const event = pushEvent({ draftId: "draft-1" });
    handler!(event);
    await event.settled;

    const [, options] = fakeSelf.registration.showNotification.mock.calls[0]!;
    expect((options as { actions?: unknown }).actions).toBeUndefined();
  });

  it("a draft already decided elsewhere gets no actions", async () => {
    await mirrorCredential(fakeSelf, CREDENTIAL);
    fakeSelf.fetch.mockResolvedValue(jsonResponse(draftRecord({ outcome: "sent" })));

    const [handler] = fakeSelf.listeners.push!;
    const event = pushEvent({ draftId: "draft-1" });
    handler!(event);
    await event.settled;

    const [, options] = fakeSelf.registration.showNotification.mock.calls[0]!;
    expect((options as { actions?: unknown }).actions).toBeUndefined();
  });

  it("a non-2xx answer falls back to the plain notification", async () => {
    await mirrorCredential(fakeSelf, CREDENTIAL);
    fakeSelf.fetch.mockResolvedValue(jsonResponse({}, false));

    const [handler] = fakeSelf.listeners.push!;
    const event = pushEvent({ draftId: "draft-1" });
    handler!(event);
    await event.settled;

    const [, options] = fakeSelf.registration.showNotification.mock.calls[0]!;
    expect((options as { actions?: unknown }).actions).toBeUndefined();
  });

  it("a network failure falls back to the plain notification, never a crash", async () => {
    await mirrorCredential(fakeSelf, CREDENTIAL);
    fakeSelf.fetch.mockRejectedValue(new Error("offline"));

    const [handler] = fakeSelf.listeners.push!;
    const event = pushEvent({ draftId: "draft-1" });
    expect(() => handler!(event)).not.toThrow();
    await event.settled;

    expect(fakeSelf.registration.showNotification).toHaveBeenCalledTimes(1);
    const [, options] = fakeSelf.registration.showNotification.mock.calls[0]!;
    expect((options as { actions?: unknown }).actions).toBeUndefined();
  });
});

describe("public/sw.js — notificationclick (#308)", () => {
  let fakeSelf: FakeSelf;
  beforeEach(() => {
    fakeSelf = loadServiceWorker();
  });

  function clickEvent(
    hash: string | undefined,
    options: { draftId?: string; action?: string } = {},
  ): SettlingEvent & {
    action?: string;
    notification: { close: ReturnType<typeof vi.fn>; data?: { hash: string; draftId?: string } };
  } {
    const event = {
      action: options.action,
      notification: {
        close: vi.fn(),
        data: hash === undefined ? undefined : { hash, ...(options.draftId ? { draftId: options.draftId } : {}) },
      },
      settled: undefined as Promise<unknown> | undefined,
      waitUntil(promise: Promise<unknown>) {
        event.settled = promise;
      },
    };
    return event;
  }

  it("focuses an already-open same-origin window and posts the hash, rather than opening a new one", async () => {
    const sameOriginClient = { url: "https://duo.example/#chats", focus: vi.fn(async () => undefined), postMessage: vi.fn() };
    fakeSelf.clients.matchAll.mockResolvedValue([sameOriginClient]);

    const [handler] = fakeSelf.listeners.notificationclick!;
    const event = clickEvent("#draft/abc");
    handler!(event);
    await event.settled;

    expect(event.notification.close).toHaveBeenCalledTimes(1);
    expect(sameOriginClient.focus).toHaveBeenCalledTimes(1);
    expect(sameOriginClient.postMessage).toHaveBeenCalledWith({ type: "duo-notification-click", hash: "#draft/abc" });
    expect(fakeSelf.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens a new window at the right address when nothing is open", async () => {
    fakeSelf.clients.matchAll.mockResolvedValue([]);
    const [handler] = fakeSelf.listeners.notificationclick!;
    const event = clickEvent("#draft/abc");
    handler!(event);
    await event.settled;
    expect(fakeSelf.clients.openWindow).toHaveBeenCalledWith("/#draft/abc");
  });

  it("skips a cross-origin client and falls through to opening a new window", async () => {
    const crossOrigin = { url: "https://not-duo.example/", focus: vi.fn(), postMessage: vi.fn() };
    fakeSelf.clients.matchAll.mockResolvedValue([crossOrigin]);
    const [handler] = fakeSelf.listeners.notificationclick!;
    const event = clickEvent("#draft/abc");
    handler!(event);
    await event.settled;
    expect(crossOrigin.focus).not.toHaveBeenCalled();
    expect(fakeSelf.clients.openWindow).toHaveBeenCalledWith("/#draft/abc");
  });

  it("falls back to #chats when the notification carries no hash", async () => {
    fakeSelf.clients.matchAll.mockResolvedValue([]);
    const [handler] = fakeSelf.listeners.notificationclick!;
    const event = clickEvent(undefined);
    handler!(event);
    await event.settled;
    expect(fakeSelf.clients.openWindow).toHaveBeenCalledWith("/#chats");
  });

  it("#311: Edit behaves exactly like a plain click — open/focus the app at the draft, nothing else", async () => {
    fakeSelf.clients.matchAll.mockResolvedValue([]);
    const [handler] = fakeSelf.listeners.notificationclick!;
    const event = clickEvent("#draft/abc", { draftId: "abc", action: "duo-edit" });
    handler!(event);
    await event.settled;
    expect(fakeSelf.fetch).not.toHaveBeenCalled();
    expect(fakeSelf.clients.openWindow).toHaveBeenCalledWith("/#draft/abc");
  });

  it("#311: Send POSTs the same outcome the in-app Send button records, with this device's mirrored token", async () => {
    await mirrorCredential(fakeSelf, CREDENTIAL);
    fakeSelf.fetch.mockResolvedValue(jsonResponse({}));
    const [handler] = fakeSelf.listeners.notificationclick!;
    const event = clickEvent("#draft/abc", { draftId: "abc", action: "duo-send" });
    handler!(event);
    await event.settled;

    expect(event.notification.close).toHaveBeenCalledTimes(1);
    expect(fakeSelf.fetch).toHaveBeenCalledWith("https://daemon.example/drafts/abc/outcome", {
      method: "POST",
      headers: { Authorization: "Bearer device-token-1", "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "sent" }),
    });
    // No app needed: Send never opens or focuses a window on success.
    expect(fakeSelf.clients.matchAll).not.toHaveBeenCalled();
    expect(fakeSelf.clients.openWindow).not.toHaveBeenCalled();
    expect(fakeSelf.registration.showNotification).toHaveBeenCalledWith("Duo", {
      body: "Sent.",
      tag: "duo-draft-abc",
      data: { hash: "#draft/abc" },
    });
  });

  it("#311: Send with no mirrored credential falls back to opening the app at the draft", async () => {
    fakeSelf.clients.matchAll.mockResolvedValue([]);
    const [handler] = fakeSelf.listeners.notificationclick!;
    const event = clickEvent("#draft/abc", { draftId: "abc", action: "duo-send" });
    handler!(event);
    await event.settled;
    expect(fakeSelf.fetch).not.toHaveBeenCalled();
    expect(fakeSelf.clients.openWindow).toHaveBeenCalledWith("/#draft/abc");
  });

  it("#311: Send that fails at the daemon falls back to opening the app, never silently", async () => {
    await mirrorCredential(fakeSelf, CREDENTIAL);
    fakeSelf.fetch.mockResolvedValue(jsonResponse({}, false));
    fakeSelf.clients.matchAll.mockResolvedValue([]);
    const [handler] = fakeSelf.listeners.notificationclick!;
    const event = clickEvent("#draft/abc", { draftId: "abc", action: "duo-send" });
    handler!(event);
    await event.settled;
    expect(fakeSelf.clients.openWindow).toHaveBeenCalledWith("/#draft/abc");
  });

  it("#311: Send over a dead network falls back to opening the app, never a crash", async () => {
    await mirrorCredential(fakeSelf, CREDENTIAL);
    fakeSelf.fetch.mockRejectedValue(new Error("offline"));
    fakeSelf.clients.matchAll.mockResolvedValue([]);
    const [handler] = fakeSelf.listeners.notificationclick!;
    const event = clickEvent("#draft/abc", { draftId: "abc", action: "duo-send" });
    expect(() => handler!(event)).not.toThrow();
    await event.settled;
    expect(fakeSelf.clients.openWindow).toHaveBeenCalledWith("/#draft/abc");
  });
});

/** The share `public/manifest.json`'s `share_target.action` POSTs here — a FormData the way a real multipart body would carry it, including a file when the share had one. */
function shareFormData(fields: { title?: string; text?: string; url?: string; files?: File[] } = {}): FormData {
  const form = new FormData();
  if (fields.title !== undefined) {
    form.set("title", fields.title);
  }
  if (fields.text !== undefined) {
    form.set("text", fields.text);
  }
  if (fields.url !== undefined) {
    form.set("url", fields.url);
  }
  for (const file of fields.files ?? []) {
    form.append("files", file);
  }
  return form;
}

function fetchEvent(method: string, url: string, formData: FormData): SettlingEvent & { request: { method: string; url: string; formData(): Promise<FormData> }; respondWith(promise: Promise<unknown>): void } {
  const event = {
    request: { method, url, formData: async () => formData },
    settled: undefined as Promise<unknown> | undefined,
    waitUntil(promise: Promise<unknown>) {
      event.settled = promise;
    },
    respondWith(promise: Promise<unknown>) {
      event.settled = promise;
    },
  };
  return event;
}

/** Reads back whatever `handleShareTarget` wrote, raw — never through `src/shareTarget.ts` (that side is `test/shareTarget.test.ts`'s own job, under its `node` environment, for exactly the Blob-fidelity reason named there); this only checks that the right record landed under the right name. */
function readRawShare(fakeSelf: FakeSelf): Promise<unknown> {
  return new Promise((resolve) => {
    const request = fakeSelf.indexedDB.open("duo-sw-share-target", 1);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("pending", "readonly");
      const getRequest = tx.objectStore("pending").get("current");
      getRequest.onsuccess = () => resolve(getRequest.result);
      getRequest.onerror = () => resolve(undefined);
    };
    request.onerror = () => resolve(undefined);
  });
}

describe("public/sw.js — the Web Share Target door (#324)", () => {
  let fakeSelf: FakeSelf;
  beforeEach(() => {
    fakeSelf = loadServiceWorker();
  });

  it("catches a POST to /share-target, writes the text fields, and redirects into the app's picker", async () => {
    const [handler] = fakeSelf.listeners.fetch!;
    const event = fetchEvent("POST", "https://duo.example/share-target", shareFormData({ title: "A page", text: "look at this", url: "https://example.com/a" }));
    handler!(event);
    const response = (await event.settled) as Response;

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://duo.example/#share");

    const stored = (await readRawShare(fakeSelf)) as { title: string; text: string; url: string; files: unknown[] };
    expect(stored).toEqual({ title: "A page", text: "look at this", url: "https://example.com/a", files: [] });
  });

  it("carries a file's name and type alongside the text", async () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const [handler] = fakeSelf.listeners.fetch!;
    const event = fetchEvent("POST", "https://duo.example/share-target", shareFormData({ text: "a note", files: [file] }));
    handler!(event);
    await event.settled;

    const stored = (await readRawShare(fakeSelf)) as { files: Array<{ name: string; type: string }> };
    expect(stored.files).toHaveLength(1);
    expect(stored.files[0]!.name).toBe("note.txt");
    expect(stored.files[0]!.type).toBe("text/plain");
  });

  it("an unreadable body still redirects — the OS's share sheet always gets a page back", async () => {
    const [handler] = fakeSelf.listeners.fetch!;
    const event = fetchEvent("POST", "https://duo.example/share-target", shareFormData());
    event.request.formData = () => Promise.reject(new Error("broken body"));
    handler!(event);
    const response = (await event.settled) as Response;
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://duo.example/#share");
  });

  it("never intercepts a GET, or a POST to any other path — only POST /share-target", async () => {
    const [handler] = fakeSelf.listeners.fetch!;
    const respondWith = vi.fn();

    const get = fetchEvent("GET", "https://duo.example/share-target", shareFormData());
    get.respondWith = respondWith;
    handler!(get);

    const otherPath = fetchEvent("POST", "https://duo.example/other", shareFormData());
    otherPath.respondWith = respondWith;
    handler!(otherPath);

    expect(respondWith).not.toHaveBeenCalled();
  });
});
