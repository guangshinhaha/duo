import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { App } from "../src/App.js";
import { Review } from "../src/routes/Review.js";
import { Corrections } from "../src/routes/Corrections.js";
import { Duo } from "../src/routes/Duo.js";
import { Setup } from "../src/routes/Setup.js";
import { Settings } from "../src/routes/Settings.js";
import { Trust } from "../src/routes/Trust.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { CorrectionCandidate, DraftRecord, GridRow } from "../src/api/types.js";

// The shell's notification side effects are Tauri's; the responsive shell
// is the client's half and is what this file pins.
vi.mock("../src/notifications.js", () => ({
  // #69 widened the module past drafts; for this file only the announcement
  // half matters, so the arrivals classify as plain drafts (null) and the
  // side-effect verbs are inert.
  draftArrivalBody: vi.fn(() => null),
  notifyDraftReady: vi.fn(),
  postNotification: vi.fn(),
  wireNotificationClicks: vi.fn(() => Promise.resolve(() => {})),
  notifyConfirmationWaiting: vi.fn(),
}));

/*
 * #38: responsive down to a phone browser (G4's mitigation — a responsive
 * web client reached over Tailscale in mobile Safari). The layout folds
 * at the desktop breakpoint, the navigation re-arranges rather than
 * shrinking (§1.5: "no tab bar, no second product"), §3.1's mobile rules
 * hold (the folded navigation carries the same three sections as the sidebar, #129; rule authoring is gone
 * — AR-18), and every control is a real touch target.
 *
 * happy-dom does not apply media queries, so these tests pin the
 * responsive *contract* — which arrangement carries which breakpoint
 * variant — the way DesignSystem.test pins the class laws. What a phone
 * actually gets is exactly what these classes say: below `md` the
 * sidebar is display:none, the top bar and its folded navigation are the
 * arrangement, and the authoring affordance is display:none.
 */

const api: DuoApiConfig = { baseUrl: "http://test:7717", token: "tok" };

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** One stub serving every route's reads by URL substring. */
function stubFetch(routes: Record<string, unknown>) {
  return vi.fn((url: string): Promise<Response> => {
    for (const [needle, payload] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
      }
    }
    return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
  });
}

function draftFor(id: string, overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id,
    question: `question ${id}`,
    threadContext: null,
    draftText: `answer ${id}`,
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
    ...overrides,
  };
}

const escalatedDraft = draftFor("e1", {
  escalated: true,
  draftText: null,
  escalationReason: "I am not sure this is still true",
  provenance: { origin: "channel", channelKind: "slack", askerRef: "asker" } as DraftRecord["provenance"],
});

const candidate: CorrectionCandidate = {
  id: "c1",
  kind: "style",
  draftId: "d1",
  question: "the question",
  draftText: "the draft",
  sentText: "the send",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  reviewedAt: null,
};

const gridRow: GridRow = { topicId: "t1", topicLabel: "Refunds", tier: "T1", level: "approve", source: "earned", stale: false };

/** The paired shell: config in storage, fetch stubbed, settled on Review. */
async function renderApp(routes: Record<string, unknown>) {
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
  const fetchMock = stubFetch(routes);
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<App />);
  // The app's launch is three phases (restore-gated, fetching, settled);
  // pin the settled app the same way #39's shell test does.
  const main = () => view.container.querySelector("main") as HTMLElement;
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalled();
    expect(main().querySelector("h1")).not.toBeNull();
  });
  return view;
}

/** Opens the folded navigation and returns its element. */
async function openMobileNav() {
  fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
  return screen.findByTestId("mobile-nav");
}

