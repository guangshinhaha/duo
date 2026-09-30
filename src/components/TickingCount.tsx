import { useEffect, useState } from "react";

/** How long the old figure lingers: its exit (`--dur-quick`) plus a frame. */
const TICK_MS = 140;

/**
 * A count that ticks (docs/motion-plan.md B3): when the number changes the
 * old figure leaves upward while the new one rises in from below, in
 * tabular numerals so nothing shifts sideways. Going to zero the old figure
 * leaves and nothing replaces it: the empty state that follows says so in
 * words. The old figure is `aria-hidden`, so a screen reader hears the count
 * once.
 */
export function TickingCount({ value }: { value: number }) {
  const [shown, setShown] = useState<{ current: number; previous: number | null }>({ current: value, previous: null });
  if (shown.current !== value) {
    setShown({ current: value, previous: shown.current });
  }
  useEffect(() => {
    if (shown.previous === null) {
      return;
    }
    const timer = setTimeout(() => setShown((state) => ({ ...state, previous: null })), TICK_MS);
    return () => clearTimeout(timer);
  }, [shown.previous, shown.current]);

  return (
    <span className="tick">
      {shown.previous !== null && (
        <span aria-hidden="true" className="tick-out">
          {shown.previous}
        </span>
      )}
      {value > 0 && (
        <span className={shown.previous !== null ? "tick-in" : undefined} key={value}>
          {value}
        </span>
      )}
    </span>
  );
}
