import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { mirrorCredentialForServiceWorker } from "../src/credentialMirror.js";

/*
 * #311: `public/sw.js` reads this same store directly (it cannot import
 * this module — a plain, unbundled script) but against the identical
 * database/store/key names, so this is the write half of the contract the
 * service worker's own test exercises on the read side.
 */

function readBack(factory: IDBFactory): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = factory.open("duo-sw-credential", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("config")) {
        request.result.createObjectStore("config");
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("config", "readonly");
      const get = tx.objectStore("config").get("current");
      get.onsuccess = () => {
        resolve(get.result);
        db.close();
      };
      get.onerror = () => {
        reject(get.error);
        db.close();
      };
    };
    request.onerror = () => reject(request.error);
  });
}

describe("#311 — mirroring this device's credential for the service worker", () => {
  it("writes the baseUrl and token under a fixed key", async () => {
    const factory = new IDBFactory();
    await mirrorCredentialForServiceWorker({ baseUrl: "http://100.64.1.5:7717", token: "abc123" }, factory);
    await expect(readBack(factory)).resolves.toEqual({ baseUrl: "http://100.64.1.5:7717", token: "abc123" });
  });

  it("overwrites a previous mirror rather than keeping both", async () => {
    const factory = new IDBFactory();
    await mirrorCredentialForServiceWorker({ baseUrl: "http://old:1", token: "old-token" }, factory);
    await mirrorCredentialForServiceWorker({ baseUrl: "http://new:2", token: "new-token" }, factory);
    await expect(readBack(factory)).resolves.toEqual({ baseUrl: "http://new:2", token: "new-token" });
  });

  it("clears the mirror when given null — nothing left for a closed-app notification to act on", async () => {
    const factory = new IDBFactory();
    await mirrorCredentialForServiceWorker({ baseUrl: "http://100.64.1.5:7717", token: "abc123" }, factory);
    await mirrorCredentialForServiceWorker(null, factory);
    await expect(readBack(factory)).resolves.toBeUndefined();
  });

  it("clearing an empty mirror is a harmless no-op", async () => {
    const factory = new IDBFactory();
    await expect(mirrorCredentialForServiceWorker(null, factory)).resolves.toBeUndefined();
  });

  it("never throws with no IndexedDB available at all", async () => {
    await expect(mirrorCredentialForServiceWorker({ baseUrl: "http://x", token: "y" }, undefined)).resolves.toBeUndefined();
  });
});
