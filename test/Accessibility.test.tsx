// Node builtins resolve at runtime (vitest runs in Node) but the app tsconfig
// deliberately has no node types — the app never touches them. Suppressed
// here rather than adding `node` to tsconfig `types` for one test file.
// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { App } from "../src/App.js";
import { OfflineBar } from "../src/components/OfflineBar.js";
import { MutationError } from "../src/components/MutationError.js";
import { SyncStatusProvider, type SyncTarget } from "../src/sync.js";
import { Review } from "../src/routes/Review.js";
import { Corrections } from "../src/routes/Corrections.js";
import { Duo } from "../src/routes/Duo.js";
import { Draft } from "../src/routes/Draft.js";
import { Trust } from "../src/routes/Trust.js";
import { Audit } from "../src/routes/Audit.js";
import { Knowledge } from "../src/routes/Knowledge.js";
import { Mirror } from "../src/routes/Mirror.js";
import { Settings } from "../src/routes/Settings.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { AuditEntry, CorrectionCandidate, DraftRecord, GridRow, Rule } from "../src/api/types.js";

// The shell's notification side effects are Tauri's; the announcement is
// the client's half and is what this file pins.
vi.mock("../src/notifications.js", () => ({
  notifyDraftReady: vi.fn(),
  wireDraftNotificationClicks: vi.fn(() => Promise.resolve(() => {})),
}));

