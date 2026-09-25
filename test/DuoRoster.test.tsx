import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Node builtins resolve at runtime; the app tsconfig has no node types.
// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import type { DuoSummary } from "../src/api/types.js";

// The shell's notification side effects are Tauri's; the roster is the
// client's half and is what this file pins.
vi.mock("../src/notifications.js", () => ({
  notifyDraftReady: vi.fn(),
  wireDraftNotificationClicks: vi.fn(() => Promise.resolve(() => {})),
}));

/*
 * #40, as reshaped by the issue's comment after #57/#59: the sidebar is
 * conversations now, not a duo list — what survives is the slice this
 * file pins. `useDuos` stops being dead code by rendering the duos the
 * daemon reports where the hardcoded "Duo" wordmark stood; the shared
 * duo is labelled with its owner so it can never read as your own; one
 * duo renders quietly; and role duos are absent because nothing
 * enumerates them, with that reasoning recorded in the source.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function stubFetch(routes: Record<string, unknown>) {
  return vi.fn((url: string): Promise<Response> => {
    for (const [needle, payload] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        if (payload instanceof Error) {
          return Promise.reject(payload);
        }
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
      }
    }
    return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
  });
}

/**
 * The paired shell, settled on Review, with /duos under the caller's
 * control. The App module is imported fresh each time: its QueryClient is
 * module-scoped, so a prior test's ["duos"] data would otherwise outlive
 * its own render — and a failed refetch keeps showing stale cache, which
 * is exactly the state the fallback test needs to be absent.
 */
async function renderApp(routes: Record<string, unknown>) {
  vi.resetModules();
  const { App } = await import("../src/App.js");
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
  const fetchMock = stubFetch(routes);
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<App />);
  const main = () => view.container.querySelector("main") as HTMLElement;
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalled();
    expect(main().querySelector("h1")).not.toBeNull();
  });
  return { view, fetchMock };
}

const sharedDuo: DuoSummary = { kind: "shared", ownerId: "owner-1", ownerName: "River" };

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#40 AC1 — the sidebar lists what the daemon returns", () => {
  it("the personal duo and the shared duo each appear, labelled from the daemon's own fields", async () => {
    const { view } = await renderApp({ "/duos": [{ kind: "personal" }, sharedDuo] });

    const sidebar = view.container.querySelector('nav[aria-label="Surfaces"]') as HTMLElement;
    expect(within(sidebar).getByTestId("duo-roster")).toBeTruthy();
    // The personal kind carries no fields — its label is the client's one
    // fixed string for "yours". The shared kind's label is the daemon's
    // own ownerName, composed into whose-it-is.
    expect(within(sidebar).getByText("Your duo")).toBeTruthy();
    expect(within(sidebar).getByText("River's duo")).toBeTruthy();

    // The folded navigation carries the same roster — one map, folded.
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const nav = await screen.findByTestId("mobile-nav");
    expect(within(nav).getByText("Your duo")).toBeTruthy();
    expect(within(nav).getByText("River's duo")).toBeTruthy();
  });
});

describe("#40 AC2 — the shared duo is distinguishable", () => {
  it("whose duo it is reads from the label, and nothing calls the shared duo yours", async () => {
    await renderApp({ "/duos": [{ kind: "personal" }, sharedDuo] });

    const roster = await screen.findByTestId("duo-roster");
    // Exactly one "Your duo" — the shared entry is named by its owner,
    // never folded into the yours vocabulary: an owner must never read
    // the shared duo's answers as their own duo's.
    expect(within(roster).getAllByText("Your duo")).toHaveLength(1);
    expect(within(roster).getByText("River's duo")).toBeTruthy();
  });

  it("a different owner's name renders as the daemon sends it", async () => {
    await renderApp({ "/duos": [{ kind: "personal" }, { kind: "shared", ownerId: "o2", ownerName: "Ada" }] });
    const roster = await screen.findByTestId("duo-roster");
    expect(within(roster).getByText("Ada's duo")).toBeTruthy();
  });
});

describe("#40 AC3 — one duo renders quietly", () => {
  it("the personal duo alone is a wordmark-truthful line, not a broken list", async () => {
    const { view } = await renderApp({ "/duos": [{ kind: "personal" }] });

    const sidebar = view.container.querySelector('nav[aria-label="Surfaces"]') as HTMLElement;
    const roster = await within(sidebar).findByTestId("duo-roster");
    expect(within(roster).getAllByText("Your duo")).toHaveLength(1);
    // No list chrome invented to dress up one entry.
    expect(within(roster).queryByText("Duos")).toBeNull();
  });

  it("while /duos is unanswered, the plain wordmark stands in — no error chrome for a wordmark", async () => {
    const { fetchMock } = await renderApp({ "/duos": new Error("unreachable") });

    // The daemon was asked and did not answer — the settled state is the
    // fallback, not a spinner or an error block where a wordmark stood.
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/duos"))).toBe(true);
    });
    expect(screen.queryByTestId("duo-roster")).toBeNull();
    expect(screen.getByTestId("duo-wordmark")).toBeTruthy();
  });
});

describe("#40 AC4 — role duos are absent on purpose", () => {
  it("the reasoning is recorded where the roster renders, not left as an apparent omission", () => {
    const source = readFileSync(join(root, "src", "components", "DuoRoster.tsx"), "utf8");
    expect(/role duo/i.test(source), "DuoRoster records why role duos do not appear").toBe(true);
    // And the reasoning is a comment, not live code enumerating kinds.
    const comments: string[] = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g) ?? [];
    expect(comments.some((comment: string) => /role duo/i.test(comment))).toBe(true);
  });
});
