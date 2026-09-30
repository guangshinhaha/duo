import { useEffect, useState } from "react";

/** How long a departing part stays mounted: the exit (`--dur-std`) plus a frame. */
const EXIT_MS = 220;

/**
 * Mount state for something that eases in and out (docs/motion-plan.md B6,
 * B8). `mounted` is true from the moment `open` flips on until the exit has
 * run; `shown` is what the CSS transition keys on, and it lags the mount by
 * two frames on the way in so the closed state has been painted for the
 * transition to run *from*. What is open at first render is simply there:
 * a restored preference is not news.
 */
export function usePresence(open: boolean): { mounted: boolean; shown: boolean } {
  const [state, setState] = useState({ mounted: open, shown: open });

  useEffect(() => {
    if (open) {
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setState({ mounted: true, shown: true }));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setState((current) => ({ ...current, shown: false }));
    const timer = setTimeout(() => setState({ mounted: false, shown: false }), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  return { mounted: open || state.mounted, shown: open && state.shown };
}
