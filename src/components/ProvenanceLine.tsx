import type { DraftProvenance } from "../api/types.js";

/**
 * #20: who asked, and where they asked it — the daemon's strings verbatim.
 * Only a channel-borne draft gets the line. A self-asked question needs no
 * attribution (it already reads as yours everywhere it renders, and #30's
 * Keep vocabulary says so), and a legacy row without provenance degrades
 * quietly — no "unknown" chrome for history that predates the field. The
 * asker ref and channel kind render exactly as sent, capitalisation
 * included, so a channel added to the core needs no change here; the
 * permalink, when the adapter supplied one, is the single click back to
 * the original message in whatever application owns it.
 */
export function ProvenanceLine({ provenance }: { provenance: DraftProvenance | undefined }) {
  // `undefined` is the persisted cache being older than the field (#86's
  // staleness belt) — it degrades like a legacy row, not a crash.
  if (provenance?.origin !== "channel") {
    return null;
  }
  return (
    <p className="text-xs text-[var(--faint)]" data-testid="draft-origin">
      Asked by {provenance.askerRef} in {provenance.channelKind}
      {provenance.permalink ? (
        <>
          {" · "}
          <a className="underline" href={provenance.permalink} target="_blank" rel="noreferrer" data-testid="origin-permalink">
            View original
          </a>
        </>
      ) : null}
    </p>
  );
}
