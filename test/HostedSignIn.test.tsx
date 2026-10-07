import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { App, opensOnWelcome } from "../src/App.js";
import { Landing } from "../src/routes/Landing.js";
import { Join } from "../src/routes/Join.js";
import { Settings } from "../src/routes/Settings.js";
import { InvitePeople } from "../src/components/InvitePeople.js";
import { configuredDaemonOrigin, readHostedAccount, writeHostedAccount, type AdminAccess } from "../src/api/hosted.js";
import type { DuoApiConfig } from "../src/api/client.js";

vi.mock("../src/notifications.js", () => ({
  draftArrivalBody: vi.fn(() => null),
  draftArrivalCategory: vi.fn(() => "draftsReady"),
  notifyDraftReady: vi.fn(),
  postNotification: vi.fn(),
  wireNotificationClicks: vi.fn(() => Promise.resolve(() => {})),
}));

/*
 * Hosted mode's seamless front door: a build that knows its server
 * (VITE_DUO_DAEMON_URL) opens on Sign in with Google — no address, no
 * token — and an admin invites people from Settings. Google Identity
 * Services is faked on `window.google`, exactly the slice the button uses.
 */

const ORIGIN = "https://duo-daemon.example.org";
const CLIENT_ID = "client-123.apps.googleusercontent.com";
const api: DuoApiConfig = { baseUrl: `${ORIGIN}/t/abc123`, token: "dev-tok" };

function installFakeGoogle(credential = "google-id-token") {
  let callback: ((response: { credential: string }) => void) | undefined;
  const initialize = vi.fn((options: { client_id: string; callback: (response: { credential: string }) => void }) => {
    callback = options.callback;
  });
  window.google = {
    accounts: {
      id: {
        initialize,
        renderButton: (parent: HTMLElement) => {
          const button = document.createElement("button");
          button.textContent = "Sign in with Google";
          button.onclick = () => callback?.({ credential });
          parent.appendChild(button);
        },
      },
    },
  };
  return { initialize };
}

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch fake keyed by "METHOD path" (origin-relative); anything unrouted answers an empty list. */
function routeFetch(routes: Record<string, Route>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const route = routes[key];
    return route ? route(init) : new Response("[]", { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function withClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete window.google;
});

describe("configuredDaemonOrigin", () => {
  it("is the build's daemon origin, or null when the build has none", () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", `${ORIGIN}/`);
    expect(configuredDaemonOrigin()).toBe(ORIGIN);
    vi.stubEnv("VITE_DUO_DAEMON_URL", "");
    expect(configuredDaemonOrigin()).toBeNull();
  });
});

describe("App's front door", () => {
  it("without VITE_DUO_DAEMON_URL is the Setup screen it always was", () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", "");
    render(<App />);
    expect(screen.getByRole("heading", { name: "Pair a duo instead" })).toBeInTheDocument();
    expect(screen.queryByTestId("landing")).not.toBeInTheDocument();
  });

  it("with it, opens on Sign in with Google — no address field", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", ORIGIN);
    window.location.hash = "#signin";
    installFakeGoogle();
    routeFetch({ "GET /hosted/config": () => json({ googleClientId: CLIENT_ID }) });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.getByTestId("landing")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /address/i })).not.toBeInTheDocument();
  });

  it("signing in pairs the browser to the account's duo and remembers who it is", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", ORIGIN);
    window.location.hash = "#signin";
    installFakeGoogle("the-id-token");
    const fetchMock = routeFetch({
      "GET /hosted/config": () => json({ googleClientId: CLIENT_ID }),
      "POST /hosted/login": () => json({ tenantId: "abc123", basePath: "/t/abc123", token: "new-tok", ownerName: "Sam", isAdmin: false }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({ baseUrl: `${ORIGIN}/t/abc123`, token: "new-tok" }));
    const login = fetchMock.mock.calls.find(([input]) => String(input) === `${ORIGIN}/hosted/login`);
    expect(JSON.parse(String(login?.[1]?.body))).toEqual({ credential: "the-id-token" });
    expect(readHostedAccount()).toEqual({ origin: ORIGIN, ownerName: "Sam", isAdmin: false });
    await waitFor(() => expect(screen.queryByTestId("landing")).not.toBeInTheDocument());
    expect(screen.getAllByText("Sign out").length).toBeGreaterThan(0);
  });

  it("signing out forgets the account along with the connection and returns to sign-in", async () => {
    vi.stubEnv("VITE_DUO_DAEMON_URL", ORIGIN);
    installFakeGoogle();
    routeFetch({ "GET /hosted/config": () => json({ googleClientId: CLIENT_ID }) });
    localStorage.setItem("duo.api-config", JSON.stringify(api));
    writeHostedAccount({ origin: ORIGIN, ownerName: "Sam", isAdmin: false });
    render(<App />);
    fireEvent.click(screen.getAllByText("Sign out")[0]!);
    expect(await screen.findByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(readHostedAccount()).toBeNull();
    expect(localStorage.getItem("duo.api-config")).toBeNull();
  });
});

