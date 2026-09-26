import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Duo } from "../src/routes/Duo.js";
import { DRAFTS_PAGE_SIZE } from "../src/api/queries.js";
import { writeComposerBuffer } from "../src/composerBuffer.js";
import type { DraftRecord } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

// One draft per index n, createdAt one deterministic minute apart — distinct
// timestamps make the newest-first windows and the exclusive cursor exact.
const BASE_MS = Date.UTC(2026, 0, 1);
const isoAt = (n: number) => new Date(BASE_MS + n * 60_000).toISOString();

function draftFor(n: number, thread: string | null, question?: string): DraftRecord {
  const id = `d${String(n).padStart(3, "0")}`;
  return {
    id,
    question: question ?? `question ${id}`,
    threadContext: thread,
    draftText: `draft ${id}`,
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.8,
    sources: [],
    createdAt: isoAt(n),
    // Decided, like the long history of a chat is: a waiting answer would be a tray, and this is about the transcript.
    outcome: "sent",
    outcomeRecordedAt: isoAt(n),
    sentText: `kept ${id}`,
    refused: false,
    escalationThreshold: 0.55,
    provenance: { origin: "owner" },
    delivery: null,
  };
}

/**
 * A fetch stub speaking the merged GET /drafts paging contract (duo #29,
 * digital-duo #203): with `limit`, a newest-first window under the exclusive
 * `before` ceiling; without it, the plain ascending list. POST /drafts
 * appends (the composer's flow), which is how a test adds drafts
 * mid-walk. Records every GET URL so tests can pin which window was asked
 * for and when.
 */
