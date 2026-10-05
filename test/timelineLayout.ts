import { vi } from "vitest";

/*
 * #248: happy-dom lays nothing out — every element measures 0 — so a
 * virtualized transcript there renders every row in plain flow (see
 * `useChatTimeline`'s no-layout fallback), which is what most tests want.
 * Tests about the virtualization itself need a layout to virtualize
 * against: this gives the transcript's scroller a viewport, each row a
 * height, the list its offset below the header, and makes `scrollTo` move
 * `scrollTop` (clamped, with a scroll event) the way a browser does.
 */

const SCROLLERS = '[data-testid="room-scroller"], [data-testid="thread-scroller"]';
const LISTS = '[data-testid="room-timeline"], [data-testid="thread-timeline"]';

export interface TimelineLayout {
  readonly viewport: number;
  /** How far down the scroller the list starts (the "All conversations" link above it). */
  readonly header: number;
  /** Space after the list (the footer's padding). */
  readonly footer: number;
}

function isScroller(element: Element): boolean {
  return element.matches(SCROLLERS);
}

function isRow(element: Element): boolean {
  return element.hasAttribute("data-index") && element.parentElement?.matches(LISTS) === true;
}

function maxScroll(scroller: HTMLElement, layout: TimelineLayout): number {
  return Math.max(0, scroller.scrollHeight - layout.viewport);
}

export function stubTimelineLayout({
  viewport = 300,
  header = 68,
  footer = 24,
  rowHeight = () => 100,
}: {
  viewport?: number;
  header?: number;
  footer?: number;
  /** A rendered row's height — by default every row is 100px. */
  rowHeight?: (row: HTMLElement) => number;
} = {}): TimelineLayout {
  const layout: TimelineLayout = { viewport, header, footer };
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!.get!;
  const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop")!.get!;
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")!.get!;
  const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!.get!;

  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (isScroller(this)) {
      return viewport;
    }
    if (isRow(this)) {
      return rowHeight(this);
    }
    // The content after the list (the footer the timeline measures for scrollPaddingEnd).
    if (this.previousElementSibling?.matches(LISTS) === true && this.parentElement !== null && isScroller(this.parentElement)) {
      return footer;
    }
    return offsetHeight.call(this);
  });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return this.matches(LISTS) ? header : offsetTop.call(this);
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isScroller(this) ? viewport : clientHeight.call(this);
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    if (!isScroller(this)) {
      return scrollHeight.call(this);
    }
    const list = this.querySelector<HTMLElement>(LISTS);
    return Math.max(viewport, header + (parseFloat(list?.style.height ?? "") || 0) + footer);
  });
  // A browser clamps every write to the scrollable range, however it's made
  // (TanStack writes `scrollTop` directly for its size adjustments).
  const scrollTopSet = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!.set!;
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, value: number) {
    scrollTopSet.call(this, isScroller(this) ? Math.min(Math.max(0, value), maxScroll(this as HTMLElement, layout)) : value);
  });
  vi.spyOn(Element.prototype, "scrollTo").mockImplementation(function (this: Element, ...args: unknown[]) {
    const [first, second] = args;
    const top = typeof first === "object" && first !== null ? (first as ScrollToOptions).top : (second as number | undefined);
    if (top === undefined) {
      return;
    }
    const element = this as HTMLElement;
    const before = element.scrollTop;
    element.scrollTop = top;
    // Like a browser: no movement, no scroll event.
    if (element.scrollTop !== before) {
      element.dispatchEvent(new Event("scroll"));
    }
  });
  // A browser's ResizeObserver reports each element's size once it starts
  // watching (and whenever it changes); happy-dom's never calls back at all.
  // The virtualizer measures rows that mount mid-scroll through this, so a
  // layout without it would leave those rows at their estimates.
  class LayoutResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element): void {
      queueMicrotask(() => {
        if (!target.isConnected) {
          return;
        }
        const blockSize = (target as HTMLElement).offsetHeight;
        const entry = { target, borderBoxSize: [{ blockSize, inlineSize: 0 }], contentRect: { height: blockSize, width: 0 } };
        this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      });
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", LayoutResizeObserver);
  return layout;
}

/** A rendered row's top, in viewport pixels from the scroller's top edge — what the member sees. */
export function rowTopOnScreen(row: HTMLElement, layout: TimelineLayout): number {
  const wrapper = row.closest<HTMLElement>("[data-index]")!;
  const scroller = wrapper.closest<HTMLElement>(SCROLLERS)!;
  const translate = /translateY\((-?[\d.]+)px\)/.exec(wrapper.style.transform);
  return layout.header + Number(translate?.[1] ?? 0) - scroller.scrollTop;
}

/** Scrolls the transcript the way a member does: a wheel turn, the move, then the browser's scroll event. */
export function scrollTranscriptTo(scroller: HTMLElement, top: number): void {
  scroller.dispatchEvent(new Event("wheel"));
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event("scroll"));
}
