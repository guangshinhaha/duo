import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { parseConnectHash } from "../src/api/hosted.js";
import { Connect } from "../src/routes/Connect.js";

// The shell's notification side effects are Tauri's, not this file's.
vi.mock("../src/notifications.js", () => ({
  draftArrivalBody: vi.fn(() => null),
  notifyDraftReady: vi.fn(),
  postNotification: vi.fn(),
  wireNotificationClicks: vi.fn(() => Promise.resolve(() => {})),
}));

/*
 * Where claude.ai sends the owner to sign in (digital-duo#240). Google
 * Identity Services is faked on `window.google`, exactly the slice the button
 * uses, and the daemon is a fetch fake keyed by "METHOD path".
 */

const HOST = "https://api.example.org";
const CLIENT_ID = "client-123.apps.googleusercontent.com";
const HASH = `#connect?host=${encodeURIComponent(HOST)}&request=req-1`;
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

function installFakeGoogle(credential = "google-id-token") {
  let callback: ((response: { credential: string }) => void) | undefined;
  window.google = {
    accounts: {
      id: {
        initialize: (options: { client_id: string; callback: (response: { credential: string }) => void }) => {
          callback = options.callback;
        },
        renderButton: (parent: HTMLElement) => {
          const button = document.createElement("button");
          button.textContent = "Sign in with Google";
          button.onclick = () => callback?.({ credential });
          parent.appendChild(button);
        },
      },
    },
  };
}

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

function routeFetch(routes: Record<string, Route>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (!route) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no route" } }), { status: 404 });
    }
    return route(init);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const failure = (status: number, code: string, message: string) => new Response(JSON.stringify({ error: { code, message } }), { status });

const daemon = (overrides: Record<string, Route> = {}) => ({
  "GET /hosted/config": () => ok({ googleClientId: CLIENT_ID }),
  "GET /oauth/requests/req-1": () => ok({ clientName: "Claude" }),
  ...overrides,
});

afterEach(() => {
  window.location.hash = "";
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete window.google;
});

describe("parseConnectHash", () => {
  it("reads the daemon address and the request id, and refuses anything incomplete or not http(s)", () => {
    expect(parseConnectHash(HASH)).toEqual({ host: HOST, request: "req-1" });
    expect(parseConnectHash(`#connect?host=${encodeURIComponent(`${HOST}/some/path?x=1`)}&request=r`)).toEqual({ host: HOST, request: "r" });
    expect(parseConnectHash(`#connect?host=${encodeURIComponent("http://localhost:7717")}&request=r`)).toEqual({ host: "http://localhost:7717", request: "r" });
    expect(parseConnectHash(`#connect?host=${encodeURIComponent("http://api.example.org")}&request=r`)).toBeNull();
    expect(parseConnectHash("#connect?host=&request=r")).toBeNull();
    expect(parseConnectHash(`#connect?host=${encodeURIComponent(HOST)}`)).toBeNull();
    expect(parseConnectHash(`#connect?host=${encodeURIComponent("javascript:alert(1)")}&request=r`)).toBeNull();
    expect(parseConnectHash("#join?host=x&invite=y")).toBeNull();
  });
});

