import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { DuoApiConfig } from "../src/api/client.js";
import { Settings } from "../src/routes/Settings.js";
import type { SettingsSectionId } from "../src/shell/routes.js";
import { SETTINGS_SECTIONS } from "../src/shell/routes.js";
import type { WorkspaceConnection } from "../src/workspace/matrix.js";
import { stubDesktop } from "./desktop.js";

/*
 * Settings in sections (#148): they read like preferences, not plumbing. An
 * index in plain words; each section on its own; the daemon's address and
 * token only under Advanced; ending your duo a section of its own, last.
 */

const api: DuoApiConfig = { baseUrl: "http://100.64.1.5:7717", token: "secret-token-1234" };

function mount(
  section: SettingsSectionId | "index" | undefined,
  duo: DuoApiConfig | null = api,
  connection: WorkspaceConnection | null = null,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Settings
        api={duo}
        connection={connection}
        onConfigChange={() => {}}
        onDuoEnded={() => {}}
        onPairDuo={() => {}}
        onSignOut={() => {}}
        onWorkspaceSignIn={() => {}}
        section={section}
        session={null}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

describe("the index", () => {
  it("lists the sections in order, each with a plain line about it, and 'End this duo' last", () => {
    mount("index");
    const links = within(screen.getByRole("navigation", { name: "Settings sections" })).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(SETTINGS_SECTIONS.map((entry) => `#settings/${entry.id}`));
    expect(links.map((link) => within(link).getAllByText(/./)[0]!.textContent)).toEqual([
      "Notifications",
      "Appearance",
      "Sending",
      "Profile",
      "Privacy & data",
      "Devices",
      "Ask links",
      "Connect to Claude",
      "Advanced",
      "End this duo",
    ]);
    expect(links.at(-1)).toHaveAttribute("href", "#settings/end");
    expect(screen.getByTestId("settings-link-devices")).toHaveTextContent("The devices that can reach your duo");
  });

  it("names nothing that needs a duo when none is paired, and points at where to pair one", () => {
    mount("index", null);
    const ids = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(ids).toContain("#settings/advanced");
    expect(ids).toContain("#settings/notifications");
    for (const needsDuo of ["privacy", "devices", "links", "claude", "end"]) {
      expect(ids).not.toContain(`#settings/${needsDuo}`);
    }
    expect(screen.getByTestId("settings-index-no-duo")).toHaveTextContent("Pair your duo under Advanced");
  });
});

describe("each section is on its own", () => {
  it("Notifications is do not disturb, quiet hours and what was held back — and nothing else", () => {
    mount("notifications");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Notifications");
    expect(screen.getByTestId("dnd-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("missed-list")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-theme")).toBeNull();
    expect(screen.queryByTestId("settings-address")).toBeNull();
  });

  it("Appearance is the theme and the keyboard shortcuts", () => {
    mount("appearance");
    expect(screen.getByTestId("settings-theme")).toBeInTheDocument();
    expect(screen.getByText("Keyboard", { selector: "h2" })).toBeInTheDocument();
    expect(screen.queryByTestId("dnd-toggle")).toBeNull();
  });

  it("Profile offers to sign in when no workspace connection is up, and renders the profile editor when one is (#224)", async () => {
    mount("profile", api, null);
    expect(screen.getByTestId("settings-profile")).toHaveTextContent("Sign in to a workspace");
    cleanup();

    const connection = {
      profile: vi.fn(async () => ({ name: "Ana", avatarUrl: null })),
      setDisplayName: vi.fn(async () => {}),
      setAvatarUrl: vi.fn(async () => "mxc://workspace.example/x"),
      loadMedia: vi.fn(async () => null),
    } as unknown as WorkspaceConnection;
    mount("profile", api, connection);
    expect(await screen.findByTestId("profile-name-input")).toHaveValue("Ana");
  });

  it("Devices, Ask links and Connect to Claude are each their own page", async () => {
    mount("devices");
    expect(await screen.findByRole("heading", { level: 2, name: "Devices" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Pair another device" })).toBeInTheDocument();
    cleanup();
    mount("links");
    expect(await screen.findByRole("heading", { level: 2, name: /ask links/i })).toBeInTheDocument();
    cleanup();
    mount("claude");
    expect(await screen.findByRole("heading", { level: 2, name: "Connect to Claude" })).toBeInTheDocument();
  });

  it("End this duo is a section of its own, and the only place that acts on the daemon itself", () => {
    mount("end");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("End this duo");
    expect(screen.getByTestId("settings-end-duo")).toHaveTextContent("End this duo");
    expect(screen.queryByTestId("settings-unpair")).toBeNull();
  });

  it("every section has a way back to the index", () => {
    for (const entry of SETTINGS_SECTIONS) {
      mount(entry.id);
      expect(screen.getByTestId("settings-back")).toHaveAttribute("href", "#settings");
      cleanup();
    }
  });
});

describe("the daemon's address and token live only under Advanced", () => {
  it("Advanced holds the workspace, the connection (address, masked token) and this device", () => {
    mount("advanced");
    expect(screen.getByTestId("settings-workspace")).toBeInTheDocument();
    expect(screen.getByTestId("settings-address")).toHaveTextContent("http://100.64.1.5:7717");
    expect(screen.getByTestId("settings-token")).toHaveTextContent("•••• 1234");
    expect(screen.getByTestId("settings-unpair")).toHaveTextContent("Forget this device");
  });

  it("no other section shows the address or any part of the token", async () => {
    for (const entry of SETTINGS_SECTIONS.filter((section) => section.id !== "advanced")) {
      const view = mount(entry.id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(view.container.textContent).not.toContain("100.64.1.5");
      expect(view.container.textContent).not.toContain("1234");
      expect(view.container.textContent).not.toContain("secret-token");
      cleanup();
    }
    const index = mount("index");
    expect(index.container.textContent).not.toContain("100.64.1.5");
  });
});

describe("a section that cannot exist here reads as the index, never a dead page", () => {
  it("shows the index for a duo-only section when no duo is paired", () => {
    mount("devices", null);
    expect(screen.getByTestId("settings-index")).toBeInTheDocument();
  });
});

describe("in the app", () => {
  it("the chat list's gear opens the index, and a deep link opens its section", async () => {
    stubDesktop();
    localStorage.setItem("duo.api-config", JSON.stringify(api));
    window.location.hash = "#chats";
    const view = render(<App />);
    expect(await screen.findByTestId("chat-list-settings")).toHaveAttribute("href", "#settings");
    view.unmount();

    window.location.hash = "#settings/appearance";
    render(<App />);
    expect(await screen.findByTestId("settings-theme")).toBeInTheDocument();
    expect(screen.getByTestId("settings")).toHaveAttribute("data-section", "appearance");
    expect(screen.getByTestId("chat-list")).toBeInTheDocument(); // the list stays beside it on a desktop
  });
});
