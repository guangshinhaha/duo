// @ts-expect-error no node types by design (this app's tsconfig has none — see test/Installable.test.ts's own precedent)
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("public/sw.js — notificationclick (#308)", () => {
  let fakeSelf: FakeSelf;
  beforeEach(() => {
    fakeSelf = loadServiceWorker();
  });

  function clickEvent(hash: string | undefined): SettlingEvent & { notification: { close: ReturnType<typeof vi.fn>; data?: { hash: string } } } {
    const event = {
      notification: { close: vi.fn(), data: hash === undefined ? undefined : { hash } },
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
});