/** The 44px law, applied to every interactive element under a root. */
function expectTouchTargets(root: HTMLElement) {
  const controls = [...root.querySelectorAll("button, input, select, textarea")];
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    expect(
      control.className,
      `<${control.tagName.toLowerCase()}> below the 44px touch-target law`,
    ).toMatch(/(^|\s)min-h-11\b/);
  }
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#38 AC1 — the app works on a phone", () => {
  it("the shell stacks below the desktop width, and its one fixed-width element is gone with it", async () => {
    const view = await renderApp({ "/drafts?outcome=pending": [] });

    // The root is a column on a phone, a row from the desktop breakpoint
    // up, sized to the dynamic viewport (mobile Safari's bar collapses
    // dvh; a fixed 100vh would bury the composer under it).
    const root = view.container.querySelector("div") as HTMLElement;
    expect(root.className).toContain("flex-col");
    expect(root.className).toContain("md:flex-row");
    expect(root.className).toContain("h-dvh");

    // The sidebar is the desktop arrangement: hidden below md, flex from
    // md up — a 14rem column cannot be what a phone renders.
    const sidebar = view.container.querySelector('nav[aria-label="Surfaces"]') as HTMLElement;
    expect(sidebar.className).toContain("w-56");
    expect(sidebar.className).toMatch(/(^|\s)hidden\b/);
    expect(sidebar.className).toMatch(/md:flex/);

    // The main column yields to its content rather than clipping it.
    const column = view.container.querySelector("main")?.parentElement as HTMLElement;
    expect(column.className).toContain("min-w-0");
  });

  it("the surfaces with unbounded text truncate, they do not push width", async () => {
    vi.stubGlobal("fetch", stubFetch({ "/trust/grid": [gridRow] }));
    renderWithClient(<Trust api={api} />);
    // Trust's topic cell is the one row-shaped element with unbounded
    // text — it must yield (min-w-0) and clip (truncate), never widen.
    const topic = await screen.findByTestId("trust-topic");
    expect(topic.className).toContain("min-w-0");
    expect(topic.className).toContain("truncate");
  });
});

describe("#38 AC2 — navigation adapts", () => {
  it("a top bar carries a labelled menu control below the desktop width; nothing of it survives at md", async () => {
    await renderApp({ "/drafts?outcome=pending": [] });

    const bar = await screen.findByTestId("mobile-topbar");
    expect(bar.className).toContain("md:hidden");

    const menu = within(bar).getByRole("button", { name: "Open navigation" });
    // An icon-only control: named for what it does, a real touch target
    // in both dimensions (#39 named it; #38 makes it hittable). Its
    // desktop-width absence is the bar's — the parent is display:none
    // from md up, and nothing inside a hidden bar renders.
    expect(menu.className).toMatch(/min-w-11\b/);
    expect(menu.className).toMatch(/min-h-11\b/);
  });

  it("the menu opens the folded navigation; Review keeps its count, and a link closes it on the way through", async () => {
    await renderApp({ "/drafts?outcome=pending": [draftFor("d1")] });

    // The count is the phone's notification surrogate (AR-15: no push) —
    // it must read without opening anything.
    const bar = await screen.findByTestId("mobile-topbar");
    expect(within(bar).getByTestId("topbar-count").textContent).toBe("1");

    const nav = await openMobileNav();

    // Review stays on top and its count still its own (§1.5).
    const review = within(nav).getByRole("link", { name: /Review/ });
    expect(review.getAttribute("href")).toBe("#review");
    expect(within(review).getByTestId("review-badge").textContent).toBe("1");

    // A link is a link — native href navigation — and following one
    // hands the screen back (the overlay never outstays its route).
    const corrections = within(nav).getByRole("link", { name: "Corrections" });
    expect(corrections.getAttribute("href")).toBe("#corrections");
    fireEvent.click(corrections);
    await waitFor(() => expect(screen.queryByTestId("mobile-nav")).toBeNull());

    // The phone's own dismissal is a labelled control, not a keyboard's
    // Escape or an invisible scrim-tap.
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    await screen.findByTestId("mobile-nav");
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    await waitFor(() => expect(screen.queryByTestId("mobile-nav")).toBeNull());
  });
});

