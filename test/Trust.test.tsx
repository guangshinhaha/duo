import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Trust } from "../src/routes/Trust.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { GridRow } from "../src/api/types.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function rowFor(topicId: string, over?: Partial<GridRow>): GridRow {
  return { topicId, topicLabel: `label for ${topicId}`, tier: "T1", level: "approve", source: "earned", stale: false, ...over };
}

const rows: GridRow[] = [
  rowFor("t1"),
  rowFor("t2", { tier: "T3", level: "auto", source: "granted" }),
  rowFor("t3", { topicLabel: undefined }),
  rowFor("t4", { stale: true }),
];

function stubGrid(list: GridRow[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/trust/grid")) {
        return new Response(JSON.stringify(list), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }),
  );
}

describe("Trust — the trust grid (issue #9)", () => {
  beforeEach(() => {
    stubGrid(rows);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders each row with the daemon's own terms: label, tier, level, source", async () => {
    renderWithClient(<Trust api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("trust-row")).toHaveLength(4));
    const first = screen.getAllByTestId("trust-row")[0];
    expect(first.querySelector('[data-testid="trust-topic"]')).toHaveTextContent("label for t1");
    expect(first.querySelector('[data-testid="trust-tier"]')).toHaveTextContent("T1");
    expect(first.querySelector('[data-testid="trust-level"]')).toHaveTextContent("approve");
    expect(first.querySelector('[data-testid="trust-source"]')).toHaveTextContent("earned");
    const granted = screen.getAllByTestId("trust-row")[1];
    expect(granted.querySelector('[data-testid="trust-tier"]')).toHaveTextContent("T3");
    expect(granted.querySelector('[data-testid="trust-level"]')).toHaveTextContent("auto");
    expect(granted.querySelector('[data-testid="trust-source"]')).toHaveTextContent("granted");
  });

  it("falls back to the topicId when a row carries no label, never an empty label", async () => {
    renderWithClient(<Trust api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("trust-row")).toHaveLength(4));
    const unlabelled = screen.getAllByTestId("trust-row")[2];
    expect(unlabelled.querySelector('[data-testid="trust-topic"]')).toHaveTextContent("t3");
  });

  it("marks stale rows so aged trust reads differently from current trust", async () => {
    renderWithClient(<Trust api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("trust-row")).toHaveLength(4));
    expect(screen.getAllByTestId("trust-row")[3].querySelector('[data-testid="trust-stale"]')).not.toBeNull();
    expect(screen.getAllByTestId("trust-row")[0].querySelector('[data-testid="trust-stale"]')).toBeNull();
  });

  it("renders an honest empty state when nothing is earned yet (AR-19)", async () => {
    stubGrid([]);
    renderWithClient(<Trust api={api} />);
    await waitFor(() => expect(screen.getByTestId("trust-empty")).toBeInTheDocument());
    expect(screen.getByTestId("trust-empty")).toHaveTextContent("Nothing earned yet");
    expect(screen.queryByTestId("trust-row")).toBeNull();
  });

  it("surfaces the daemon's error message when the route fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "unknown", message: "store locked" } }), { status: 500 })),
    );
    renderWithClient(<Trust api={api} />);
    await waitFor(() => expect(screen.getByText("store locked")).toBeInTheDocument());
  });
});
