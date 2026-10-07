import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { writeHostedAccount } from "../src/api/hosted.js";
import { ProfilePane } from "../src/shell/ProfilePane.js";

/*
 * duo#318: the owner's own read of their duo's verification/answering state, shown next to "Your
 * duo" in the profile header — the one label a colleague never sees, matched against the admin
 * screens' own fields (`OrgAdmin.test.tsx`). Hosted-only: a personal duo is never signed in to a
 * hosted account, so `GET /org` is never even asked.
 */

const BASE = "https://duo-daemon.example.org/t/abc123";
const api: DuoApiConfig = { baseUrl: BASE, token: "device-tok" };

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProfilePane api={api} tab="portrait" />
    </QueryClientProvider>,
  );
}

/** Everything the Portrait tab (rendered under the header this file is about) needs to not crash, with no interrupters. */
const EMPTY_PORTRAIT = {
  totalQuestions: 0,
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-01-01T00:00:00.000Z",
  topicBreakdown: [],
  topFiveShare: 0,
  busiestThreads: [],
  tooThin: true,
  minimumQuestionsToCharacterize: 10,
};

/** Only `GET /org` answers with `orgBody`; every other route (the Portrait tab behind this header) gets a safe empty default, so this file tests the header in isolation. */
function stubOrg(orgBody: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith("/org")) {
        return new Response(JSON.stringify(orgBody), { status: 200 });
      }
      if (pathname.endsWith("/mirror/portrait")) {
        return new Response(JSON.stringify(EMPTY_PORTRAIT), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("duo#318 — the owner's own verification/answering label", () => {
  it("shows a quiet Verified badge once GET /org answers verified and answering", async () => {
    writeHostedAccount({ origin: new URL(BASE).origin, ownerName: "Ada", isAdmin: false });
    stubOrg({ org: { id: "plat1", name: "Platform team" }, role: "member", superAdmin: false, verified: true, answeringEnabled: true });
    mount();
    expect(await screen.findByTestId("profile-verified")).toHaveTextContent("Verified");
    expect(screen.queryByTestId("profile-answering-paused")).toBeNull();
  });

  it("shows no badge at all for an unverified-but-answering duo — informational only, never an alarm", async () => {
    writeHostedAccount({ origin: new URL(BASE).origin, ownerName: "Ada", isAdmin: false });
    stubOrg({ org: { id: "plat1", name: "Platform team" }, role: "member", superAdmin: false, verified: false, answeringEnabled: true });
    mount();
    await waitFor(() => expect(screen.getByTestId("profile-pane")).toBeInTheDocument());
    expect(screen.queryByTestId("profile-verified")).toBeNull();
    expect(screen.queryByTestId("profile-answering-paused")).toBeNull();
  });

  it("shows the refused-toned 'answering paused' notice, and never the quiet Verified badge, once an admin revokes answering", async () => {
    writeHostedAccount({ origin: new URL(BASE).origin, ownerName: "Ada", isAdmin: false });
    stubOrg({ org: { id: "plat1", name: "Platform team" }, role: "member", superAdmin: false, verified: true, answeringEnabled: false });
    mount();
    expect(await screen.findByTestId("profile-answering-paused")).toHaveTextContent(/admin has paused/i);
    expect(screen.queryByTestId("profile-verified")).toBeNull();
  });

  it("asks nothing and shows nothing for a personal duo — never signed in to a hosted account", async () => {
    // Never written: `pairedHostedAccount` reads null, so `useOrgOverview` stays disabled.
    stubOrg({ org: { id: "plat1", name: "Platform team" }, role: "member", superAdmin: false, verified: true, answeringEnabled: true });
    mount();
    await waitFor(() => expect(screen.getByTestId("profile-pane")).toBeInTheDocument());
    expect(screen.queryByTestId("profile-verified")).toBeNull();
    expect(screen.queryByTestId("profile-answering-paused")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith("/org"))).toBe(false);
  });
});
