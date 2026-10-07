import { dehydrate, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { stubDesktop } from "./desktop.js";
import { Admin } from "../src/routes/Admin.js";
import type { DuoApiConfig } from "../src/api/client.js";
import { adminRoleOf, readHostedAccount, readOrgMembers, type HostedAccount, type OrgOverview } from "../src/api/hosted.js";
import { queryKeys, shouldPersistQuery } from "../src/api/queries.js";

vi.mock("../src/notifications.js", () => ({
  draftArrivalBody: vi.fn(() => null),
  notifyDraftReady: vi.fn(),
  postNotification: vi.fn(),
  wireNotificationClicks: vi.fn(() => Promise.resolve(() => {})),
}));

/*
 * #254 (the app half): an org admin who manages their own org. The role is learned from the daemon
 * (`GET <basePath>/org`), never read back from storage; the admin page is the org's own and asks no `/hosted/*`
 * route; appoint and revoke are confirmed and their refusals are said in words keyed by the daemon's error code.
 * The daemon is a fetch fake keyed "METHOD path" at the origin.
 */

const ORIGIN = "https://duo-daemon.example.org";
const BASE = `${ORIGIN}/t/abc123`;
const api: DuoApiConfig = { baseUrl: BASE, token: "member-tok" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refusal = (status: number, code: string, message = "Refused.") => json({ error: { code, message } }, status);
const forbidden = () => refusal(403, "forbidden", "Only an admin can do this.");

const NOT_FOR_YOU = "This page is for admins, and your account isn't one right now. If that changed, ask an admin of your org.";
const ORG = { id: "plat1", name: "Platform team" };
const overview = (role: "member" | "org_admin", superAdmin = false, org = ORG) => json({ org, role, superAdmin });

interface Row {
  duoId: string;
  name: string;
  email: string | null;
  isRoot: boolean;
  joinedAt: string | null;
  isAdmin: boolean;
  superAdmin: boolean;
  orgRole: "member" | "org_admin";
  appointedBy: string | null;
  appointedByName: string | null;
  appointedAt: string | null;
  orgAdminLog: { at: string; action: "grant" | "revoke"; by: string; byName: string | null }[];
}

function row(fields: Partial<Row> & Pick<Row, "duoId" | "name">): Row {
  return {
    email: null,
    isRoot: false,
    joinedAt: "2026-09-21T00:00:00.000Z",
    isAdmin: false,
    superAdmin: false,
    orgRole: "member",
    appointedBy: null,
    appointedByName: null,
    appointedAt: null,
    orgAdminLog: [],
    ...fields,
  };
}

/** The signed-in duo (`abc123`), an org admin appointed by the super admin. */
const ME = row({
  duoId: "abc123",
  name: "Ada",
  email: "ada@example.com",
  orgRole: "org_admin",
  appointedBy: "super-admin",
  appointedByName: "Super admin",
  appointedAt: "2026-09-22T00:00:00.000Z",
  orgAdminLog: [{ at: "2026-09-22T00:00:00.000Z", action: "grant", by: "super-admin", byName: "Super admin" }],
});
const SAM = row({
  duoId: "sam1",
  name: "Sam",
  email: "sam@example.com",
  orgRole: "org_admin",
  appointedBy: "abc123",
  appointedByName: "Ada",
  appointedAt: "2026-09-23T00:00:00.000Z",
});
const KIM = row({ duoId: "kim1", name: "Kim", email: "kim@example.com" });
const BOSS = row({ duoId: "boss1", name: "Boss", email: "boss@example.com", isAdmin: true, superAdmin: true });
const ROOT = row({ duoId: "root", name: "Shin", email: "shin@example.com", isRoot: true, joinedAt: null, isAdmin: true, superAdmin: true });

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/** Routes are read fresh per call, so a test can change what a route answers after a write. */
function daemon(routes: Record<string, Handler>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const handler = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    return handler ? handler(init) : new Response("[]", { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function callsTo(mock: ReturnType<typeof daemon>, method: string, path: string) {
  return mock.mock.calls.filter(([input, init]) => new URL(String(input)).pathname === path && (init?.method ?? "GET") === method);
}

function urls(mock: ReturnType<typeof daemon>): string[] {
  return mock.mock.calls.map(([input]) => String(input));
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function withClient(ui: ReactElement, client = newClient()) {
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

function signInAs(account: Partial<HostedAccount> = {}) {
  localStorage.setItem("duo.api-config", JSON.stringify(api));
  localStorage.setItem("duo.hosted-account", JSON.stringify({ origin: ORIGIN, ownerName: "Ada", isAdmin: false, ...account }));
}

async function renderShell() {
  stubDesktop();
  // A fresh app per test: its query cache is one for the life of the module, and a role answered in one test must not be another's first paint.
  vi.resetModules();
  const { App } = await import("../src/App.js");
  const view = render(<App />);
  await waitFor(() => expect(view.container.querySelector("main")).not.toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return view;
}

const adminLink = () => within(screen.getByTestId("chat-list")).queryByRole("link", { name: "Admin" });

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
  localStorage.clear();
  window.location.hash = "";
});

/** A fake org the org-admin routes read and the appoint/revoke routes write. */
function orgDaemon(initial: Row[], extra: Record<string, Handler> = {}) {
  const state = { members: initial, invites: [] as { id: string; name: string; email: string | null; orgId: string; createdAt: string; expiresAt: string; code?: string; link?: string }[], role: "org_admin" as "member" | "org_admin", org: ORG };
  const set = (duoId: string, orgRole: "member" | "org_admin") => {
    state.members = state.members.map((m) =>
      m.duoId === duoId
        ? { ...m, orgRole, appointedBy: orgRole === "org_admin" ? "abc123" : null, appointedByName: orgRole === "org_admin" ? "Ada" : null, appointedAt: orgRole === "org_admin" ? "2026-09-27T00:00:00.000Z" : null }
        : m,
    );
    return state.members.find((m) => m.duoId === duoId)!;
  };
  const mock = daemon({
    "GET /t/abc123/org": () => overview(state.role, false, state.org),
    "GET /t/abc123/org/members": () => json(state.members),
    "GET /t/abc123/org/invites": () => json(state.invites),
    "POST /t/abc123/org/admins/kim1/grant": () => json({ member: set("kim1", "org_admin"), changed: true }),
    "POST /t/abc123/org/admins/sam1/revoke": () => json({ member: set("sam1", "member"), changed: true }),
    "POST /t/abc123/org/admins/abc123/revoke": () => {
      const member = set("abc123", "member");
      state.role = "member";
      return json({ member, changed: true });
    },
    ...extra,
  });
  return { mock, state };
}

function rowFor(name: string): HTMLElement {
  const found = screen.getAllByTestId("admin-member").find((li) => li.textContent?.startsWith(name));
  if (!found) {
    throw new Error(`no row for ${name}`);
  }
  return found;
}

describe("#254 — how the role is learned", () => {
  it("asks the paired duo for its role with its own token, and a member sees no Admin entry", async () => {
    signInAs();
    const mock = daemon({ "GET /t/abc123/org": () => overview("member") });
    await renderShell();
    const [url, init] = callsTo(mock, "GET", "/t/abc123/org")[0]!;
    expect(String(url)).toBe(`${BASE}/org`);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer member-tok");
    expect(adminLink()).toBeNull();
  });

  it("an org admin sees the entry, and a super admin does too", async () => {
    signInAs();
    daemon({ "GET /t/abc123/org": () => overview("org_admin") });
    const first = await renderShell();
    await waitFor(() => expect(adminLink()).toHaveAttribute("href", "#admin"));
    first.unmount();

    signInAs({ isAdmin: true });
    daemon({ "GET /t/abc123/org": () => overview("member", true) });
    await renderShell();
    await waitFor(() => expect(adminLink()).toHaveAttribute("href", "#admin"));
  });

  it("a stale stored admin flag is corrected by the daemon's answer: the entry goes", async () => {
    signInAs({ isAdmin: true });
    let release: (r: Response) => void = () => {};
    daemon({ "GET /t/abc123/org": () => new Promise<Response>((resolve) => (release = resolve)) });
    await renderShell();
    // Before the answer the stored flag is all there is, and it only draws an entry.
    expect(adminLink()).not.toBeNull();
    await act(async () => release(await overview("member", false)));
    await waitFor(() => expect(adminLink()).toBeNull());
  });

  it("the role stored at sign-in is a first-paint hint, and the daemon's 'member' outranks it", async () => {
    signInAs({ orgRole: "org_admin" });
    let release: (r: Response) => void = () => {};
    daemon({ "GET /t/abc123/org": () => new Promise<Response>((resolve) => (release = resolve)) });
    await renderShell();
    expect(adminLink()).not.toBeNull();
    await act(async () => release(await overview("member")));
    await waitFor(() => expect(adminLink()).toBeNull());
  });

  it("a stored hint is not an answer either when the daemon says this duo is in no org (404)", async () => {
    signInAs({ orgRole: "org_admin" });
    daemon({ "GET /t/abc123/org": () => refusal(404, "not_found", "This duo is in no org.") });
    await renderShell();
    await waitFor(() => expect(adminLink()).toBeNull());
  });

  it("a super admin in no org (404) keeps the entry from the stored flag", async () => {
    signInAs({ isAdmin: true });
    daemon({ "GET /t/abc123/org": () => refusal(404, "not_found") });
    await renderShell();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adminLink()).not.toBeNull();
  });

  it("an answer that is not the documented shape is no answer: the stored flag decides, and nothing crashes", async () => {
    signInAs({ isAdmin: true });
    daemon({ "GET /t/abc123/org": () => json({ org: null, role: 7 }) });
    await renderShell();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adminLink()).not.toBeNull();
  });

  it("an answer that is not the documented shape is no reason to show a member the entry", async () => {
    signInAs();
    daemon({ "GET /t/abc123/org": () => json("nonsense") });
    await renderShell();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adminLink()).toBeNull();
  });

  it("a network failure keeps the hint's entry and shows no error screen", async () => {
    signInAs({ orgRole: "org_admin" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    await renderShell();
    expect(adminLink()).not.toBeNull();
    expect(screen.queryByTestId("route-error")).toBeNull();
  });

  it("a role change reaches an already signed-in person when the app comes back to the front, with no sign-out", async () => {
    signInAs();
    let role: "member" | "org_admin" = "member";
    const mock = daemon({ "GET /t/abc123/org": () => overview(role) });
    await renderShell();
    expect(adminLink()).toBeNull();

    role = "org_admin"; // appointed meanwhile
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(adminLink()).not.toBeNull());

    role = "member"; // and revoked again
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(adminLink()).toBeNull());
    expect(callsTo(mock, "GET", "/t/abc123/org").length).toBeGreaterThanOrEqual(3);
    expect(localStorage.getItem("duo.api-config")).not.toBeNull(); // still signed in
  });

  it("and it is asked again on a timer while the app stays open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signInAs();
    let role: "member" | "org_admin" = "member";
    const mock = daemon({ "GET /t/abc123/org": () => overview(role) });
    await renderShell();
    expect(adminLink()).toBeNull();
    const before = callsTo(mock, "GET", "/t/abc123/org").length;
    role = "org_admin";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(callsTo(mock, "GET", "/t/abc123/org").length).toBeGreaterThan(before);
    await waitFor(() => expect(adminLink()).not.toBeNull());
  });

  it("a 401 on the role is a revoked device: the app unpairs like anywhere else", async () => {
    signInAs({ orgRole: "org_admin" });
    daemon({ "GET /t/abc123/org": () => refusal(401, "unauthorized", "Sign in.") });
    await renderShell();
    await waitFor(() => expect(localStorage.getItem("duo.api-config")).toBeNull());
    expect(localStorage.getItem("duo.hosted-account")).toBeNull();
  });

  it("nothing is asked of a browser that is not signed in to a hosted server (a personal duo)", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify(api));
    const mock = daemon({});
    await renderShell();
    expect(callsTo(mock, "GET", "/t/abc123/org")).toHaveLength(0);
  });

  it("a stored account for another server gets nothing: no request to /org, no entry, the plain note on #admin", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify(api));
    localStorage.setItem("duo.hosted-account", JSON.stringify({ origin: "https://elsewhere.example.org", ownerName: "Ada", isAdmin: false, orgRole: "org_admin" }));
    const mock = daemon({});
    window.location.hash = "#admin";
    await renderShell();
    expect(adminLink()).toBeNull();
    expect(screen.getByTestId("admin-not-available")).toBeInTheDocument();
    expect(urls(mock).filter((url) => url.includes("/org") || url.includes("/hosted/"))).toHaveLength(0);
  });

  it("every call an org admin's screens make goes to the paired duo's own /org routes, with its token, and to nothing under /hosted", async () => {
    signInAs({ orgRole: "org_admin" });
    const { mock } = orgDaemon([ME, SAM, KIM]);
    window.location.hash = "#admin";
    await renderShell();
    await screen.findByTestId("admin-org-page");
    const orgCalls = mock.mock.calls.filter(([input]) => new URL(String(input)).pathname.includes("/org"));
    expect(orgCalls.length).toBeGreaterThanOrEqual(3); // the role, the people, the invites
    for (const [input, init] of orgCalls) {
      expect(String(input).startsWith(`${BASE}/org`)).toBe(true);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer member-tok");
    }
    expect(urls(mock).filter((url) => url.includes("/hosted/"))).toHaveLength(0);
  });

  it("the role and the org's people are never written to the persisted cache or to storage", async () => {
    const client = new QueryClient();
    const keys: (readonly unknown[])[] = [queryKeys.orgOverview, queryKeys.orgMembers("plat1"), queryKeys.orgInvites("plat1"), queryKeys.devices];
    await Promise.all(keys.map((queryKey) => client.prefetchQuery({ queryKey, queryFn: async () => "x" })));
    expect(dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery }).queries.map((q) => q.queryKey)).toEqual([queryKeys.devices]);

    signInAs({ orgRole: "org_admin" });
    orgDaemon([ME, SAM, KIM]);
    window.location.hash = "#admin";
    await renderShell();
    await screen.findByTestId("admin-org-page");
    await new Promise((resolve) => setTimeout(resolve, 1300)); // past the persister's write delay
    const everything = Object.keys(localStorage)
      .map((key) => `${key}=${localStorage.getItem(key)}`)
      .join("\n");
    expect(everything).not.toContain("kim@example.com");
    expect(everything).not.toContain("sam@example.com");
    expect(everything).not.toContain("Platform team");
    expect(localStorage.getItem("duo-cache") ?? "").not.toContain("org_admin");
  });
});

