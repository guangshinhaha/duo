import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { usePendingDrafts } from "../src/api/queries.js";
import type { DraftRecord, DraftShape } from "../src/api/types.js";
import { DraftTray } from "../src/components/DraftTray.js";
import { SwipeRow } from "../src/shell/SwipeRow.js";

const sync = vi.hoisted(() => ({ reachable: true }));
vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync.js")>();
  return { ...actual, useSyncStatus: () => ({ reachable: sync.reachable, lastSyncedAt: null }) };
});

/*
 * Alternatives (#257) and one-tap shaping (#258) on the draft tray: a
 * hedged draft pages "1 of 3" by button, ←/→ and swipe; Send records which
 * one; the shape chips rewrite the draft through the daemon and Undo puts
 * the previous words back.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

const ruleSource = { kind: "rule" as const, id: "r1", label: "Leave: five days a quarter" };
const evidence = { kind: "evidence" as const, id: "e1", label: "past exchange" };

const single: DraftRecord = {
  id: "d1",
  question: "How much leave do I get?",
  threadContext: null,
  draftText: "Five days per quarter, per policy.",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.6,
  sources: [ruleSource, evidence],
  createdAt: "2026-01-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
  provenance: { origin: "owner" },
  delivery: null,
  alternatives: [],
  chosenAlternative: null,
  shapes: [],
};

const hedged: DraftRecord = {
  ...single,
  alternatives: [
    { text: "Five days per quarter, per policy.", instruction: null, confidenceScore: 0.6, sources: [ruleSource, evidence], outcome: null },
    { text: "Five days a quarter.", instruction: "shorter", confidenceScore: 0.58, sources: [ruleSource, evidence], outcome: null },
    // A differing sources list here only to prove the tray reads each
    // candidate's own — the daemon gives every candidate the same pool.
    { text: "I believe it's five days — check the policy page.", instruction: "cautious", confidenceScore: 0.57, sources: [evidence], outcome: null },
  ],
};

/** The daemon's side of a test: the pending list it serves, and what each shape/undo call returns. */
let server: { pending: DraftRecord[]; onShape?: (body: { instruction: string; alternative: number }) => Promise<DraftRecord> | DraftRecord; onUndo?: (body: { alternative: number }) => DraftRecord };

