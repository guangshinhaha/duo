import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { App } from "../src/App.js";
import { Join } from "../src/routes/Join.js";
import { Ask } from "../src/routes/Ask.js";
import { Setup, normalizeBaseUrl } from "../src/routes/Setup.js";
import { MayDo } from "../src/profile/MayDo.js";
import { AskLinks, askLinkUrl } from "../src/components/AskLinks.js";
import { PairAnotherDevice } from "../src/components/PairAnotherDevice.js";
import { parseJoinHash } from "../src/api/hosted.js";
import { useDraftReadySocket } from "../src/api/ws.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { AskLinkRow } from "../src/api/types.js";

// The shell's notification side effects are Tauri's, not this file's.
vi.mock("../src/notifications.js", () => ({
  draftArrivalBody: vi.fn(() => null),
  notifyDraftReady: vi.fn(),
  postNotification: vi.fn(),
  wireNotificationClicks: vi.fn(() => Promise.resolve(() => {})),
}));

/*
 * Invite-only hosted mode: one daemon origin serves many people's duos, each
 * under `/t/<tenantId>`. This file pins the client's half of that contract —
 * the invite link, the signup call, and that a duo address with a path is
 * carried whole everywhere a URL is built from it (API calls, the push
 * socket, ask links).
 */

const ORIGIN = "https://duo-daemon.example.org";
const hosted: DuoApiConfig = { baseUrl: `${ORIGIN}/t/abc123`, token: "dev-tok" };

function withClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function joinHash(host = ORIGIN, invite = "inv-code") {
  return `#join?host=${encodeURIComponent(host)}&invite=${encodeURIComponent(invite)}`;
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("parseJoinHash", () => {
  it("reads the daemon origin and invite code, trailing slash and path dropped", () => {
    expect(parseJoinHash(joinHash(`${ORIGIN}/`, "abc"))).toEqual({ host: ORIGIN, invite: "abc" });
    expect(parseJoinHash(`#join?host=${encodeURIComponent(`${ORIGIN}/some/path?x=1`)}&invite=abc`)).toEqual({ host: ORIGIN, invite: "abc" });
  });

  it("accepts plain http only for loopback, refusing it elsewhere", () => {
    expect(parseJoinHash(`#join?host=${encodeURIComponent("http://localhost:7717")}&invite=x`)).toEqual({
      host: "http://localhost:7717",
      invite: "x",
    });
    expect(parseJoinHash(`#join?host=${encodeURIComponent("http://127.0.0.1:7717")}&invite=x`)).toEqual({
      host: "http://127.0.0.1:7717",
      invite: "x",
    });
    expect(parseJoinHash(`#join?host=${encodeURIComponent("http://daemon.example.org")}&invite=x`)).toBeNull();
  });

  it("is null for a link missing either half, a non-join hash, or a non-http(s) host", () => {
    expect(parseJoinHash(`#join?host=${encodeURIComponent(ORIGIN)}`)).toBeNull();
    expect(parseJoinHash("#join?invite=abc")).toBeNull();
    expect(parseJoinHash("#review")).toBeNull();
    expect(parseJoinHash(`#join?host=${encodeURIComponent("javascript:alert(1)")}&invite=x`)).toBeNull();
  });
});

describe("Join — spending an invite", () => {
  it("posts the invite and name to {host}/hosted/signup, then hands back host + basePath with the first token", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ tenantId: "abc123", basePath: "/t/abc123", token: "first-tok", ownerName: "Sam" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onJoined = vi.fn();
    render(<Join alreadyPaired={false} hash={joinHash()} onJoined={onJoined} trustedOrigins={[ORIGIN]} />);

    fireEvent.change(await screen.findByRole("textbox", { name: /your name/i }), { target: { value: "  Sam  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create my duo" }));

    await waitFor(() =>
      expect(onJoined).toHaveBeenCalledWith({ baseUrl: `${ORIGIN}/t/abc123`, token: "first-tok" }, { origin: ORIGIN, ownerName: "Sam", isAdmin: false }),
    );
    // The first call asks the server whether it signs people in with Google (this one answers no field: the name form).
    const [url, init] = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/hosted/signup")) as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/hosted/signup`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ invite: "inv-code", name: "Sam" });
    // The invite is the credential — no bearer rides along.
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("says plainly when the invite can't be used, and lets the person try again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "invite_invalid", message: "invite unknown, used, or expired" } }), { status: 403 })),
    );
    const onJoined = vi.fn();
    render(<Join alreadyPaired={false} hash={joinHash()} onJoined={onJoined} trustedOrigins={[ORIGIN]} />);
    fireEvent.change(await screen.findByRole("textbox", { name: /your name/i }), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Create my duo" }));

    expect(await screen.findByTestId("join-error")).toHaveTextContent(/already been used, has expired/);
    expect(screen.getByRole("button", { name: "Create my duo" })).toBeEnabled();
    expect(onJoined).not.toHaveBeenCalled();
  });

  it("an unreachable server is a connection problem, not a bad invite", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    render(<Join alreadyPaired={false} hash={joinHash()} onJoined={vi.fn()} trustedOrigins={[ORIGIN]} />);
    fireEvent.change(await screen.findByRole("textbox", { name: /your name/i }), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Create my duo" }));
    expect(await screen.findByTestId("join-error")).toHaveTextContent(/Couldn't reach the duo server/);
  });

  it("an incomplete link offers no form at all", () => {
    render(<Join alreadyPaired={false} hash="#join?invite=x" onJoined={vi.fn()} trustedOrigins={[ORIGIN]} />);
    expect(screen.getByTestId("join-invalid")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("tells a browser already paired that joining replaces its pairing, and names who runs the server", () => {
    render(<Join alreadyPaired hash={joinHash()} onJoined={vi.fn()} trustedOrigins={[ORIGIN]} />);
    expect(screen.getByTestId("join-replaces")).toBeInTheDocument();
    expect(screen.getByTestId("join-host")).toHaveTextContent("duo-daemon.example.org");
  });

  it("sends nothing to a server the link names but this app doesn't trust (a build pinned to a daemon)", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", ORIGIN);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const evil = joinHash("https://evil.example", "x");
    render(<Join alreadyPaired={false} hash={evil} onJoined={vi.fn()} trustedOrigins={[ORIGIN]} />);

    expect(screen.getByTestId("join-untrusted")).toHaveTextContent("evil.example");
    expect(screen.queryByTestId("join-confirm-host")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the daemon this build was made for is trusted even when the browser isn't paired to anything yet", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ googleClientId: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Join alreadyPaired={false} hash={joinHash()} onJoined={vi.fn()} trustedOrigins={[ORIGIN]} />);
    expect(await screen.findByTestId("join-host")).toBeInTheDocument();
    expect(screen.queryByTestId("join-confirm-host")).toBeNull();
  });

  it("a daemon this browser is already paired to is trusted, by origin alone", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ googleClientId: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const pairedOrigin = "https://paired-daemon.example.org";
    render(<Join alreadyPaired hash={joinHash(pairedOrigin)} onJoined={vi.fn()} trustedOrigins={[pairedOrigin]} />);
    expect(await screen.findByTestId("join-host")).toHaveTextContent("paired-daemon.example.org");
    expect(screen.queryByTestId("join-confirm-host")).toBeNull();
  });

  it("a build with no configured daemon shows the host and waits for confirmation before sending anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const link = joinHash("https://some-daemon.example.org", "inv-code");
    render(<Join alreadyPaired={false} hash={link} onJoined={vi.fn()} trustedOrigins={[]} />);

    expect(screen.getByTestId("join-confirm-host")).toHaveTextContent("some-daemon.example.org");
    expect(screen.queryByTestId("join-host")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("join-confirm-host-button"));
    expect(await screen.findByTestId("join-host")).toHaveTextContent("some-daemon.example.org");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`https://some-daemon.example.org/hosted/config`));
  });
});

describe("Join in the app", () => {
  it("an unpaired app opened on an invite link shows Join, not Setup — and joining pairs it and lands on Onboarding", async () => {
    const empty = {
      records: { total: 0, bySource: {} },
      lastImport: null,
      corpus: { tooThin: true, minimumQuestionsToCharacterize: 10, totalQuestions: 0, periodStart: null, periodEnd: null, topicBreakdown: [] },
      rules: { byReviewStatus: { pending: 0, approved: 0, rejected: 0, superseded: 0 } },
      providers: { inference: "openrouter", embedding: { name: "ollama", model: "nomic-embed-text" } },
      sharedUsage: {
        totalQuestions: 0, distinctAskers: 0, repeatAskers: 0, answeredCount: 0, declinedCount: 0, answerRate: 0, escalationRate: 0,
        weeklyTrend: [], gaps: [], lastAskedAt: null, daysSinceLastAsk: null, abandoned: false, summary: "",
      },
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === `${ORIGIN}/hosted/signup`) {
        return new Response(JSON.stringify({ tenantId: "abc123", basePath: "/t/abc123", token: "first-tok", ownerName: "Sam" }), { status: 201 });
      }
      if (url === `${ORIGIN}/t/abc123/knowledge`) {
        return new Response(JSON.stringify(empty), { status: 200 });
      }
      if (url.endsWith("/corpus/embed") || url.endsWith("/corpus/derive")) {
        return new Response(JSON.stringify({ state: "idle", stage: null, startedAt: null, finishedAt: null, embedded: 0, total: 0, error: null }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.location.hash = joinHash();
    render(<App />);

    expect(await screen.findByTestId("join")).toBeInTheDocument();
    expect(screen.queryByText(/Sign in to your workspace/)).toBeNull();

    // This build has no configured daemon (no VITE_DUO_DAEMON_URL) and the browser isn't paired
    // to anything yet, so the host from the link is confirmed explicitly before anything is sent.
    expect(screen.getByTestId("join-confirm-host")).toHaveTextContent("duo-daemon.example.org");
    fireEvent.click(screen.getByTestId("join-confirm-host-button"));

    fireEvent.change(await screen.findByRole("textbox", { name: /your name/i }), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Create my duo" }));

    expect(await screen.findByTestId("onboarding")).toBeInTheDocument();
    expect(window.location.hash).toBe("#onboarding");
    expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({ baseUrl: `${ORIGIN}/t/abc123`, token: "first-tok" });
    // The duo's own calls go under its path.
    expect(fetchMock.mock.calls.some(([u]) => u === `${ORIGIN}/t/abc123/knowledge`)).toBe(true);
  });

  it("Setup points invitees at their link", () => {
    render(<Setup onConnect={vi.fn()} onWorkspaceSession={vi.fn()} />);
    expect(screen.getByTestId("setup-invite-hint")).toHaveTextContent(/invite link/i);
  });
});

describe("a duo address with a path is carried whole", () => {
  it("normalizeBaseUrl keeps a hosted duo's /t/<id> path, trailing slash dropped", () => {
    expect(normalizeBaseUrl(`${ORIGIN}/t/abc123/`)).toBe(`${ORIGIN}/t/abc123`);
    expect(normalizeBaseUrl("https://100.64.1.5:7717/")).toBe("https://100.64.1.5:7717");
  });

  it("the push socket connects under the path: wss://<origin>/t/<id>/ws", () => {
    class FakeWebSocket {
      static urls: string[] = [];
      constructor(url: string) {
        FakeWebSocket.urls.push(url);
      }
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    function Host() {
      useDraftReadySocket(hosted);
      return null;
    }
    withClient(<Host />);
    expect(FakeWebSocket.urls).toEqual(["wss://duo-daemon.example.org/t/abc123/ws"]);
  });

  it("the asker page posts to the path the link's host carries", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "bad_request", message: "question is required" } }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.location.hash = `#host=${encodeURIComponent(hosted.baseUrl)}&token=asktok`;
    render(<Ask />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`${ORIGIN}/t/abc123/ask`);
  });
});

describe("Ask links in Settings", () => {
  it("askLinkUrl builds this app's ask.html with the duo's full address and the token, in the hash", () => {
    expect(askLinkUrl("https://web.example.org", hosted.baseUrl, "tok+/=")).toBe(
      `https://web.example.org/ask.html#host=${encodeURIComponent(hosted.baseUrl)}&token=${encodeURIComponent("tok+/=")}`,
    );
  });

  it("mints a link with name and expiry, shows the shareable URL once, and revokes behind a confirmation", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    let links: AskLinkRow[] = [
      { id: "l1", name: "Priya", createdAt: "2026-09-26T08:00:00.000Z", expiresAt: "2026-09-29T08:00:00.000Z", revokedAt: null, valid: true },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === "POST" && url === `${hosted.baseUrl}/ask-links`) {
          return new Response(JSON.stringify({ id: "l2", name: "Sam", expiresAt: "2026-09-29T09:00:00.000Z", token: "ask-secret" }), { status: 201 });
        }
        if (method === "POST" && url.endsWith("/revoke")) {
          links = links.map((l) => ({ ...l, revokedAt: "2026-09-26T09:00:00.000Z", valid: false }));
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify(links), { status: 200 });
      }),
    );
    withClient(<AskLinks api={hosted} origin="https://web.example.org" />);

    await screen.findByTestId("ask-link-row");
    fireEvent.change(screen.getByRole("textbox", { name: /who it's for/i }), { target: { value: "Sam" } });
    expect(screen.getByRole("textbox", { name: /expires in/i })).toHaveValue("72");
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    expect(await screen.findByTestId("ask-link-url")).toHaveTextContent(
      `https://web.example.org/ask.html#host=${encodeURIComponent(hosted.baseUrl)}&token=ask-secret`,
    );
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Sam", expiresInHours: 72 });

    fireEvent.click(screen.getByTestId("ask-link-revoke"));
    fireEvent.click(await screen.findByTestId("ask-link-revoke-confirm"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === `${hosted.baseUrl}/ask-links/l1/revoke`)).toBe(true));
  });
});

describe("Pair another device", () => {
  it("mints a device token and shows it once with the address to paste", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "d2", name: "phone", token: "phone-tok" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    withClient(<PairAnotherDevice api={hosted} />);
    fireEvent.change(screen.getByRole("textbox", { name: /device name/i }), { target: { value: "phone" } });
    fireEvent.click(screen.getByRole("button", { name: "Pair device" }));

    expect(await screen.findByTestId("pair-device-token")).toHaveTextContent("phone-tok");
    expect(screen.getByTestId("pair-device-address")).toHaveTextContent(hosted.baseUrl);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${hosted.baseUrl}/devices`);
    expect(JSON.parse(String(init.body))).toEqual({ name: "phone" });
  });
});

describe("Trust writes — from the profile's May do tab", () => {
  function stubTrust(handlers: { promotions?: unknown; grant?: (body: Record<string, unknown>) => unknown }) {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        calls.push({ method, url, body });
        if (url.endsWith("/trust/promotions") && method === "GET") {
          return new Response(JSON.stringify(handlers.promotions ?? []), { status: 200 });
        }
        if (url.endsWith("/trust/grant")) {
          return new Response(JSON.stringify(handlers.grant?.(body ?? {}) ?? { status: "no_match" }), { status: 200 });
        }
        if (url.includes("/trust/promotions/")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );
    return calls;
  }

  it("never offers T4 as a kind to grant", async () => {
    stubTrust({});
    withClient(<MayDo api={hosted} />);
    await screen.findByTestId("may-empty");
    expect(screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value)).toEqual(["T0", "T1", "T2", "T3"]);
  });

  it("an ambiguous grant shows the candidates and re-posts with the one the owner picks — never a guess", async () => {
    const calls = stubTrust({
      grant: (body) =>
        body.topicId
          ? { status: "applied", topicId: body.topicId, topicLabel: "Deploy access", tier: "T1" }
          : {
              status: "ambiguous",
              candidates: [
                { topicId: "t1", label: "Deploy access", score: 1 },
                { topicId: "t2", label: "Deploy schedule", score: 0.5 },
              ],
            },
    });
    withClient(<MayDo api={hosted} />);
    fireEvent.change(await screen.findByRole("textbox", { name: /what it may handle/i }), { target: { value: "deploy questions" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    const picker = await screen.findByTestId("grant-candidates");
    expect(screen.queryByTestId("grant-outcome")).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: "Deploy access" }));

    expect(await screen.findByTestId("grant-outcome")).toHaveTextContent('on "Deploy access".');
    const grants = calls.filter((c) => c.url.endsWith("/trust/grant"));
    expect(grants.map((c) => c.body)).toEqual([
      { scopeText: "deploy questions", tier: "T1" },
      { scopeText: "deploy questions", tier: "T1", topicId: "t1" },
    ]);
  });

  it("lists promotion offers and accepts one through its own route", async () => {
    const calls = stubTrust({
      promotions: [{ topicId: "t1", topicLabel: "Deploy access", tier: "T1", currentLevel: "approve", offeredLevel: "auto", cleanStreak: 8 }],
    });
    withClient(<MayDo api={hosted} />);
    const offer = await screen.findByTestId("offer-card");
    expect(offer).toHaveTextContent("Deploy access");
    await act(async () => {
      fireEvent.click(within(offer).getByTestId("offer-accept"));
    });
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.url === `${hosted.baseUrl}/trust/promotions/t1/T1`)?.body).toEqual({ decision: "accept" }),
    );
  });
});
