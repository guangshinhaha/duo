import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { logger } from "matrix-js-sdk/lib/logger.js";
import { connect, type LiveArrival, type WorkspaceConnection, type WorkspaceSession } from "../src/workspace/matrix.js";
import { forgetWorkspaceCache, workspaceCacheName } from "../src/workspace/cache.js";

/*
 * #288: open instantly from a local cache, then catch up. Unlike the seam
 * test (which mocks matrix-js-sdk), this drives the REAL SDK and its real
 * `IndexedDBStore` over `fake-indexeddb`, against a scripted homeserver on
 * `fetch` — because the claim under test is the SDK's own: that a client
 * started over a store it filled last time reaches PREPARED from that store
 * before the homeserver has answered anything at all.
 */

// The real SDK narrates every request and store write; the assertions are what this file reads.
logger.disableAll();

const HS = "https://workspace.example";
const ROOM = "!project-x:workspace.example";
const ANA: WorkspaceSession = { homeserverUrl: HS, userId: "@ana:workspace.example", accessToken: "syt_ana", deviceId: "ANADEVICE" };
const BOSE: WorkspaceSession = { homeserverUrl: HS, userId: "@bose:workspace.example", accessToken: "syt_bose", deviceId: "BOSEDEVICE" };

let seq = 0;
function event(type: string, sender: string, content: Record<string, unknown>, stateKey?: string): Record<string, unknown> {
  seq += 1;
  return {
    type,
    sender,
    content,
    event_id: `$e${seq}`,
    origin_server_ts: 1_700_000_000_000 + seq * 1000,
    ...(stateKey === undefined ? {} : { state_key: stateKey }),
  };
}

function message(sender: string, body: string): Record<string, unknown> {
  return event("m.room.message", sender, { msgtype: "m.text", body });
}

/** A first (initial) sync: one joined room, named, with one message in it. */
function initialSync(self: string, roomName: string, body: string): Record<string, unknown> {
  return {
    next_batch: "s1",
    rooms: {
      join: {
        [ROOM]: {
          state: {
            events: [
              event("m.room.create", self, { creator: self }, ""),
              event("m.room.member", self, { membership: "join", displayname: "Ana" }, self),
              event("m.room.name", self, { name: roomName }, ""),
            ],
          },
          timeline: { events: [message(self, body)], limited: false, prev_batch: "p0" },
          unread_notifications: { notification_count: 0, highlight_count: 0 },
          summary: { "m.joined_member_count": 1, "m.invited_member_count": 0 },
        },
      },
    },
    account_data: { events: [] },
  };
}

/** An incremental sync: one new message in the room. */
function incrementalSync(nextBatch: string, sender: string, body: string): Record<string, unknown> {
  return {
    next_batch: nextBatch,
    rooms: { join: { [ROOM]: { timeline: { events: [message(sender, body)], limited: false, prev_batch: "px" } } } },
  };
}

type SyncAnswer = { status: number; body: unknown } | "hang";

/**
 * A scripted homeserver. Each `/sync` takes the next answer off `syncs` (a
 * value, a promise of one, or "hang" — never answering); the endpoints the
 * SDK asks for at startup answer plainly. `silent` answers only the tiny
 * `GET /versions` and leaves every other request — push rules, filters,
 * every `/sync` — hanging forever: matrix-js-sdk 34's `startClient` awaits
 * that one request (or its failure) before it reads its store, which is the
 * one network round trip a cached open still waits for. `down` is the
 * network gone: every request fails at once, the way `fetch` does offline.
 * Hanging requests honour the abort signal, so a stopped client leaves
 * nothing behind.
 */
function homeserver(options: { syncs?: Array<SyncAnswer | Promise<SyncAnswer>>; silent?: boolean; down?: boolean } = {}) {
  const syncs = [...(options.syncs ?? [])];
  const requests: string[] = [];
  const hang = (init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (options.down) {
      throw new TypeError("Failed to fetch");
    }
    const path = url.pathname;
    if (path.endsWith("/versions")) {
      return json(200, { versions: ["v1.1", "v1.5", "v1.11"], unstable_features: {} });
    }
    if (options.silent) {
      return hang(init);
    }
    if (path.includes("/pushrules")) {
      return json(200, { global: { override: [], content: [], room: [], sender: [], underride: [] } });
    }
    if (/\/user\/[^/]+\/filter$/.test(path)) {
      return json(200, { filter_id: "f1" });
    }
    if (/\/user\/[^/]+\/filter\//.test(path)) {
      return json(200, {});
    }
    if (path.endsWith("/capabilities")) {
      return json(200, { capabilities: {} });
    }
    if (path.endsWith("/members")) {
      return json(200, { chunk: [] });
    }
    if (path.endsWith("/sync")) {
      const next = syncs.shift() ?? "hang";
      const answer = await next;
      return answer === "hang" ? hang(init) : json(answer.status, answer.body);
    }
    if (path.includes("/send/")) {
      return hang(init);
    }
    return json(404, { errcode: "M_UNRECOGNIZED", error: "Not in this script" });
  });
  return { fetch, requests };
}

