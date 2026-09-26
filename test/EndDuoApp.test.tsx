import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EndDuoResult } from "../src/api/types.js";

vi.mock("../src/workspace/matrix.js", () => ({
  connect: vi.fn(() => new Promise(() => {})),
  signIn: vi.fn(),
}));

/*
 * #55 AC3 — the app reflects the end. After a confirmed `POST
 * /lifecycle/end` the daemon drops every token, so this device's very next
 * request is a 401 — on the wire exactly a revoked token (#41). The app
 * must say the true thing (the duo was ended) and never the other one
 * ("no longer paired — run duo pair new"), whichever 401 arrives first,
 * across a relaunch, and in both shells.
 */

const PREVIEW: EndDuoResult = {
  confirmed: false,
  storeDataDir: "/Users/river/.duo/data",
  storePaths: ["duo.db", "passphrase"],
  duoDir: "/Users/river/duo",
  duoDirPaths: ["voice.md", "lifecycle.json"],
};
const SESSION = { homeserverUrl: "https://hs.example.org", userId: "@river:example.org", accessToken: "syt_x", deviceId: "DEV1" };

/** A daemon that is alive until the end is confirmed, and answers every request after it with the 401 the real one gives. */
function stubMortalDaemon() {
  let ended = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (ended) {
        return new Response(JSON.stringify({ error: { code: "unauthorized", message: "device token is not recognised" } }), { status: 401 });
      }
      const path = String(url).replace("http://d:7717", "");
      if (path === "/lifecycle/end") {
        const body = JSON.parse(String(init?.body)) as { confirmed?: boolean };
        if (body.confirmed === true) {
          ended = true;
          return new Response(JSON.stringify({ ...PREVIEW, confirmed: true }), { status: 200 });
        }
        return new Response(JSON.stringify(PREVIEW), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }),
  );
}

async function renderApp() {
  vi.resetModules();
  const { App } = await import("../src/App.js");
  return render(<App />);
}

function goHash(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
}

async function endTheDuo() {
  goHash("#settings");
  fireEvent.click(await screen.findByTestId("settings-end-duo"));
  await screen.findByTestId("end-duo-ends");
  fireEvent.change(screen.getByTestId("settings-end-duo-phrase"), { target: { value: "END" } });
  fireEvent.click(screen.getByTestId("settings-end-duo-confirm"));
}

// The app's module graph is heavy to transform the first time; pay that once,
// outside any test's own clock.
beforeAll(async () => {
  await import("../src/App.js");
}, 60_000);

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "tok" }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

describe("#55 AC3 — the app continues running, and says the duo has ended", () => {
  it("lands on Setup saying the duo was ended — not 'no longer paired' — with nothing of the duo left on this device", async () => {
    stubMortalDaemon();
    await renderApp();
    // A cache with the live duo's queries in it first, so its going is the claim under test, not a side effect of never having had one.
    const queriesPersisted = (): number => {
      const blob = localStorage.getItem("duo-cache");
      return blob === null ? 0 : (JSON.parse(blob) as { clientState: { queries: unknown[] } }).clientState.queries.length;
    };
    await waitFor(() => expect(queriesPersisted()).toBeGreaterThan(0), { timeout: 4000 });
    await endTheDuo();

    const notice = await screen.findByTestId("setup-notice");
    expect(notice).toHaveTextContent(/your duo was ended/i);
    expect(notice).not.toHaveTextContent(/no longer paired/i);
    expect(notice).not.toHaveTextContent(/duo pair new/i);
    // The dead credential and the dead duo's cached data are gone, not left readable under a token that can never work.
    expect(localStorage.getItem("duo.api-config")).toBeNull();
    // (The persister may write an EMPTY blob once more when the end mutation settles; what must not survive is any dead-duo query in it.)
    await waitFor(() => expect(queriesPersisted()).toBe(0));
    // Nothing on screen implies it is still answering: no Review, no composer, no duo surfaces.
    expect(screen.queryByText("Review")).toBeNull();
    expect(screen.queryByTestId("settings-end-duo")).toBeNull();
  });

  it("a 401 from a request already in flight cannot turn the ending into 'revoked'", async () => {
    stubMortalDaemon();
    await renderApp();
    await endTheDuo();
    await screen.findByTestId("setup-notice");
    // Whatever the stale queries and the socket say afterwards, the notice stays the true one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("setup-notice")).toHaveTextContent(/your duo was ended/i);
    expect(screen.getByTestId("setup-notice")).not.toHaveTextContent(/no longer paired/i);
  });

  it("survives a relaunch: the marker is per-device, and the next launch still says so", async () => {
    stubMortalDaemon();
    const first = await renderApp();
    await endTheDuo();
    await screen.findByTestId("setup-notice");
    expect(JSON.parse(localStorage.getItem("duo.ended") ?? "null")).toEqual({ endedAt: expect.any(String) });
    first.unmount();

    await renderApp();
    expect(await screen.findByTestId("setup-notice")).toHaveTextContent(/your duo was ended/i);
  });

  it("a fresh pairing is a new duo: the notice and the marker go, and 'ended' does not follow it", async () => {
    stubMortalDaemon();
    await renderApp();
    await endTheDuo();
    await screen.findByTestId("setup-notice");

    fireEvent.change(screen.getByPlaceholderText("100.64.1.5:7717"), { target: { value: "d:7717" } });
    fireEvent.change(screen.getByRole("textbox", { name: /token/i }), { target: { value: "tok2" } });
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => expect(screen.queryByTestId("setup-notice")).toBeNull());
    expect(localStorage.getItem("duo.ended")).toBeNull();
  });

  it("in the member shell (workspace signed in, no duo) a banner says so and stays, and Settings offers to pair rather than to end", async () => {
    localStorage.setItem("duo.workspace-session", JSON.stringify(SESSION));
    stubMortalDaemon();
    await renderApp();
    await endTheDuo();

    const banner = await screen.findByTestId("ended-notice");
    expect(banner).toHaveTextContent(/your duo was ended/i);
    expect(screen.queryByTestId("revoked-notice")).toBeNull();
    // The workspace sign-in was never the duo's to end: it stands.
    expect(JSON.parse(localStorage.getItem("duo.workspace-session") ?? "null")).toEqual(SESSION);
    expect(screen.queryByTestId("settings-end-duo")).toBeNull();
    expect(screen.getByTestId("settings-no-duo")).toBeInTheDocument();
  });

  it("an ordinary revoked token still says 'no longer paired' — the two 401s are told apart only by what this device knows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), { status: 401 })),
    );
    await renderApp();
    expect(await screen.findByTestId("setup-notice")).toHaveTextContent(/no longer paired/i);
    expect(localStorage.getItem("duo.ended")).toBeNull();
  });
});
