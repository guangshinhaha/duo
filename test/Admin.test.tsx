import { dehydrate, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { App } from "../src/App.js";
import { stubDesktop } from "./desktop.js";
import { Admin } from "../src/routes/Admin.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { HostedOrg } from "../src/api/hosted.js";
import { queryKeys, shouldPersistQuery } from "../src/api/queries.js";

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
  // Side by side, so the chat list (with its footer's Admin link) stands beside the open page.
  stubDesktop();
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
  it("a signed-in admin sees Admin in the list footer, beside Sign out", async () => {
    signInAs(true);
    daemon({});
    await renderShell();
    const link = within(screen.getByTestId("chat-list")).getByRole("link", { name: "Admin" });
    expect(link).toHaveAttribute("href", "#admin");
    expect(link.closest("nav")).toBeNull(); // the footer, never among the chats
  });

  it("a signed-in non-admin never sees it, and a paired-by-address app doesn't either", async () => {
    signInAs(false);
    daemon({});
    const { unmount } = await renderShell();
    expect(within(screen.getByTestId("chat-list")).queryByRole("link", { name: "Admin" })).toBeNull();
    unmount();

    localStorage.removeItem("duo.hosted-account");
    await renderShell();
    expect(within(screen.getByTestId("chat-list")).queryByRole("link", { name: "Admin" })).toBeNull();
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
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="super" />);
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
    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("aria-current", "page");
    unmount();

    window.location.hash = "#admin/plat1";
    await renderShell();
    expect(await screen.findByTestId("admin-org-name")).toHaveTextContent("Platform team");
    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("aria-current", "page");
  });
});

