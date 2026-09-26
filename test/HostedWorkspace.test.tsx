import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHostedWorkspace, refreshDelayMs } from "../src/workspace/access.js";
import { fetchWorkspaceSession, revokeWorkspaceSession, workspaceSessionUrl, WorkspaceSessionShapeError } from "../src/api/hosted.js";
import type { DuoApiConfig } from "../src/api/client.js";

/*
 * #127 (auto-connect half): after Google sign-in the app asks the paired
 * daemon for the person's own workspace session (`POST
 * <basePath>/workspace/session`, digital-duo#233 and #244), holds it in memory,
 * renews it about an hour before it expires, and ends it at the workspace on
 * sign-out. When the workspace refuses it (M_UNKNOWN_TOKEN) the daemon's copy
 * is dropped with `DELETE` before the next ask.
 * These pin the hook that does it against a stubbed fetch and fake timers;
 * the app-level wiring (connect, the surfaces) is in Workspace.test.tsx.
 */

const ORIGIN = "https://duo-daemon.example.org";
const API: DuoApiConfig = { baseUrl: `${ORIGIN}/t/ada`, token: "device-token-ada" };
const BOB: DuoApiConfig = { baseUrl: `${ORIGIN}/t/bob`, token: "device-token-bob" };
/** The root duo has no path: its route is at the bare origin. */
const ROOT: DuoApiConfig = { baseUrl: ORIGIN, token: "device-token-root" };
function isSessionRoute(url: string): boolean {
  return [API, BOB, ROOT].some((config) => workspaceSessionUrl(config) === url);
}
const HOMESERVER = "https://workspace.example.org";
const HOUR = 3_600_000;

interface Reply {
  status: number;
  /** A function is read when the daemon answers, so a credential's expiry is measured from then. */
  body: unknown;
  headers?: Record<string, string>;
}

let mint = 0;
/** The daemon's 200: a fresh credential each call unless a test pins one. */
function granted(over: Partial<Record<string, unknown>> = {}, ttlMs = 24 * HOUR): Reply {
  mint += 1;
  const token = `syt_minted_${mint}`;
  return {
    status: 200,
    body: () => ({
      homeserverUrl: HOMESERVER,
      userId: "@acme.ada:workspace.example.org",
      accessToken: token,
      deviceId: null,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      ...over,
    }),
  };
}

function refusal(status: number, code: string, headers?: Record<string, string>): Reply {
  return { status, body: { error: { code, message: `daemon says ${code}` } }, headers };
}

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}

