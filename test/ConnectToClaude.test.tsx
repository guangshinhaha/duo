import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { ConnectToClaude } from "../src/components/ConnectToClaude.js";

const PROMPT = "Use my past chats to feed my Digital Duo.\n\n3. Save the notes with the save_notes_to_duo tool.";
const SECRET_PATH = "/mcp/s3cr3t-token-value";

interface Daemon {
  connector: { id: string; createdAt: string } | null;
  /** Set to make the daemon a sign-in one (digital-duo#240): a plain address and connections, no secret to mint. */
  signIn?: { url: string; connections: { id: string; clientName: string; createdAt: string; lastUsedAt: string | null; scopes?: string[] }[] };
  revoked?: string[];
  failMint?: boolean;
  mints: number;
}

function stubDaemon(daemon: Daemon) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/t\/[a-z0-9]+/, "");
      const revoke = /^\/connector\/connections\/([^/]+)\/revoke$/.exec(path);
      if (revoke && init?.method === "POST" && daemon.signIn) {
        daemon.revoked = [...(daemon.revoked ?? []), decodeURIComponent(revoke[1])];
        daemon.signIn = { ...daemon.signIn, connections: daemon.signIn.connections.filter((c) => c.id !== decodeURIComponent(revoke[1])) };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path === "/connector" && daemon.signIn && init?.method !== "POST") {
        return new Response(JSON.stringify({ mode: "signin", connector: null, ...daemon.signIn, historyPrompt: PROMPT }), { status: 200 });
      }
      if (path === "/connector" && init?.method === "POST") {
        if (daemon.failMint) {
          return new Response(JSON.stringify({ error: { code: "boom", message: "The daemon could not mint a connector." } }), { status: 500 });
        }
        daemon.mints += 1;
        daemon.connector = { id: `c${daemon.mints}`, createdAt: "2026-09-26T03:00:00.000Z" };
        return new Response(JSON.stringify({ ...daemon.connector, path: SECRET_PATH }), { status: 201 });
      }
      if (path === "/connector") {
        return new Response(JSON.stringify({ connector: daemon.connector, historyPrompt: PROMPT }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }),
  );
}

function renderCard(api: DuoApiConfig = { baseUrl: "https://daemon.example", token: "tok" }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConnectToClaude api={api} />
    </QueryClientProvider>,
  );
}

