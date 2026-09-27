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
  delete window.google;
});

describe("parseConnectHash", () => {
  it("reads the daemon address and the request id, and refuses anything incomplete or not http(s)", () => {
    expect(parseConnectHash(HASH)).toEqual({ host: HOST, request: "req-1" });
    expect(parseConnectHash(`#connect?host=${encodeURIComponent(`${HOST}/`)}&request=r`)).toEqual({ host: HOST, request: "r" });
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
    render(<Connect hash={HASH} navigate={navigate} />);

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
    render(<Connect hash={HASH} navigate={navigate} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByTestId("connect-error")).toHaveTextContent("There's no duo for this Google account, so nothing was connected");
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
  });

  it("says a lapsed request has expired instead of offering sign-in", async () => {
    installFakeGoogle();
    routeFetch(daemon({ "GET /oauth/requests/req-1": () => failure(404, "request_expired", "gone") }));
    render(<Connect hash={HASH} navigate={vi.fn()} />);
    expect(await screen.findByTestId("connect-expired")).toHaveTextContent("This connection request has expired. Start again from Claude.");
    expect(screen.queryByTestId("connect-google")).toBeNull();
  });

  it("declines: tells the daemon and sends the browser back to Claude with the refusal", async () => {
    installFakeGoogle();
    const navigate = vi.fn();
    routeFetch(daemon({ "POST /oauth/requests/req-1/deny": () => ok({ redirectTo: `${CALLBACK}?error=access_denied&state=xyz` }) }));
    render(<Connect hash={HASH} navigate={navigate} />);

    fireEvent.click(await screen.findByTestId("connect-decline"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`${CALLBACK}?error=access_denied&state=xyz`));
    expect(screen.getByTestId("connect-declined")).toHaveTextContent("Nothing was connected");
  });

  it("never follows a redirect that is not https", async () => {
    installFakeGoogle();
    const navigate = vi.fn();
    routeFetch(daemon({ "POST /oauth/requests/req-1/approve": () => ok({ redirectTo: "javascript:alert(1)" }) }));
    render(<Connect hash={HASH} navigate={navigate} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByTestId("connect-error")).toHaveTextContent("won't follow");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("says so when the link is incomplete, or the server has no sign-in", async () => {
    installFakeGoogle();
    routeFetch(daemon());
    render(<Connect hash="#connect?host=&request=" navigate={vi.fn()} />);
    expect(screen.getByTestId("connect-invalid")).toBeInTheDocument();
    cleanup();

    routeFetch(daemon({ "GET /hosted/config": () => ok({ googleClientId: null }) }));
    render(<Connect hash={HASH} navigate={vi.fn()} />);
    expect(await screen.findByTestId("connect-no-sign-in")).toBeInTheDocument();
  });

  it("is what the app opens on a #connect link, ahead of its own front door", async () => {
    installFakeGoogle();
    routeFetch(daemon());
    window.location.hash = HASH;
    render(<App />);
    expect(await screen.findByTestId("connect")).toBeInTheDocument();
    expect(screen.queryByText(/Sign in to your workspace/)).toBeNull();
  });
});
