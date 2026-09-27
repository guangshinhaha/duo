import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  // Google's popup can finish after the button is gone from the page: this fires the callback it registered, button or not.
  return { fire: () => callback?.({ credential }) };
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

const PERMISSIONS = [
  { id: "duo:read", label: "Read", description: "Search your duo and ask it questions.", defaultOn: true },
  { id: "duo:save", label: "Save", description: "Add notes to your duo.", defaultOn: true },
  { id: "duo:operate", label: "Operate", description: "Embed, derive and draft replies.", defaultOn: true },
  { id: "duo:send", label: "Send", description: "Record a draft as sent, which can deliver a message as you.", defaultOn: false },
];
const withPermissions = (permissions = PERMISSIONS) => daemon({ "GET /oauth/requests/req-1": () => ok({ clientName: "Claude", scopes: permissions }) });

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

describe("Connect: what the owner allows (digital-duo#256)", () => {
  it("lists what Claude is asking for in the daemon's words, ticks the usual three, and leaves Send unticked", async () => {
    installFakeGoogle();
    routeFetch(withPermissions());
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);

    expect(await screen.findByTestId("connect-scopes")).toHaveTextContent("Choose what it may do");
    for (const id of ["duo:read", "duo:save", "duo:operate"]) {
      expect(within(screen.getByTestId(`connect-scope-${id}`)).getByRole("checkbox")).toBeChecked();
    }
    expect(within(screen.getByTestId("connect-scope-duo:send")).getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByTestId("connect-scope-duo:send")).toHaveTextContent("can deliver a message as you");
    expect(screen.queryByTestId("connect-send-warning")).toBeNull();
    expect(screen.queryByText(/it can't read what is in your duo/)).toBeNull();
  });

  it("sends exactly what is ticked with the approval, and warns when Send is ticked", async () => {
    installFakeGoogle("the-credential");
    const fetchMock = routeFetch({
      ...withPermissions(),
      "POST /oauth/requests/req-1/approve": () => ok({ redirectTo: `${CALLBACK}?code=abc&state=xyz`, ownerName: "Sam" }),
    });
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);

    await screen.findByTestId("connect-scopes");
    fireEvent.click(within(screen.getByTestId("connect-scope-duo:send")).getByRole("checkbox"));
    expect(screen.getByTestId("connect-send-warning")).toHaveTextContent("Send lets Claude act as you");
    fireEvent.click(within(screen.getByTestId("connect-scope-duo:save")).getByRole("checkbox"));

    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/approve"))).toBe(true));
    const approve = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/approve"));
    expect(JSON.parse(String(approve?.[1]?.body))).toEqual({ credential: "the-credential", scopes: ["duo:read", "duo:operate", "duo:send"] });
  });

  it("offers no sign-in while nothing is ticked, and still lets the owner decline", async () => {
    installFakeGoogle();
    routeFetch(withPermissions());
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);

    await screen.findByTestId("connect-scopes");
    for (const id of ["duo:read", "duo:save", "duo:operate"]) {
      fireEvent.click(within(screen.getByTestId(`connect-scope-${id}`)).getByRole("checkbox"));
    }
    expect(screen.getByTestId("connect-choose-one")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    expect(screen.getByTestId("connect-decline")).toBeInTheDocument();
  });

  it("shows only what Claude asked for", async () => {
    installFakeGoogle();
    routeFetch(withPermissions([PERMISSIONS[0]]));
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);
    await screen.findByTestId("connect-scopes");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("falls back to the old wording, and sends no permissions, against a daemon that predates them", async () => {
    installFakeGoogle();
    const fetchMock = routeFetch({ ...daemon(), "POST /oauth/requests/req-1/approve": () => ok({ redirectTo: `${CALLBACK}?code=abc`, ownerName: "Sam" }) });
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);

    await screen.findByTestId("connect");
    expect(screen.queryByTestId("connect-scopes")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/approve"))).toBe(true));
    const approve = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/approve"));
    expect(JSON.parse(String(approve?.[1]?.body))).toEqual({ credential: "google-id-token" });
  });
});

describe("Connect: the choice at the moment Google answers (digital-duo#256 review)", () => {
  it("sends nothing when everything was unticked while the Google popup was open", async () => {
    const google = installFakeGoogle();
    const fetchMock = routeFetch({ ...withPermissions(), "POST /oauth/requests/req-1/approve": () => ok({ redirectTo: `${CALLBACK}?code=abc` }) });
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);

    await screen.findByTestId("connect-scopes");
    await screen.findByRole("button", { name: "Sign in with Google" });
    for (const id of ["duo:read", "duo:save", "duo:operate"]) {
      fireEvent.click(within(screen.getByTestId(`connect-scope-${id}`)).getByRole("checkbox"));
    }
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    google.fire();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/approve"))).toBe(false);
  });

  it("sends what is ticked when Google answers, not what was ticked when the button was clicked", async () => {
    const google = installFakeGoogle("the-credential");
    const fetchMock = routeFetch({ ...withPermissions(), "POST /oauth/requests/req-1/approve": () => ok({ redirectTo: `${CALLBACK}?code=abc` }) });
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);

    await screen.findByRole("button", { name: "Sign in with Google" });
    fireEvent.click(within(screen.getByTestId("connect-scope-duo:operate")).getByRole("checkbox"));
    google.fire();
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/approve"))).toBe(true));
    const approve = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/approve"));
    expect(JSON.parse(String(approve?.[1]?.body)).scopes).toEqual(["duo:read", "duo:save"]);
  });

  it("never ticks Send for the owner, even when the daemon's list says to", async () => {
    installFakeGoogle();
    routeFetch(withPermissions(PERMISSIONS.map((permission) => ({ ...permission, defaultOn: true }))));
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);
    await screen.findByTestId("connect-scopes");
    expect(within(screen.getByTestId("connect-scope-duo:send")).getByRole("checkbox")).not.toBeChecked();
    expect(within(screen.getByTestId("connect-scope-duo:read")).getByRole("checkbox")).toBeChecked();
  });

  it("says there is nothing to allow when the daemon lists no permissions, instead of an empty checklist", async () => {
    installFakeGoogle();
    routeFetch(withPermissions([]));
    render(<Connect hash={HASH} navigate={vi.fn()} trustedOrigins={[HOST]} />);
    expect(await screen.findByTestId("connect-nothing-offered")).toBeInTheDocument();
    expect(screen.queryByTestId("connect-scopes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).toBeNull();
    expect(screen.getByTestId("connect-decline")).toBeInTheDocument();
  });
});