describe("#254 — the entry matrix (adminRoleOf)", () => {
  const account = (fields: Partial<HostedAccount> = {}): HostedAccount => ({ origin: ORIGIN, ownerName: "Ada", isAdmin: false, ...fields });
  const answer = (role: OrgOverview["role"], superAdmin = false): OrgOverview => ({ org: ORG, role, superAdmin, verified: true, answeringEnabled: true });
  const none = { none: true } as const;

  it.each([
    ["no account", null, undefined, null],
    ["a member", account(), answer("member"), null],
    ["an org admin", account(), answer("org_admin"), "org"],
    ["a super admin", account(), answer("member", true), "super"],
    ["a super admin who is also an org admin: the super admin's screens", account(), answer("org_admin", true), "super"],
    ["a stale flag the answer contradicts", account({ isAdmin: true }), answer("member"), null],
    ["a stale hint the answer contradicts", account({ orgRole: "org_admin" }), answer("member"), null],
    ["no answer yet, the stored flag", account({ isAdmin: true }), undefined, "super"],
    ["no answer yet, the stored hint", account({ orgRole: "org_admin" }), undefined, "org"],
    ["no answer yet, nothing stored", account(), undefined, null],
    ["an unreadable answer is no answer", account({ isAdmin: true }), null, "super"],
    ["in no org, a stored hint", account({ orgRole: "org_admin" }), none, null],
    ["in no org, a stored super admin flag", account({ isAdmin: true }), none, "super"],
  ] as const)("%s", (_label, stored, live, expected) => {
    expect(adminRoleOf(stored as HostedAccount | null, live)).toBe(expected);
  });
});

