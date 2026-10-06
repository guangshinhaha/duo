import type { DuoApiConfig } from "../api/client.js";
import { useMirrorVoiceTrend } from "../api/queries.js";
import type { VoiceTrendBucket, VoiceTrendExample } from "../api/types.js";
import { MeterBar } from "../components/MeterBar.js";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/** The cache is a storage layer, not a promise (Patterns.tsx's own rule): a payload that isn't the daemon's documented VoiceTrend shape is not an answer, and this section must say so rather than call `.filter` on whatever came back. */
function isVoiceTrendShape(value: unknown): value is import("../api/types.js").VoiceTrend {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.tooThin === "boolean" && Array.isArray(candidate.buckets) && typeof candidate.minimumSendsToCharacterize === "number";
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** Every scored bucket's worst examples, lowest score first, deduped by draft (the same draft can only ever appear once in its own bucket, but a short trend may re-surface it) and capped — the trend's whole point is a short, honest pointer to what to look at, not an audit log. */
function worstOverall(buckets: readonly VoiceTrendBucket[], cap: number): VoiceTrendExample[] {
  const seen = new Set<string>();
  const examples: VoiceTrendExample[] = [];
  for (const bucket of buckets) {
    for (const example of bucket.worstExamples) {
      if (!seen.has(example.draftId)) {
        seen.add(example.draftId);
        examples.push(example);
      }
    }
  }
  return examples.sort((a, b) => a.score - b.score).slice(0, cap);
}

/**
 * One bucket's row: the period, a bar for its score (never a numeral — the
 * Mirror's own rule for a derived proportion, §1.6), and how many drafts it
 * was measured over. A bucket whose anchor was just rebuilt (its own score,
 * or the one before it, fell below the daemon's threshold) says so plainly
 * rather than letting a jump in the bar read as unexplained.
 */
function BucketRow({ bucket }: { bucket: VoiceTrendBucket }) {
  if (bucket.score === null) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1" data-testid="voice-trend-bucket">
      <div className="flex justify-between type-provenance text-[var(--muted)]">
        <span>
          {formatDate(bucket.periodStart)} – {formatDate(bucket.periodEnd)}
        </span>
        <span>
          {bucket.sampleSize} {plural(bucket.sampleSize, "draft", "drafts")}
        </span>
      </div>
      <MeterBar testId="voice-trend-score" value={bucket.score} />
      {bucket.reanchored && (
        <p className="type-identifier text-[var(--faint)]" data-testid="voice-trend-reanchored">
          Recalibrated against your more recent sends here.
        </p>
      )}
    </div>
  );
}

/**
 * duo#276: "how closely your duo still sounds like you" — persona drift is
 * a known failure mode nobody shows (Character.ai); this is the Portrait's
 * answer. Entirely read-only (AR-18): nothing here edits, re-anchors on
 * demand, or fixes anything — a drop is something to look at, in Rules or
 * in the drafts it names, not something this screen offers to undo.
 */
export function VoiceTrendSection({ api }: { api: DuoApiConfig }) {
  const trend = useMirrorVoiceTrend(api, "week");

  if (trend.isLoading) {
    return (
      <section className="shape-container flex flex-col gap-2 p-4" data-testid="voice-trend-section">
        <h2 className="type-heading">How closely it still sounds like you</h2>
        <p className="type-provenance text-[var(--muted)]" data-testid="voice-trend-loading">
          Reading the trend…
        </p>
      </section>
    );
  }
  if (trend.error || !trend.data || !isVoiceTrendShape(trend.data)) {
    return (
      <section className="shape-container flex flex-col gap-2 p-4" data-testid="voice-trend-section">
        <h2 className="type-heading">How closely it still sounds like you</h2>
        <p className="type-provenance text-[var(--refused)]" data-testid="voice-trend-error" role="status">
          Couldn&apos;t read the trend — try again later.
        </p>
      </section>
    );
  }

  const data = trend.data;
  if (data.tooThin) {
    return (
      <section className="shape-container flex flex-col gap-2 p-4" data-testid="voice-trend-section">
        <h2 className="type-heading">How closely it still sounds like you</h2>
        <p className="type-body text-[var(--muted)]" data-testid="voice-trend-thin">
          Not enough sent drafts yet to show a trend. Your duo needs at least {data.minimumSendsToCharacterize} approved sends to set a
          baseline, and it has {data.totalApprovedSends}.
        </p>
      </section>
    );
  }

  const scoredBuckets = data.buckets.filter((bucket) => bucket.score !== null);
  if (scoredBuckets.length === 0) {
    return (
      <section className="shape-container flex flex-col gap-2 p-4" data-testid="voice-trend-section">
        <h2 className="type-heading">How closely it still sounds like you</h2>
        <p className="type-body text-[var(--muted)]" data-testid="voice-trend-baseline">
          Your duo has enough approved sends now to set a baseline. The trend will start appearing as you send and edit more.
        </p>
      </section>
    );
  }

  const worst = worstOverall(data.buckets, 3);

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="voice-trend-section">
      <h2 className="type-heading">How closely it still sounds like you</h2>
      <p className="type-provenance text-[var(--muted)]">
        Each draft, before any edit, measured against how you&apos;ve actually been writing lately.
      </p>
      <div className="flex flex-col gap-3" data-testid="voice-trend-buckets">
        {scoredBuckets.map((bucket) => (
          <BucketRow bucket={bucket} key={bucket.periodStart} />
        ))}
      </div>
      {worst.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-[var(--edge)] pt-3" data-testid="voice-trend-worst">
          <p className="type-provenance text-[var(--muted)]">Worst recent examples</p>
          <ul className="flex flex-col gap-2">
            {worst.map((example) => (
              <li key={example.draftId}>
                <a
                  className="type-body text-[var(--text)] underline"
                  data-testid="voice-trend-worst-link"
                  href={`#draft/${encodeURIComponent(example.draftId)}`}
                >
                  {example.snippet}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