function calls(suffix: string) {
  return (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter((call) => String(call[0]).endsWith(suffix))
    .map((call) => JSON.parse(((call[1] as RequestInit).body as string) ?? "null"));
}

beforeEach(() => {
  sync.reachable = true;
  server = { pending: [hedged] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.endsWith("/drafts?outcome=pending")) {
        return json(server.pending);
      }
      if (url.endsWith("/shape/undo")) {
        return json(server.onUndo!(JSON.parse(init!.body as string)));
      }
      if (url.endsWith("/shape")) {
        return json(await server.onShape!(JSON.parse(init!.body as string)));
      }
      return json({});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The tray as the app mounts it: fed from the pending-drafts query, so a shaped draft arrives the way it really does — through the cache. */
function Harness({ wrap }: { wrap?: (tray: ReactElement) => ReactElement }) {
  const pending = usePendingDrafts(api);
  const draft = pending.data?.[0];
  if (!draft) {
    return null;
  }
  const tray = <DraftTray api={api} draft={draft} />;
  return wrap ? wrap(tray) : tray;
}

async function mount(wrap?: (tray: ReactElement) => ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness wrap={wrap} />
    </QueryClientProvider>,
  );
  return screen.findByTestId("draft-tray");
}

function swipe(target: HTMLElement, dx: number, dy = 0, pointerType = "touch"): void {
  const base = { pointerId: 1, pointerType, button: 0 };
  fireEvent.pointerDown(target, { ...base, clientX: 300, clientY: 100 });
  fireEvent.pointerMove(target, { ...base, clientX: 300 + dx / 2, clientY: 100 + dy / 2 });
  fireEvent.pointerMove(target, { ...base, clientX: 300 + dx, clientY: 100 + dy });
  fireEvent.pointerUp(target, { ...base, clientX: 300 + dx, clientY: 100 + dy });
}

const position = () => screen.getByTestId("alternative-position").textContent;
const shownText = () => screen.getByTestId("draft-tray-line").textContent;

describe("#257 — a hedged draft offers alternatives, paged 1 of 3", () => {
  it("says which of how many is on screen and what it was asked to be, with ‹ › to page", async () => {
    await mount();
    expect(position()).toBe("1 of 3 · your duo’s draft");
    expect(shownText()).toContain("Five days per quarter, per policy.");
    expect(screen.getByRole("button", { name: "Previous alternative" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next alternative" }));
    expect(position()).toBe("2 of 3 · shorter");
    expect(shownText()).toContain("Five days a quarter.");
    fireEvent.click(screen.getByRole("button", { name: "Next alternative" }));
    expect(position()).toBe("3 of 3 · more careful");
    expect(screen.getByRole("button", { name: "Next alternative" })).toBeDisabled();
  });

  it("each alternative shows its own sources, and Why? speaks about the one on screen", async () => {
    await mount();
    expect(screen.getByTestId("draft-tray-why")).toHaveTextContent("Standing order: Leave: five days a quarter · Drew on 1 source");
    fireEvent.click(screen.getByRole("button", { name: "Next alternative" }));
    fireEvent.click(screen.getByRole("button", { name: "Next alternative" }));
    expect(screen.getByTestId("draft-tray-why")).not.toHaveTextContent("Standing order");
    expect(screen.getByTestId("draft-tray-why")).toHaveTextContent("Drew on 1 source");
    expect(screen.getByTestId("tray-why")).toBeInTheDocument();
  });

  it("←/→ page it while the draft has focus — but not while typing in its editor", async () => {
    const tray = await mount();
    tray.focus();
    fireEvent.keyDown(tray, { key: "ArrowRight" });
    expect(position()).toBe("2 of 3 · shorter");
    fireEvent.keyDown(screen.getByRole("button", { name: "Next alternative" }), { key: "ArrowRight" });
    expect(position()).toBe("3 of 3 · more careful");
    fireEvent.keyDown(tray, { key: "ArrowLeft" });
    expect(position()).toBe("2 of 3 · shorter");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit your duo's draft" });
    expect(editor).toHaveValue("Five days a quarter.");
    fireEvent.keyDown(editor, { key: "ArrowRight" });
    expect(position()).toBe("2 of 3 · shorter");
  });

  it("a horizontal swipe inside the card flips it; a vertical drag, a short one, or a mouse drag does not", async () => {
    await mount();
    const body = screen.getByTestId("draft-tray-body");
    swipe(body, -120);
    expect(position()).toBe("2 of 3 · shorter");
    swipe(body, -30);
    swipe(body, -60, 120);
    swipe(body, -120, 0, "mouse");
    expect(position()).toBe("2 of 3 · shorter");
    swipe(body, 120);
    expect(position()).toBe("1 of 3 · your duo’s draft");
  });

  it("Send records which alternative was chosen", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Next alternative" }));
    fireEvent.click(screen.getByRole("button", { name: "Next alternative" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(calls("/outcome")).toEqual([{ outcome: "sent", alternative: 2 }]));
  });

  it("an edit of an alternative is diffed against, and sent as an edit of, that alternative", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Next alternative" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Edit your duo's draft" }), { target: { value: "Five days a quarter. Enjoy!" } });
    fireEvent.click(screen.getByRole("button", { name: "Keep edited" }));
    await waitFor(() => expect(calls("/outcome")).toEqual([{ outcome: "edited", sentText: "Five days a quarter. Enjoy!", alternative: 1 }]));
  });

  it("a single draft shows no pager and names no alternative when sent", async () => {
    server.pending = [single];
    await mount();
    expect(screen.queryByTestId("draft-alternatives")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(calls("/outcome")).toEqual([{ outcome: "sent" }]));
  });

  it("the card's flip never fights the row swipe around it: a swipe in the body flips, and sends nothing", async () => {
    const send = vi.fn(async () => {});
    await mount((tray) => (
      <SwipeRow dismiss={null} send={send}>
        {tray}
      </SwipeRow>
    ));
    swipe(screen.getByTestId("draft-tray-body"), -240);
    expect(position()).toBe("2 of 3 · shorter");
    expect(send).not.toHaveBeenCalled();
    // A sideways drag along the chip row is the chips' own scroll.
    swipe(screen.getByTestId("shape-chips"), -240);
    expect(send).not.toHaveBeenCalled();
    // Control: outside the card body and the chips, the row's own swipe
    // still reaches it — the flip claims only its own fingers.
    swipe(screen.getByTestId("draft-tray-why"), -240);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("#258 — one tap shapes the draft, and Undo is one tap back", () => {
  function shaped(record: DraftRecord, alternative: number, text: string, instruction: DraftShape["instruction"]): DraftRecord {
    const shapes = [...(record.shapes ?? []), { id: `s${(record.shapes ?? []).length}`, alternative, instruction, createdAt: "2026-01-01T00:01:00.000Z", undoneAt: null }];
    if ((record.alternatives ?? []).length === 0) {
      return { ...record, draftText: text, shapes };
    }
    const alternatives = record.alternatives!.map((candidate, index) => (index === alternative ? { ...candidate, text } : candidate));
    return { ...record, alternatives, draftText: alternatives[0].text, shapes };
  }

  it("a chip asks the daemon to reshape the draft, shows it working, swaps the new words in, and offers Undo back to the old ones", async () => {
    server.pending = [single];
    let release: () => void = () => {};
    server.onShape = (body) =>
      new Promise((resolve) => {
        release = () => {
          server.pending = [shaped(single, body.alternative, "Five days a quarter.", "shorter")];
          resolve(server.pending[0]);
        };
      });
    server.onUndo = () => {
      server.pending = [{ ...single, shapes: [{ ...server.pending[0].shapes![0], undoneAt: "2026-01-01T00:02:00.000Z" }] }];
      return server.pending[0];
    };
    await mount();
    expect(screen.queryByTestId("shape-undo")).toBeNull();

    fireEvent.click(screen.getByTestId("shape-chip-shorter"));
    expect(await screen.findByTestId("shape-pending")).toHaveTextContent("Making it shorter…");
    expect(screen.getByTestId("shape-chip-warmer")).toBeDisabled();
    expect(calls("/shape")).toEqual([{ instruction: "shorter", alternative: 0 }]);

    await act(async () => release());
    await waitFor(() => expect(shownText()).toContain("Five days a quarter."));
    expect(screen.queryByTestId("shape-pending")).toBeNull();
    // Its sources are the draft's own, unchanged.
    expect(screen.getByTestId("draft-tray-why")).toHaveTextContent("Standing order: Leave: five days a quarter · Drew on 1 source");

    fireEvent.click(screen.getByTestId("shape-undo"));
    await waitFor(() => expect(shownText()).toContain("Five days per quarter, per policy."));
    expect(calls("/shape/undo")).toEqual([{ alternative: 0 }]);
    expect(screen.queryByTestId("shape-undo")).toBeNull();
  });

  it("shapes the alternative on screen, leaving the others as they were", async () => {
    server.onShape = (body) => {
      server.pending = [shaped(hedged, body.alternative, "I believe it's five days, kindly check the policy page.", "warmer")];
      return server.pending[0];
    };
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Next alternative" }));
    fireEvent.click(screen.getByRole("button", { name: "Next alternative" }));
    fireEvent.click(screen.getByTestId("shape-chip-warmer"));
    await waitFor(() => expect(shownText()).toContain("kindly check the policy page"));
    expect(calls("/shape")).toEqual([{ instruction: "warmer", alternative: 2 }]);
    expect(position()).toBe("3 of 3 · more careful");
    expect(screen.getByTestId("shape-undo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous alternative" }));
    expect(shownText()).toContain("Five days a quarter.");
    // Undo belongs to the candidate that was shaped.
    expect(screen.queryByTestId("shape-undo")).toBeNull();
  });

  it("a refusal from the daemon is said, and the draft stays as it was", async () => {
    server.pending = [single];
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) =>
      url.endsWith("/shape")
        ? new Response(JSON.stringify({ error: { code: "ShapingUnavailableError", message: "Shaping a draft needs an inference provider, and none is configured." } }), { status: 409 })
        : new Response(JSON.stringify(server.pending), { status: 200 }),
    );
    await mount();
    fireEvent.click(screen.getByTestId("shape-chip-more_formal"));
    expect(await screen.findByText(/needs an inference provider/)).toBeInTheDocument();
    expect(shownText()).toContain("Five days per quarter, per policy.");
  });

  it("is offered only for a draft with words on it, waiting on you — not a passed-on question, a refusal, or while editing", async () => {
    server.pending = [{ ...single, draftText: null, escalated: true, escalationReason: "No rule covers this." }];
    await mount();
    expect(screen.queryByTestId("shape-chips")).toBeNull();
    cleanup();

    server.pending = [single];
    await mount();
    expect(screen.getByTestId("shape-chips")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByTestId("shape-chips")).toBeNull();
  });

  it("waits, like every decision, while the daemon is unreachable", async () => {
    sync.reachable = false;
    server.pending = [single];
    await mount();
    expect(screen.getByTestId("shape-chip-shorter")).toBeDisabled();
  });
});