function databaseNames(factory: IDBFactory): Promise<string[]> {
  return factory.databases().then((list) => list.map((info) => info.name ?? ""));
}

/** Whether the SDK's store has written a sync snapshot to this database yet (it writes after the first live sync). */
function hasSavedSync(factory: IDBFactory, name: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sync")) {
        db.close();
        resolve(false);
        return;
      }
      const count = db.transaction("sync", "readonly").objectStore("sync").count();
      count.onsuccess = () => {
        db.close();
        resolve(count.result > 0);
      };
      count.onerror = () => {
        db.close();
        reject(count.error);
      };
    };
  });
}

const dbOf = (session: WorkspaceSession): string => `matrix-js-sdk:${workspaceCacheName(session)}`;

let factory: IDBFactory;
const open: WorkspaceConnection[] = [];

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  // The SDK's backend reads membership by key range — a browser global, so
  // the fake's goes beside its factory.
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  localStorage.clear();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.stop()));
  vi.unstubAllGlobals();
});

/** Signs in once with the network up and lets the store write its first snapshot — the "last time" a cold open reads back. */
async function primeCache(session: WorkspaceSession, roomName: string, body: string): Promise<void> {
  const server = homeserver({ syncs: [{ status: 200, body: initialSync(session.userId, roomName, body) }] });
  vi.stubGlobal("fetch", server.fetch);
  const connection = await connect(session);
  await vi.waitFor(async () => expect(await hasSavedSync(factory, dbOf(session))).toBe(true));
  await connection.stop();
}

describe("#288 — a cold open renders from the local cache before the network answers", () => {
  it("a second connect (an app reload) shows the cached room list and recent messages with the homeserver silent", async () => {
    await primeCache(ANA, "Project X", "the cached words");

    // The reload: past `/versions`, not one request is ever answered — no
    // sync, no push rules, no members.
    const server = homeserver({ silent: true });
    vi.stubGlobal("fetch", server.fetch);
    const connection = await connect(ANA);
    open.push(connection);

    const rooms = await connection.rooms();
    expect(rooms.map((room) => room.name)).toEqual(["Project X"]);
    expect(rooms[0]!.latest?.body).toBe("the cached words");
    const timeline = await connection.timeline(ROOM);
    expect(timeline.map((row) => row.body)).toEqual(["the cached words"]);
    // It was asked; it never answered — what rendered came from the device.
    expect(server.requests.some((request) => request.includes("/pushrules"))).toBe(true);
  });

  it("opens from the cache with the network down altogether", async () => {
    await primeCache(ANA, "Project X", "readable offline");

    vi.stubGlobal("fetch", homeserver({ down: true }).fetch);
    const connection = await connect(ANA);
    open.push(connection);

    expect((await connection.rooms()).map((room) => room.name)).toEqual(["Project X"]);
    expect((await connection.timeline(ROOM)).map((row) => row.body)).toEqual(["readable offline"]);
  });

  it("then catches up: what arrived while closed is room news (no notification), and live messages after are arrivals again", async () => {
    await primeCache(ANA, "Project X", "before the reload");

    let answerCatchUp!: (answer: SyncAnswer) => void;
    const catchUp = new Promise<SyncAnswer>((resolve) => (answerCatchUp = resolve));
    let answerLive!: (answer: SyncAnswer) => void;
    const live = new Promise<SyncAnswer>((resolve) => (answerLive = resolve));
    vi.stubGlobal("fetch", homeserver({ syncs: [catchUp, live] }).fetch);
    const connection = await connect(ANA);
    open.push(connection);
    const heard: Array<{ roomId: string; arrival?: LiveArrival }> = [];
    connection.subscribe((roomId, arrival) => heard.push({ roomId, arrival }));

    // Still the cache: the homeserver has not answered the catch-up sync.
    expect((await connection.timeline(ROOM)).map((row) => row.body)).toEqual(["before the reload"]);

    answerCatchUp({ status: 200, body: incrementalSync("s2", "@bose:workspace.example", "said while you were away") });
    await vi.waitFor(async () =>
      expect((await connection.timeline(ROOM)).map((row) => row.body)).toEqual(["before the reload", "said while you were away"]),
    );
    // Heard as room news so every list re-reads — never as an arrival a notification would act on.
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0));
    expect(heard.every((entry) => entry.roomId === ROOM && entry.arrival === undefined)).toBe(true);

    answerLive({ status: 200, body: incrementalSync("s3", "@bose:workspace.example", "and now, live") });
    await vi.waitFor(() => expect(heard.some((entry) => entry.arrival?.body === "and now, live")).toBe(true));
  });

  it("a send still in flight (#209's local echo) is never cached as if the server had it", async () => {
    await primeCache(ANA, "Project X", "confirmed words");

    vi.stubGlobal("fetch", homeserver({ silent: true }).fetch);
    const first = await connect(ANA);
    void first.send(ROOM, "not sent yet").catch(() => undefined);
    await vi.waitFor(async () => {
      const rows = await first.timeline(ROOM);
      expect(rows.find((row) => row.body === "not sent yet")?.pending).toBe(true);
    });
    await first.stop();

    vi.stubGlobal("fetch", homeserver({ silent: true }).fetch);
    const reopened = await connect(ANA);
    open.push(reopened);
    expect((await reopened.timeline(ROOM)).map((row) => row.body)).toEqual(["confirmed words"]);
    // Nor parked in web storage under a key no sign-out would find.
    expect(Object.keys(localStorage).filter((key) => key.startsWith("mx_"))).toEqual([]);
  });
});

