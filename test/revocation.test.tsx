import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { DraftRecord } from "../src/api/types.js";

const draft: DraftRecord = {
  id: "d1",
  question: "What's our refund policy?",
  threadContext: null,
  draftText: "Refunds within 30 days.",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.8,
  sources: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.6,
};

/**
 * #41: a revoked device token ends in Setup with an explanation, not a raw
 * `ApiRequestError` sentence on whichever route happened to be open. The
 * daemon's 401 body (`§1.5`'s `{ error: { code, message } }`) is the only
 * signal needed — `ApiRequestError` already carries `status`, so the whole
 * app can branch on it from one place.
 */
const REVOKED_BODY = { error: { code: "unauthorized", message: "device token is not recognised" } };

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function revoked(): Response {
  return new Response(JSON.stringify(REVOKED_BODY), { status: 401 });
}

/** Renders the app with a stored pairing and a fetch mock whose failures the test flips mid-session. */
function mountApp(fetchMock: ReturnType<typeof vi.fn>): ReturnType<typeof render> {
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "revoked-token" }));
  vi.stubGlobal("fetch", fetchMock);
  return render(<App />);
}

function goHash(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
}

describe("#41 — a revoked token returns to Setup; an unreachable daemon is not a 401", () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = "";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    window.location.hash = "";
  });

  it("a 401 on a query clears the connection and the persisted cache, and Setup says why", async () => {
    let failWith401 = false;
    const fetchMock = vi.fn(async () => (failWith401 ? revoked() : ok([draft])));
    mountApp(fetchMock);

    // One successful sync first, so there is a config and a cache to clear —
    // clearing them is the claim under test, not a side effect of never having had them.
    await waitFor(() => expect(screen.getByText(draft.question)).toBeInTheDocument());
    await waitFor(() => expect(localStorage.getItem("duo-cache")).toContain("refund"), { timeout: 3000 });

    failWith401 = true;
    // Mounting the Duo route starts a new query (["drafts", {}]), which 401s.
    goHash("#duo");

    await waitFor(() => expect(screen.getByTestId("setup-notice")).toBeInTheDocument());
    expect(screen.getByTestId("setup-notice")).toHaveTextContent(/no longer paired/i);
    // Back on the first-run screen, with neither the connection nor the old duo's cached data left on this device.
    expect(screen.getByPlaceholderText("100.64.1.5:7717")).toBeInTheDocument();
    expect(localStorage.getItem("duo.api-config")).toBeNull();
    await waitFor(() => expect(localStorage.getItem("duo-cache")).toBeNull());
  });

  it("a 401 on a mutation returns to Setup the same way", async () => {
    let failWith401 = false;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST" && failWith401) {
        return revoked();
      }
      return ok([draft]);
    });
    mountApp(fetchMock);
    await waitFor(() => expect(screen.getByText(draft.question)).toBeInTheDocument());

    failWith401 = true;
    fireEvent.click(screen.getByText("Send", { selector: "button" }));

    await waitFor(() => expect(screen.getByTestId("setup-notice")).toBeInTheDocument());
    expect(localStorage.getItem("duo.api-config")).toBeNull();
    await waitFor(() => expect(localStorage.getItem("duo-cache")).toBeNull());
  });

  // Long timeout: a network-level failure legitimately retries (TanStack's
  // default three attempts, ~7s of backoff) before the bar appears — only a
  // 401 is exempt from retrying, which is exactly what the first two tests assert.
  it("a network-level failure keeps the connection and shows the offline bar instead", { timeout: 30_000 }, async () => {
    let failOffline = false;
    const fetchMock = vi.fn(async () => {
      if (failOffline) {
        throw new TypeError("fetch failed");
      }
      return ok([draft]);
    });
    mountApp(fetchMock);
    await waitFor(() => expect(screen.getByText(draft.question)).toBeInTheDocument());

    failOffline = true;
    goHash("#duo");

    // §3.3's bar, and the connection survives — an unreachable Mac is not a revoked token.
    await waitFor(() => expect(screen.getByTestId("offline-bar")).toBeInTheDocument(), { timeout: 20000 });
    expect(screen.getByTestId("offline-bar")).toHaveTextContent("Your Mac is unreachable.");
    expect(screen.queryByTestId("setup-notice")).toBeNull();
    expect(screen.queryByPlaceholderText("100.64.1.5:7717")).toBeNull();
    expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({
      baseUrl: "http://d:7717",
      token: "revoked-token",
    });
  });
});
