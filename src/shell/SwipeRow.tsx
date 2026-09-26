import { useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ApiRequestError } from "../api/client.js";
import { IGNORE_UNDO_WINDOW_MS } from "../components/useDraftDecision.js";

/*
 * The swipe on a phone's waiting list (#153): the one-handed way to clear
 * what waits. It is a shortcut over buttons that always exist — the tray in
 * the chat has Send and Dismiss — never the only way to do a thing, so it
 * adds no capability of its own: what may be swiped is decided by
 * `swipeActionsOf`, the same rule as everywhere a draft is sent from
 * outside its chat, and a full swipe writes the same outcome the tray's
 * button does.
 */

/** How far a swipe must travel to count, so a scroll that drifts sideways or a tap that slips is not a decision. */
const COMMIT_PX = 96;
const COMMIT_FRACTION = 0.35;
/** How far a finger moves before we know whether it is scrolling or swiping. */
const LOCK_PX = 10;

type Phase = "idle" | "sending" | "sent" | "dismissed" | "failed";

/**
 * A row that decides one draft when swiped: **left sends**, **right
 * dismisses** (held for the undo window before it is written — the daemon
 * has no way to take a dismissal back once it has it). Either side is absent
 * when its action is not available for this row, and a swipe toward an
 * absent side does not move the row at all — there is nothing to reveal.
 * Vertical movement stays the page's scroll (`touch-action: pan-y`), and a
 * tap on the row is still a tap.
 */
export function SwipeRow({
  children,
  send,
  dismiss,
}: {
  children: ReactNode;
  /** Sends the draft; resolves when it is recorded. Absent: no left swipe. */
  send: (() => Promise<unknown>) | null;
  /** Records the dismissal; called only after the undo window. Absent: no right swipe. */
  dismiss: (() => Promise<unknown>) | null;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const gesture = useRef<{ x: number; y: number; axis: "h" | "v" | null } | null>(null);
  const swallowClick = useRef(false);
  // A ref, and never cleared on unmount: walking off the list inside the window is not an undo, and dropping the timer would leave the owner believing a dismissal was recorded that the daemon never received (the same law `useDraftDecision` keeps).
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fail = (cause: unknown): void => {
    setError(cause instanceof ApiRequestError || cause instanceof Error ? cause.message : "It didn’t go through.");
    setPhase("failed");
  };

  const commitSend = (): void => {
    if (!send) {
      return;
    }
    setPhase("sending");
    send().then(() => setPhase("sent"), fail);
  };

  const commitDismiss = (): void => {
    if (!dismiss) {
      return;
    }
    setPhase("dismissed");
    undoTimer.current = setTimeout(() => {
      undoTimer.current = null;
      dismiss().catch(fail);
    }, IGNORE_UNDO_WINDOW_MS);
  };

  const undo = (): void => {
    if (undoTimer.current !== null) {
      clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
    setPhase("idle");
    setOffset(0);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (phase !== "idle" || (send === null && dismiss === null) || (e.pointerType === "mouse" && e.button !== 0)) {
      return;
    }
    gesture.current = { x: e.clientX, y: e.clientY, axis: null };
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
    // Toward a side with nothing to reveal, the row does not move.
    setOffset(dx < 0 ? (send ? dx : 0) : dismiss ? dx : 0);
  };

  const finish = (e: PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.axis !== "h") {
      return;
    }
    setDragging(false);
    // The tap that ends a swipe is not a tap on the link underneath.
    swallowClick.current = true;
    const width = e.currentTarget.getBoundingClientRect().width;
    const threshold = Math.max(COMMIT_PX, width * COMMIT_FRACTION);
    if (!cancelled && offset <= -threshold && send) {
      commitSend();
    } else if (!cancelled && offset >= threshold && dismiss) {
      commitDismiss();
    } else {
      setOffset(0);
    }
  };

  if (phase !== "idle") {
    return (
      <div className="flex min-h-14 items-center justify-between gap-3 rounded-[var(--r-md)] bg-[var(--surface-2)] px-3" data-testid="swipe-status">
        {phase === "sending" && (
          <p className="type-body text-[var(--muted)]" role="status">
            Sending…
          </p>
        )}
        {phase === "sent" && (
          <p className="type-body text-[var(--muted)]" role="status">
            Sent
          </p>
        )}
        {phase === "dismissed" && (
          <>
            <p className="type-body text-[var(--muted)]" role="status">
              Dismissed
            </p>
            <button className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" data-testid="swipe-undo" onClick={undo} type="button">
              Undo
            </button>
          </>
        )}
        {phase === "failed" && (
          <>
            <p className="type-body text-[var(--refused)]" role="alert">
              {error ?? "It didn’t go through."}
            </p>
            <button
              className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
              data-testid="swipe-retry"
              onClick={() => {
                setPhase("idle");
                setOffset(0);
              }}
              type="button"
            >
              Back
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-[var(--r-md)]" data-testid="swipe-row">
      {dismiss && (
        <div aria-hidden="true" className="absolute inset-y-0 left-0 flex w-full items-center bg-[var(--surface-2)] pl-4 type-body text-[var(--muted)]" data-testid="swipe-reveal-dismiss">
          Dismiss
        </div>
      )}
      {send && (
        <div aria-hidden="true" className="absolute inset-y-0 right-0 flex w-full items-center justify-end bg-[var(--accent)] pr-4 type-body text-[var(--bg)]" data-testid="swipe-reveal-send">
          Send
        </div>
      )}
      <div
        className={`relative touch-pan-y bg-[var(--bg)] ${dragging ? "" : "transition-transform motion-reduce:transition-none"}`}
        data-testid="swipe-surface"
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
