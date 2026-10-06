import type { DuoApiConfig } from "../api/client.js";
import type { DraftSource } from "../api/types.js";
import { SourceRemoveButton } from "./SourceRemoveButton.js";

/**
 * A draft's evidence as a collapsed count + labels (`client-design.md`
 * §1.5 provenance rail). Empty sources render nothing. duo#272: given an
 * `api`, each rule/evidence row gets an inline Remove — omitted entirely
 * (`api` absent) wherever this list renders read-only, e.g. the share
 * path's own surfaces.
 */
export function SourceList({ api, sources }: { api?: DuoApiConfig; sources: DraftSource[] }) {
  if (sources.length === 0) {
    return null;
  }
  return (
    <details className="type-provenance text-[var(--muted)]">
      <summary>
        Drew on {sources.length} source{sources.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 space-y-1">
        {sources.map((source) => (
          <li className="flex items-center justify-between gap-2" key={`${source.kind}:${source.id}`}>
            <span className="min-w-0 truncate">{source.label}</span>
            {api && <SourceRemoveButton api={api} source={source} />}
          </li>
        ))}
      </ul>
    </details>
  );
}
