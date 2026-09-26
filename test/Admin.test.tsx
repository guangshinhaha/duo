import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { App } from "../src/App.js";
import { Admin } from "../src/routes/Admin.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { HostedOrg } from "../src/api/hosted.js";

vi.mock("../src/notifications.js", () => ({
  draftArrivalBody: vi.fn(() => null),
  notifyDraftReady: vi.fn(),
  postNotification: vi.fn(),
  wireNotificationClicks: vi.fn(() => Promise.resolve(() => {})),
}));

/*
 * #128: the super admin's screens. The way in is drawn only for an account
 * the sign-in answer marked admin, and the screen answers a 401/403 with a
 * plain "not for you" note — the daemon is the lock, the entry a courtesy.
 * The daemon is a fetch fake keyed "METHOD path" at the origin.
 */

const ORIGIN = "https://duo-daemon.example.org";
const api: DuoApiConfig = { baseUrl: `${ORIGIN}/t/abc123`, token: "admin-tok" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const forbidden = () => json({ error: { code: "forbidden", message: "Only an admin can do this." } }, 403);

const PLATFORM: HostedOrg = { id: "plat1", name: "Platform team", createdAt: "2026-09-20T00:00:00.000Z", memberCount: 2 };
const DEFAULT_ORG: HostedOrg = { id: "default", name: "Default", createdAt: "2026-09-01T00:00:00.000Z", memberCount: 1 };

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

/** Routes are read fresh per call, so a test can change what the list answers after a write. */
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

function withClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function signInAs(isAdmin: boolean) {
  localStorage.setItem("duo.api-config", JSON.stringify(api));
  localStorage.setItem("duo.hosted-account", JSON.stringify({ origin: ORIGIN, ownerName: "Shin", isAdmin }));
}

async function renderShell() {
  const view = render(<App />);
  await waitFor(() => expect(view.container.querySelector("main")).not.toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return view;
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
  localStorage.clear();
  window.location.hash = "";
});

describe("#128 — who sees the way in", () => {
  it("a signed-in admin sees Admin beside Settings, outside the three sections", async () => {
    signInAs(true);
    daemon({});
    await renderShell();
    const link = within(screen.getByRole("navigation", { name: "Surfaces" })).getByRole("link", { name: "Admin" });
    expect(link).toHaveAttribute("href", "#admin");
    expect(link.closest('[role="group"]')).toBeNull();
  });

  it("a signed-in non-admin never sees it, and a paired-by-address app doesn't either", async () => {
    signInAs(false);
    daemon({});
    const { unmount } = await renderShell();
    expect(within(screen.getByRole("navigation", { name: "Surfaces" })).queryByRole("link", { name: "Admin" })).toBeNull();
    unmount();

    localStorage.removeItem("duo.hosted-account");
    await renderShell();
    expect(within(screen.getByRole("navigation", { name: "Surfaces" })).queryByRole("link", { name: "Admin" })).toBeNull();
  });

  it("typing #admin as a non-admin says it isn't for you and asks the daemon nothing", async () => {
    signInAs(false);
    const mock = daemon({});
    window.location.hash = "#admin";
    await renderShell();
    expect(screen.getByTestId("admin-not-available")).toHaveTextContent("Only the person who runs this server can open this page.");
    expect(callsTo(mock, "GET", "/hosted/orgs")).toHaveLength(0);
  });

  it("a stale admin flag is answered by the daemon's 403 with the same plain note, not an error screen", async () => {
    signInAs(true);
    daemon({ "GET /hosted/orgs": forbidden });
    window.location.hash = "#admin";
    await renderShell();
    expect(await screen.findByTestId("admin-not-available")).toBeInTheDocument();
    expect(screen.queryByTestId("route-error")).toBeNull();
  });

  it("a 401 is the same note", async () => {
    daemon({ "GET /hosted/orgs": () => json({ error: { code: "unauthorized", message: "Only an admin can do this." } }, 401) });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} />);
    expect(await screen.findByTestId("admin-not-available")).toBeInTheDocument();
  });

  it("an admin's #admin opens the org list, and an org's address opens that org", async () => {
    signInAs(true);
    daemon({
      "GET /hosted/orgs": () => json([PLATFORM]),
      "GET /hosted/orgs/plat1/members": () => json([]),
    });
    window.location.hash = "#admin";
    const { unmount } = await renderShell();
    expect(await screen.findByTestId("admin-orgs")).toBeInTheDocument();
    // The Admin entry is the lit one.
    expect(screen.getByRole("link", { name: "Admin" }).className).toContain("bg-[var(--surface)]");
    unmount();

    window.location.hash = "#admin/plat1";
    await renderShell();
    expect(await screen.findByTestId("admin-org-name")).toHaveTextContent("Platform team");
    expect(screen.getByRole("link", { name: "Admin" }).className).toContain("bg-[var(--surface)]");
  });
});

