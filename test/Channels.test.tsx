import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Channels } from "../src/routes/Channels.js";
import type { ChannelPolicy, ChannelSummary } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/*
 * #47: the screen the owner opens to find out why it is quiet. Every
 * fixture here speaks the DAEMON'S side of the wire (digital-duo #171's
 * ChannelSummary, #172's policy routes) — and deliberately uses kinds and
 * labels this client has never heard of, because the contract under test
 * is that nothing on this screen is keyed on either (#43).
 */
const connected: ChannelSummary = {
  kind: "carrier-pigeon",
  label: "Roof loft, north window",
  state: "connected",
  lastActivityAt: "2026-09-19T16:40:00.000Z",
  muted: false,
};
const broken: ChannelSummary = {
  kind: "smoke-signal",
  label: "Hilltop beacon",
  state: "failed",
  reason: "The beacon's flint is wet — 3 sends have not lit.",
  lastActivityAt: null,
  muted: false,
};

/** A stateful daemon: GET /channels reflects the mute the POSTs wrote, the way the real one reads its one store. */
function stubDaemon(initial: ChannelSummary[], opts?: { muteStatus?: number }) {
  let channels = initial.map((c) => ({ ...c }));
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace("http://test", "");
      const method = init?.method ?? "GET";
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/channels" && method === "GET") {
        return new Response(JSON.stringify(channels), { status: 200 });
      }
      if (path === "/channels/policy/mute" || path === "/channels/policy/unmute") {
        if (opts?.muteStatus) {
          return new Response(JSON.stringify({ error: { code: "bad_request", message: "the policy store is read-only" } }), {
            status: opts.muteStatus,
          });
        }
        const { channel } = JSON.parse(String(init?.body)) as { channel: string };
        const muting = path.endsWith("/mute");
        channels = channels.map((c) => (c.kind === channel ? { ...c, muted: muting } : c));
        const policy: ChannelPolicy = { muted: channels.filter((c) => c.muted).map((c) => c.kind), mutedThreads: [] };
        return new Response(JSON.stringify(policy), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#47 AC1 — configured channels list with the daemon's own strings", () => {
  it("shows each channel's label, state and last activity, exactly as sent", async () => {
    stubDaemon([
      connected,
      { ...connected, kind: "semaphore", label: "Ridge flags", state: "degraded" as ChannelSummary["state"], lastActivityAt: "2026-09-18T08:00:00.000Z" },
    ]);
    renderWithClient(<Channels api={api} />);

    const rows = await screen.findAllByTestId("channel");
    expect(rows).toHaveLength(2);

    const first = within(rows[0]!);
    expect(first.getByTestId("channel-label")).toHaveTextContent("Roof loft, north window");
    expect(first.getByTestId("channel-state")).toHaveTextContent("connected");
    expect(first.getByTestId("channel-last-activity")).toHaveTextContent(new Date("2026-09-19T16:40:00.000Z").toLocaleString());

    // A state this client has never seen renders as the daemon spelled it —
    // nothing maps state words either.
    expect(within(rows[1]!).getByTestId("channel-state")).toHaveTextContent("degraded");
  });

  it("a channel that has never been active says so instead of showing a blank", async () => {
    stubDaemon([{ ...connected, lastActivityAt: null }]);
    renderWithClient(<Channels api={api} />);
    expect(await screen.findByTestId("channel-last-activity")).toHaveTextContent("No activity yet");
  });

  it("a kind this client has never seen renders like any other — nothing is keyed on it", async () => {
    stubDaemon([{ ...connected, kind: "never-seen-before-kind", label: "Whatever the adapter calls itself" }]);
    renderWithClient(<Channels api={api} />);
    expect(await screen.findByTestId("channel-label")).toHaveTextContent("Whatever the adapter calls itself");
    // No icon, no attribute or class derived from the kind.
    const row = screen.getByTestId("channel");
    expect(row.querySelector("svg, img")).toBeNull();
    expect(row.outerHTML.match(/never-seen-before-kind/g)).toHaveLength(1); // the kind chip's text, nowhere else
  });

  it("offers no way to connect or authorise a channel — that happens where the credentials are", async () => {
    stubDaemon([connected]);
    renderWithClient(<Channels api={api} />);
    await screen.findByTestId("channel");
    expect(screen.queryByRole("button", { name: /connect|authori[sz]e|add|set up/i })).toBeNull();
  });

  it("asks the daemon for the list and nothing else on open", async () => {
    const calls = stubDaemon([connected]);
    renderWithClient(<Channels api={api} />);
    await screen.findByTestId("channel");
    expect(calls).toEqual([{ method: "GET", path: "/channels", body: undefined }]);
  });
});