describe("opensOnWelcome", () => {
  it("sends only a bare-root arrival to the landing page", () => {
    expect(opensOnWelcome({ pathname: "/", hash: "", search: "" })).toBe(true);
    expect(opensOnWelcome({ pathname: "/", hash: "#signin", search: "" })).toBe(false);
    expect(opensOnWelcome({ pathname: "/", hash: "#join?host=x&invite=y", search: "" })).toBe(false);
    expect(opensOnWelcome({ pathname: "/", hash: "", search: "?x=1" })).toBe(false);
    expect(opensOnWelcome({ pathname: "/ask.html", hash: "", search: "" })).toBe(false);
  });
});

describe("Landing", () => {
  it("says plainly when the Google account has no duo", async () => {
    installFakeGoogle();
    routeFetch({
      "GET /hosted/config": () => json({ googleClientId: CLIENT_ID }),
      "POST /hosted/login": () => json({ error: { code: "no_duo", message: "no duo" } }, 404),
    });
    const onSignedIn = vi.fn();
    render(<Landing onConnect={vi.fn()} onSignedIn={onSignedIn} onWorkspaceSession={vi.fn()} origin={ORIGIN} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByTestId("landing-error")).toHaveTextContent(/no duo for this Google account yet/i);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("hands the root duo's empty basePath through as the bare origin", async () => {
    installFakeGoogle();
    routeFetch({
      "GET /hosted/config": () => json({ googleClientId: CLIENT_ID }),
      "POST /hosted/login": () => json({ tenantId: null, basePath: "", token: "root-tok", ownerName: "Shin", isAdmin: true }),
    });
    const onSignedIn = vi.fn();
    render(<Landing onConnect={vi.fn()} onSignedIn={onSignedIn} onWorkspaceSession={vi.fn()} origin={ORIGIN} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    await waitFor(() =>
      expect(onSignedIn).toHaveBeenCalledWith({ baseUrl: ORIGIN, token: "root-tok" }, { origin: ORIGIN, ownerName: "Shin", isAdmin: true }),
    );
  });

  it("falls back to Setup when the server has no sign-in configured, and keeps Setup under Advanced otherwise", async () => {
    routeFetch({ "GET /hosted/config": () => json({ googleClientId: null }) });
    const { unmount } = render(<Landing onConnect={vi.fn()} onSignedIn={vi.fn()} onWorkspaceSession={vi.fn()} origin={ORIGIN} />);
    expect(await screen.findByRole("heading", { name: "Pair a duo instead" })).toBeInTheDocument();
    unmount();

    installFakeGoogle();
    routeFetch({ "GET /hosted/config": () => json({ googleClientId: CLIENT_ID }) });
    render(<Landing onConnect={vi.fn()} onSignedIn={vi.fn()} onWorkspaceSession={vi.fn()} origin={ORIGIN} />);
    fireEvent.click(await screen.findByTestId("landing-advanced"));
    expect(screen.getByRole("heading", { name: "Pair a duo instead" })).toBeInTheDocument();
  });
});

describe("Join with Google", () => {
  const hash = `#join?host=${encodeURIComponent(ORIGIN)}&invite=inv-code`;

  it("spends the invite with the Google credential instead of a typed name", async () => {
    installFakeGoogle("join-token");
    const fetchMock = routeFetch({
      "GET /hosted/config": () => json({ googleClientId: CLIENT_ID }),
      "POST /hosted/signup": () => json({ tenantId: "abc123", basePath: "/t/abc123", token: "first-tok", ownerName: "Sam", isAdmin: false }, 201),
    });
    const onJoined = vi.fn();
    render(<Join alreadyPaired={false} hash={hash} onJoined={onJoined} trustedOrigins={[ORIGIN]} />);
    const googleButton = await screen.findByRole("button", { name: "Sign in with Google" });
    expect(screen.queryByRole("textbox", { name: /your name/i })).not.toBeInTheDocument();
    fireEvent.click(googleButton);

    await waitFor(() =>
      expect(onJoined).toHaveBeenCalledWith({ baseUrl: `${ORIGIN}/t/abc123`, token: "first-tok" }, { origin: ORIGIN, ownerName: "Sam", isAdmin: false }),
    );
    const signup = fetchMock.mock.calls.find(([input]) => String(input) === `${ORIGIN}/hosted/signup`);
    expect(JSON.parse(String(signup?.[1]?.body))).toEqual({ invite: "inv-code", credential: "join-token" });
  });

  it("points an account that already has a duo back to sign-in, invite unspent", async () => {
    installFakeGoogle();
    routeFetch({
      "GET /hosted/config": () => json({ googleClientId: CLIENT_ID }),
      "POST /hosted/signup": () => json({ error: { code: "already_has_duo", message: "x" } }, 409),
    });
    render(<Join alreadyPaired={false} hash={hash} onJoined={vi.fn()} trustedOrigins={[ORIGIN]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByTestId("join-error")).toHaveTextContent(/already has a duo/i);
    expect(screen.getByTestId("join-sign-in-instead")).toHaveAttribute("href", "#");
  });

  it("shows the daemon's own words when the invite is locked to another account", async () => {
    installFakeGoogle();
    routeFetch({
      "GET /hosted/config": () => json({ googleClientId: CLIENT_ID }),
      "POST /hosted/signup": () =>
        json({ error: { code: "invite_wrong_account", message: "This invite is for sam@example.com. Sign in with that Google account." } }, 403),
    });
    render(<Join alreadyPaired={false} hash={hash} onJoined={vi.fn()} trustedOrigins={[ORIGIN]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(await screen.findByTestId("join-error")).toHaveTextContent("This invite is for sam@example.com.");
  });

  it("keeps the typed-name form against a server without sign-in", async () => {
    routeFetch({ "GET /hosted/config": () => json({ googleClientId: null }) });
    render(<Join alreadyPaired={false} hash={hash} onJoined={vi.fn()} trustedOrigins={[ORIGIN]} />);
    expect(await screen.findByRole("textbox", { name: /your name/i })).toBeInTheDocument();
  });
});

describe("Invite people (admins)", () => {
  // What the shell says (`adminRoleOf`, the daemon's live role): Settings follows it, never the stored sign-in flag.
  const settings = (admin?: AdminAccess) => (
    <Settings admin={admin} api={api} onConfigChange={vi.fn()} onPairDuo={vi.fn()} onSignOut={vi.fn()} onWorkspaceSignIn={vi.fn()} session={null} />
  );

  it("is absent for a signed-in non-admin, present for a super admin", async () => {
    routeFetch({});
    writeHostedAccount({ origin: ORIGIN, ownerName: "Sam", isAdmin: false });
    const { unmount } = withClient(settings({ role: null, origin: null }));
    expect(screen.getByTestId("settings-account")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-invite-people")).not.toBeInTheDocument();
    unmount();

    writeHostedAccount({ origin: ORIGIN, ownerName: "Shin", isAdmin: true });
    withClient(settings({ role: "super", origin: ORIGIN }));
    expect(screen.getByTestId("settings-invite-people")).toBeInTheDocument();
    expect(screen.getByTestId("settings-account")).toHaveTextContent("as an admin of this server");
  });

  it("a stale stored admin flag keeps nothing on screen once the shell says the role is gone", async () => {
    routeFetch({});
    writeHostedAccount({ origin: ORIGIN, ownerName: "Shin", isAdmin: true });
    withClient(settings({ role: null, origin: null }));
    expect(screen.queryByTestId("settings-invite-people")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-account")).not.toHaveTextContent("as an admin of this server");
  });

  it("an org admin is not the server's admin: no invite tool of the server's", async () => {
    routeFetch({});
    writeHostedAccount({ origin: ORIGIN, ownerName: "Ada", isAdmin: false, orgRole: "org_admin" });
    withClient(settings({ role: "org", origin: ORIGIN }));
    expect(screen.queryByTestId("settings-invite-people")).not.toBeInTheDocument();
  });

  it("asks the paired origin the shell names, not the stored account's", async () => {
    const fetchMock = routeFetch({});
    writeHostedAccount({ origin: "https://elsewhere.example.org", ownerName: "Shin", isAdmin: true });
    withClient(settings({ role: "super", origin: ORIGIN }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const called = fetchMock.mock.calls.map(([input]) => String(input));
    expect(called.every((url) => url.startsWith(ORIGIN))).toBe(true);
    expect(called.some((url) => url.includes("elsewhere"))).toBe(false);
  });

  it("mints an invite with this device's token at the daemon origin and shows the link once", async () => {
    const fetchMock = routeFetch({
      "GET /hosted/invites": () =>
        json([{ id: "i1", name: "Kim", email: null, createdAt: "2026-09-20T00:00:00Z", expiresAt: "2026-09-21T00:00:00Z", usedAt: "2026-09-20T01:00:00Z", tenantId: "k1" }]),
      "POST /hosted/invites": () =>
        json(
          { id: "i2", name: "Sam", email: "sam@example.com", expiresAt: "2099-01-01T00:00:00Z", code: "c0de", link: "https://web.example/#join?host=x&invite=c0de" },
          201,
        ),
    });
    withClient(<InvitePeople api={api} origin={ORIGIN} />);
    expect(await screen.findByTestId("invite-status")).toHaveTextContent("Joined");

    fireEvent.change(screen.getByRole("textbox", { name: /who it's for/i }), { target: { value: "Sam" } });
    fireEvent.change(screen.getByRole("textbox", { name: /google/i }), { target: { value: "sam@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite" }));

    expect(await screen.findByTestId("invite-link")).toHaveTextContent("https://web.example/#join?host=x&invite=c0de");
    const post = fetchMock.mock.calls.find(([input, init]) => String(input) === `${ORIGIN}/hosted/invites` && init?.method === "POST");
    expect((post?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer dev-tok");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ name: "Sam", email: "sam@example.com", expiresInHours: 168 });
  });
});
