/**
 * A proportion rendered as width, never as a numeral. `client-design.md` §1.6
 * bans percentages for draft confidence ("precision the number does not
 * have"); the Mirror reuses that rule for its own proportions — topic shares,
 * top-five share, rule consistency — so no derived statistic anywhere in the
 * client displays more precision than it carries.
 */
export function MeterBar({ value, testId }: { value: number; testId?: string }) {
  // Clamp so a malformed share (negative, > 1) can only ever render a full or
  // empty bar, never a broken layout — the data comes off the wire, after all.
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    // #33: the fill is greyscale. §1.6 reserves the accent for *action
    // available*, and a proportion is data, not an action — an accent
    // meter made every screen it touched read as though something there
    // wanted clicking.
    <div className="h-1 w-full overflow-hidden rounded bg-[var(--surface-2)]" data-testid={testId ? `${testId}-track` : undefined}>
      <div className="h-full rounded bg-[var(--muted)]" style={{ width: `${pct}%` }} data-testid={testId ? `${testId}-fill` : undefined} />
    </div>
  );
}
