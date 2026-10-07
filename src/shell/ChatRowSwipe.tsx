import { useRef, useState, type PointerEvent, type ReactNode } from "react";

/*
 * #297: pin and archive, by swipe, on a conversation's own row — the phone
 * half of "row menu and shortcuts" (docs/design-language.md §6.4 names the
 * mechanism, the draft swipe, `SwipeRow.tsx`, that this borrows the gesture
 * feel from). Deliberately its own component rather than a second mode
 * bolted onto `SwipeRow`: that one holds a draft's own two-phase commit
 * (sent/dismissed, with an undo window, because a dismissal can't be taken
 * back once the daemon has it) — pinning and archiving are instant,
 * idempotent account state, with no undo to hold open and nothing to fail
 * in a way this row needs to show; the caller's own busy lock and error
 * banner (the same ones `markRead`/`markUnread` already report through)
 * cover it. `ChatList.tsx` never wraps a row that already shows a draft in
 * this — the one rule the issue's own AC asks for, "don't conflict with the
 * draft swipe" — so the two swipes never compete for the same row.
 */

/** How far a swipe must travel to count — same feel as the draft swipe. */
const COMMIT_PX = 96;
const COMMIT_FRACTION = 0.35;
/** How far a finger moves before this decides it's a horizontal swipe, not a vertical scroll. */
const LOCK_PX = 10;
/** Past the commit point the row follows the finger at this fraction, so the commit is felt. */
const RESISTANCE = 0.35;

function travel(raw: number, threshold: number): number {
  const distance = Math.abs(raw);
  const shown = distance <= threshold ? distance : threshold + (distance - threshold) * RESISTANCE;
  return raw < 0 ? -shown : shown;
}

/**
 * A row that pins or archives a conversation when swiped: swiping it
 * **right reveals Pin/Unpin**, swiping it **left reveals Archive/Unarchive**
 * — either side absent when that action has nowhere to go (no connection,
 * or the member is offline and the action is a server write). A swipe
 * toward an absent side doesn't move the row at all. Vertical movement
 * stays the page's scroll; a tap on the row is still a tap.
 */
export function ChatRowSwipe({
  children,
  pin,
  pinLabel,
  archive,
  archiveLabel,
}: {
  children: ReactNode;
  /** Runs the pin/unpin write. Absent: no right swipe. */
  pin: (() => void) | null;
  /** "Pin" or "Unpin" — whichever this row would do next. */
  pinLabel: string;
  /** Runs the archive/unarchive write. Absent: no left swipe. */
  archive: (() => void) | null;
  /** "Archive" or "Unarchive" — whichever this row would do next. */
  archiveLabel: string;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [armed, setArmed] = useState<"pin" | "archive" | null>(null);
  const gesture = useRef<{ x: number; y: number; axis: "h" | "v" | null; raw: number } | null>(null);
  const swallowClick = useRef(false);

  if (pin === null && archive === null) {
    return <>{children}</>;
  }

  const settle = (): void => setOffset(0);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === "mouse" && e.button !== 0) {
      return;
    }
    gesture.current = { x: e.clientX, y: e.clientY, axis: null, raw: 0 };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (!g) {
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.axis === null) {
      if (Math.abs(dx) < LOCK_PX && Math.abs(dy) < LOCK_PX) {
        return;
      }
      g.axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      if (g.axis === "h") {
        setDragging(true);
        if (typeof e.currentTarget.setPointerCapture === "function") {
          e.currentTarget.setPointerCapture(e.pointerId);
        }
      }
    }
    if (g.axis !== "h") {
      return;
    }
    // Right (positive dx) reveals Pin; left (negative dx) reveals Archive —
    // never toward a side with nothing to reveal.
    const raw = dx > 0 ? (pin ? dx : 0) : archive ? dx : 0;
    g.raw = raw;
    const threshold = Math.max(COMMIT_PX, e.currentTarget.getBoundingClientRect().width * COMMIT_FRACTION);
    setOffset(travel(raw, threshold));
    setArmed(raw >= threshold ? "pin" : raw <= -threshold ? "archive" : null);
  };

  const finish = (e: PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.axis !== "h") {
      return;
    }
    setDragging(false);
    setArmed(null);
    swallowClick.current = true;
    const width = e.currentTarget.getBoundingClientRect().width;
    const threshold = Math.max(COMMIT_PX, width * COMMIT_FRACTION);
    if (!cancelled && g.raw >= threshold && pin) {
      pin();
      settle();
    } else if (!cancelled && g.raw <= -threshold && archive) {
      archive();
      settle();
    } else {
      settle();
    }
  };

  return (
    <div className="relative overflow-hidden rounded-[var(--r-md)]" data-testid="chat-row-swipe">
      {pin && (
        <div aria-hidden="true" className="absolute inset-y-0 left-0 flex w-full items-center bg-[var(--accent)] pl-4 type-body text-[var(--bg)]" data-testid="chat-row-swipe-reveal-pin">
          <span className="swipe-label" data-armed={armed === "pin" ? "" : undefined}>
            {pinLabel}
          </span>
        </div>
      )}
      {archive && (
        <div aria-hidden="true" className="absolute inset-y-0 right-0 flex w-full items-center justify-end bg-[var(--surface-2)] pr-4 type-body text-[var(--muted)]" data-testid="chat-row-swipe-reveal-archive">
          <span className="swipe-label" data-armed={armed === "archive" ? "" : undefined}>
            {archiveLabel}
          </span>
        </div>
      )}
      <div
        className={`relative touch-pan-y bg-[var(--bg)] ${dragging ? "" : "swipe-settle motion-reduce:transition-none"}`}
        data-testid="chat-row-swipe-surface"
        onClickCapture={(e) => {
          if (swallowClick.current) {
            swallowClick.current = false;
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onPointerCancel={(e) => finish(e, true)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        style={{ transform: offset === 0 ? undefined : `translateX(${offset}px)` }}
      >
        {children}
      </div>
    </div>
  );
}
