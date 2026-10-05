import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range, type VirtualItem, type Virtualizer } from "@tanstack/react-virtual";

/**
 * #248: a conversation's transcript, virtualized — TanStack Virtual (MIT,
 * the same family as the TanStack Query this app already uses) in place of
 * rendering every loaded row and restoring the scroll position by hand.
 * Only the rows near the viewport are in the DOM; each is measured as it
 * renders (text, images, file cards, formatted HTML and reply quotes all
 * differ in height), and the library keeps three chat behaviours that used
 * to be hand-rolled:
 *
 * - **Scroll-back keeps your place** (#211): `anchorTo: "end"` — when rows
 *   are prepended (an older page), the row at the viewport's top is found
 *   again by its key and the scroll offset re-applied to it, before paint.
 *   No `scrollHeight` arithmetic.
 * - **New messages keep you pinned** (#183): `followOnAppend` — a row
 *   appended while you're at the end scrolls into view; while you're up in
 *   history, nothing moves under you.
 * - **Measuring never jumps the view**: a row above the viewport that
 *   turns out taller or shorter than estimated adjusts the scroll offset
 *   by the difference.
 *
 * Only rows go in the list. What sits above it in the scroller (the way
 * back to the conversation list) is fixed in height and read as the list's
 * `scrollMargin`; what sits below it (a room's drafts, #68) is fed back as
 * `scrollPaddingEnd`, so "the end" is the true bottom — the draft included.
 * Anything that comes and goes above the list (the "Loading older…" status)
 * must not sit in its flow, or it would shift every row without being one.
 *
 * When the scroller has no size to measure (not laid out — hidden, or a
 * test DOM with no layout engine), there is nothing to virtualize against:
 * every row renders, in plain flow.
 */

export interface ChatTimeline {
  readonly virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
  /** Whether the scroller has a real size — virtualized and absolutely placed when true, every row in flow when false. */
  readonly laidOut: boolean;
  /** The scroll container — the element carrying `overflow-y-auto`. */
  readonly scrollerRef: RefObject<HTMLDivElement | null>;
  /** The list element (`ChatTimelineList` attaches it). */
  readonly listRef: RefObject<HTMLElement | null>;
  /** The content after the list, inside the scroller. */
  readonly footerRef: RefObject<HTMLDivElement | null>;
  /** How far down the scroller the list starts — what sits above it. */
  readonly scrollMargin: number;
  /** The list has rendered and its place in the scroller is measured — scrolls asked for from here on aim true. */
  readonly ready: boolean;
  /** Scroll so the row at `index` sits mid-viewport (a search landing, a quote's original, the unread line). */
  scrollToRow(index: number): void;
  /** The very end — the last row and whatever follows it. */
  scrollToEnd(): void;
  /** The very top of what's loaded. */
  scrollToTop(): void;
}

