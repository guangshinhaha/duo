import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, NAMED_ROUTES } from "../src/App.js";
import { ADMIN_SCREEN, NAV_SECTIONS, SETTINGS_SCREEN } from "../src/navSections.js";
import { connect } from "../src/workspace/matrix.js";

/*
 * #129: the sidebar is grouped by the three things a person does here —
 * talking to people, their duo answering others, training their duo. The
 * map is one data structure (`src/navSections.ts`), so these tests pin the
 * properties that must survive any regrouping the owner asks for: every
 * screen sits in exactly one section (or is Settings), nothing user-facing
 * borrows infrastructure words, a section without its backend is a short
 * note and never a form, and the phone folds the same map.
 */

// The workspace seam is mocked the way Workspace.test does it: a member's
// connection that never settles is enough to hold the shell in its
// signed-in state without any room data.
vi.mock("../src/workspace/matrix.js", () => ({
  signIn: vi.fn(),
  connect: vi.fn(),
}));

const SESSION = {
  homeserverUrl: "https://workspace.example",
  userId: "@ana:workspace.example",
  accessToken: "syt_workspace_token",
  deviceId: "YGBNAUIOMK",
};

const allScreens = () => [...NAV_SECTIONS.flatMap((section) => section.screens), SETTINGS_SCREEN, ADMIN_SCREEN];

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
  vi.mocked(connect).mockReset();
  vi.mocked(connect).mockReturnValue(new Promise(() => {}));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

function seedPairing() {
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
}

function seedSession() {
  localStorage.setItem("duo.workspace-session", JSON.stringify(SESSION));
}

/** The persisted cache restores and the queries settle before anything is read — the same launch phases App.test waits out. */
async function renderShell() {
  const view = render(<App />);
  await waitFor(() => expect(view.container.querySelector("main")).not.toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return view;
}

/** The sidebar's own navigation — the folded one lives in a dialog, and is only there while open. */
function sidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Surfaces" });
}

