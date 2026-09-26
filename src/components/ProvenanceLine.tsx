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
 * the original message in whatever application owns it. #68: when the
 * message arrived in a conversation of this app, the caller says where that
 * conversation opens — finding it is the caller's job, this line only
 * renders what it is handed.
 */
export function ProvenanceLine({
  provenance,
  conversationHref,
}: {
  provenance: DraftProvenance | undefined;
  /** #68: where the conversation this message arrived in opens in this app — passed only when the caller found it among the member's own. */
  conversationHref?: string;
}) {
  // `undefined` is the persisted cache being older than the field (#86's
  // staleness belt) — it degrades like a legacy row, not a crash.
  if (provenance?.origin !== "channel") {
    return null;
  }
  return (
    <p className="type-provenance text-[var(--faint)]" data-testid="draft-origin">
      Asked by {provenance.askerRef} in {provenance.channelKind}
      {provenance.permalink ? (
        <>
          {" · "}
          <a className="underline" href={provenance.permalink} target="_blank" rel="noreferrer" data-testid="origin-permalink">
            View original
          </a>
        </>
      ) : null}
      {conversationHref ? (
        <>
          {" · "}
          <a className="underline" href={conversationHref} data-testid="open-conversation">
            Open the conversation
          </a>
        </>
      ) : null}
    </p>
  );
}