describe("#128 — the org list", () => {
  it("lists every org with its member count, each linking to its own page, using this device's token", async () => {
    const mock = daemon({ "GET /hosted/orgs": () => json([DEFAULT_ORG, PLATFORM]) });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} />);
    const rows = await screen.findAllByTestId("admin-org");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Default");
    expect(within(rows[0]!).getByTestId("admin-org-count")).toHaveTextContent("1 person");
    expect(within(rows[1]!).getByTestId("admin-org-count")).toHaveTextContent("2 people");
    expect(rows[1]).toHaveAttribute("href", "#admin/plat1");
    const [, init] = callsTo(mock, "GET", "/hosted/orgs")[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer admin-tok");
  });

  it("creates an org: posts the trimmed name, then the list shows it", async () => {
    let orgs: HostedOrg[] = [DEFAULT_ORG];
    const mock = daemon({
      "GET /hosted/orgs": () => json(orgs),
      "POST /hosted/orgs": (init) => {
        const { name } = JSON.parse(String(init?.body)) as { name: string };
        const org = { id: "new1", name, createdAt: "2026-09-26T00:00:00.000Z" };
        orgs = [...orgs, { ...org, memberCount: 0 }];
        return json({ ...org, memberCount: 0 }, 201);
      },
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} />);
    await screen.findAllByTestId("admin-org");

    fireEvent.change(screen.getByRole("textbox", { name: "Name of the org" }), { target: { value: "  Agency B  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create org" }));

    expect(await screen.findByTestId("admin-org-created")).toHaveTextContent("Created Agency B.");
    await waitFor(() => expect(screen.getAllByTestId("admin-org")).toHaveLength(2));
    expect(screen.getAllByTestId("admin-org")[1]).toHaveTextContent("Agency B");
    expect(screen.getAllByTestId("admin-org-count")[1]).toHaveTextContent("0 people");
    const [, init] = callsTo(mock, "POST", "/hosted/orgs")[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Agency B" });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer admin-tok");
    expect(screen.getByRole("textbox", { name: "Name of the org" })).toHaveValue("");
  });

  it("can't create with an empty name", async () => {
    daemon({ "GET /hosted/orgs": () => json([]) });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} />);
    expect(await screen.findByTestId("admin-orgs-empty")).toHaveTextContent("No orgs yet.");
    expect(screen.getByRole("button", { name: "Create org" })).toBeDisabled();
  });

  it("a taken name shows the daemon's own words and keeps what was typed", async () => {
    daemon({
      "GET /hosted/orgs": () => json([PLATFORM]),
      "POST /hosted/orgs": () => json({ error: { code: "org_name_taken", message: 'There is already an org named "Platform team".' } }, 409),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} />);
    await screen.findAllByTestId("admin-org");
    fireEvent.change(screen.getByRole("textbox", { name: "Name of the org" }), { target: { value: "platform team" } });
    fireEvent.click(screen.getByRole("button", { name: "Create org" }));
    expect(await screen.findByTestId("mutation-error")).toHaveTextContent('There is already an org named "Platform team".');
    expect(screen.queryByTestId("admin-org-created")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Name of the org" })).toHaveValue("platform team");
  });
});

