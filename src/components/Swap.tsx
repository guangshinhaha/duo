import { useEffect, useState, type ReactNode } from "react";

/** How long the old value lingers: its cross-fade (`--dur-slow`) plus a frame. */
const SWAP_MS = 340;

/**
 * A value that changes in place cross-fades (docs/motion-plan.md C1): the
 * old one fades out where it stood while the new one fades in over it, so a
 * level stepping down is *seen* to step down rather than silently rewritten.
 * `value` is what changed (the key, and the only thing compared); `children` is how it reads. The old
 * copy is `aria-hidden`, so assistive tech hears the new value once.
 */
export function Swap({ value, children }: { value: string; children: ReactNode }) {
  const [shown, setShown] = useState<{ value: string; children: ReactNode; previous: ReactNode | null }>({ value, children, previous: null });
  if (shown.value !== value) {
    setShown({ value, children, previous: shown.children });
  }
  useEffect(() => {
    if (shown.previous === null) {
      return;
    }
    const timer = setTimeout(() => setShown((state) => ({ ...state, previous: null })), SWAP_MS);
    return () => clearTimeout(timer);
  }, [shown.previous, shown.value]);

  return (
    <span className="swap">
      {shown.previous !== null && (
        <span aria-hidden="true" className="swap-out">
          {shown.previous}
        </span>
      )}
      <span className={shown.previous !== null ? "swap-in" : undefined} key={value}>
        {children}
      </span>
    </span>
  );
}
