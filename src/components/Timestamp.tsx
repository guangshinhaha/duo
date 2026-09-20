/**
 * #26: one time format everywhere a draft-side message renders (Review's
 * DraftCard, the Duo thread). Recent times read relative — the age is the
 * useful fact about something minutes old; older ones read as absolute
 * dates, because "4,380h ago" is arithmetic, not information. The full
 * timestamp rides on hover (`title`) for the moment either rounding loses.
 * Audit keeps its own always-absolute format: an audit trail is a record,
 * and records do not age in relative terms.
 */
export function Timestamp({ iso }: { iso: string }) {
  const when = new Date(iso);
  const ageMs = Date.now() - when.getTime();
  let label: string;
  if (ageMs < 60_000) {
    label = "just now";
  } else if (ageMs < 60 * 60_000) {
    label = `${Math.floor(ageMs / 60_000)}m ago`;
  } else if (ageMs < 24 * 60 * 60_000) {
    label = `${Math.floor(ageMs / 3_600_000)}h ago`;
  } else {
    label = when.toLocaleDateString();
  }
  return (
    <time dateTime={iso} title={when.toISOString()} data-testid="timestamp" className="shrink-0">
      {label}
    </time>
  );
}