describe("#38 AC3 — §3.1's mobile rules hold", () => {
  it("the folded navigation keeps the sidebar's three sections — same map, each screen in exactly one (#129)", async () => {
    const view = await renderApp({ "/drafts?outcome=pending": [] });

    // The desktop sidebar first — its queries must run before the folded
    // navigation opens, because the dialog primitive marks everything
    // outside itself aria-hidden while it is open (#34's focus contract).
    const sidebar = view.container.querySelector('nav[aria-label="Surfaces"]') as HTMLElement;
    const sectionLinks = (root: HTMLElement) =>
      Object.fromEntries(
        ["people", "answering", "training"].map((id) => [
          id,
          [...within(root.querySelector(`[data-testid="nav-section-${id}"]`) as HTMLElement).queryAllByRole("link")].map(
            (link) => link.getAttribute("href"),
          ),
        ]),
      );
    const desktop = sectionLinks(sidebar);
    expect(within(sidebar).queryByText("More")).toBeNull();

    // The phone folds the same three groups: no "More" bucket pulling
    // Trust and Audit out of the sections they belong to.
    const nav = await openMobileNav();
    expect(within(nav).queryByText("More")).toBeNull();
    expect(sectionLinks(nav)).toEqual(desktop);
    // Long enough to outgrow a short phone, so the panel scrolls inside the screen.
    expect(nav.className).toMatch(/overflow-y-auto/);
    expect(nav.className).toMatch(/max-h-/);
  });

  it("no rule-authoring affordance appears on a phone (AR-18) — read, approve, reject, promote stay", async () => {
    // The one free-text affordance that authors a standing-order: gated
    // out of narrow widths, still itself on the desktop it belongs to.
    vi.stubGlobal("fetch", stubFetch({ "/drafts?outcome=pending": [escalatedDraft] }));
    renderWithClient(<Review api={api} />);
    const answerInput = await screen.findByLabelText("Answer it yourself — becomes a standing-order candidate");
    const authoring = answerInput.closest("div");
    expect(authoring?.className).toMatch(/(^|\s)hidden\b/);
    expect(authoring?.className).toContain("md:flex");
    cleanup();

    // The verbs AR-18 spells out for mobile stay ungated: a verdict…
    vi.stubGlobal("fetch", stubFetch({ "/review?status=pending": [candidate] }));
    renderWithClient(<Corrections api={api} />);
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(approve.className).not.toMatch(/(^|\s)hidden\b/);
    cleanup();

    // …and the duo conversation, which is messaging, not rule writing.
    vi.stubGlobal("fetch", stubFetch({ "/drafts?limit=50": [] }));
    renderWithClient(<Duo api={api} />);
    const composer = await screen.findByTestId("composer");
    const ask = within(composer).getByRole("textbox");
    expect(ask.className).not.toMatch(/(^|\s)hidden\b/);
  });
});

describe("#38 AC4 — touch targets are real", () => {
  it("every control on the reading surfaces is at least 44 CSS pixels tall", async () => {
    // Review with both card kinds — the surface the phone exists for.
    vi.stubGlobal("fetch", stubFetch({ "/drafts?outcome=pending": [draftFor("d1"), escalatedDraft] }));
    const review = renderWithClient(<Review api={api} />);
    await screen.findAllByTestId("draft-card");
    expectTouchTargets(review.container);
    cleanup();

    // Corrections with a candidate.
    vi.stubGlobal("fetch", stubFetch({ "/review?status=pending": [candidate] }));
    const corrections = renderWithClient(<Corrections api={api} />);
    await screen.findByTestId("candidate");
    expectTouchTargets(corrections.container);
    cleanup();

    // Settings — the pairing's maintenance surface.
    vi.stubGlobal("fetch", stubFetch({}));
    const settings = renderWithClient(<Settings api={api} session={null} onConfigChange={() => {}} onSignOut={() => {}} onPairDuo={() => {}} onWorkspaceSignIn={() => {}} />);
    await screen.findByTestId("settings");
    expectTouchTargets(settings.container);
    cleanup();

    // Setup — the FIRST screen a phone reaches, over Tailscale (G4).
    const setup = render(<Setup onConnect={() => {}} onWorkspaceSession={() => {}} />);
    expectTouchTargets(setup.container);
    cleanup();

    // Duo with its composer.
    vi.stubGlobal("fetch", stubFetch({ "/drafts?limit=50": [] }));
    const duo = renderWithClient(<Duo api={api} />);
    await screen.findByTestId("composer");
    expectTouchTargets(duo.container);
    cleanup();

    // And the shell's own controls, once the queue is settled.
    const shell = await renderApp({ "/drafts?outcome=pending": [] });
    expectTouchTargets(shell.container);
  });
});