/*
 * #39: the accessibility pass. Structure (landmarks, one h1 per route,
 * no skipped heading levels), announcements (offline, mutation failure,
 * a draft arriving — polite, once, never stealing focus), names (every
 * control says what it does), and motion (reduced preference stops all
 * of it).
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

const auditEntry: AuditEntry = {
  id: "a1",
  createdAt: "2026-01-01T00:00:00.000Z",
  question: "the question",
  askerRef: "asker",
  askerResolved: true,
  declined: false,
  answerText: "the answer",
};

const rule: Rule = {
  id: "r1",
  topicId: "t1",
  text: "Prefer short answers",
  status: "confirmed",
  supportCount: 3,
  consistency: 0.9,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastConfirmedAt: null,
  reviewStatus: "pending",
  origin: "derived",
};

function knowledgeFor() {
  return {
    records: { total: 3, bySource: {} },
    lastImport: null,
    corpus: { tooThin: true, minimumQuestionsToCharacterize: 10, totalQuestions: 0, periodStart: null, periodEnd: null, topicBreakdown: [] },
    rules: { byReviewStatus: { pending: 0, approved: 0, rejected: 0, superseded: 0 } },
    providers: { inference: null, embedding: null },
    sharedUsage: { totalQuestions: 0, distinctAskers: 0, repeatAskers: 0, answeredCount: 0, declinedCount: 0, answerRate: 0, escalationRate: 0, weeklyTrend: [], gaps: [], lastAskedAt: null, daysSinceLastAsk: null, abandoned: false, summary: "The shared duo is not being used." },
  };
}

/** The heading law: one page, headings present, first is h1, no level skipped. */
function assertHeadingOrder(container: HTMLElement) {
  const headings = [...container.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  expect(headings.length, "the page has headings").toBeGreaterThan(0);
  let level = 0;
  for (const heading of headings) {
    const current = Number(heading.tagName[1]);
    if (level === 0) {
      expect(current, "the first heading on the page is the page's h1").toBe(1);
    } else {
      expect(current, `heading ${heading.textContent} does not skip a level`).toBeLessThanOrEqual(level + 1);
    }
    level = current;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("#39 AC1 — the page has structure", () => {
  it("the shell is landmarks: a labelled nav and one main", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    const fetchMock = stubFetch({ "/drafts?outcome=pending": [] });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<App />);

    // The app's launch is three phases: cache-restore-gated (queries idle,
    // no fetch has fired, an empty queue already renders), fetching
    // (route-loading, no headings), settled. Only the conjunction of
    // "a fetch has happened" and "main has its h1" pins the settled app —
    // either alone is true in a transient phase too.
    const main = () => container.querySelector("main") as HTMLElement;
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      expect(main().querySelector("h1")).not.toBeNull();
    });

    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();
    expect(nav).toHaveAttribute("aria-label", "Surfaces");
    expect(container.querySelectorAll("main")).toHaveLength(1);
    assertHeadingOrder(main());
  });

  it("every route starts at its own h1 and never skips a level", async () => {
    const cases: Array<{ name: string; ui: ReactElement; routes: Record<string, unknown> }> = [
      { name: "Review — queue", ui: <Review api={api} />, routes: { "/drafts?outcome=pending": [draftFor("d1"), escalatedDraft] } },
      { name: "Review — empty", ui: <Review api={api} />, routes: { "/drafts?outcome=pending": [], "/knowledge": knowledgeFor() } },
      { name: "Corrections — list", ui: <Corrections api={api} />, routes: { "/review?status=pending": [candidate] } },
      { name: "Corrections — empty", ui: <Corrections api={api} />, routes: { "/review?status=pending": [] } },
      { name: "Duo", ui: <Duo api={api} />, routes: { "/drafts?limit=50": [] } },
      // The one parameterized route (#25) is a page like the named ones.
      { name: "Draft", ui: <Draft api={api} draftId="d1" />, routes: { "/drafts/d1": draftFor("d1") } },
      { name: "Trust — grid", ui: <Trust api={api} />, routes: { "/trust/grid": [gridRow] } },
      { name: "Trust — empty", ui: <Trust api={api} />, routes: { "/trust/grid": [] } },
      { name: "Audit — log", ui: <Audit api={api} />, routes: { "/audit": [auditEntry] } },
      { name: "Audit — empty", ui: <Audit api={api} />, routes: { "/audit": [] } },
      { name: "Knowledge", ui: <Knowledge api={api} />, routes: { "/knowledge": knowledgeFor() } },
      {
        name: "Mirror",
        ui: <Mirror api={api} />,
        routes: {
          "/mirror/portrait": { totalQuestions: 0, periodStart: null, periodEnd: null, topicBreakdown: [], topFiveShare: 0, busiestThreads: [], tooThin: true, minimumQuestionsToCharacterize: 10 },
          "/mirror/rules": { awaitingApproval: [rule], weakSignals: [], inconsistent: [], approved: [], rejected: [] },
        },
      },
      { name: "Settings", ui: <Settings api={api} session={null} onConfigChange={() => {}} onSignOut={() => {}} onPairDuo={() => {}} onWorkspaceSignIn={() => {}} />, routes: {} },
    ];

    for (const { ui, routes } of cases) {
      vi.stubGlobal("fetch", stubFetch(routes));
      const { container } = renderWithClient(ui);
      // Wait for whichever terminal state the route lands in.
      await waitFor(() => expect(container.querySelector("h1")).not.toBeNull(), { timeout: 3000 });
      const main = document.createElement("div");
      main.innerHTML = container.innerHTML;
      assertHeadingOrder(main);
      expect(main.querySelectorAll("h1")).toHaveLength(1);
      cleanup();
    }
  });

  it("Mirror's buckets sit at h2 under the page's h1, not at h3", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "/mirror/portrait": { totalQuestions: 0, periodStart: null, periodEnd: null, topicBreakdown: [], topFiveShare: 0, busiestThreads: [], tooThin: true, minimumQuestionsToCharacterize: 10 },
        "/mirror/rules": { awaitingApproval: [rule], weakSignals: [], inconsistent: [], approved: [], rejected: [] },
      }),
    );
    const { container } = renderWithClient(<Mirror api={api} />);
    await waitFor(() => expect(container.querySelector("[data-testid^='bucket-']")).not.toBeNull());
    const bucketHeading = container.querySelector("[data-testid^='bucket-'] h2, [data-testid^='bucket-'] h3");
    expect(bucketHeading?.tagName).toBe("H2");
  });
});

