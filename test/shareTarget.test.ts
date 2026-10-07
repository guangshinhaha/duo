// @vitest-environment node
//
// happy-dom's `Blob` doesn't carry what `fake-indexeddb`'s structured-clone
// needs to hand one back whole (it reads back as a plain object, methods
// gone) — a limitation of this test's two stand-ins meeting each other,
// never of a real browser's own IndexedDB. Node's real `Blob` doesn't have
// the gap, and this module needs no DOM otherwise.
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { readPendingShare, stashShareForRoom, takeShareForRoom } from "../src/shareTarget.js";

/*
 * #324: the client half of the Web Share Target handoff. `public/sw.js`
 * writes what it caught into this origin's own IndexedDB
 * (`duo-sw-share-target`/`pending`/`current` — the exact names this reads
 * back, pinned here so the two sides of the handoff can never drift apart
 * silently); `test/ServiceWorker.test.ts` drives the writing side against
 * the real shipped bytes. This drives the reading side against a real (if
 * fresh per test) IndexedDB, the same `fake-indexeddb` package
 * `WorkspaceCache.test.ts` already uses.
 */

function writeRaw(factory: IDBFactory, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open("duo-sw-share-target", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("pending");
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("pending", "readwrite");
      tx.objectStore("pending").put(value, "current");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe("#324 — reading the share a service worker caught", () => {
  let factory: IDBFactory;
  beforeEach(() => {
    factory = new IDBFactory();
  });

  it("reads back exactly what was written, and clears it", async () => {
    await writeRaw(factory, { title: "A page", text: "look at this", url: "https://example.com/a", files: [] });

    const first = await readPendingShare(factory);
    expect(first).toEqual({ title: "A page", text: "look at this", url: "https://example.com/a", files: [] });

    const second = await readPendingShare(factory);
    expect(second).toBeNull();
  });

  it("carries a file's bytes, name and type", async () => {
    const blob = new Blob(["hello"], { type: "text/plain" });
    await writeRaw(factory, { title: "", text: "", url: "", files: [{ name: "note.txt", type: "text/plain", blob }] });

    const share = await readPendingShare(factory);
    expect(share?.files).toHaveLength(1);
    expect(share?.files[0]?.name).toBe("note.txt");
    expect(share?.files[0]?.type).toBe("text/plain");
    expect(await share?.files[0]?.blob.text()).toBe("hello");
  });

  it("nothing shared reads as null, never an error", async () => {
    expect(await readPendingShare(factory)).toBeNull();
  });

  it("something unrelated in the store doesn't crash — it's just not a share", async () => {
    await writeRaw(factory, { not: "a share" });
    expect(await readPendingShare(factory)).toBeNull();
  });

  it("with no IndexedDB at all (a sandboxed webview), it answers null rather than throwing", async () => {
    expect(await readPendingShare(undefined)).toBeNull();
  });
});

describe("#324 — the per-room handoff into a room's own composer", () => {
  it("stashes and takes exactly once — a second take finds nothing", () => {
    const file = new File(["x"], "x.txt", { type: "text/plain" });
    stashShareForRoom("!r:w", { text: "hello", files: [file] });

    const first = takeShareForRoom("!r:w");
    expect(first).toEqual({ text: "hello", files: [file] });

    expect(takeShareForRoom("!r:w")).toBeNull();
  });

  it("a room nothing was stashed for takes nothing", () => {
    expect(takeShareForRoom("!never:w")).toBeNull();
  });
});