describe("#128 — the org list", () => {
  it("lists every org with its member count, each linking to its own page, using this device's token", async () => {
    const mock = daemon({ "GET /hosted/orgs": () => json([DEFAULT_ORG, PLATFORM]) });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="super" />);
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
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="super" />);
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
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="super" />);
    expect(await screen.findByTestId("admin-orgs-empty")).toHaveTextContent("No orgs yet.");
    expect(screen.getByRole("button", { name: "Create org" })).toBeDisabled();
  });

  it("a taken name shows the daemon's own words and keeps what was typed", async () => {
    daemon({
      "GET /hosted/orgs": () => json([PLATFORM]),
      "POST /hosted/orgs": () => json({ error: { code: "org_name_taken", message: 'There is already an org named "Platform team".' } }, 409),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="super" />);
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
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    const rows = await screen.findAllByTestId("admin-member");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Shin");
    expect(rows[0]).toHaveTextContent("Shin's duo");
    expect(within(rows[0]!).getByTestId("admin-member-root")).toHaveTextContent("Root duo");
    // The older `isAdmin` flag reads as the super admin: its own words, never "Org admin".
    expect(within(rows[0]!).getByTestId("admin-member-super-admin")).toHaveTextContent("Super admin");
    expect(within(rows[0]!).queryByTestId("admin-member-org-admin")).toBeNull();
    expect(rows[1]).toHaveTextContent("Kim's duo");
    expect(rows[1]).toHaveTextContent("kim@example.com");
    expect(within(rows[1]!).queryByTestId("admin-member-root")).toBeNull();
    expect(callsTo(mock, "GET", "/hosted/orgs/plat1/members")).toHaveLength(1);
    expect(screen.getByTestId("admin-back")).toHaveAttribute("href", "#admin");
  });

  it("says so when nobody has joined yet", async () => {
    daemon({ "GET /hosted/orgs": () => json([{ ...PLATFORM, memberCount: 0 }]), "GET /hosted/orgs/plat1/members": () => json([]) });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    expect(await screen.findByTestId("admin-members-empty")).toBeInTheDocument();
  });

  it("an org that isn't there is a note with the way back, not a crash", async () => {
    daemon({ "GET /hosted/orgs": () => json([PLATFORM]) });
    withClient(<Admin api={api} origin={ORIGIN} orgId="gone" role="super" />);
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
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
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

  it("a rename to a taken name says the name isn't available and leaves the form open", async () => {
    daemon({
      "GET /hosted/orgs": () => json([PLATFORM, DEFAULT_ORG]),
      "GET /hosted/orgs/plat1/members": () => json([]),
      "POST /hosted/orgs/plat1/rename": () => json({ error: { code: "org_name_taken", message: 'There is already an org named "Default".' } }, 409),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    fireEvent.click(await screen.findByTestId("admin-rename"));
    fireEvent.change(screen.getByRole("textbox", { name: "New name" }), { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByTestId("mutation-error")).toHaveTextContent("That name isn't available. Choose a different one.");
    expect(screen.getByTestId("mutation-error")).not.toHaveTextContent("Default");
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
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
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
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Lee" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByTestId("admin-invite-code")).toHaveTextContent("onlycode");
    const [, init] = callsTo(mock, "POST", "/hosted/invites")[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Lee", orgId: "plat1" });
  });

  it("an email without an @ can't be submitted", async () => {
    daemon({ "GET /hosted/orgs": () => json([PLATFORM]), "GET /hosted/orgs/plat1/members": () => json([]) });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
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
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByTestId("mutation-error")).toHaveTextContent('There is no org "plat1".');
  });
});

describe("#128 — review fixes", () => {
  const AGENCY: HostedOrg = { id: "agency2", name: "Agency", createdAt: "2026-09-22T00:00:00.000Z", memberCount: 0 };
  const MINTED = {
    id: "i1",
    name: "Sam",
    email: null,
    orgId: "plat1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    code: "c0de",
    link: "https://web.example/#join?host=x&invite=c0de",
  };

  it("a hash change straight from one org to another drops the invite link made for the first", async () => {
    signInAs(true);
    daemon({
      "GET /hosted/orgs": () => json([PLATFORM, AGENCY]),
      "POST /hosted/invites": () => json(MINTED, 201),
    });
    window.location.hash = "#admin/plat1";
    await renderShell();
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    const minted = await screen.findByTestId("admin-invite-minted");
    expect(minted).toHaveTextContent("Sam's invite to Platform team");
    expect(screen.getByTestId("admin-invite-link")).toHaveTextContent("invite=c0de");

    act(() => {
      window.location.hash = "#admin/agency2";
    });
    expect(await screen.findByRole("heading", { name: "Invite someone into Agency" })).toBeInTheDocument();
    expect(screen.queryByTestId("admin-invite-minted")).toBeNull();
    expect(screen.queryByTestId("admin-invite-link")).toBeNull();
  });

  it("the minted result takes focus and is a polite live region", async () => {
    daemon({
      "GET /hosted/orgs": () => json([PLATFORM]),
      "GET /hosted/orgs/plat1/members": () => json([]),
      "POST /hosted/invites": () => json(MINTED, 201),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    const minted = await screen.findByTestId("admin-invite-minted");
    expect(minted).toHaveAttribute("aria-live", "polite");
    expect(minted).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(minted).toHaveFocus());
  });

  it("with no link the button is named 'Copy invite code' and the explanation sits in the sentence above", async () => {
    daemon({
      "GET /hosted/orgs": () => json([PLATFORM]),
      "GET /hosted/orgs/plat1/members": () => json([]),
      "POST /hosted/invites": () => json({ ...MINTED, link: null }, 201),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByRole("button", { name: "Copy invite code" })).toBeInTheDocument();
    expect(screen.getByTestId("admin-invite-minted")).toHaveTextContent("doesn't know its public address");
  });

  it("Rename moves focus into the input; Cancel and a saved name hand it back to the button", async () => {
    let name = PLATFORM.name;
    daemon({
      "GET /hosted/orgs": () => json([{ ...PLATFORM, name }]),
      "GET /hosted/orgs/plat1/members": () => json([]),
      "POST /hosted/orgs/plat1/rename": (init) => {
        name = (JSON.parse(String(init?.body)) as { name: string }).name;
        return json({ ...PLATFORM, name });
      },
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    fireEvent.click(await screen.findByTestId("admin-rename"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "New name" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByTestId("admin-rename")).toHaveFocus());

    fireEvent.click(screen.getByTestId("admin-rename"));
    fireEvent.change(await screen.findByRole("textbox", { name: "New name" }), { target: { value: "Platform" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByTestId("admin-org-name").textContent).toBe("Platform"));
    await waitFor(() => expect(screen.getByTestId("admin-rename")).toHaveFocus());
  });

  it("after a create, the note points at the list above", async () => {
    daemon({
      "GET /hosted/orgs": () => json([]),
      "POST /hosted/orgs": () => json({ ...AGENCY }, 201),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId={null} role="super" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name of the org" }), { target: { value: "Agency" } });
    fireEvent.click(screen.getByRole("button", { name: "Create org" }));
    expect(await screen.findByTestId("admin-org-created")).toHaveTextContent("Open it in the list above to invite people in.");
  });
});

describe("#128 — what rests in the persisted cache", () => {
  it("leaves out the orgs, each org's people and the invites, and keeps the rest", async () => {
    const client = new QueryClient();
    const keys: (readonly unknown[])[] = [
      queryKeys.hostedOrgs,
      queryKeys.hostedOrgMembers("plat1"),
      queryKeys.hostedInvites,
      ["workspace", "search", "q"],
      queryKeys.devices,
    ];
    await Promise.all(keys.map((queryKey) => client.prefetchQuery({ queryKey, queryFn: async () => "x" })));
    const persisted = dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery }).queries.map((q) => q.queryKey);
    expect(persisted).toEqual([queryKeys.devices]);
  });
});

describe("#128 — the token goes only to the server the app is paired with", () => {
  it("a stored account for another origin is no admin here: no entry, the plain note, no request anywhere", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify(api));
    localStorage.setItem("duo.hosted-account", JSON.stringify({ origin: "https://elsewhere.example.org", ownerName: "Shin", isAdmin: true }));
    const mock = daemon({});
    window.location.hash = "#admin";
    await renderShell();
    expect(within(screen.getByTestId("chat-list")).queryByRole("link", { name: "Admin" })).toBeNull();
    expect(screen.getByTestId("admin-not-available")).toBeInTheDocument();
    expect(mock.mock.calls.filter(([input]) => String(input).includes("/hosted/"))).toHaveLength(0);
  });

  it("the admin calls go to the origin of api.baseUrl, path and all stripped", async () => {
    signInAs(true);
    const mock = daemon({ "GET /hosted/orgs": () => json([PLATFORM]) });
    window.location.hash = "#admin";
    await renderShell();
    await screen.findByTestId("admin-orgs");
    const [url] = callsTo(mock, "GET", "/hosted/orgs")[0]!;
    expect(new URL(String(url)).origin).toBe(ORIGIN);
  });
});

describe("#128 — addresses that aren't an org", () => {
  it("a non-admin on #admin/<id> gets the plain note and asks the daemon nothing", async () => {
    signInAs(false);
    const mock = daemon({});
    window.location.hash = "#admin/plat1";
    await renderShell();
    expect(screen.getByTestId("admin-not-available")).toBeInTheDocument();
    expect(mock.mock.calls.filter(([input]) => String(input).includes("/hosted/"))).toHaveLength(0);
  });

  it.each(["#admin/", "#admin/%E0%A4%A"])("%s is the org list, and no org's people are asked for", async (hash) => {
    signInAs(true);
    const mock = daemon({ "GET /hosted/orgs": () => json([PLATFORM]) });
    window.location.hash = hash;
    await renderShell();
    expect(await screen.findByTestId("admin-orgs")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-org-page")).toBeNull();
    expect(mock.mock.calls.filter(([input]) => String(input).endsWith("/members"))).toHaveLength(0);
  });

  it("an id with characters that need encoding travels encoded in the members and rename paths", async () => {
    const odd: HostedOrg = { ...PLATFORM, id: "x y/z" };
    const mock = daemon({
      "GET /hosted/orgs": () => json([odd]),
      "GET /hosted/orgs/x%20y%2Fz/members": () => json([]),
      "POST /hosted/orgs/x%20y%2Fz/rename": () => json({ ...odd, name: "Renamed" }),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="x y/z" role="super" />);
    await screen.findByTestId("admin-members-empty");
    expect(callsTo(mock, "GET", "/hosted/orgs/x%20y%2Fz/members")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("admin-rename"));
    fireEvent.change(screen.getByRole("textbox", { name: "New name" }), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(callsTo(mock, "POST", "/hosted/orgs/x%20y%2Fz/rename")).toHaveLength(1));
  });
});

describe("#128 — the daemon says no", () => {
  const orgRoutes = { "GET /hosted/orgs": () => json([PLATFORM]) };

  it.each([401, 403])("a %i on the people is the plain note", async (status) => {
    daemon({ ...orgRoutes, "GET /hosted/orgs/plat1/members": () => json({ error: { code: "forbidden", message: "Only an admin can do this." } }, status) });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    expect(await screen.findByTestId("admin-not-available")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-org-page")).toBeNull();
  });

  it("a 404 on the people says so and offers Try again, which asks again", async () => {
    let ok = false;
    const mock = daemon({
      ...orgRoutes,
      "GET /hosted/orgs/plat1/members": () => (ok ? json([]) : json({ error: { code: "org_not_found", message: 'There is no org "plat1".' } }, 404)),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    expect(await screen.findByTestId("admin-members-error")).toHaveTextContent('There is no org "plat1".');
    ok = true;
    fireEvent.click(screen.getByTestId("admin-members-retry"));
    expect(await screen.findByTestId("admin-members-empty")).toBeInTheDocument();
    expect(callsTo(mock, "GET", "/hosted/orgs/plat1/members")).toHaveLength(2);
  });

  it.each([401, 403, 404])("a %i on rename shows the daemon's words and leaves the form open", async (status) => {
    daemon({
      ...orgRoutes,
      "GET /hosted/orgs/plat1/members": () => json([]),
      "POST /hosted/orgs/plat1/rename": () => json({ error: { code: "no", message: `Refused with ${status}.` } }, status),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    fireEvent.click(await screen.findByTestId("admin-rename"));
    fireEvent.change(screen.getByRole("textbox", { name: "New name" }), { target: { value: "Other" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByTestId("mutation-error")).toHaveTextContent(`Refused with ${status}.`);
    expect(screen.getByRole("textbox", { name: "New name" })).toBeInTheDocument();
  });

  it.each([401, 403, 404])("a %i on an invite shows the daemon's words and no link", async (status) => {
    daemon({
      ...orgRoutes,
      "GET /hosted/orgs/plat1/members": () => json([]),
      "POST /hosted/invites": () => json({ error: { code: "no", message: `Refused with ${status}.` } }, status),
    });
    withClient(<Admin api={api} origin={ORIGIN} orgId="plat1" role="super" />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Who it's for" }), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByTestId("mutation-error")).toHaveTextContent(`Refused with ${status}.`);
    expect(screen.queryByTestId("admin-invite-minted")).toBeNull();
  });
});