describe("#254 — an org admin's page is their own org and nothing else", () => {
  it("shows the org's people with distinct marks, who appointed each org admin and when, and the person and their duo", async () => {
    const { mock } = orgDaemon([ME, SAM, KIM, BOSS, ROOT]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    expect(await screen.findByTestId("admin-org-name")).toHaveTextContent("Platform team");
    await screen.findAllByTestId("admin-member");

    const ada = rowFor("Ada");
    expect(within(ada).getByTestId("admin-member-org-admin")).toHaveTextContent("Org admin");
    expect(ada).toHaveTextContent("(you)");
    expect(within(ada).getByTestId("admin-member-appointed")).toHaveTextContent(/^Appointed by Super admin on /);
    expect(within(ada).getByTestId("admin-member-appointed").querySelector("time")).toHaveAttribute("datetime", "2026-09-22T00:00:00.000Z");
    expect(rowFor("Sam")).toHaveTextContent("Sam's duo");
    expect(within(rowFor("Sam")).getByTestId("admin-member-appointed")).toHaveTextContent(/^Appointed by Ada on /);

    // The marks differ in words, not colour alone.
    const boss = rowFor("Boss");
    expect(within(boss).getByTestId("admin-member-super-admin")).toHaveTextContent("Super admin");
    expect(within(boss).queryByTestId("admin-member-org-admin")).toBeNull();
    expect(within(boss).queryByRole("button")).toBeNull(); // an org admin cannot change the super admin
    expect(within(rowFor("Shin")).getByTestId("admin-member-root")).toHaveTextContent("Root duo");
    expect(within(rowFor("Shin")).queryByRole("button")).toBeNull(); // nor appoint the root duo
    expect(within(rowFor("Kim")).queryByTestId("admin-member-org-admin")).toBeNull();

    // No org list, no create-org, no way to another org; nothing under /hosted was asked.
    expect(screen.queryByTestId("admin-orgs")).toBeNull();
    expect(screen.queryByTestId("admin-create-org")).toBeNull();
    expect(screen.queryByTestId("admin-back")).toBeNull();
    expect(urls(mock).filter((url) => url.includes("/hosted/"))).toHaveLength(0);
    expect(urls(mock).every((url) => url.startsWith(`${BASE}/org`))).toBe(true);
  });

  it("#admin/<another org's id> is still this org's page and asks nothing about that id", async () => {
    signInAs({ orgRole: "org_admin" });
    const { mock } = orgDaemon([ME, KIM]);
    window.location.hash = "#admin/someone-elses-org";
    await renderShell();
    expect(await screen.findByTestId("admin-org-name")).toHaveTextContent("Platform team");
    expect(urls(mock).some((url) => url.includes("someone-elses-org"))).toBe(false);
    expect(urls(mock).filter((url) => url.includes("/hosted/"))).toHaveLength(0);
  });

  it("lists this org's pending invites, and says how they fill when there are none", async () => {
    const { state } = orgDaemon([ME, KIM]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    expect(await screen.findByTestId("admin-pending-invites-empty")).toHaveTextContent("No invites waiting.");
    cleanup();

    // The daemon must never send these, so the fixture does: a row that rendered either would fail below.
    state.invites = [
      { id: "i1", name: "Lee", email: "lee@example.com", orgId: "plat1", createdAt: "2026-09-25T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", code: "leak-code", link: "https://leak.example/x" },
    ];
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    const invite = await screen.findByTestId("admin-pending-invite");
    expect(invite).toHaveTextContent("Lee");
    expect(invite).toHaveTextContent("lee@example.com");
    expect(document.body.textContent).not.toContain("leak-code"); // the code exists only in the create answer
    expect(document.body.textContent).not.toContain("leak.example");
    expect(document.body.innerHTML).not.toContain("leak-code");
  });

  it("invites into the org: no org id is sent, the link is shown once, focused, copyable, and the pending list is re-read", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { mock, state } = orgDaemon([ME, KIM], {
      "POST /t/abc123/org/invites": () => {
        state.invites = [{ id: "i9", name: "Sam2", email: null, orgId: "plat1", createdAt: "2026-09-27T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" }];
        return json({ id: "i9", name: "Sam2", email: "sam2@example.com", orgId: "plat1", expiresAt: "2099-01-01T00:00:00.000Z", code: "c0de", link: "https://web.example/#join?host=x&invite=c0de" }, 201);
      },
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findByTestId("admin-pending-invites-empty");
    expect(screen.getByRole("heading", { name: "Invite someone into Platform team" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Who it's for" }), { target: { value: "  Sam2  " } });
    fireEvent.change(screen.getByRole("textbox", { name: /google/i }), { target: { value: "sam2@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));

    const minted = await screen.findByTestId("admin-invite-minted");
    expect(minted).toHaveTextContent("Sam2's invite to Platform team (only sam2@example.com can use it)");
    expect(minted).toHaveTextContent("It won't be shown again, works once");
    expect(screen.getByTestId("admin-invite-link")).toHaveTextContent("invite=c0de");
    expect(minted).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(minted).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Copy invite link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://web.example/#join?host=x&invite=c0de"));

    const [url, init] = callsTo(mock, "POST", "/t/abc123/org/invites")[0]!;
    expect(String(url)).toBe(`${BASE}/org/invites`);
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Sam2", email: "sam2@example.com" });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer member-tok");
    expect(await screen.findByTestId("admin-pending-invite")).toHaveTextContent("Sam2");
    expect(document.body.textContent!.match(/c0de/g)).toHaveLength(1); // shown in one place only: the link, once
  });

  it("the invite link made for one org is gone when the org changes underneath", async () => {
    const { state } = orgDaemon([ME, KIM], {
      "POST /t/abc123/org/invites": () =>
        json({ id: "i9", name: "Sam2", email: null, orgId: "plat1", expiresAt: "2099-01-01T00:00:00.000Z", code: "c0de", link: "https://web.example/#join?invite=c0de" }, 201),
    });
    const { client } = withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Sam2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    await screen.findByTestId("admin-invite-link");

    state.org = { id: "agency9", name: "Agency" };
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.orgOverview });
    });
    expect(await screen.findByRole("heading", { name: "Invite someone into Agency" })).toBeInTheDocument();
    expect(screen.queryByTestId("admin-invite-minted")).toBeNull();
    expect(screen.queryByTestId("admin-invite-link")).toBeNull();
  });

  it("renames the org: posts the trimmed name, the new name shows, and focus returns to the button", async () => {
    const { mock, state } = orgDaemon([ME, KIM], {
      "POST /t/abc123/org/rename": (init) => {
        state.org = { id: "plat1", name: (JSON.parse(String(init?.body)) as { name: string }).name };
        return json({ org: state.org });
      },
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    fireEvent.click(await screen.findByTestId("admin-rename"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "New name" })).toHaveFocus());
    fireEvent.change(screen.getByRole("textbox", { name: "New name" }), { target: { value: "  Platform  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByTestId("admin-org-name").textContent).toBe("Platform"));
    await waitFor(() => expect(screen.getByTestId("admin-rename")).toHaveFocus());
    const [url, init] = callsTo(mock, "POST", "/t/abc123/org/rename")[0]!;
    expect(String(url)).toBe(`${BASE}/org/rename`);
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Platform" });
  });

  it.each(["name_unavailable", "org_name_taken"])("a rename refused with %s says the name isn't available, without naming who has it", async (code) => {
    orgDaemon([ME, KIM], { "POST /t/abc123/org/rename": () => refusal(409, code, 'There is already an org named "Secret Org".') });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    fireEvent.click(await screen.findByTestId("admin-rename"));
    fireEvent.change(screen.getByRole("textbox", { name: "New name" }), { target: { value: "Secret Org" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByTestId("mutation-error")).toHaveTextContent("That name isn't available. Choose a different one.");
    expect(screen.getByTestId("mutation-error")).not.toHaveTextContent("There is already");
    expect(screen.getByRole("textbox", { name: "New name" })).toBeInTheDocument();
  });

  it("an invite refused as too many pending says so plainly, keeps the form, and shows no link", async () => {
    orgDaemon([ME, KIM], { "POST /t/abc123/org/invites": () => refusal(409, "too_many_invites", "Too many pending invites.") });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Sam2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByTestId("mutation-error")).toHaveTextContent(
      "This org has too many invites waiting. Some need to be used or to expire (invites last up to a year) before you can make another, or the super admin can cancel one.",
    );
    expect(screen.queryByTestId("admin-invite-minted")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Who it's for" })).toHaveValue("Sam2");
  });

  it("an invite the daemon refuses as bad input shows the daemon's own sentence", async () => {
    orgDaemon([ME, KIM], { "POST /t/abc123/org/invites": () => refusal(400, "bad_request", "email, when given, must be an email address") });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Sam2" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByTestId("mutation-error")).toHaveTextContent("email, when given, must be an email address");
  });
});

describe("#254 — appoint and revoke by an org admin", () => {
  it("appoints a member after a plain confirmation: nothing is sent until Confirm, no body, the row is marked and announced, focus on the row", async () => {
    const { mock } = orgDaemon([ME, SAM, KIM]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");

    fireEvent.click(within(rowFor("Kim")).getByRole("button", { name: "Appoint Kim as an org admin…" }));
    const dialog = screen.getByTestId("admin-appoint-confirmation");
    expect(dialog).toHaveTextContent("Make Kim an org admin?");
    expect(dialog).toHaveTextContent("stay a normal member, with no extra power");
    expect(callsTo(mock, "POST", "/t/abc123/org/admins/kim1/grant")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("admin-appoint-cancel"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10)); // the dialog's own hand-back of focus runs on the next tick
    });
    expect(screen.queryByTestId("admin-appoint-confirmation")).toBeNull();
    expect(callsTo(mock, "POST", "/t/abc123/org/admins/kim1/grant")).toHaveLength(0);

    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-appoint"));
    fireEvent.click(screen.getByTestId("admin-appoint-confirm"));
    await waitFor(() => expect(within(rowFor("Kim")).getByTestId("admin-member-org-admin")).toBeInTheDocument());
    expect(screen.getByTestId("admin-people-notice")).toHaveTextContent("Kim is now an org admin of Platform team.");
    expect(within(rowFor("Kim")).getByTestId("admin-member-appointed")).toHaveTextContent(/^Appointed by Ada on /);
    await waitFor(() => expect(rowFor("Kim")).toHaveFocus());

    const [url, init] = callsTo(mock, "POST", "/t/abc123/org/admins/kim1/grant")[0]!;
    expect(String(url)).toBe(`${BASE}/org/admins/kim1/grant`);
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer member-tok");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(screen.getByTestId("admin-people-notice")).toHaveAttribute("aria-live", "polite");
  });

  it("appointing someone who already is one says so and changes nothing else", async () => {
    orgDaemon([ME, SAM, KIM], { "POST /t/abc123/org/admins/kim1/grant": () => json({ member: KIM, changed: false }) });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-appoint"));
    fireEvent.click(screen.getByTestId("admin-appoint-confirm"));
    expect(await screen.findByText("Kim was already an org admin.")).toBeInTheDocument();
  });

  it("revokes another org admin after a plain confirmation: they stay a member, and it is announced", async () => {
    const { mock } = orgDaemon([ME, SAM, KIM]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Sam")).getByRole("button", { name: "Revoke Sam as an org admin…" }));
    expect(screen.getByTestId("admin-revoke-confirmation")).toHaveTextContent("Sam stays in Platform team as a normal member, but can no longer manage it.");
    fireEvent.click(screen.getByTestId("admin-revoke-confirm"));
    await waitFor(() => expect(within(rowFor("Sam")).queryByTestId("admin-member-org-admin")).toBeNull());
    expect(screen.getByTestId("admin-people-notice")).toHaveTextContent("Sam is no longer an org admin. They stay in Platform team as a member.");
    expect(within(rowFor("Sam")).getByTestId("admin-appoint")).toBeInTheDocument(); // still a member, and appointable again
    await waitFor(() => expect(rowFor("Sam")).toHaveFocus());
    expect(callsTo(mock, "POST", "/t/abc123/org/admins/sam1/revoke")).toHaveLength(1);
  });

  it("stepping down, with another org admin left: confirm, then the page says so and the entry disappears on the role refresh", async () => {
    signInAs({ orgRole: "org_admin" });
    const { mock } = orgDaemon([ME, SAM, KIM]);
    window.location.hash = "#admin";
    await renderShell();
    await screen.findAllByTestId("admin-member");
    expect(adminLink()).not.toBeNull();

    fireEvent.click(within(rowFor("Ada")).getByRole("button", { name: "Step down as an org admin…" }));
    const dialog = screen.getByTestId("admin-revoke-confirmation");
    expect(dialog).toHaveTextContent("Step down as an org admin?");
    expect(dialog).toHaveTextContent("You stay in Platform team as a normal member");
    fireEvent.click(screen.getByTestId("admin-revoke-confirm"));

    const note = await screen.findByTestId("admin-stepped-down");
    expect(note).toHaveTextContent("You're no longer an org admin");
    expect(note).toHaveTextContent("You're still a member of Platform team");
    await waitFor(() => expect(note).toHaveFocus());
    await waitFor(() => expect(adminLink()).toBeNull());
    expect(screen.getByTestId("admin-stepped-down")).toBeInTheDocument(); // the page that noticed still says why
    expect(callsTo(mock, "POST", "/t/abc123/org/admins/abc123/revoke")).toHaveLength(1);
  });

  it("the org's only org admin is not offered a revoke: the rule is explained instead", async () => {
    orgDaemon([ME, KIM]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    const ada = rowFor("Ada");
    expect(within(ada).queryByTestId("admin-revoke")).toBeNull();
    expect(within(ada).getByTestId("admin-member-last")).toHaveTextContent("The org's last org admin. Only the super admin can remove them.");
  });

  it("last_org_admin from the daemon (a list that had gone stale) says the same, and nothing else changes", async () => {
    const { state } = orgDaemon([ME, SAM, KIM], { "POST /t/abc123/org/admins/sam1/revoke": () => refusal(409, "last_org_admin", "This is the last org admin of the org. Appoint another org admin first, or ask the super admin.") });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Sam")).getByTestId("admin-revoke"));
    fireEvent.click(screen.getByTestId("admin-revoke-confirm"));
    expect(await screen.findByText("This is the org's last org admin. Only the super admin can remove them.")).toBeInTheDocument();
    expect(state.members.find((m) => m.duoId === "sam1")?.orgRole).toBe("org_admin");
    expect(screen.queryByTestId("admin-not-available")).toBeNull();
  });

  it.each([
    ["super_admin_protected", "The super admin manages every org already, so this can't be changed here."],
    ["root_not_appointable", "The first duo on this server can't be made an org admin."],
  ])("%s says its plain sentence, in the app's words", async (code, copy) => {
    orgDaemon([ME, SAM, KIM], { "POST /t/abc123/org/admins/kim1/grant": () => refusal(409, code, "Daemon text that must not be shown.") });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-appoint"));
    fireEvent.click(screen.getByTestId("admin-appoint-confirm"));
    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByText(/Daemon text/)).toBeNull();
  });

  it("a person who has left the org (404 not_found) is said so and the list is re-read", async () => {
    const { mock } = orgDaemon([ME, SAM, KIM], { "POST /t/abc123/org/admins/kim1/grant": () => refusal(404, "not_found", "There is no such member in this org.") });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-appoint"));
    fireEvent.click(screen.getByTestId("admin-appoint-confirm"));
    expect(await screen.findByText("Kim isn't in Platform team any more. The list has been refreshed.")).toBeInTheDocument();
    await waitFor(() => expect(callsTo(mock, "GET", "/t/abc123/org/members").length).toBeGreaterThan(1));
  });

  it("a super admin who also holds the role can step down, and another org admin is not offered to revoke them", async () => {
    const both = row({ duoId: "abc123", name: "Ada", email: "ada@example.com", orgRole: "org_admin", isAdmin: true, superAdmin: true, appointedBy: "super-admin", appointedByName: "Super admin", appointedAt: "2026-09-22T00:00:00.000Z" });
    const other = row({ duoId: "sam1", name: "Sam", orgRole: "org_admin", appointedBy: "super-admin", appointedByName: "Super admin", appointedAt: "2026-09-22T00:00:00.000Z" });
    orgDaemon([both, other]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    const ada = rowFor("Ada");
    expect(within(ada).getByTestId("admin-member-super-admin")).toHaveTextContent("Super admin");
    expect(within(ada).getByTestId("admin-member-org-admin")).toHaveTextContent("Org admin");
    expect(within(ada).getByRole("button", { name: "Step down as an org admin…" })).toBeInTheDocument();
    cleanup();

    orgDaemon([row({ duoId: "boss1", name: "Boss", orgRole: "org_admin", isAdmin: true, superAdmin: true }), row({ duoId: "abc123", name: "Ada", orgRole: "org_admin" })]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    expect(within(rowFor("Boss")).queryByRole("button")).toBeNull();
  });
});

describe("#254/duo#318 — answering, alongside the org admin role", () => {
  /** Like `orgDaemon`'s `set` for the role, but for `answeringEnabled`. */
  function answeringDaemon(initial: Row[], extra: Record<string, Handler> = {}) {
    const answering: Record<string, boolean> = {};
    const members = () => initial.map((m) => ({ ...m, answeringEnabled: answering[m.duoId] !== false, answeringRevokedByName: answering[m.duoId] === false ? "Ada" : null }));
    return orgDaemon(initial, {
      "GET /t/abc123/org/members": () => json(members()),
      "POST /t/abc123/org/members/kim1/answering/revoke": () => {
        const changed = answering["kim1"] !== false;
        answering["kim1"] = false;
        return json({ member: members().find((m) => m.duoId === "kim1"), changed });
      },
      "POST /t/abc123/org/members/kim1/answering/restore": () => {
        const changed = answering["kim1"] === false;
        delete answering["kim1"];
        return json({ member: members().find((m) => m.duoId === "kim1"), changed });
      },
      ...extra,
    });
  }

  it("revokes a member's answering after a plain confirmation, marks the row, and announces it; restoring brings the button back", async () => {
    const { mock } = answeringDaemon([ME, SAM, KIM]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    const kim = rowFor("Kim");
    expect(within(kim).queryByTestId("admin-member-unverified")).toBeNull();
    expect(within(kim).queryByTestId("admin-member-revoked")).toBeNull();

    fireEvent.click(within(kim).getByRole("button", { name: "Stop Kim's duo from answering colleagues…" }));
    const dialog = screen.getByTestId("admin-revoke-answering-confirmation");
    expect(dialog).toHaveTextContent("stops answering colleagues at once");
    expect(callsTo(mock, "POST", "/t/abc123/org/members/kim1/answering/revoke")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("admin-revoke-answering-confirm"));

    await waitFor(() => expect(within(rowFor("Kim")).getByTestId("admin-member-revoked")).toBeInTheDocument());
    expect(screen.getByTestId("admin-people-notice")).toHaveTextContent("Kim's duo no longer answers colleagues.");
    expect(within(rowFor("Kim")).getByTestId("admin-member-answering-revoked")).toHaveTextContent(/^Revoked by Ada\. Kim's duo still works for them/);
    const [, init] = callsTo(mock, "POST", "/t/abc123/org/members/kim1/answering/revoke")[0]!;
    expect(init?.body).toBeUndefined();

    fireEvent.click(within(rowFor("Kim")).getByRole("button", { name: "Let Kim's duo answer colleagues again…" }));
    fireEvent.click(screen.getByTestId("admin-restore-answering-confirm"));
    await waitFor(() => expect(within(rowFor("Kim")).queryByTestId("admin-member-revoked")).toBeNull());
    expect(screen.getByTestId("admin-people-notice")).toHaveTextContent("Kim's duo can answer colleagues again.");
    expect(callsTo(mock, "POST", "/t/abc123/org/members/kim1/answering/restore")).toHaveLength(1);
  });

  it("shows Unverified for a duo with no identity check, with no answering control offered (nothing to toggle)", async () => {
    const unverified = row({ duoId: "kim1", name: "Kim", email: "kim@example.com" });
    orgDaemon([ME, SAM, { ...unverified, verified: false } as unknown as Row]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    const kim = rowFor("Kim");
    expect(within(kim).getByTestId("admin-member-unverified")).toHaveTextContent("Unverified");
    expect(within(kim).queryByTestId("admin-revoke-answering")).toBeNull();
    expect(within(kim).queryByTestId("admin-restore-answering")).toBeNull();
  });

  it("super_admin_protected on an answering route says the same plain sentence as the role routes", async () => {
    answeringDaemon([ME, SAM, KIM], { "POST /t/abc123/org/members/kim1/answering/revoke": () => refusal(409, "super_admin_protected", "Daemon text that must not be shown.") });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-revoke-answering"));
    fireEvent.click(screen.getByTestId("admin-revoke-answering-confirm"));
    expect(await screen.findByText("The super admin manages every org already, so this can't be changed here.")).toBeInTheDocument();
    expect(screen.queryByText(/Daemon text/)).toBeNull();
  });
});

describe("#254 — the role goes while the page is open", () => {
  it("a 403 on Confirm is the plain 'not for you' note: no error screen, nothing changed, and the role is asked again", async () => {
    const { mock } = orgDaemon([ME, SAM, KIM], { "POST /t/abc123/org/admins/kim1/grant": () => forbidden() });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    const before = callsTo(mock, "GET", "/t/abc123/org").length;
    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-appoint"));
    fireEvent.click(screen.getByTestId("admin-appoint-confirm"));
    expect(await screen.findByTestId("admin-not-available")).toHaveTextContent(NOT_FOR_YOU);
    expect(screen.queryByTestId("route-error")).toBeNull();
    expect(screen.queryByTestId("admin-org-page")).toBeNull();
    await waitFor(() => expect(callsTo(mock, "GET", "/t/abc123/org").length).toBeGreaterThan(before));
  });

  it("the loser of two org admins revoking each other at once (403) gets the same note", async () => {
    orgDaemon([ME, SAM], { "POST /t/abc123/org/admins/sam1/revoke": () => forbidden() });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Sam")).getByTestId("admin-revoke"));
    fireEvent.click(screen.getByTestId("admin-revoke-confirm"));
    expect(await screen.findByTestId("admin-not-available")).toBeInTheDocument();
  });

  it.each([["members", "GET /t/abc123/org/members"], ["invites", "GET /t/abc123/org/invites"]])("a 403 loading the %s is the same note", async (_what, route) => {
    orgDaemon([ME, KIM], { [route]: () => forbidden() });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    expect(await screen.findByTestId("admin-not-available")).toBeInTheDocument();
    expect(screen.queryByTestId("route-error")).toBeNull();
  });

  it("revoked while the page is open: the next role answer closes it with the note, and the entry goes", async () => {
    signInAs({ orgRole: "org_admin" });
    const { state } = orgDaemon([ME, KIM]);
    window.location.hash = "#admin";
    await renderShell();
    await screen.findByTestId("admin-org-page");
    expect(adminLink()).not.toBeNull();

    state.role = "member"; // the super admin revoked them
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await screen.findByTestId("admin-not-available")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-org-page")).toBeNull();
    expect(screen.queryByTestId("route-error")).toBeNull();
    await waitFor(() => expect(adminLink()).toBeNull());
  });

  it("a member who types #admin sees the note and asks for no people or invites", async () => {
    signInAs();
    const mock = daemon({ "GET /t/abc123/org": () => overview("member") });
    window.location.hash = "#admin";
    await renderShell();
    expect(await screen.findByTestId("admin-not-available")).toBeInTheDocument();
    expect(callsTo(mock, "GET", "/t/abc123/org/members")).toHaveLength(0);
    expect(callsTo(mock, "GET", "/t/abc123/org/invites")).toHaveLength(0);
    expect(urls(mock).filter((url) => url.includes("/hosted/"))).toHaveLength(0);
  });

  it("an org admin whose org has vanished (404 on the role) gets the note, not an error screen", async () => {
    daemon({ "GET /t/abc123/org": () => refusal(404, "not_found") });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    expect(await screen.findByTestId("admin-not-available")).toBeInTheDocument();
  });

  it("a role answer that can't be read is the note, and a network failure offers Try again", async () => {
    daemon({ "GET /t/abc123/org": () => json({ nothing: true }) });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    expect(await screen.findByTestId("admin-not-available")).toBeInTheDocument();
    cleanup();

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    expect(await screen.findByTestId("route-error")).toBeInTheDocument();
  });
});

describe("#254 — malformed org data is tolerated", () => {
  it("drops rows it can't read, defaults what is missing, and reads a pre-#254 daemon as everyone a member", () => {
    const rows = readOrgMembers([
      null,
      "x",
      { duoId: "", name: "No id" },
      { duoId: "old1", name: "Old", email: "old@example.com", isRoot: false, joinedAt: "not a date", isAdmin: true },
      { duoId: "n1", name: "New", orgRole: "org_admin", appointedByName: 5, appointedAt: "2026-09-22T00:00:00.000Z", orgAdminLog: [null, { at: "bad", action: "grant" }, { at: "2026-09-22T00:00:00.000Z", action: "shrug" }, { at: "2026-09-22T00:00:00.000Z", action: "grant", byName: "Boss" }] },
      { duoId: "m1", name: "Member", orgRole: "wizard", appointedAt: "2026-09-22T00:00:00.000Z", orgAdminLog: "nope" },
    ]);
    expect(rows.map((r) => r.duoId)).toEqual(["old1", "n1", "m1"]);
    expect(rows[0]).toMatchObject({ superAdmin: true, isAdmin: true, orgRole: "member", joinedAt: null, orgAdminLog: [] });
    expect(rows[1]).toMatchObject({ orgRole: "org_admin", appointedByName: null, orgAdminLog: [{ action: "grant", byName: "Boss" }] });
    expect(rows[2]).toMatchObject({ orgRole: "member", appointedAt: null, orgAdminLog: [] });
    expect(readOrgMembers({ not: "a list" })).toEqual([]);
  });

  it("an org admin's page survives members, invites and rows that are not the documented shape", async () => {
    orgDaemon([], {
      "GET /t/abc123/org/members": () => json([{ duoId: "abc123", name: "Ada", orgRole: "org_admin" }, { junk: true }, 7]),
      "GET /t/abc123/org/invites": () => json({ not: "a list" }),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    expect(await screen.findByTestId("admin-org-name")).toHaveTextContent("Platform team");
    expect(await screen.findAllByTestId("admin-member")).toHaveLength(1);
    expect(screen.getByTestId("admin-pending-invites-empty")).toBeInTheDocument();
    expect(within(rowFor("Ada")).getByTestId("admin-member-appointed")).toHaveTextContent(/^Appointed$/);
  });
});

describe("#254 — the super admin's org page: appoint, revoke, marks and history", () => {
  const PLAT = { id: "plat1", name: "Platform team", createdAt: "2026-09-20T00:00:00.000Z", memberCount: 3 };
  const superToken: DuoApiConfig = { baseUrl: BASE, token: "super-tok" };
  const history = [
    { at: "2026-09-22T00:00:00.000Z", action: "grant" as const, by: "super-admin", byName: "Super admin" },
    { at: "2026-09-24T00:00:00.000Z", action: "revoke" as const, by: "sam1", byName: "Sam" },
    { at: "2026-09-25T00:00:00.000Z", action: "grant" as const, by: "abc123", byName: null },
  ];

  function superDaemon(members: Row[], extra: Record<string, Handler> = {}) {
    const state = { members };
    const set = (duoId: string, orgRole: "member" | "org_admin") => {
      state.members = state.members.map((m) => (m.duoId === duoId ? { ...m, orgRole, appointedByName: orgRole === "org_admin" ? "Super admin" : null, appointedAt: orgRole === "org_admin" ? "2026-09-27T00:00:00.000Z" : null } : m));
      return state.members.find((m) => m.duoId === duoId)!;
    };
    const mock = daemon({
      "GET /hosted/orgs": () => json([PLAT]),
      "GET /hosted/orgs/plat1/members": () => json(state.members),
      "POST /hosted/orgs/plat1/admins/kim1/grant": () => json({ member: set("kim1", "org_admin"), changed: true }),
      "POST /hosted/orgs/plat1/admins/abc123/revoke": () => json({ member: set("abc123", "member"), changed: true }),
      ...extra,
    });
    return { mock, state };
  }

  it("marks each person, shows who appointed an org admin and when, and keeps the history quiet until opened", async () => {
    superDaemon([{ ...ME, orgAdminLog: history }, KIM, BOSS, ROOT]);
    withClient(<Admin api={superToken} origin={ORIGIN} orgId="plat1" role="super" />);
    await screen.findAllByTestId("admin-member");
    const ada = rowFor("Ada");
    expect(within(ada).getByTestId("admin-member-org-admin")).toHaveTextContent("Org admin");
    expect(within(ada).getByTestId("admin-member-appointed")).toHaveTextContent(/^Appointed by Super admin on /);
    const details = within(ada).getByTestId("admin-member-history") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("History (3)")).toBeInTheDocument();
    const entries = within(details).getAllByTestId("admin-member-history-entry");
    expect(entries.map((e) => e.textContent?.replace(/ on .*$/, ""))).toEqual(["Appointed by Super admin", "Revoked by Sam", "Appointed"]);
    expect(within(rowFor("Kim")).queryByTestId("admin-member-history")).toBeNull();
    expect(within(rowFor("Boss")).getByTestId("admin-member-super-admin")).toHaveTextContent("Super admin");
    expect(within(rowFor("Boss")).queryByRole("button")).toBeNull();
    expect(within(rowFor("Shin")).queryByRole("button")).toBeNull();
  });

  it("duo#318: revokes and restores a member's answering through the super admin's own route; the root duo and Boss (another super admin) offer no control", async () => {
    let answeringEnabled = true;
    const currentMembers = () => [ME, { ...KIM, answeringEnabled, answeringRevokedByName: answeringEnabled ? null : "Super admin" }, BOSS, ROOT];
    const { mock } = superDaemon([ME, KIM, BOSS, ROOT], {
      "GET /hosted/orgs/plat1/members": () => json(currentMembers()),
      "POST /hosted/orgs/plat1/members/kim1/answering/revoke": () => {
        const changed = answeringEnabled;
        answeringEnabled = false;
        return json({ member: currentMembers().find((m) => m.duoId === "kim1"), changed });
      },
      "POST /hosted/orgs/plat1/members/kim1/answering/restore": () => {
        const changed = !answeringEnabled;
        answeringEnabled = true;
        return json({ member: currentMembers().find((m) => m.duoId === "kim1"), changed });
      },
    });
    withClient(<Admin api={superToken} origin={ORIGIN} orgId="plat1" role="super" />);
    await screen.findAllByTestId("admin-member");
    expect(within(rowFor("Boss")).queryByRole("button")).toBeNull();
    expect(within(rowFor("Shin")).queryByRole("button")).toBeNull();

    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-revoke-answering"));
    fireEvent.click(screen.getByTestId("admin-revoke-answering-confirm"));
    await waitFor(() => expect(within(rowFor("Kim")).getByTestId("admin-member-revoked")).toBeInTheDocument());
    expect(callsTo(mock, "POST", "/hosted/orgs/plat1/members/kim1/answering/revoke")).toHaveLength(1);

    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-restore-answering"));
    fireEvent.click(screen.getByTestId("admin-restore-answering-confirm"));
    await waitFor(() => expect(within(rowFor("Kim")).queryByTestId("admin-member-revoked")).toBeNull());
    expect(callsTo(mock, "POST", "/hosted/orgs/plat1/members/kim1/answering/restore")).toHaveLength(1);
  });

  it("appoints through the super admin's route with the device token, then the row shows the mark", async () => {
    const { mock } = superDaemon([ME, KIM]);
    withClient(<Admin api={superToken} origin={ORIGIN} orgId="plat1" role="super" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-appoint"));
    fireEvent.click(screen.getByTestId("admin-appoint-confirm"));
    await waitFor(() => expect(within(rowFor("Kim")).getByTestId("admin-member-org-admin")).toBeInTheDocument());
    expect(screen.getByTestId("admin-people-notice")).toHaveTextContent("Kim is now an org admin of Platform team.");
    const [url, init] = callsTo(mock, "POST", "/hosted/orgs/plat1/admins/kim1/grant")[0]!;
    expect(String(url)).toBe(`${ORIGIN}/hosted/orgs/plat1/admins/kim1/grant`);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer super-tok");
    expect(init?.body).toBeUndefined();
    expect(urls(mock).some((u) => u.includes("/t/abc123/org"))).toBe(false); // the per-duo routes are the org admin's, not this one's
  });

  it("the super admin may revoke the org's last org admin, and the result is shown", async () => {
    const { mock } = superDaemon([ME, KIM]);
    withClient(<Admin api={superToken} origin={ORIGIN} orgId="plat1" role="super" />);
    await screen.findAllByTestId("admin-member");
    // The only org admin: an org admin would be told the rule; the super admin is offered the revoke.
    expect(within(rowFor("Ada")).queryByTestId("admin-member-last")).toBeNull();
    fireEvent.click(within(rowFor("Ada")).getByRole("button", { name: "Revoke Ada as an org admin…" }));
    fireEvent.click(screen.getByTestId("admin-revoke-confirm"));
    await waitFor(() => expect(within(rowFor("Ada")).queryByTestId("admin-member-org-admin")).toBeNull());
    expect(screen.getByTestId("admin-people-notice")).toHaveTextContent("Ada is no longer an org admin.");
    expect(callsTo(mock, "POST", "/hosted/orgs/plat1/admins/abc123/revoke")).toHaveLength(1);
  });

  it.each([
    ["super_admin_protected", "The super admin manages every org already, so this can't be changed here."],
    ["root_not_appointable", "The first duo on this server can't be made an org admin."],
    ["last_org_admin", "This is the org's last org admin. Only the super admin can remove them."],
  ])("%s is said in the app's words", async (code, copy) => {
    superDaemon([ME, KIM], { "POST /hosted/orgs/plat1/admins/kim1/grant": () => refusal(409, code, "Daemon text.") });
    withClient(<Admin api={superToken} origin={ORIGIN} orgId="plat1" role="super" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-appoint"));
    fireEvent.click(screen.getByTestId("admin-appoint-confirm"));
    expect(await screen.findByText(copy)).toBeInTheDocument();
  });

  it("an unknown org or member (404) shows the daemon's own words, and a 403 does not become an error screen", async () => {
    superDaemon([ME, KIM], { "POST /hosted/orgs/plat1/admins/kim1/grant": () => refusal(404, "org_not_found", 'There is no org "plat1".') });
    withClient(<Admin api={superToken} origin={ORIGIN} orgId="plat1" role="super" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-appoint"));
    fireEvent.click(screen.getByTestId("admin-appoint-confirm"));
    expect(await screen.findByText('There is no org "plat1".')).toBeInTheDocument();
    expect(screen.queryByTestId("route-error")).toBeNull();
  });
});

describe("#254 — review fixes", () => {
  it("the not-for-you note replaces a page the person was using: it is announced and takes focus", async () => {
    orgDaemon([ME, SAM, KIM], { "POST /t/abc123/org/admins/kim1/grant": () => forbidden() });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-appoint"));
    fireEvent.click(screen.getByTestId("admin-appoint-confirm"));
    const note = await screen.findByTestId("admin-not-available");
    expect(note).toHaveAttribute("role", "status");
    expect(note).toHaveTextContent(NOT_FOR_YOU);
    expect(note.textContent).not.toMatch(/runs this server/);
    await waitFor(() => expect(note).toHaveFocus());
  });

  it("the header says who else manages the org, the super admin included", async () => {
    orgDaemon([ME, KIM]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    expect(screen.getByTestId("admin-org-page")).toHaveTextContent("You and the org's other org admins manage it, and so does the super admin.");
    expect(screen.getByTestId("admin-org-page").textContent).not.toContain("Only you");
  });

  it("a second Confirm while one change is in flight sends one request and still ends the page on a step-down", async () => {
    signInAs({ orgRole: "org_admin" });
    let release: (r: Response) => void = () => {};
    const { mock, state } = orgDaemon([ME, SAM, KIM], {
      "POST /t/abc123/org/admins/abc123/revoke": () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    window.location.hash = "#admin";
    await renderShell();
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Ada")).getByRole("button", { name: "Step down as an org admin…" }));
    const confirm = screen.getByTestId("admin-revoke-confirm");
    // Two clicks in one tick: the button has not yet had a render to show it is busy.
    act(() => {
      confirm.click();
      confirm.click();
    });
    await waitFor(() => expect(callsTo(mock, "POST", "/t/abc123/org/admins/abc123/revoke")).toHaveLength(1));
    state.role = "member";
    await act(async () => release(json({ member: state.members[0], changed: true })));
    expect(await screen.findByTestId("admin-stepped-down")).toBeInTheDocument();
    expect(callsTo(mock, "POST", "/t/abc123/org/admins/abc123/revoke")).toHaveLength(1);
  });

  it("a change that finished can be followed by another (the guard lets go)", async () => {
    const { mock } = orgDaemon([ME, SAM, KIM]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Kim")).getByTestId("admin-appoint"));
    fireEvent.click(screen.getByTestId("admin-appoint-confirm"));
    await waitFor(() => expect(within(rowFor("Kim")).getByTestId("admin-member-org-admin")).toBeInTheDocument());
    fireEvent.click(within(rowFor("Sam")).getByTestId("admin-revoke"));
    fireEvent.click(screen.getByTestId("admin-revoke-confirm"));
    await waitFor(() => expect(within(rowFor("Sam")).queryByTestId("admin-member-org-admin")).toBeNull());
    expect(callsTo(mock, "POST", "/t/abc123/org/admins/sam1/revoke")).toHaveLength(1);
  });

  it("a 404 on the role stays an answer across refreshes: a stale hint does not bring the entry back while one is in flight", async () => {
    signInAs({ orgRole: "org_admin" });
    let calls = 0;
    daemon({
      "GET /t/abc123/org": () => {
        calls += 1;
        return calls === 1 ? refusal(404, "not_found", "This duo is in no org.") : new Promise<Response>(() => {});
      },
    });
    await renderShell();
    await waitFor(() => expect(adminLink()).toBeNull());
    // The hint is stale again (as it would be from another tab's sign-in), and the next refresh is slow.
    localStorage.setItem("duo.hosted-account", JSON.stringify({ origin: ORIGIN, ownerName: "Ada", isAdmin: false, orgRole: "org_admin" }));
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    expect(adminLink()).toBeNull();
  });

  it("the live answer is written back to the stored account: a revoked ex-admin's next cold start draws no entry", async () => {
    signInAs({ isAdmin: true, orgRole: "org_admin" });
    daemon({ "GET /t/abc123/org": () => overview("member", false) });
    const first = await renderShell();
    await waitFor(() => expect(adminLink()).toBeNull());
    await waitFor(() => expect(readHostedAccount()).toMatchObject({ origin: ORIGIN, isAdmin: false, orgRole: "member" }));
    first.unmount();

    // A cold start whose answer is slow: only the stored account is there to draw from.
    daemon({ "GET /t/abc123/org": () => new Promise<Response>(() => {}) });
    await renderShell();
    expect(adminLink()).toBeNull();
  });

  it("an appointment is written back too, so the entry is there at the next cold start", async () => {
    signInAs();
    daemon({ "GET /t/abc123/org": () => overview("org_admin") });
    await renderShell();
    await waitFor(() => expect(readHostedAccount()).toMatchObject({ isAdmin: false, orgRole: "org_admin" }));
  });

  it("'in no org' clears the org hint and leaves the super admin flag, which it says nothing about", async () => {
    signInAs({ isAdmin: true, orgRole: "org_admin" });
    daemon({ "GET /t/abc123/org": () => refusal(404, "not_found") });
    await renderShell();
    await waitFor(() => expect(readHostedAccount()).toMatchObject({ isAdmin: true, orgRole: "member" }));
    expect(adminLink()).not.toBeNull();
  });

  it("nothing is written for an account of another server", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify(api));
    const other = { origin: "https://elsewhere.example.org", ownerName: "Ada", isAdmin: true, orgRole: "org_admin" };
    localStorage.setItem("duo.hosted-account", JSON.stringify(other));
    daemon({ "GET /t/abc123/org": () => overview("member") });
    await renderShell();
    expect(readHostedAccount()).toEqual(other);
  });

  it("a person with no name stays on the list under a label, and can still be appointed", async () => {
    expect(readOrgMembers([{ duoId: "n1", name: "", email: "nn@example.com" }, { duoId: "n2" }, { duoId: "n3", name: "  " }]).map((m) => m.name)).toEqual([
      "nn@example.com",
      "Unnamed member",
      "  ",
    ]);
    orgDaemon([ME, { ...KIM, name: "" }]);
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    expect(screen.getAllByTestId("admin-member")).toHaveLength(2);
    fireEvent.click(within(rowFor("kim@example.com")).getByRole("button", { name: "Appoint kim@example.com as an org admin…" }));
    expect(screen.getByTestId("admin-appoint-confirmation")).toHaveTextContent("Make kim@example.com an org admin?");
  });

  it("a switch of org never shows the old org's people or invites while the new org's load", async () => {
    let current = "plat1";
    let releaseMembers: (r: Response) => void = () => {};
    let releaseInvites: (r: Response) => void = () => {};
    const old = { id: "i1", name: "OldInvite", email: null, orgId: "plat1", createdAt: "2026-09-25T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
    const { state } = orgDaemon([ME], {
      "GET /t/abc123/org/members": () => (current === "plat1" ? json([ME, KIM]) : new Promise<Response>((resolve) => (releaseMembers = resolve))),
      "GET /t/abc123/org/invites": () => (current === "plat1" ? json([old]) : new Promise<Response>((resolve) => (releaseInvites = resolve))),
    });
    const { client } = withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="org" />);
    await screen.findAllByTestId("admin-member");
    expect(await screen.findByTestId("admin-pending-invite")).toHaveTextContent("OldInvite");

    current = "agency9";
    state.org = { id: "agency9", name: "Agency" };
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.orgOverview });
    });
    expect(await screen.findByRole("heading", { name: "Invite someone into Agency" })).toBeInTheDocument();
    expect(screen.queryAllByTestId("admin-member")).toHaveLength(0);
    expect(screen.queryByTestId("admin-pending-invite")).toBeNull();
    expect(document.body.textContent).not.toContain("Kim");
    expect(document.body.textContent).not.toContain("OldInvite");

    await act(async () => {
      releaseMembers(json([row({ duoId: "abc123", name: "Ada", orgRole: "org_admin" }), row({ duoId: "zed1", name: "Zed" })]));
      releaseInvites(json([]));
    });
    expect(await screen.findByText("Zed")).toBeInTheDocument();
    expect(screen.queryByText("Kim")).toBeNull();
  });

  it("the org's cached people and invites are keyed by the org", () => {
    expect(queryKeys.orgMembers("a")).not.toEqual(queryKeys.orgMembers("b"));
    expect(queryKeys.orgInvites("a")).not.toEqual(queryKeys.orgInvites("b"));
    expect(queryKeys.orgMembers("a").slice(0, 2)).toEqual(["org", "a"]);
  });

  it("a revoke that the daemon refuses for the root duo says the root duo's plain sentence", async () => {
    const PLAT = { id: "plat1", name: "Platform team", createdAt: "2026-09-20T00:00:00.000Z", memberCount: 2 };
    daemon({
      "GET /hosted/orgs": () => json([PLAT]),
      "GET /hosted/orgs/plat1/members": () => json([ME, KIM]),
      "POST /hosted/orgs/plat1/admins/abc123/revoke": () => refusal(409, "root_not_appointable", "Daemon text that must not be shown."),
    });
    withClient(<Admin api={{ baseUrl: BASE, token: "super-tok" }} origin={ORIGIN} orgId="plat1" role="super" />);
    await screen.findAllByTestId("admin-member");
    fireEvent.click(within(rowFor("Ada")).getByTestId("admin-revoke"));
    fireEvent.click(screen.getByTestId("admin-revoke-confirm"));
    expect(await screen.findByText("The first duo on this server can't be made an org admin.")).toBeInTheDocument();
    expect(screen.queryByText(/Daemon text/)).toBeNull();
  });

  it("Settings offers the invite tool from the live role, not the stored flag: a stale super admin flag loses it", async () => {
    signInAs({ isAdmin: true });
    daemon({ "GET /t/abc123/org": () => overview("member", false) });
    window.location.hash = "#settings/advanced";
    await renderShell();
    await screen.findByTestId("settings-account");
    await waitFor(() => expect(screen.queryByTestId("settings-invite-people")).toBeNull());
    expect(screen.getByTestId("settings-account")).not.toHaveTextContent("as an admin of this server");
  });

  it("Settings offers the invite tool to the live super admin, and its token goes to the paired origin", async () => {
    signInAs();
    const mock = daemon({ "GET /t/abc123/org": () => overview("member", true) });
    window.location.hash = "#settings/advanced";
    await renderShell();
    expect(await screen.findByTestId("settings-invite-people")).toBeInTheDocument();
    expect(screen.getByTestId("settings-account")).toHaveTextContent("as an admin of this server");
    await waitFor(() => expect(callsTo(mock, "GET", "/hosted/invites")).toHaveLength(1));
    const [url, init] = callsTo(mock, "GET", "/hosted/invites")[0]!;
    expect(String(url)).toBe(`${ORIGIN}/hosted/invites`);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer member-tok");
  });

  it("Settings offers an org admin no invite tool of the server's", async () => {
    signInAs();
    const mock = daemon({ "GET /t/abc123/org": () => overview("org_admin", false) });
    window.location.hash = "#settings/advanced";
    await renderShell();
    await screen.findByTestId("settings-account");
    expect(screen.queryByTestId("settings-invite-people")).toBeNull();
    expect(callsTo(mock, "GET", "/hosted/invites")).toHaveLength(0);
  });
});