describe("#128 — one org", () => {
  const MEMBERS = [
    { duoId: "root", name: "Shin", email: "shin@example.com", isRoot: true, joinedAt: null, isAdmin: true },
    { duoId: "k1", name: "Kim", email: "kim@example.com", isRoot: false, joinedAt: "2026-09-21T00:00:00.000Z", isAdmin: false },
  ];

  it("lists its people with their duos, and marks the root duo", async () => {
    const mock = daemon({
      "GET /hosted/orgs": () => json([PLATFORM]),
      "GET /hosted/orgs/plat1/members": () => json(MEMBERS),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" />);
    const rows = await screen.findAllByTestId("admin-member");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Shin");
    expect(rows[0]).toHaveTextContent("Shin's duo");
    expect(within(rows[0]!).getByTestId("admin-member-root")).toHaveTextContent("Root duo");
    expect(rows[0]).toHaveTextContent("Admin");
    expect(rows[1]).toHaveTextContent("Kim's duo");
    expect(rows[1]).toHaveTextContent("kim@example.com");
    expect(within(rows[1]!).queryByTestId("admin-member-root")).toBeNull();
    expect(callsTo(mock, "GET", "/hosted/orgs/plat1/members")).toHaveLength(1);
    expect(screen.getByTestId("admin-back")).toHaveAttribute("href", "#admin");
  });

  it("says so when nobody has joined yet", async () => {
    daemon({ "GET /hosted/orgs": () => json([{ ...PLATFORM, memberCount: 0 }]), "GET /hosted/orgs/plat1/members": () => json([]) });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" />);
    expect(await screen.findByTestId("admin-members-empty")).toBeInTheDocument();
  });

  it("an org that isn't there is a note with the way back, not a crash", async () => {
    daemon({ "GET /hosted/orgs": () => json([PLATFORM]) });
    withClient(<Admin api={api} origin={ORIGIN} orgId="gone" />);
    expect(await screen.findByTestId("admin-org-missing")).toHaveTextContent("There is no org with this address.");
    expect(screen.getByTestId("admin-back")).toBeInTheDocument();
  });

  it("renames: posts the new name to the org's rename address, and the page shows it", async () => {
    let name = PLATFORM.name;
    const mock = daemon({
      "GET /hosted/orgs": () => json([{ ...PLATFORM, name }]),
      "GET /hosted/orgs/plat1/members": () => json([]),
      "POST /hosted/orgs/plat1/rename": (init) => {
        name = (JSON.parse(String(init?.body)) as { name: string }).name;
        return json({ ...PLATFORM, name });
      },
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" />);
    fireEvent.click(await screen.findByTestId("admin-rename"));
    const input = screen.getByRole("textbox", { name: "New name" });
    expect(input).toHaveValue("Platform team");
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled(); // unchanged
    fireEvent.change(input, { target: { value: " Platform " } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByTestId("admin-org-name").textContent).toBe("Platform"));
    expect(screen.queryByRole("textbox", { name: "New name" })).toBeNull();
    const [, init] = callsTo(mock, "POST", "/hosted/orgs/plat1/rename")[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Platform" });
  });

  it("a rename to a taken name shows the daemon's words and leaves the form open", async () => {
    daemon({
      "GET /hosted/orgs": () => json([PLATFORM, DEFAULT_ORG]),
      "GET /hosted/orgs/plat1/members": () => json([]),
      "POST /hosted/orgs/plat1/rename": () => json({ error: { code: "org_name_taken", message: 'There is already an org named "Default".' } }, 409),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" />);
    fireEvent.click(await screen.findByTestId("admin-rename"));
    fireEvent.change(screen.getByRole("textbox", { name: "New name" }), { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByTestId("mutation-error")).toHaveTextContent('There is already an org named "Default".');
    expect(screen.getByRole("textbox", { name: "New name" })).toBeInTheDocument();
    expect(screen.getByTestId("admin-org-name")).toHaveTextContent("Platform team");
  });

  it("creates an invite link into this org — orgId in the body, the link shown once and copyable", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const mock = daemon({
      "GET /hosted/orgs": () => json([PLATFORM]),
      "GET /hosted/orgs/plat1/members": () => json([]),
      "POST /hosted/invites": () =>
        json(
          {
            id: "i1",
            name: "Sam",
            email: "sam@example.com",
            orgId: "plat1",
            expiresAt: "2099-01-01T00:00:00.000Z",
            code: "c0de",
            link: "https://web.example/#join?host=x&invite=c0de",
          },
          201,
        ),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" />);
    await screen.findByTestId("admin-invite");
    expect(screen.getByRole("heading", { name: "Invite someone into Platform team" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Who it's for" }), { target: { value: "Sam" } });
    fireEvent.change(screen.getByRole("textbox", { name: /google/i }), { target: { value: "sam@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));

    expect(await screen.findByTestId("admin-invite-link")).toHaveTextContent("https://web.example/#join?host=x&invite=c0de");
    expect(screen.getByTestId("admin-invite-minted")).toHaveTextContent("only sam@example.com can use it");
    const [, init] = callsTo(mock, "POST", "/hosted/invites")[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Sam", orgId: "plat1", email: "sam@example.com" });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer admin-tok");

    fireEvent.click(screen.getByRole("button", { name: "Copy invite link" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith("https://web.example/#join?host=x&invite=c0de");
  });

  it("without an email the body has none, and a server with no public address hands over the code", async () => {
    const mock = daemon({
      "GET /hosted/orgs": () => json([PLATFORM]),
      "GET /hosted/orgs/plat1/members": () => json([]),
      "POST /hosted/invites": () =>
        json({ id: "i2", name: "Lee", email: null, orgId: "plat1", expiresAt: "2099-01-01T00:00:00.000Z", code: "onlycode", link: null }, 201),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Lee" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByTestId("admin-invite-code")).toHaveTextContent("onlycode");
    const [, init] = callsTo(mock, "POST", "/hosted/invites")[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Lee", orgId: "plat1" });
  });

  it("an email without an @ can't be submitted", async () => {
    daemon({ "GET /hosted/orgs": () => json([PLATFORM]), "GET /hosted/orgs/plat1/members": () => json([]) });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Sam" } });
    fireEvent.change(screen.getByRole("textbox", { name: /google/i }), { target: { value: "sam" } });
    expect(screen.getByRole("button", { name: "Create invite link" })).toBeDisabled();
  });

  it("an invite the daemon refuses shows its words", async () => {
    daemon({
      "GET /hosted/orgs": () => json([PLATFORM]),
      "GET /hosted/orgs/plat1/members": () => json([]),
      "POST /hosted/invites": () => json({ error: { code: "org_not_found", message: 'There is no org "plat1".' } }, 404),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByTestId("mutation-error")).toHaveTextContent('There is no org "plat1".');
  });
});