function stubPagedDaemon(all: DraftRecord[]) {
  const gets: string[] = [];
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    if (init?.method === "POST" && href.endsWith("/drafts")) {
      const body = JSON.parse(init.body as string) as { question: string; threadContext?: string | null };
      const created = draftFor(all.length, body.threadContext ?? null, body.question);
      all.push(created);
      return Promise.resolve(new Response(JSON.stringify({ kind: "draft", draftId: created.id }), { status: 201 }));
    }
    const { searchParams } = new URL(href);
    gets.push(href);
    let rows = [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const before = searchParams.get("before");
    if (before !== null) {
      rows = rows.filter((d) => d.createdAt < before);
    }
    const rawLimit = searchParams.get("limit");
    if (rawLimit !== null) {
      rows = rows.reverse().slice(0, Number(rawLimit));
    }
    return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { gets, fetchMock };
}

// One continuous chat of `total` turns: page one is exactly the newest
// DRAFTS_PAGE_SIZE, so what loaded and what didn't is visible as which turns exist.
function seedHistory(total: number): DraftRecord[] {
  return Array.from({ length: total }, (_, n) => draftFor(n, null));
}

describe("#29 — history pages as you read it", () => {
  beforeEach(() => {
    writeComposerBuffer("");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens on the newest page — one fetch, oldest history absent until asked for", async () => {
    const total = DRAFTS_PAGE_SIZE * 2 + 3;
    const { gets } = stubPagedDaemon(seedHistory(total));
    renderWithClient(<Duo api={api} />);

    // Only the newest window is a turn on screen: the oldest history lives
    // entirely in pages not yet asked for.
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(DRAFTS_PAGE_SIZE));
    expect(screen.queryByText("question d000")).toBeNull();

    // The first page asked for the newest window: limit, no cursor — and
    // nothing waited on history beyond it (that's #29's responsiveness: the
    // feed renders from one fetch).
    expect(gets).toHaveLength(1);
    const first = new URL(gets[0]);
    expect(first.searchParams.get("limit")).toBe(String(DRAFTS_PAGE_SIZE));
    expect(first.searchParams.has("before")).toBe(false);
  });

  it("Load older walks the cursor down — adjacent, exclusive, ending", async () => {
    const total = DRAFTS_PAGE_SIZE * 2 + 3;
    const { gets } = stubPagedDaemon(seedHistory(total));
    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(DRAFTS_PAGE_SIZE));

    // One page older: the cursor is page one's OLDEST createdAt, and `before`
    // is exclusive — the adjacent window, not a re-read.
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(DRAFTS_PAGE_SIZE * 2));
    expect(gets).toHaveLength(2);
    const second = new URL(gets[1]);
    expect(second.searchParams.get("before")).toBe(isoAt(total - DRAFTS_PAGE_SIZE));

    // Two pages cover 100 of the 103. The last three are still unloaded — one
    // more short page ends the walk, and the button goes.
    expect(screen.queryByText("question d000")).toBeNull();
    expect(screen.getByTestId("load-older")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => expect(screen.queryByTestId("load-older")).toBeNull());
    expect(screen.getAllByTestId("thread-entry")).toHaveLength(total);
    expect(screen.getByText("question d000")).toBeInTheDocument();
    // End of history: three page fetches total, none repeated.
    expect(gets).toHaveLength(3);
  });

  it("an outcome mutation's invalidation refreshes every loaded page without losing the seam or the view", async () => {
    const total = DRAFTS_PAGE_SIZE * 2 + 3;
    const drafts = seedHistory(total);
    const { gets } = stubPagedDaemon(drafts);
    renderWithClient(<Duo api={api} />);

    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(DRAFTS_PAGE_SIZE));
    fireEvent.click(screen.getByTestId("load-older"));
    await waitFor(() => expect(gets).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(DRAFTS_PAGE_SIZE * 2));

    // The seam draft: page one's oldest. When a newer draft arrives, the
    // newest window shifts past it — it stays on screen only if the refetch
    // RECOMPUTES page two's cursor from fresh data instead of replaying the
    // stale one (the gap that would otherwise swallow it).
    const seam = screen.getByText("question d053");
    const group = screen.getByTestId("thread-group");

    // The composer: a new ask is the mutation whose onSuccess invalidates
    // ["drafts"] — exactly what Review's outcome buttons do too.
    fireEvent.change(screen.getByLabelText("Question for your duo"), { target: { value: "brand new question" } });
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(screen.getByText("brand new question")).toBeInTheDocument());

    // The new draft arrived above; nothing loaded vanished — the seam draft
    // specifically, and no page overlapped its neighbour into duplicates.
    expect(screen.getByText("question d053")).toBe(seam);
    expect(seam.isConnected).toBe(true);
    expect(screen.getAllByText("question d053")).toHaveLength(1);
    expect(screen.getAllByText("question d054")).toHaveLength(1);
    // The DOM the owner was reading is the same DOM — replaced in place, not
    // unmounted and rebuilt (what "without losing the scroll position" means
    // structurally: the nodes keep their identity).
    expect(screen.getByTestId("thread-group")).toBe(group);
    expect(group.isConnected).toBe(true);

    // The refetch walked page one AND page two (both loaded pages refresh),
    // and page two's cursor was recomputed from the new newest window: the
    // draft one below the new seam, not the old seam's timestamp.
    expect(gets).toHaveLength(4);
    const recomputed = `/drafts?limit=${DRAFTS_PAGE_SIZE}&before=${encodeURIComponent(isoAt(total - DRAFTS_PAGE_SIZE + 1))}`;
    expect(gets.some((href) => href.endsWith(recomputed))).toBe(true);
  });

  it("a draft-ready push's root-key invalidation refreshes the same feed", async () => {
    const drafts = seedHistory(DRAFTS_PAGE_SIZE + 3);
    const { gets } = stubPagedDaemon(drafts);
    const { client } = renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(DRAFTS_PAGE_SIZE));
    const chat = screen.getByTestId("thread-group");

    // A draft lands daemon-side (what /ws announces), then the handler's
    // exact call: invalidate the ["drafts"] root, which the feed's key sits
    // under (src/ws.ts performs this very invalidation).
    drafts.push(draftFor(drafts.length, null, "pushed"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["drafts"] });
    });

    // The pushed turn arrives at the end of the chat; the loaded view wasn't reset to get it.
    await waitFor(() => expect(screen.getByText("pushed")).toBeInTheDocument());
    expect(gets).toHaveLength(2);
    expect(screen.getByTestId("thread-group")).toBe(chat);
    expect(chat.isConnected).toBe(true);
  });

  it("a failed refresh keeps the loaded feed on screen instead of blanking it", async () => {
    stubPagedDaemon(seedHistory(DRAFTS_PAGE_SIZE + 3));
    const { client } = renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(DRAFTS_PAGE_SIZE));
    const entry = screen.getByText("question d003");

    // The daemon goes away between refreshes: the next invalidation fails,
    // and the pages already read stay rendered — the feed is not swapped for
    // an error screen that would throw away the owner's place.
    const failing = vi.fn(
      async () => new Response(JSON.stringify({ error: { code: "internal", message: "down" } }), { status: 500 }),
    );
    vi.stubGlobal("fetch", failing);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["drafts"] });
    });
    await waitFor(() => expect(failing).toHaveBeenCalled());

    expect(screen.getAllByTestId("thread-entry")).toHaveLength(DRAFTS_PAGE_SIZE);
    expect(screen.getByText("question d003")).toBe(entry);
    expect(entry.isConnected).toBe(true);
  });

  it("a chat with hundreds of turns renders whole and unduplicated", async () => {
    const total = DRAFTS_PAGE_SIZE * 6; // 300 — an exact multiple of the page size
    const { gets } = stubPagedDaemon(Array.from({ length: total }, (_, n) => draftFor(n, "long")));
    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(DRAFTS_PAGE_SIZE));

    // An exact multiple costs one empty page at the end — the daemon's
    // documented end-of-history signal — so 300 drafts walk in 7 fetches.
    // (happy-dom has no frame budget to measure "smooth" against; the pin is
    // that the whole walk + render stays correct at volume, while the OPEN
    // stays one fetch — measured above.)
    for (let fetches = 2; fetches <= 7; fetches += 1) {
      fireEvent.click(screen.getByTestId("load-older"));
      await waitFor(() => expect(gets).toHaveLength(fetches));
      await waitFor(() => {
        const button = screen.queryByTestId("load-older");
        if (button) {
          expect(button).not.toBeDisabled();
        }
      });
    }
    expect(screen.queryByTestId("load-older")).toBeNull();

    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(total));
    // Every entry exactly once — a mis-walked cursor shows up as overlap
    // (duplicates) or a gap (missing turns).
    expect(screen.getAllByText("question d000")).toHaveLength(1);
    expect(screen.getByText("question d299")).toBeInTheDocument();
  });
});
