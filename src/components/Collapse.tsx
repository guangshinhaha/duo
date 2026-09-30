import { useEffect, useState, type ReactNode } from "react";

/** How long a leaving item stays mounted: its collapse (`--dur-std`) plus a frame. */
const LEAVE_MS = 230;

/**
 * A thing that leaves by folding away (docs/motion-plan.md B1): its height
 * and opacity ease out together, so what sits below it moves once rather
 * than jumping. `leaving` flips on the same element that was already
 * mounted, which is what lets the CSS transition run; it is inert to
 * assistive tech while it goes.
 */
export function Collapse({ leaving = false, children }: { leaving?: boolean; children: ReactNode }) {
  return (
    <div aria-hidden={leaving || undefined} className="motion-collapse" data-leaving={leaving ? "" : undefined} inert={leaving || undefined}>
      <div>{children}</div>
    </div>
  );
}

/**
 * `items` plus the ones that just left, flagged so they can play their
 * exit. Derived during render (the documented "adjust state while
 * rendering" pattern) so a removed item never unmounts for a frame before
 * coming back as leaving. An item that returns stops leaving. The leaving
 * item is shown as it last looked when the set of items changed. With
 * `holdMs` a removed item first stays put, not yet leaving, so what just
 * happened to it can be seen.
 */
export function useLeaving<T>(items: readonly T[], keyOf: (item: T) => string, holdMs = 0): { item: T; leaving: boolean }[] {
  const signature = items.map(keyOf).join("\u0000");
  const [state, setState] = useState<{ signature: string; items: readonly T[]; leaving: { item: T; index: number }[]; released: boolean }>({
    signature,
    items,
    leaving: [],
    released: holdMs === 0,
  });

  if (state.signature !== signature) {
    const present = new Set(items.map(keyOf));
    const carried = state.leaving.filter(({ item }) => !present.has(keyOf(item)));
    const carriedKeys = new Set(carried.map(({ item }) => keyOf(item)));
    const gone = state.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !present.has(keyOf(item)) && !carriedKeys.has(keyOf(item)));
    setState({ signature, items, leaving: [...carried, ...gone], released: holdMs === 0 });
  }

  const leavingCount = state.leaving.length;
  const { released } = state;
  // Held first (so a decided thing can be seen to be decided), then folded away, then gone.
  useEffect(() => {
    if (leavingCount === 0 || released) {
      return;
    }
    const timer = setTimeout(() => setState((current) => ({ ...current, released: true })), holdMs);
    return () => clearTimeout(timer);
  }, [leavingCount, released, holdMs, state.signature]);
  useEffect(() => {
    if (leavingCount === 0 || !released) {
      return;
    }
    const timer = setTimeout(() => setState((current) => ({ ...current, leaving: [], released: holdMs === 0 })), LEAVE_MS);
    return () => clearTimeout(timer);
  }, [leavingCount, released, holdMs, state.signature]);

  const result = items.map((item) => ({ item, leaving: false }));
  for (const { item, index } of state.leaving) {
    result.splice(Math.min(index, result.length), 0, { item, leaving: released });
  }
  return result;
}
