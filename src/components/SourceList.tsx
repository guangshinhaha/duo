import type { DraftSource } from "../api/types.js";

/** A draft's evidence as a collapsed count + labels (`client-design.md` §1.5 provenance rail). Empty sources render nothing. */
export function SourceList({ sources }: { sources: DraftSource[] }) {
  if (sources.length === 0) {
    return null;
  }
  return (
    <details className="text-xs text-[var(--muted)]">
      <summary>
        Drew on {sources.length} source{sources.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 space-y-1">
        {sources.map((source) => (
          <li key={`${source.kind}:${source.id}`}>{source.label}</li>
        ))}
      </ul>
    </details>
  );
}