describe("#47 AC2 — a broken channel is obvious", () => {
  it("names the failure and shows the adapter's reason verbatim", async () => {
    stubDaemon([connected, broken]);
    renderWithClient(<Channels api={api} />);

    const failure = await screen.findByTestId("channel-failure");
    expect(failure).toHaveTextContent("The beacon's flint is wet — 3 sends have not lit.");
    expect(failure).toHaveTextContent(/failed/i);
    // It is announced, not merely coloured.
    expect(failure).toHaveAttribute("role", "alert");
    // And it belongs to the broken channel alone.
    const rows = screen.getAllByTestId("channel");
    expect(within(rows[0]!).getByTestId("channel-label")).toHaveTextContent("Hilltop beacon");
    expect(within(rows[0]!).getByTestId("channel-failure")).toBe(failure);
    expect(within(rows[0]!).getByTestId("channel-state")).toHaveTextContent("failed");
    expect(within(rows[1]!).queryByTestId("channel-failure")).toBeNull();
  });

  it("a failed channel without a reason still reads as failed", async () => {
    stubDaemon([{ ...broken, reason: undefined }]);
    renderWithClient(<Channels api={api} />);
    expect(await screen.findByTestId("channel-failure")).toHaveTextContent(/failed/i);
  });

  it("puts a failed channel first, where the owner will see it, whatever order the daemon sent", async () => {
    stubDaemon([connected, broken]);
    renderWithClient(<Channels api={api} />);
    const rows = await screen.findAllByTestId("channel");
    expect(within(rows[0]!).getByTestId("channel-label")).toHaveTextContent("Hilltop beacon");
    expect(within(rows[1]!).getByTestId("channel-label")).toHaveTextContent("Roof loft, north window");
  });
});

describe("#47 AC3 — channels can be muted", () => {
  it("mutes by the channel's kind through the policy route, and the state shows here", async () => {
    const calls = stubDaemon([connected]);
    renderWithClient(<Channels api={api} />);

    const row = await screen.findByTestId("channel");
    expect(within(row).queryByTestId("channel-muted")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /^mute/i }));

    await waitFor(() => expect(within(screen.getByTestId("channel")).getByTestId("channel-muted")).toBeInTheDocument());
    expect(screen.getByTestId("channel-muted")).toHaveTextContent(/no drafts/i);
    expect(calls).toContainEqual({ method: "POST", path: "/channels/policy/mute", body: { channel: "carrier-pigeon" } });
    // The shown state is the daemon's re-read, not a flag this screen keeps.
    expect(calls.filter((c) => c.method === "GET" && c.path === "/channels").length).toBeGreaterThanOrEqual(2);
  });

  it("unmutes a muted channel, reversibly", async () => {
    const calls = stubDaemon([{ ...connected, muted: true }]);
    renderWithClient(<Channels api={api} />);

    const row = await screen.findByTestId("channel");
    expect(within(row).getByTestId("channel-muted")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: /^unmute/i }));

    await waitFor(() => expect(screen.queryByTestId("channel-muted")).toBeNull());
    expect(calls).toContainEqual({ method: "POST", path: "/channels/policy/unmute", body: { channel: "carrier-pigeon" } });
    expect(within(screen.getByTestId("channel")).getByRole("button", { name: /^mute/i })).toBeInTheDocument();
  });

  it("a refused mute says so in the daemon's words and leaves the state as the daemon has it", async () => {
    stubDaemon([connected], { muteStatus: 400 });
    renderWithClient(<Channels api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: /^mute/i }));

    expect(await screen.findByTestId("channel-mute-error")).toHaveTextContent("the policy store is read-only");
    expect(screen.queryByTestId("channel-muted")).toBeNull();
  });

  it("a muted channel that has failed shows both facts", async () => {
    stubDaemon([{ ...broken, muted: true }]);
    renderWithClient(<Channels api={api} />);
    await screen.findByTestId("channel");
    expect(screen.getByTestId("channel-failure")).toBeInTheDocument();
    expect(screen.getByTestId("channel-muted")).toBeInTheDocument();
  });
});

describe("#47 AC4 — no channels reads as normal", () => {
  it("says the duo answers only the owner right now, not that something is missing", async () => {
    stubDaemon([]);
    renderWithClient(<Channels api={api} />);

    const empty = await screen.findByTestId("channels-none");
    expect(empty).toHaveTextContent(/answers only you/i);
    expect(empty).toHaveTextContent(/nothing is bridged in/i);
    // Not an unfinished-setup screen: no error, no warning tone, no call to action.
    expect(screen.queryByTestId("route-error")).toBeNull();
    expect(empty).not.toHaveAttribute("role", "alert");
    expect(screen.queryByRole("button")).toBeNull();
    expect(empty.textContent).not.toMatch(/missing|not yet|set up|finish|connect one/i);
  });
});

describe("#47 — the read's own states", () => {
  it("says what to do when the daemon can't be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    renderWithClient(<Channels api={api} />);
    expect(await screen.findByTestId("route-error")).toBeInTheDocument();
    expect(screen.queryByTestId("channels-none")).toBeNull();
  });

  it("holds a loading shape until the list arrives", async () => {
    stubDaemon([connected]);
    renderWithClient(<Channels api={api} />);
    expect(screen.getByTestId("route-loading")).toBeInTheDocument();
    await screen.findByTestId("channel");
    expect(screen.queryByTestId("route-loading")).toBeNull();
  });
});