describe("#129 — the map is three sections, every screen in exactly one", () => {
  it("has exactly the three sections, in the order a newcomer meets them", () => {
    expect(NAV_SECTIONS.map((section) => section.id)).toEqual(["people", "answering", "training"]);
    expect(NAV_SECTIONS.map((section) => section.title)).toEqual([
      "Talking to people",
      "Your duo answering others",
      "Training your duo",
    ]);
  });

  it("lists no screen twice, and Settings and Admin are in none of the sections", () => {
    const hrefs = allScreens().map((screen) => screen.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(NAV_SECTIONS.flatMap((section) => section.screens.map((s) => s.href))).not.toContain(SETTINGS_SCREEN.href);
    expect(NAV_SECTIONS.flatMap((section) => section.screens.map((s) => s.href))).not.toContain(ADMIN_SCREEN.href);
  });

  it("covers every named route the app has — a new route must be placed, not forgotten", () => {
    // The parser and this test read one list, so a route of any spelling
    // (hyphenated, numeric) is seen here the moment it can be parsed.
    const routes = NAMED_ROUTES.map((name) => `#${name}`);
    // The first run is the way in, not a place in the map.
    const expected = routes.filter((route) => route !== "#onboarding").sort();
    expect(expected.length).toBeGreaterThan(8);
    expect(allScreens().map((screen) => screen.href).sort()).toEqual(expected);
  });

  it("puts what the duo did for others together, and the learning loop together", () => {
    const hrefsOf = (id: string) => NAV_SECTIONS.find((section) => section.id === id)!.screens.map((s) => s.href);
    expect(hrefsOf("people")).toEqual(["#conversations"]);
    expect(hrefsOf("answering").sort()).toEqual(["#audit", "#channels", "#escalations"]);
    expect(hrefsOf("training").sort()).toEqual(
      ["#confirmations", "#corrections", "#duo", "#knowledge", "#mirror", "#review", "#trust"].sort(),
    );
  });
});

describe("#129 — the copy is plain words", () => {
  it("no user-facing string names infrastructure, or makes the duo a person", () => {
    const strings = [
      ...NAV_SECTIONS.flatMap((section) => [
        section.title,
        section.explainer,
        section.notSetUp,
        ...(section.setUp ? [section.setUp.label] : []),
        ...section.screens.map((screen) => screen.label),
      ]),
      SETTINGS_SCREEN.label,
      ADMIN_SCREEN.label,
    ];
    for (const text of strings) {
      expect(text, text).not.toMatch(/workspace|homeserver|matrix|server|assistant|employee|teammate|colleague|chatbot/i);
    }
  });

  it("every section says what it is for in one line", () => {
    for (const section of NAV_SECTIONS) {
      expect(section.explainer.length, section.id).toBeGreaterThan(10);
      expect(section.explainer.length, section.id).toBeLessThanOrEqual(70);
      expect(section.explainer, section.id).not.toContain("\n");
    }
  });
});

describe("#129 — the sidebar renders the map", () => {
  it("a paired owner sees three labelled groups, each with its explainer and its screens, and Settings outside them", async () => {
    seedPairing();
    await renderShell();
    const nav = sidebar();

    for (const section of NAV_SECTIONS) {
      const group = within(nav).getByRole("group", { name: section.title });
      expect(within(group).getByText(section.explainer)).toBeInTheDocument();
      if (section.id === "people") {
        // No conversation account yet: a note, not a login form and not a dead link.
        expect(within(group).getByTestId("nav-section-people-not-set-up")).toHaveTextContent("Not set up yet.");
        expect(within(group).queryByRole("link", { name: "Conversations" })).toBeNull();
        expect(within(group).getByRole("link", { name: "Set up in Settings" })).toHaveAttribute("href", "#settings");
      } else {
        const links = within(group).getAllByRole("link");
        expect(links.map((link) => link.getAttribute("href")).sort()).toEqual(
          section.screens.map((s) => s.href).sort(),
        );
      }
    }
    expect(nav.querySelector("input, form")).toBeNull();

    // Settings sits outside every group.
    const settings = within(nav).getByRole("link", { name: /^Settings$/ });
    expect(settings.closest('[role="group"]')).toBeNull();
    expect(settings).toHaveAttribute("href", "#settings");
  });

  it("the section titles run in order down the sidebar", async () => {
    seedPairing();
    await renderShell();
    const groups = [...sidebar().querySelectorAll('[role="group"]')].map((group) => group.getAttribute("data-testid"));
    expect(groups).toEqual(["nav-section-people", "nav-section-answering", "nav-section-training"]);
  });

  it("a member with no duo sees conversations, and the two duo sections say not set up yet", async () => {
    seedSession();
    await renderShell();
    const nav = sidebar();

    const people = within(nav).getByRole("group", { name: "Talking to people" });
    expect(within(people).getByRole("link", { name: "Conversations" })).toHaveAttribute("href", "#conversations");
    expect(within(people).queryByTestId("nav-section-people-not-set-up")).toBeNull();

    for (const id of ["answering", "training"]) {
      const group = nav.querySelector(`[data-testid="nav-section-${id}"]`) as HTMLElement;
      expect(within(group).getByTestId(`nav-section-${id}-not-set-up`)).toHaveTextContent("Not set up yet.");
      // Only the note: the screens would each just ask for a duo.
      expect(within(group).queryAllByRole("link")).toHaveLength(0);
    }
    // The pairing offer stays where the roster would have stood.
    expect(within(nav).getByTestId("no-duo-pair")).toBeInTheDocument();
  });

  it("the entry for the screen you are on is the lit one", async () => {
    seedPairing();
    window.location.hash = "#trust";
    await renderShell();
    expect(litHrefs()).toEqual(["#trust"]);
  });

  it("a draft's page keeps Review lit, so the way back is always named", async () => {
    seedPairing();
    window.location.hash = "#draft/abc";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/drafts/abc")
          ? new Response(
              JSON.stringify({
                id: "abc",
                question: "q",
                threadContext: null,
                draftText: "a",
                escalated: false,
                escalationReason: null,
                confidenceScore: 0.8,
                sources: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                outcome: null,
                outcomeRecordedAt: null,
                sentText: null,
                refused: false,
                escalationThreshold: 0.55,
                provenance: { origin: "unknown" },
                delivery: null,
              }),
              { status: 200 },
            )
          : new Response(JSON.stringify([]), { status: 200 }),
      ),
    );
    await renderShell();
    expect(litHrefs()).toEqual(["#review"]);
  });
});

/** The hrefs of the sidebar entries drawn as the current one. */
function litHrefs(): (string | null)[] {
  return [...sidebar().querySelectorAll("a")]
    .filter((a) => a.className.includes("bg-[var(--surface)]"))
    .map((a) => a.getAttribute("href"));
}
