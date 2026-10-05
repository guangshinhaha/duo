import { useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

/**
 * #252: a long hold on a touch surface — the gesture a phone's message
 * actions open from, in place of the permanent row. Read from pointer
 * events, the same model this app's other gesture (SwipeRow's drag) already
 * reads, so touch, pen and mouse are one code path rather than three. Only
 * a touch pointer counts: a long mouse click is a different thing (a
 * context menu's own, native, already-handled gesture), never this one.
 *
 * A hold that drifts past a scroll's own slop before the timer fires is a
 * scroll carrying the finger across the row, not a press on it, and never
 * fires. A hold that lets go before the timer fires is a tap, and does
 * nothing — the whole point of #252 AC "not on a quick tap". The native
 * click a touchend still dispatches after a press that DID fire is
 * swallowed (`onClickCapture`), so whatever sits under the finger — a link,
 * a reaction pill — doesn't also run from the same touch.
 */
const LONG_PRESS_MS = 500;
const MOVE_CANCEL_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
  onClickCapture: (e: ReactMouseEvent) => void;
}

export function useLongPress(onLongPress: () => void, enabled = true): LongPressHandlers {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  };

  return {
    onPointerDown: (e) => {
      if (!enabled || e.pointerType !== "touch") {
        return;
      }
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e) => {
      const start = origin.current;
      if (!start || timer.current === null) {
        return;
      }
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_CANCEL_PX) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e) => {
      if (fired.current) {
        fired.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}