/** A stubbed fetch: daemon session `POST`s answer from `sessionReplies` in order (the last repeats), a `DELETE` answers 204; Matrix logout calls are recorded. */
function stubFetch(sessionReplies: Array<Reply | Error | Promise<Reply>>) {
  const calls: Call[] = [];
  let sessionCalls = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", authorization: headers.get("Authorization") });
    if (isSessionRoute(url) && init?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (isSessionRoute(url)) {
      const picked = sessionReplies[Math.min(sessionCalls, sessionReplies.length - 1)]!;
      sessionCalls += 1;
      if (picked instanceof Error) {
        throw picked;
      }
      const reply = await picked;
      const body = typeof reply.body === "function" ? (reply.body as () => unknown)() : reply.body;
      return new Response(JSON.stringify(body), { status: reply.status, headers: reply.headers });
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return {
    calls,
    sessionCalls: () => calls.filter((call) => isSessionRoute(call.url) && call.method === "POST"),
    drops: () => calls.filter((call) => isSessionRoute(call.url) && call.method === "DELETE"),
    logouts: () => calls.filter((call) => call.url.endsWith("/_matrix/client/v3/logout")),
  };
}

function signInAt(origin: string = ORIGIN) {
  localStorage.setItem("duo.hosted-account", JSON.stringify({ origin, ownerName: "Ada", isAdmin: false }));
}

/** Runs the hook, letting the first fetch settle. */
async function mount(api: DuoApiConfig | null = API, onUnauthorized: () => void = () => {}) {
  const view = renderHook(({ config }: { config: DuoApiConfig | null }) => useHostedWorkspace(config, onUnauthorized), {
    initialProps: { config: api },
  });
  await flush();
  return view;
}

/** Lets promises and zero-delay timers run, on fake timers. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-26T08:00:00.000Z"));
  vi.stubEnv("VITE_DUO_DAEMON_URL", ORIGIN);
  localStorage.clear();
  mint = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe("asking the daemon for the session", () => {
  it("POSTs to the paired daemon with the device token as the bearer, and holds what comes back", async () => {
    signInAt();
    const net = stubFetch([granted()]);

    const view = await mount();

    expect(net.sessionCalls()).toEqual([
      { url: workspaceSessionUrl(API), method: "POST", authorization: "Bearer device-token-ada" },
    ]);
    expect(workspaceSessionUrl(API)).toBe(`${ORIGIN}/t/ada/workspace/session`);
    expect(view.result.current.access).toEqual({ kind: "hosted-connected" });
    expect(view.result.current.session).toEqual({
      homeserverUrl: HOMESERVER,
      userId: "@acme.ada:workspace.example.org",
      accessToken: "syt_minted_1",
      deviceId: null,
    });
  });

  it("the root duo's route is at the bare origin, and the old /hosted route is never used", async () => {
    signInAt();
    const net = stubFetch([granted()]);

    await mount(ROOT);

    expect(net.sessionCalls().map((call) => call.url)).toEqual([`${ORIGIN}/workspace/session`]);
    expect(net.calls.some((call) => call.url.includes("/hosted/"))).toBe(false);
  });

  it("sends no body: nothing the caller says can name an account", async () => {
    signInAt();
    const fn = stubFetch([granted()]);
    await mount();
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(init.body).toBeUndefined();
    expect(fn.calls).toHaveLength(1);
  });

  it("is connecting until the daemon has answered", async () => {
    signInAt();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    const view = await mount();

    expect(view.result.current.access).toEqual({ kind: "hosted-connecting" });
    expect(view.result.current.session).toBeNull();
  });

  it("never sends the device token anywhere but the paired daemon: a stored account for another server gets nothing", async () => {
    signInAt("https://elsewhere.example.org");
    const net = stubFetch([granted()]);

    const view = await mount();

    expect(net.calls).toEqual([]);
    expect(view.result.current.session).toBeNull();
    // Still a hosted device: the homeserver form stays hidden.
    expect(view.result.current.access.kind).not.toBe("manual");
  });

  it("asks nothing while signed out, or on a build made for no hosted server", async () => {
    signInAt();
    const net = stubFetch([granted()]);
    await mount(null);
    expect(net.calls).toEqual([]);

    cleanup();
    vi.stubEnv("VITE_DUO_DAEMON_URL", "");
    const view = await mount();
    expect(net.calls).toEqual([]);
    expect(view.result.current.access).toEqual({ kind: "manual" });
  });

  it("a personal daemon (no hosted account on this device) stays manual and asks nothing", async () => {
    const net = stubFetch([granted()]);

    const view = await mount({ baseUrl: "http://100.64.1.5:7717", token: "tok" });

    expect(net.calls).toEqual([]);
    expect(view.result.current.access).toEqual({ kind: "manual" });
    expect(view.result.current.session).toBeNull();
  });

  it("keeps the credential out of every browser store", async () => {
    signInAt();
    stubFetch([granted()]);
    const view = await mount();
    const token = view.result.current.session!.accessToken;

    const everything = JSON.stringify({ ...localStorage, session: { ...sessionStorage } });
    expect(everything).not.toContain(token);
    expect(localStorage.getItem("duo.workspace-session")).toBeNull();
    expect(localStorage.getItem("duo-cache")).toBeNull();
  });
});

describe("each answer the daemon can give", () => {
  it("401 is signed out, tells the shell, and does not retry", async () => {
    signInAt();
    const net = stubFetch([refusal(401, "unauthorized")]);
    const onUnauthorized = vi.fn();

    const view = await mount(API, onUnauthorized);
    await advance(10 * 60_000);

    expect(view.result.current.access).toEqual({ kind: "hosted-signed-out" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(net.sessionCalls()).toHaveLength(1);
  });

  it("404 (no workspace set up) is not-set-up and is not retried", async () => {
    signInAt();
    const net = stubFetch([refusal(404, "workspace_not_configured")]);

    const view = await mount();
    await advance(10 * 60_000);

    expect(view.result.current.access).toEqual({ kind: "hosted-not-set-up" });
    expect(view.result.current.session).toBeNull();
    expect(net.sessionCalls()).toHaveLength(1);
  });

  it("403 (this device is no duo's) is also not-set-up", async () => {
    signInAt();
    stubFetch([refusal(403, "no_duo")]);
    const view = await mount();
    expect(view.result.current.access).toEqual({ kind: "hosted-not-set-up" });
  });

  it("503 workspace_pending is 'pending', honours Retry-After, and connects when the accounts exist", async () => {
    signInAt();
    const net = stubFetch([refusal(503, "workspace_pending", { "Retry-After": "60" }), granted()]);

    const view = await mount();
    expect(view.result.current.access).toEqual({ kind: "hosted-retrying", why: "pending" });

    await advance(59_000);
    expect(net.sessionCalls()).toHaveLength(1);
    await advance(1_000);
    expect(net.sessionCalls()).toHaveLength(2);
    expect(view.result.current.access).toEqual({ kind: "hosted-connected" });
    expect(view.result.current.session?.accessToken).toBe("syt_minted_1");
  });

  it("503 workspace_unavailable is 'unreachable' and waits as long as the daemon asked", async () => {
    signInAt();
    const net = stubFetch([refusal(503, "workspace_unavailable", { "Retry-After": "120" }), granted()]);

    const view = await mount();
    expect(view.result.current.access).toEqual({ kind: "hosted-retrying", why: "unreachable" });

    await advance(119_000);
    expect(net.sessionCalls()).toHaveLength(1);
    await advance(1_000);
    expect(net.sessionCalls()).toHaveLength(2);
  });

  it("503 with no Retry-After waits the daemon's usual minute", async () => {
    signInAt();
    const net = stubFetch([refusal(503, "workspace_unavailable"), granted()]);
    await mount();
    await advance(59_000);
    expect(net.sessionCalls()).toHaveLength(1);
    await advance(1_000);
    expect(net.sessionCalls()).toHaveLength(2);
  });

  it("429 backs off for minutes, not seconds, so the limiter is not fed", async () => {
    signInAt();
    const net = stubFetch([refusal(429, "rate_limited"), granted()]);

    const view = await mount();
    expect(view.result.current.access.kind).toBe("hosted-retrying");

    await advance(4 * 60_000);
    expect(net.sessionCalls()).toHaveLength(1);
    await advance(60_000);
    expect(net.sessionCalls()).toHaveLength(2);
  });

  it("no answer at all backs off 5s, 10s, 20s, 40s, then a minute — and recovers", async () => {
    signInAt();
    const net = stubFetch([new TypeError("offline"), new TypeError("offline"), new TypeError("offline"), new TypeError("offline"), new TypeError("offline"), new TypeError("offline"), granted()]);

    const view = await mount();
    expect(view.result.current.access).toEqual({ kind: "hosted-retrying", why: "unreachable" });

    const seen: number[] = [];
    for (const wait of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      await advance(wait - 1);
      seen.push(net.sessionCalls().length);
      await advance(1);
    }
    // Each retry lands exactly on its delay, never before it.
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect(net.sessionCalls()).toHaveLength(7);
    expect(view.result.current.access).toEqual({ kind: "hosted-connected" });
  });

  it("a 200 that is not the documented shape is treated as unavailable, never trusted", async () => {
    signInAt();
    stubFetch([{ status: 200, body: [] }]);
    const view = await mount();
    expect(view.result.current.access).toEqual({ kind: "hosted-retrying", why: "unreachable" });
    expect(view.result.current.session).toBeNull();
  });

  it("a renewal that fails leaves the working connection alone and tries again", async () => {
    signInAt();
    const net = stubFetch([granted(), refusal(503, "workspace_unavailable", { "Retry-After": "60" }), granted()]);
    const view = await mount();
    const key = view.result.current.reconnectKey;

    await advance(23 * HOUR);
    expect(net.sessionCalls()).toHaveLength(2);
    expect(view.result.current.access).toEqual({ kind: "hosted-connected" });
    expect(view.result.current.session?.accessToken).toBe("syt_minted_1");

    await advance(60_000);
    expect(net.sessionCalls()).toHaveLength(3);
    expect(view.result.current.session?.accessToken).toBe("syt_minted_2");
    expect(view.result.current.reconnectKey).toBe(key);
  });
});

describe("renewing before it expires", () => {
  it("asks again about an hour before expiresAt, not on a fixed interval, and renews without a reconnect", async () => {
    signInAt();
    const net = stubFetch([granted({}, 24 * HOUR), granted({}, 24 * HOUR)]);
    const view = await mount();
    const key = view.result.current.reconnectKey;

    await advance(23 * HOUR - 1_000);
    expect(net.sessionCalls()).toHaveLength(1);
    await advance(1_000);
    expect(net.sessionCalls()).toHaveLength(2);
    expect(view.result.current.session?.accessToken).toBe("syt_minted_2");
    // A routine renewal is swapped under the open connection: the key does not move.
    expect(view.result.current.reconnectKey).toBe(key);

    // ...and the next renewal is scheduled from the NEW expiry.
    await advance(23 * HOUR);
    expect(net.sessionCalls()).toHaveLength(3);
  });

  it("schedules from a short expiry too, but never faster than every 30 seconds", async () => {
    expect(refreshDelayMs(new Date(Date.now() + 90 * 60_000).toISOString(), Date.now())).toBe(30 * 60_000);
    expect(refreshDelayMs(new Date(Date.now() + 10 * 60_000).toISOString(), Date.now())).toBe(30_000);
    expect(refreshDelayMs(new Date(Date.now() - 5 * 60_000).toISOString(), Date.now())).toBe(30_000);
    expect(refreshDelayMs("not a date", Date.now())).toBe(30 * 60_000);
    expect(refreshDelayMs(new Date(Date.now() + 400 * 24 * HOUR).toISOString(), Date.now())).toBe(2_147_483_647);
  });

  it("a near-expiry session cannot become a request loop", async () => {
    signInAt();
    const net = stubFetch([granted({}, 10 * 60_000)]);
    await mount();
    await advance(5 * 60_000);
    // 10 renewals at the 30s floor over 5 minutes, not hundreds.
    expect(net.sessionCalls().length).toBeLessThanOrEqual(11);
  });
});

describe("the workspace refusing the credential (M_UNKNOWN_TOKEN)", () => {
  it("asks for a fresh session at once and asks the app to connect again", async () => {
    signInAt();
    const net = stubFetch([granted(), granted()]);
    const view = await mount();
    const key = view.result.current.reconnectKey;

    act(() => view.result.current.report("up"));
    act(() => view.result.current.report("rejected"));
    await flush();

    expect(net.sessionCalls()).toHaveLength(2);
    expect(view.result.current.session?.accessToken).toBe("syt_minted_2");
    expect(view.result.current.reconnectKey).toBe(key + 1);
  });

  it("has the daemon drop its cached session (DELETE, same auth) before the new ask — the daemon no longer notices a signed-out token itself", async () => {
    signInAt();
    const net = stubFetch([granted(), granted()]);
    const view = await mount();
    expect(net.drops()).toHaveLength(0);

    act(() => view.result.current.report("rejected"));
    await flush();

    expect(net.drops()).toEqual([{ url: workspaceSessionUrl(API), method: "DELETE", authorization: "Bearer device-token-ada" }]);
    // Drop first, then ask: the ask must not be answered from the copy being dropped.
    expect(net.calls.map((call) => call.method)).toEqual(["POST", "DELETE", "POST"]);
    // A routine renewal or a plain failure drops nothing.
    act(() => view.result.current.report("failed"));
    await advance(5_000);
    expect(net.drops()).toHaveLength(1);
  });

  it("if the DELETE cannot be made the ask goes ahead anyway", async () => {
    signInAt();
    const net = stubFetch([granted(), granted()]);
    const view = await mount();
    const stubbed = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method === "DELETE") {
        throw new TypeError("offline");
      }
      return stubbed(input, init);
    });

    act(() => view.result.current.report("rejected"));
    await flush();

    expect(net.sessionCalls()).toHaveLength(2);
  });

  it("is not a reconnect storm: at once, then after 11 seconds (the daemon keeps a token under 10s old), then a minute at a time", async () => {
    signInAt();
    const net = stubFetch([granted()]);
    const view = await mount();

    act(() => view.result.current.report("rejected"));
    await flush();
    expect(net.sessionCalls()).toHaveLength(2);

    act(() => view.result.current.report("rejected"));
    await advance(10_999);
    expect(net.sessionCalls()).toHaveLength(2);
    await advance(1);
    expect(net.sessionCalls()).toHaveLength(3);

    act(() => view.result.current.report("rejected"));
    await advance(59_999);
    expect(net.sessionCalls()).toHaveLength(3);
    await advance(1);
    expect(net.sessionCalls()).toHaveLength(4);
  });

  it("two refusals in a row do not double up while a fetch is already on its way", async () => {
    signInAt();
    let release: (reply: Reply) => void = () => {};
    const net = stubFetch([granted(), new Promise<Reply>((resolve) => (release = resolve))]);
    const view = await mount();

    act(() => view.result.current.report("rejected"));
    await flush();
    act(() => view.result.current.report("rejected"));
    await flush();
    await advance(11_000);
    // Only the one in-flight ask (plus the first): the timer found it busy.
    expect(net.sessionCalls()).toHaveLength(2);
    release(granted());
    await flush();
    expect(view.result.current.access).toEqual({ kind: "hosted-connected" });
  });

  it("a success resets the count, so a later refusal is answered at once again", async () => {
    signInAt();
    const net = stubFetch([granted()]);
    const view = await mount();

    act(() => view.result.current.report("rejected"));
    await flush();
    act(() => view.result.current.report("up"));
    act(() => view.result.current.report("rejected"));
    await flush();

    expect(net.sessionCalls()).toHaveLength(3);
  });

  it("while a fresh session is awaited it says it is connecting; if the daemon then says the workspace is down it says so", async () => {
    signInAt();
    stubFetch([granted(), refusal(503, "workspace_unavailable", { "Retry-After": "60" })]);
    const view = await mount();

    act(() => view.result.current.report("rejected"));
    await flush();

    expect(view.result.current.access).toEqual({ kind: "hosted-retrying", why: "unreachable" });
  });

  it("a connect that failed for another reason is tried again with a backoff, and reconnects on success", async () => {
    signInAt();
    const net = stubFetch([granted(), granted()]);
    const view = await mount();
    const key = view.result.current.reconnectKey;

    act(() => view.result.current.report("failed"));
    expect(view.result.current.access).toEqual({ kind: "hosted-retrying", why: "unreachable" });
    await advance(4_999);
    expect(net.sessionCalls()).toHaveLength(1);
    await advance(1);
    expect(net.sessionCalls()).toHaveLength(2);
    expect(view.result.current.reconnectKey).toBe(key + 1);
  });

  it("is ignored once signed out", async () => {
    signInAt();
    const net = stubFetch([granted()]);
    const view = await mount();
    act(() => view.result.current.signOut());

    act(() => view.result.current.report("rejected"));
    await advance(2 * 60_000);

    expect(net.sessionCalls()).toHaveLength(1);
  });
});

describe("signing out", () => {
  it("ends the session at the workspace with its own credential, then forgets it", async () => {
    signInAt();
    const net = stubFetch([granted()]);
    const view = await mount();
    const token = view.result.current.session!.accessToken;

    act(() => view.result.current.signOut());
    await flush();

    expect(net.logouts()).toEqual([
      { url: `${HOMESERVER}/_matrix/client/v3/logout`, method: "POST", authorization: `Bearer ${token}` },
    ]);
    // ...and the daemon is told to forget the copy it caches, so signing back in is not handed it.
    expect(net.drops()).toEqual([{ url: workspaceSessionUrl(API), method: "DELETE", authorization: "Bearer device-token-ada" }]);
    expect(view.result.current.session).toBeNull();
  });

  it("the device token never rides the workspace's logout, and the workspace credential never rides the daemon", async () => {
    signInAt();
    const net = stubFetch([granted(), granted()]);
    const view = await mount();
    await advance(23 * HOUR);
    act(() => view.result.current.signOut());
    await flush();

    for (const call of net.sessionCalls()) {
      expect(call.authorization).toBe("Bearer device-token-ada");
    }
    for (const call of net.logouts()) {
      expect(call.authorization).not.toContain("device-token-ada");
      expect(call.url.startsWith(HOMESERVER)).toBe(true);
    }
  });

  it("forgets the session even when the workspace cannot be reached", async () => {
    signInAt();
    const net = stubFetch([granted()]);
    const view = await mount();
    vi.mocked(fetch).mockImplementation(async () => {
      throw new TypeError("offline");
    });

    act(() => view.result.current.signOut());
    await flush();

    expect(net.logouts()).toEqual([]);
    expect(view.result.current.session).toBeNull();
  });

  it("does not ask again after signing out, and logs out once", async () => {
    signInAt();
    const net = stubFetch([granted()]);
    const view = await mount();
    act(() => view.result.current.signOut());
    view.rerender({ config: null });
    await advance(30 * HOUR);

    expect(net.sessionCalls()).toHaveLength(1);
    expect(net.logouts()).toHaveLength(1);
  });

  it("the app dropping the pairing (setApi(null)) ends the session too, without going through signOut", async () => {
    signInAt();
    const net = stubFetch([granted()]);
    const view = await mount();

    view.rerender({ config: null });
    await flush();

    expect(net.logouts()).toHaveLength(1);
    expect(view.result.current.session).toBeNull();
  });

  it("signing in as someone else ends the first person's session and asks afresh", async () => {
    signInAt();
    const net = stubFetch([granted(), granted()]);
    const view = await mount();

    view.rerender({ config: BOB });
    await flush();

    expect(net.logouts()).toHaveLength(1);
    // The first person's daemon copy is dropped with the first person's device token, at the first person's route.
    expect(net.drops()).toEqual([{ url: workspaceSessionUrl(API), method: "DELETE", authorization: "Bearer device-token-ada" }]);
    expect(net.sessionCalls().at(-1)?.url).toBe(workspaceSessionUrl(BOB));
    expect(net.sessionCalls().at(-1)?.authorization).toBe("Bearer device-token-bob");
    expect(view.result.current.session?.accessToken).toBe("syt_minted_2");
  });

  it("signing straight back in can be handed the same credential (the daemon keeps a token under 10s old); the refusal is answered by dropping it and asking again", async () => {
    signInAt();
    // The daemon hands the just-signed-out credential again, then a new one once the copy is dropped.
    const same = granted();
    const net = stubFetch([same, same, granted()]);
    const view = await mount();
    act(() => view.result.current.signOut());
    view.rerender({ config: null });
    await flush();
    view.rerender({ config: API });
    await flush();
    const handedAgain = view.result.current.session!.accessToken;
    expect(handedAgain).toBe("syt_minted_1");

    // The app connects with it, and the workspace says M_UNKNOWN_TOKEN.
    act(() => view.result.current.report("rejected"));
    await flush();

    expect(net.sessionCalls()).toHaveLength(3);
    // Two drops: one at sign-out, one because of the refusal — the last before the last ask.
    expect(net.drops()).toHaveLength(2);
    expect(net.calls.at(-2)?.method).toBe("DELETE");
    expect(view.result.current.session?.accessToken).toBe("syt_minted_2");
  });
});

describe("the daemon's answer shape", () => {
  it("fetchWorkspaceSession reads deviceId null and a missing deviceId alike", async () => {
    stubFetch([granted({ deviceId: undefined })]);
    const session = await fetchWorkspaceSession({ baseUrl: ORIGIN, token: "t" });
    expect(session.deviceId).toBeNull();
  });
});

describe("Retry-After is followed only inside a sane window", () => {
  it("a Retry-After of 0 (a proxy in front of the daemon) waits 5 seconds, not a tight loop", async () => {
    signInAt();
    const net = stubFetch([refusal(503, "workspace_unavailable", { "Retry-After": "0" }), granted()]);
    await mount();

    await advance(4_999);
    expect(net.sessionCalls()).toHaveLength(1);
    await advance(1);
    expect(net.sessionCalls()).toHaveLength(2);
  });

  it("a Retry-After of a day waits 5 minutes at most, so the person is never stuck on the retry note for hours", async () => {
    signInAt();
    const net = stubFetch([refusal(429, "rate_limited", { "Retry-After": "86400" }), granted()]);
    await mount();

    await advance(5 * 60_000 - 1);
    expect(net.sessionCalls()).toHaveLength(1);
    await advance(1);
    expect(net.sessionCalls()).toHaveLength(2);
  });
});

describe("a workspace that cannot be connected to is not asked about faster and faster", () => {
  it("the daemon answering 200 between failures does not send the backoff back to 5 seconds: 5, 10, 20, 40, then a minute", async () => {
    signInAt();
    const net = stubFetch([granted()]);
    const view = await mount();
    const waits: number[] = [];

    for (const expected of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
      const asked = net.sessionCalls().length;
      // The app connected with what the daemon gave, and the workspace could not be reached.
      act(() => view.result.current.report("failed"));
      await advance(expected - 1);
      expect(net.sessionCalls()).toHaveLength(asked);
      await advance(1);
      // The daemon answered again (a 200, which must not reset the run of failures).
      expect(net.sessionCalls()).toHaveLength(asked + 1);
      waits.push(expected);
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  it("once the connection is up the run is over: the next failure waits 5 seconds again", async () => {
    signInAt();
    const net = stubFetch([granted()]);
    const view = await mount();

    for (const wait of [5_000, 10_000]) {
      act(() => view.result.current.report("failed"));
      await advance(wait);
    }
    act(() => view.result.current.report("up"));
    const asked = net.sessionCalls().length;
    act(() => view.result.current.report("failed"));
    await advance(4_999);
    expect(net.sessionCalls()).toHaveLength(asked);
    await advance(1);
    expect(net.sessionCalls()).toHaveLength(asked + 1);
  });

  it("a routine renewal that succeeds ends the run too", async () => {
    signInAt();
    // Two failed asks at first, then a granted session that renews once.
    const net = stubFetch([new TypeError("offline"), new TypeError("offline"), granted(), granted()]);
    const view = await mount();
    await advance(5_000);
    await advance(10_000);
    expect(view.result.current.access).toEqual({ kind: "hosted-connected" });
    act(() => view.result.current.report("up"));

    await advance(23 * HOUR);
    expect(net.sessionCalls()).toHaveLength(4);
    // A later failure starts from 5s.
    act(() => view.result.current.report("failed"));
    await advance(5_000);
    expect(net.sessionCalls()).toHaveLength(5);
  });
});

describe("the workspace address the daemon returns (the token rides it)", () => {
  it("an http: answer is a shape error: nothing connects and no request carries the workspace token", async () => {
    signInAt();
    const net = stubFetch([granted({ homeserverUrl: "http://workspace.example.org" })]);

    const view = await mount();

    expect(view.result.current.session).toBeNull();
    expect(view.result.current.access).toEqual({ kind: "hosted-retrying", why: "unreachable" });
    expect(net.calls.every((call) => !(call.authorization ?? "").includes("syt_minted"))).toBe(true);
    expect(net.logouts()).toEqual([]);
    await expect(fetchWorkspaceSession(API)).rejects.toBeInstanceOf(WorkspaceSessionShapeError);
  });

  it("a homeserver that is not an address at all is a shape error too", async () => {
    stubFetch([granted({ homeserverUrl: "not a url" })]);
    await expect(fetchWorkspaceSession(API)).rejects.toBeInstanceOf(WorkspaceSessionShapeError);
  });

  it("is normalised to the same address the manual sign-in uses (its origin), so connecting and signing out name one base URL", async () => {
    signInAt();
    const net = stubFetch([granted({ homeserverUrl: "https://workspace.example.org/prefix/" })]);
    const view = await mount();
    const held = view.result.current.session!;

    expect(held.homeserverUrl).toBe("https://workspace.example.org");
    act(() => view.result.current.signOut());
    await flush();

    // Logout goes where the connection went: no path, no double slash.
    expect(net.logouts().map((call) => call.url)).toEqual(["https://workspace.example.org/_matrix/client/v3/logout"]);
  });

  it("revokeWorkspaceSession sends nothing at all for an http: address", async () => {
    const net = stubFetch([granted()]);

    await revokeWorkspaceSession({ homeserverUrl: "http://workspace.example.org", accessToken: "syt_secret" });
    await revokeWorkspaceSession({ homeserverUrl: "nonsense", accessToken: "syt_secret" });

    expect(net.calls).toEqual([]);
  });

  it("revokeWorkspaceSession for a path-prefixed address posts to the same base URL the connection uses", async () => {
    const net = stubFetch([granted()]);

    await revokeWorkspaceSession({ homeserverUrl: "https://workspace.example.org/prefix", accessToken: "syt_secret" });

    expect(net.logouts().map((call) => call.url)).toEqual(["https://workspace.example.org/_matrix/client/v3/logout"]);
  });
});

describe("a reply that lands after the hook has moved on", () => {
  /** The first ask stays open; returns the signal it was made with and a way to answer it. */
  async function holdFirstAsk(second?: Reply) {
    signInAt();
    let release: (reply: Reply) => void = () => {};
    const net = stubFetch([new Promise<Reply>((resolve) => (release = resolve)), ...(second ? [second] : [])]);
    const view = await mount();
    const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    expect(signal.aborted).toBe(false);
    return { net, view, signal, release };
  }

  it("signing out with the ask open aborts it, drops the late answer and starts no renewal", async () => {
    const { net, view, signal, release } = await holdFirstAsk();

    act(() => view.result.current.signOut());
    view.rerender({ config: null });
    expect(signal.aborted).toBe(true);
    release(granted());
    await flush();
    // No renewal was scheduled by the answer that arrived too late.
    expect(vi.getTimerCount()).toBe(0);
    await advance(30 * HOUR);

    expect(view.result.current.session).toBeNull();
    expect(view.result.current.access.kind).not.toBe("hosted-connected");
    expect(net.sessionCalls()).toHaveLength(1);
    // Nothing was held, so nothing is left to end.
    expect(net.logouts()).toEqual([]);
  });

  it("unmounting with the ask open does the same", async () => {
    const { net, view, signal, release } = await holdFirstAsk();

    view.unmount();
    expect(signal.aborted).toBe(true);
    release(granted());
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await advance(30 * HOUR);

    expect(net.sessionCalls()).toHaveLength(1);
  });

  it("re-pairing with the ask open drops the late answer and keeps only the new pairing's session", async () => {
    const { net, view, signal, release } = await holdFirstAsk(granted());

    view.rerender({ config: BOB });
    await flush();
    expect(signal.aborted).toBe(true);
    const bobsToken = view.result.current.session?.accessToken;
    expect(bobsToken).toBe("syt_minted_1");

    // The first ask's answer arrives now, for the account that is no longer paired.
    release(granted());
    await advance(1_000);

    expect(view.result.current.session?.accessToken).toBe(bobsToken);
    // One renewal timer, for the current session only.
    expect(vi.getTimerCount()).toBe(1);
    expect(net.sessionCalls().map((call) => call.url)).toEqual([workspaceSessionUrl(API), workspaceSessionUrl(BOB)]);
    expect(net.logouts()).toEqual([]);
  });
});
