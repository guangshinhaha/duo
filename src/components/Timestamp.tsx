/** The age of a moment in the words the app uses everywhere: "just now", "5m ago", "3h ago", then the date. */
export function ageLabel(iso: string, now: number = Date.now()): string {
  const when = new Date(iso);
  const ageMs = now - when.getTime();
  if (ageMs < 60_000) {
    return "just now";
  }
  if (ageMs < 60 * 60_000) {
    return `${Math.floor(ageMs / 60_000)}m ago`;
  }
  if (ageMs < 24 * 60 * 60_000) {
    return `${Math.floor(ageMs / 3_600_000)}h ago`;
  }
  return when.toLocaleDateString();
}

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
  const label = ageLabel(iso);
  return (
    <time dateTime={iso} title={when.toISOString()} data-testid="timestamp" className="shrink-0">
      {label}
    </time>
  );
}