describe("#39 AC2 — state changes announce politely, once, without stealing focus", () => {
  /** #58's probe: a query whose refetch the test controls — first call syncs (so there is a lastSyncedAt), the refetch fails. */
  const probeCalls = new Map<SyncTarget, number>();
  function Probe({ target, failRefetch }: { target: SyncTarget; failRefetch?: Error }) {
    const query = useQuery({
      queryKey: ["probe", target],
      queryFn: () => {
        const calls = (probeCalls.get(target) ?? 0) + 1;
        probeCalls.set(target, calls);
        if (calls === 1 || !failRefetch) {
          return Promise.resolve(`synced-${target}`);
        }
        return Promise.reject(failRefetch);
      },
      retry: false,
      meta: { target },
    });
    return <div data-testid={`probe-${target}`}>{String(query.data)}</div>;
  }

  it("the offline bar appearing is a polite status, and never takes focus", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <SyncStatusProvider>
          <Probe target="daemon" failRefetch={new TypeError("fetch failed")} />
          <OfflineBar />
        </SyncStatusProvider>
      </QueryClientProvider>,
    );

    // The daemon goes quiet mid-session — synced once, then failing.
    await screen.findByText("synced-daemon");
    await client.refetchQueries({ queryKey: ["probe", "daemon"] });

    const bar = await screen.findByTestId("offline-bar");
    expect(bar).toHaveAttribute("role", "status");
    // Polite by kind: not an alert, which would interrupt.
    expect(bar).not.toHaveAttribute("role", "alert");
    expect(document.activeElement).toBe(document.body);
    unmount();
  });

  it("a failed mutation announces through the status role", () => {
    const { rerender } = render(<MutationError error={null} />);
    expect(screen.queryByTestId("mutation-error")).toBeNull();

    rerender(<MutationError error={new Error("The daemon refused the outcome.")} />);
    const message = screen.getByTestId("mutation-error");
    expect(message).toHaveAttribute("role", "status");
    expect(message).toHaveTextContent("The daemon refused the outcome.");
  });

  it("a draft arriving announces once, politely, without stealing focus", async () => {
    localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
    vi.stubGlobal("fetch", stubFetch({ "/drafts?outcome=pending": [] }));
    vi.stubGlobal("WebSocket", FakeWebSocket);

    render(<App />);
    await screen.findByText("Nothing waiting on you.");
    expect(FakeWebSocket.instances.length).toBe(1);

    // The push arrives from outside React — wrapped in act like the
    // sync-status tests wrap their refetches, since it sets shell state.
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].message({ type: "draft-ready", draftId: "d-new" });
    });

    const notice = await screen.findByText("A draft is waiting in the Review queue.");
    expect(notice.closest("[role='status']")).not.toBeNull();
    expect(notice.closest("[aria-live='assertive']")).toBeNull();
    // Never steals focus.
    expect(document.activeElement).toBe(document.body);
  });
});

describe("#39 AC3 — controls are named", () => {
  /** The accessible-name computation, simplified to what this client uses. */
  function accessibleName(element: Element): string {
    const labelledby = element.getAttribute("aria-labelledby");
    if (labelledby) {
      const labels = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "");
      if (labels.join("")) return labels.join(" ");
    }
    const id = element.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label?.textContent?.trim()) return label.textContent.trim();
    }
    const wrappingLabel = element.closest("label")?.textContent?.trim();
    return (
      element.getAttribute("aria-label")?.trim() ||
      wrappingLabel ||
      element.textContent?.trim() ||
      element.getAttribute("placeholder")?.trim() ||
      element.getAttribute("title")?.trim() ||
      ""
    );
  }

  it("every control on the reading surfaces says what it does — including the icon-quiet ones", async () => {
    vi.stubGlobal("fetch", stubFetch({ "/drafts?outcome=pending": [draftFor("d1"), escalatedDraft], "/knowledge": knowledgeFor() }));
    const { container } = renderWithClient(<Review api={api} />);
    await screen.findAllByTestId("draft-card");

    vi.stubGlobal("fetch", stubFetch({}));
    const settings = renderWithClient(<Settings api={api} session={null} onConfigChange={() => {}} onSignOut={() => {}} onPairDuo={() => {}} onWorkspaceSignIn={() => {}} />);

    for (const root of [container, settings.container]) {
      const controls = [...root.querySelectorAll("button, input, select, textarea")];
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        const name = accessibleName(control);
        expect(name, `<${control.tagName.toLowerCase()}> with no accessible name`).not.toBe("");
      }
    }
  });
});

describe("#39 AC4 — motion is respected", () => {
  it("a reduced-motion preference stops every animation and transition, globally", () => {
    const tokensCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles", "tokens.css"), "utf8");
    const match = tokensCss.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(match, "tokens.css carries the reduced-motion block").not.toBeNull();
    const block = match?.[1] ?? "";
    // The kill switch: near-zero durations, single iteration, and it
    // applies to everything — *, ::before and ::after — so no animation
    // can opt out of the preference.
    expect(block).toContain("animation-duration: 0.01ms !important");
    expect(block).toContain("animation-iteration-count: 1 !important");
    expect(block).toContain("transition-duration: 0.01ms !important");
    expect(block).toMatch(/[^,]*\*,\s*::before,\s*::after/);
  });
});

/** The ws double from ws.test.ts's shape — the socket is the test seam. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners = new Map<string, Array<(event: never) => void>>();
  constructor() {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  removeEventListener() {}
  send() {}
  close() {}
  open() {
    this.listeners.get("open")?.forEach((cb) => cb(new Event("open") as never));
  }
  message(data: unknown) {
    this.listeners.get("message")?.forEach((cb) => cb({ data: JSON.stringify(data) } as never));
  }
}