describe("#288 — the cache belongs to one account and leaves with it", () => {
  /** /sync refuses the credential: a connect only gets past that if a cache let it reach PREPARED first. */
  const refusing = (): ReturnType<typeof homeserver> =>
    homeserver({ syncs: [{ status: 401, body: { errcode: "M_UNKNOWN_TOKEN", error: "Invalid access token" } }] });

  it("two accounts on one device never read each other's cache", async () => {
    await primeCache(ANA, "Ana's room", "for Ana only");

    vi.stubGlobal("fetch", refusing().fetch);
    // Bose has no cache of his own, so nothing gets him past the refusal —
    // Ana's cache, had he been handed it, would have.
    await expect(connect(BOSE)).rejects.toMatchObject({ errcode: "M_UNKNOWN_TOKEN" });

    // The control: the same refusing homeserver, but Ana's own cache opens.
    vi.stubGlobal("fetch", refusing().fetch);
    const onSessionRejected = vi.fn();
    const ana = await connect(ANA, { onSessionRejected });
    open.push(ana);
    expect((await ana.rooms()).map((room) => room.name)).toEqual(["Ana's room"]);
    // …and the refusal still reaches the caller once the connection is up.
    await vi.waitFor(() => expect(onSessionRejected).toHaveBeenCalledTimes(1));
  });

  it("an account's connect sweeps away any other account's cache left on the device", async () => {
    await primeCache(BOSE, "Bose's room", "left behind");
    await primeCache(ANA, "Ana's room", "current");

    vi.stubGlobal("fetch", homeserver({ silent: true }).fetch);
    open.push(await connect(ANA));

    await vi.waitFor(async () => expect(await databaseNames(factory)).toEqual([dbOf(ANA)]));
  });

  it("signing out deletes the account's database, and the next open has nothing cached to show", async () => {
    await primeCache(ANA, "Project X", "gone after sign-out");
    expect(await databaseNames(factory)).toContain(dbOf(ANA));

    await forgetWorkspaceCache(ANA);

    expect(await databaseNames(factory)).not.toContain(dbOf(ANA));
    vi.stubGlobal("fetch", refusing().fetch);
    await expect(connect(ANA)).rejects.toMatchObject({ errcode: "M_UNKNOWN_TOKEN" });
  });

  it("the wipe is not held up by a connection that is still open", async () => {
    await primeCache(ANA, "Project X", "still open");
    vi.stubGlobal("fetch", homeserver({ silent: true }).fetch);
    open.push(await connect(ANA));

    await forgetWorkspaceCache(ANA);

    expect(await databaseNames(factory)).not.toContain(dbOf(ANA));
  });
});