describe("Connect", () => {
  it("says who is asking and what they may do, then approves with the Google credential and follows the daemon's redirect", async () => {
    installFakeGoogle("the-credential");
    const navigate = vi.fn();
    const fetchMock = routeFetch(daemon({ "POST /oauth/requests/req-1/approve": () => ok({ redirectTo: `${CALLBACK}?code=abc&state=xyz`, ownerName: "Sam" }) }));
    render(<Connect hash={HASH} navigate={navigate} trustedOrigins={[HOST]} />);

    expect(await screen.findByRole("heading")).toHaveTextContent("Connect Claude to your duo");
    await waitFor(() => expect(screen.getByTestId("connect-google")).toBeInTheDocument());
    expect(screen.getByTestId("connect")).toHaveTextContent("can add notes; it can't read what is in your duo");
    expect(screen.getByTestId("connect-host")).toHaveTextContent("api.example.org");

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`${CALLBACK}?code=abc&state=xyz`));
    const approve = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/approve"));
    expect(JSON.parse(String(approve?.[1]?.body))).toEqual({ credential: "the-credential" });
  });

  it("tells a Google account with no duo so, and lets them try another account", async () => {
    installFakeGoogle();
    const navigate = vi.fn();
    routeFetch(daemon({ "POST /oauth/requests/req-1/approve": () => failure(404, "no_duo", "no duo") }));
    render(<Connect hash={HASH} navigate={navigate} trustedOrigins={[HOST]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByTestId("connect-error")).toHaveTextContent("There's no duo for this Google account, so nothing was connected");
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
  });

  it("says a lapsed request has expired instead of offering sign-in", async () => {
    installFakeGoogle();
    routeFetch(daemon({ "GET /oauth/requests/req-1": () => failure(404, "request_expired", "gone") }));
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);
    expect(await screen.findByTestId("connect-expired")).toHaveTextContent("This connection request has expired. Start again from Claude.");
    expect(screen.queryByTestId("connect-google")).toBeNull();
  });

  it("declines: tells the daemon and sends the browser back to Claude with the refusal", async () => {
    installFakeGoogle();
    const navigate = vi.fn();
    routeFetch(daemon({ "POST /oauth/requests/req-1/deny": () => ok({ redirectTo: `${CALLBACK}?error=access_denied&state=xyz` }) }));
    render(<Connect hash={HASH} navigate={navigate} trustedOrigins={[HOST]} />);

    fireEvent.click(await screen.findByTestId("connect-decline"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`${CALLBACK}?error=access_denied&state=xyz`));
    expect(screen.getByTestId("connect-declined")).toHaveTextContent("Nothing was connected");
  });

  it.each([
    ["a script address", "javascript:alert(1)"],
    ["an https address that is not Claude's", "https://phish.example/callback?code=abc"],
    ["an address that reads as claude.ai but carries credentials", "https://claude.ai@phish.example/callback"],
    ["plain http on Claude's own host", "http://claude.ai/api/mcp/auth_callback?code=abc"],
  ])("never follows %s the server names, and does not claim nothing happened", async (_label, redirectTo) => {
    installFakeGoogle();
    const navigate = vi.fn();
    routeFetch(daemon({ "POST /oauth/requests/req-1/approve": () => ok({ redirectTo }) }));
    render(<Connect hash={HASH} navigate={navigate} trustedOrigins={[HOST]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    const message = await screen.findByTestId("connect-error");
    expect(message).toHaveTextContent("won't follow");
    expect(message).toHaveTextContent("check whether it connected");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("follows claude.com as well as claude.ai", async () => {
    installFakeGoogle();
    const navigate = vi.fn();
    routeFetch(daemon({ "POST /oauth/requests/req-1/approve": () => ok({ redirectTo: "https://claude.com/api/mcp/auth_callback?code=abc" }) }));
    render(<Connect hash={HASH} navigate={navigate} trustedOrigins={[HOST]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://claude.com/api/mcp/auth_callback?code=abc"));
  });

  it("sends nothing to a server the link names but the app does not trust, and offers no sign-in", async () => {
    installFakeGoogle();
    const fetchMock = routeFetch(daemon());
    const evil = `#connect?host=${encodeURIComponent("https://evil.example")}&request=req-1`;
    render(<Connect hash={evil} navigate={vi.fn()} trustedOrigins={[HOST]} />);

    expect(screen.getByTestId("connect-untrusted")).toHaveTextContent("evil.example");
    expect(screen.queryByTestId("connect-google")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers no sign-in until the daemon has confirmed the request is live", async () => {
    installFakeGoogle();
    let release: (response: Response) => void = () => {};
    routeFetch(daemon({ "GET /oauth/requests/req-1": () => new Promise<Response>((resolve) => (release = resolve)) }));
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);

    await screen.findByText("Connecting…");
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    release(ok({ clientName: "Claude" }));
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
  });

  it("reports a failed sign-in lookup as a problem to retry, not as a server without sign-in, and keeps Decline", async () => {
    installFakeGoogle();
    let configCalls = 0;
    routeFetch(daemon({ "GET /hosted/config": () => (++configCalls === 1 ? failure(500, "boom", "boom") : ok({ googleClientId: CLIENT_ID })) }));
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);

    expect(await screen.findByTestId("connect-config-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("connect-no-sign-in")).toBeNull();
    expect(screen.getByTestId("connect-decline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
  });

  it("says so when the link is incomplete, or the server has no sign-in", async () => {
    installFakeGoogle();
    routeFetch(daemon());
    render(<Connect hash="#connect?host=&request=" navigate={vi.fn()} trustedOrigins={[HOST]} />);
    expect(screen.getByTestId("connect-invalid")).toBeInTheDocument();
    cleanup();

    routeFetch(daemon({ "GET /hosted/config": () => ok({ googleClientId: null }) }));
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);
    expect(await screen.findByTestId("connect-no-sign-in")).toBeInTheDocument();
  });

  it("is what the app opens on a #connect link, ahead of its own front door", async () => {
    installFakeGoogle();
    vi.stubEnv("VITE_DUO_DAEMON_URL", HOST);
    routeFetch(daemon());
    window.location.hash = HASH;
    render(<App />);
    expect(await screen.findByTestId("connect")).toBeInTheDocument();
    expect(await screen.findByTestId("connect-google")).toBeInTheDocument();
    expect(screen.queryByText(/Sign in to your workspace/)).toBeNull();
  });
});