/** The gap between rows (Tailwind's gap-5), and the list's padding above its first row. */
const ROW_GAP_PX = 20;
const LIST_PADDING_PX = 8;
const NONE: readonly number[] = [];
/** What a member does to scroll a list themselves — a wheel, a touch, a key, a press on the scrollbar. */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "mousedown"] as const;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function useChatTimeline({
  count,
  getKey,
  estimateSize,
  keepMounted = NONE,
  follow,
}: {
  count: number;
  getKey: (index: number) => string;
  estimateSize: (index: number) => number;
  /** Rows that stay rendered however far off screen (a row mid-edit) — TanStack's documented `rangeExtractor` pattern for sticky rows. */
  keepMounted?: readonly number[];
  /**
   * Whether an arrival at the end pulls the view along. Off until the
   * conversation has made its first landing (the end, an unread line, a
   * search hit): the library would otherwise "follow" the very first page
   * in, from empty, straight past the place the member is meant to land.
   */
  follow: boolean;
}): ChatTimeline {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  const [scrollMargin, setScrollMargin] = useState(0);

  // What's above the list is read from the layout, before paint — a static
  // header, so this settles on the first measured render. `ready` says it
  // has: a scroll asked for before then would aim with the wrong margin.
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (!listRef.current) {
      return;
    }
    const top = listRef.current.offsetTop;
    if (top !== scrollMargin) {
      setScrollMargin(top);
    } else if (!ready) {
      setReady(true);
    }
  });

  useEffect(() => {
    const footer = footerRef.current;
    if (!footer || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => setFooterHeight(footer.offsetHeight));
    observer.observe(footer);
    return () => observer.disconnect();
  }, []);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getScrollElement: () => scrollerRef.current,
    getItemKey: getKey,
    estimateSize,
    rangeExtractor: useCallback(
      (range: Range) => {
        const indexes = defaultRangeExtractor(range);
        const extra = keepMounted.filter((index) => index < range.count && !indexes.includes(index));
        return extra.length === 0 ? indexes : [...indexes, ...extra].sort((a, b) => a - b);
      },
      [keepMounted],
    ),
    overscan: 6,
    gap: ROW_GAP_PX,
    paddingStart: LIST_PADDING_PX,
    scrollMargin,
    scrollPaddingEnd: footerHeight,
    anchorTo: "end",
    // The arrival glides in (docs/motion-plan.md B7), unless the member
    // asked for less motion.
    followOnAppend: follow && (prefersReducedMotion() ? true : "smooth"),
    // "At the end" within a couple of lines' slack — a member who's a few
    // pixels short of the bottom is still reading the latest.
    scrollEndThreshold: 48,
    // Until the scroller is measured, assume a window's worth of viewport so
    // the first paint renders a screenful, not every row.
    initialRect: { width: 0, height: typeof window === "undefined" ? 0 : window.innerHeight },
  });
  const laidOut = (virtualizer.scrollRect?.height ?? 0) > 0;

  // Where the app asked the view to be — the end, or a row by its key —
  // held until the member takes the scroll over themselves. Rows keep
  // settling after a jump (measured as they render, images loading, a page
  // landing above), and the library's own settle loop can finish a frame
  // before the list's new height commits; re-aiming at the intent whenever
  // the list's size changes means the jump always ends where it was meant
  // to, on the row it was meant for (by key, so a prepend can't shift it
  // onto a neighbour).
  const intent = useRef<{ readonly kind: "end" } | { readonly kind: "row"; readonly key: string } | null>(null);
  const settled = useRef({ total: -1, count: -1 });
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    if (settled.current.total === totalSize && settled.current.count === count) {
      return;
    }
    settled.current = { total: totalSize, count };
    const aim = intent.current;
    if (aim?.kind === "end") {
      virtualizer.scrollToEnd();
    } else if (aim?.kind === "row") {
      const index = Array.from({ length: count }, (_, i) => i).find((i) => getKey(i) === aim.key);
      if (index !== undefined) {
        virtualizer.scrollToIndex(index, { align: "center" });
      }
    }
  });
  // A wheel, a touch, a key, a press on the scrollbar: the member is
  // scrolling now, and nothing re-aims under them.
  const watched = useRef<HTMLElement | null>(null);
  const takeOver = useRef(() => {
    intent.current = null;
  });
  useEffect(() => {
    // The scroller mounts once the timeline has loaded; watch whichever is current.
    const scroller = scrollerRef.current;
    if (scroller === watched.current) {
      return;
    }
    for (const event of USER_SCROLL_EVENTS) {
      watched.current?.removeEventListener(event, takeOver.current);
      scroller?.addEventListener(event, takeOver.current, { passive: true });
    }
    watched.current = scroller;
  });
  useEffect(
    () => () => {
      for (const event of USER_SCROLL_EVENTS) {
        watched.current?.removeEventListener(event, takeOver.current);
      }
      // Forgotten too, so a remount (StrictMode runs every effect's cleanup
      // and then the effect again) attaches the listeners afresh rather than
      // finding the same scroller "already watched" with nothing on it — and
      // re-aiming at the end under a member who's scrolling.
      watched.current = null;
    },
    [],
  );

  return {
    virtualizer,
    laidOut,
    scrollerRef,
    listRef,
    footerRef,
    scrollMargin,
    ready,
    scrollToRow: (index) => {
      if (index >= 0 && index < count) {
        intent.current = { kind: "row", key: getKey(index) };
        virtualizer.scrollToIndex(index, { align: "center" });
      }
    },
    scrollToEnd: () => {
      intent.current = { kind: "end" };
      virtualizer.scrollToEnd();
    },
    scrollToTop: () => {
      intent.current = null;
      virtualizer.scrollToOffset(0);
    },
  };
}

/** The rows to render: the virtualizer's window when laid out, every row otherwise. */
function rowsToRender(timeline: ChatTimeline, count: number): readonly Pick<VirtualItem, "index" | "key" | "start">[] {
  if (timeline.laidOut) {
    return timeline.virtualizer.getVirtualItems();
  }
  return Array.from({ length: count }, (_, index) => ({ index, key: timeline.virtualizer.options.getItemKey(index), start: 0 }));
}

/**
 * The list itself: a sized, positioned container with each rendered row
 * measured in place. `renderRow` draws one row's content; the wrapper here
 * owns its position and measurement.
 */
export function ChatTimelineList({
  timeline,
  count,
  renderRow,
  testId,
}: {
  timeline: ChatTimeline;
  count: number;
  renderRow: (index: number) => ReactNode;
  testId: string;
}) {
  const { virtualizer, laidOut, scrollMargin } = timeline;
  const listStyle: CSSProperties | undefined = laidOut ? { height: virtualizer.getTotalSize() } : undefined;
  return (
    <section
      className={laidOut ? "relative" : "relative flex flex-col gap-5 pt-2"}
      data-testid={testId}
      ref={(element) => {
        timeline.listRef.current = element;
      }}
      style={listStyle}
    >
      {rowsToRender(timeline, count).map((item) => (
        <div
          className={laidOut ? "absolute top-0 left-0 w-full" : undefined}
          data-index={item.index}
          key={String(item.key)}
          ref={virtualizer.measureElement}
          style={laidOut ? { transform: `translateY(${item.start - scrollMargin}px)` } : undefined}
        >
          {renderRow(item.index)}
        </div>
      ))}
    </section>
  );
}
