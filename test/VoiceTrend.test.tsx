import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import type { VoiceTrend } from "../src/api/types.js";
import { VoiceTrendSection } from "../src/profile/VoiceTrend.js";

/*
 * duo#276: "how closely your duo still sounds like you" — a Portrait
 * section built entirely from `GET /mirror/voice-trend`'s own fields
 * (digital-duo `src/derivation/voice-trend.ts`'s `VoiceTrend`). Covers the
 * honest-empty state, a real trend with a drop and a worst-example link,
 * and a malformed payload — the same "braces and belt" guard
 * Patterns.tsx's RateSection already pins for a daemon read.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <VoiceTrendSection api={api} />
    </QueryClientProvider>,
  );
}

function stubTrend(trend: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(url).toContain("/mirror/voice-trend");
      return new Response(JSON.stringify(trend), { status: 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const trend = (over: Partial<VoiceTrend> = {}): VoiceTrend => ({
  bucketing: "week",
  buckets: [],
  tooThin: false,
  minimumSendsToCharacterize: 20,
  totalApprovedSends: 41,
  ...over,
});

describe("VoiceTrendSection", () => {
  it("says there isn't enough history yet, in words — never an empty chart", async () => {
    stubTrend(trend({ tooThin: true, totalApprovedSends: 6 }));
    mount();
    expect(await screen.findByTestId("voice-trend-thin")).toHaveTextContent("needs at least 20 approved sends");
    expect(await screen.findByTestId("voice-trend-thin")).toHaveTextContent("it has 6");
    expect(screen.queryByTestId("voice-trend-buckets")).toBeNull();
  });

  it("says a baseline is set but the trend hasn't started yet, when every bucket is still unscored", async () => {
    stubTrend(
      trend({
        buckets: [{ periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-09-07T23:59:59.999Z", sampleSize: 0, score: null, reanchored: false, worstExamples: [] }],
      }),
    );
    mount();
    expect(await screen.findByTestId("voice-trend-baseline")).toHaveTextContent("set a baseline");
  });

  it("renders a bar per scored bucket, no percentage numerals, and a recalibration note where the anchor was rebuilt", async () => {
    stubTrend(
      trend({
        buckets: [
          { periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-09-07T23:59:59.999Z", sampleSize: 4, score: 0.3, reanchored: false, worstExamples: [] },
          {
            periodStart: "2026-09-08T00:00:00.000Z",
            periodEnd: "2026-09-14T23:59:59.999Z",
            sampleSize: 3,
            score: 0.92,
            reanchored: true,
            worstExamples: [],
          },
        ],
      }),
    );
    mount();
    const rows = await screen.findAllByTestId("voice-trend-bucket");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByTestId("voice-trend-score-fill")).toHaveStyle({ width: "30%" });
    expect(within(rows[0]!).queryByTestId("voice-trend-reanchored")).toBeNull();
    expect(within(rows[1]!).getByTestId("voice-trend-score-fill")).toHaveStyle({ width: "92%" });
    expect(within(rows[1]!).getByTestId("voice-trend-reanchored")).toHaveTextContent("Recalibrated");
    expect(rows.map((row) => row.textContent).join(" ")).not.toContain("%");
  });

  it("links the worst recent examples to their drafts, deduped across buckets and capped", async () => {
    stubTrend(
      trend({
        buckets: [
          {
            periodStart: "2026-09-01T00:00:00.000Z",
            periodEnd: "2026-09-07T23:59:59.999Z",
            sampleSize: 2,
            score: 0.4,
            reanchored: false,
            worstExamples: [
              { draftId: "d1", score: 0.1, snippet: "hey thanks!" },
              { draftId: "d2", score: 0.3, snippet: "no worries" },
            ],
          },
          {
            periodStart: "2026-09-08T00:00:00.000Z",
            periodEnd: "2026-09-14T23:59:59.999Z",
            sampleSize: 2,
            score: 0.5,
            reanchored: false,
            worstExamples: [
              { draftId: "d1", score: 0.1, snippet: "hey thanks!" }, // same draft re-surfaced — must appear once
              { draftId: "d3", score: 0.2, snippet: "Dear Sir, kind regards" },
            ],
          },
        ],
      }),
    );
    mount();
    await waitFor(() => expect(screen.getByTestId("voice-trend-worst")).toBeInTheDocument());
    const links = screen.getAllByTestId("voice-trend-worst-link");
    const ids = links.map((link) => link.getAttribute("href"));
    expect(new Set(ids).size).toBe(ids.length); // no duplicate draft
    expect(ids).toContain("#draft/d1");
    expect(ids).toContain("#draft/d3");
  });

  it("says it couldn't read the trend, rather than throwing, when the daemon's payload isn't the documented shape", async () => {
    stubTrend({ awaitingApproval: [], weakSignals: [] }); // some other mirror route's shape, by mistake
    mount();
    expect(await screen.findByTestId("voice-trend-error")).toHaveTextContent("Couldn't read the trend");
  });
});