/** The button stays disabled until the connector status has loaded, so a click before then would do nothing. */
async function clickGenerate() {
  const button = await screen.findByRole("button", { name: "Generate connector URL" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

beforeEach(() => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => undefined) } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConnectToClaude (digital-duo#227)", () => {
  it("shows the full connector URL once after generating, with the claude.ai steps", async () => {
    stubDaemon({ connector: null, mints: 0 });
    renderCard();
    await clickGenerate();
    expect(await screen.findByTestId("connect-claude-url")).toHaveTextContent(`https://daemon.example${SECRET_PATH}`);
    expect(screen.getByTestId("connect-claude-result")).toHaveTextContent("Settings, then Connectors, then Add custom connector");
    expect(screen.getByTestId("connect-claude-result")).toHaveTextContent("won't be shown again");
    expect(screen.getByRole("button", { name: "Copy connector url" })).toBeInTheDocument();
  });

  it("offers the history prompt once a connector exists, keeping its line breaks", async () => {
    stubDaemon({ connector: null, mints: 0 });
    renderCard();
    expect(screen.queryByTestId("connect-claude-history")).toBeNull();
    await clickGenerate();
    const prompt = await screen.findByTestId("connect-claude-prompt");
    expect(prompt.textContent).toBe(PROMPT);
    expect(prompt.className).toContain("whitespace-pre-wrap");
  });

  it("returning later says a connector exists and when, and does not show the URL", async () => {
    stubDaemon({ connector: { id: "c1", createdAt: "2026-09-26T03:00:00.000Z" }, mints: 1 });
    renderCard();
    expect(await screen.findByTestId("connect-claude-existing")).toHaveTextContent(/A connector was created on/);
    expect(screen.queryByTestId("connect-claude-url")).toBeNull();
    expect(screen.getByTestId("connect-claude-prompt")).toBeInTheDocument();
  });

  it("warns before replacing, and only replaces after the owner confirms", async () => {
    const daemon: Daemon = { connector: { id: "c1", createdAt: "2026-09-26T03:00:00.000Z" }, mints: 0 };
    stubDaemon(daemon);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Generate new URL" }));
    expect(screen.getByTestId("connect-claude-confirm")).toHaveTextContent("The current URL will stop working right away");
    expect(daemon.mints).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByTestId("connect-claude-confirm")).toBeNull();
    expect(daemon.mints).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Generate new URL" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace it" }));
    expect(await screen.findByTestId("connect-claude-url")).toHaveTextContent(SECRET_PATH);
    expect(daemon.mints).toBe(1);
  });

  it("shows the daemon's error and no URL when generating fails", async () => {
    stubDaemon({ connector: null, failMint: true, mints: 0 });
    renderCard();
    await clickGenerate();
    await waitFor(() => expect(screen.getByTestId("mutation-error")).toHaveTextContent("The daemon could not mint a connector."));
    expect(screen.queryByTestId("connect-claude-url")).toBeNull();
  });

  it("keeps a hosted duo's /t/<id> prefix in the URL, so it opens that duo and no other", async () => {
    stubDaemon({ connector: null, mints: 0 });
    renderCard({ baseUrl: "https://daemon.example/t/abc123", token: "tok" });
    await clickGenerate();
    expect(await screen.findByTestId("connect-claude-url")).toHaveTextContent(`https://daemon.example/t/abc123${SECRET_PATH}`);
  });

  it("in sign-in mode shows the plain address, no generate button, and says nothing is connected yet", async () => {
    stubDaemon({ connector: null, mints: 0, signIn: { url: "https://daemon.example/mcp", connections: [] } });
    renderCard();
    expect(await screen.findByTestId("connect-claude-address")).toHaveTextContent("https://daemon.example/mcp");
    expect(screen.getByTestId("connect-claude-none")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Generate/ })).toBeNull();
    // The prompt holds no secret and is what the owner needs right after connecting, so it is there before anything is.
    expect(screen.getByTestId("connect-claude-prompt").textContent).toBe(PROMPT);
    expect(screen.getByTestId("connect-claude-history")).toHaveTextContent("Once Claude is connected, paste this into a claude.ai chat");
  });

  it("in sign-in mode lists who is connected, offers the history prompt, and disconnects one on request", async () => {
    const daemon: Daemon = {
      connector: null,
      mints: 0,
      signIn: {
        url: "https://daemon.example/mcp",
        connections: [{ id: "g1", clientName: "Claude", createdAt: "2026-09-26T03:00:00.000Z", lastUsedAt: null, scopes: ["duo:read", "duo:operate"] }],
      },
    };
    stubDaemon(daemon);
    renderCard();

    const row = await screen.findByTestId("connect-claude-connection");
    expect(row).toHaveTextContent("Claude, connected");
    expect(row).toHaveTextContent("not used yet");
    expect(screen.getByTestId("connect-claude-permissions")).toHaveTextContent("May: read, operate");
    expect(screen.getByTestId("connect-claude-prompt").textContent).toBe(PROMPT);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(daemon.revoked).toEqual(["g1"]));
    expect(await screen.findByTestId("connect-claude-none")).toBeInTheDocument();
    // Disconnecting the last Claude does not take the prompt away.
    expect(screen.getByTestId("connect-claude-prompt").textContent).toBe(PROMPT);
  });

  it("offers neither card while the mode is unknown: no Generate button before the daemon answers, or if it fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    renderCard();
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Generate/ })).toBeNull();
    cleanup();

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "boom", message: "The daemon could not be reached." } }), { status: 500 })));
    renderCard();
    expect(await screen.findByTestId("connect-claude-load-error")).toHaveTextContent("The daemon could not be reached.");
    expect(screen.queryByRole("button", { name: /Generate/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
