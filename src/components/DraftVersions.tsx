import { useRef, type PointerEvent } from "react";
import type { DraftShape, ShapeInstruction } from "../api/types.js";
import { SHAPE_INSTRUCTIONS } from "../api/types.js";

/*
 * The two ways a draft has more than one version (digital-duo drafting):
 * the alternatives a hedged draft comes with (#257), paged "1 of 3", and
 * the shapes the owner gives it with one tap (#258), with Undo one tap
 * away. Both only change which words are on the card — deciding the draft
 * is still the tray's Send / Edit / Dismiss.
 */

/** How far a finger travels across the card before it counts as a flip, so a slipped tap or a drifting scroll is not one. */
const FLIP_PX = 48;
/** How far a finger moves before we know whether it is scrolling or flipping. */
const LOCK_PX = 10;

/**
 * Horizontal swipe inside the card body flips to the next or previous
 * alternative (#257) — touch and pen only; a mouse drag over text is a
 * selection, and the desktop has ←/→. It is a different axis-owner from
 * the waiting list's row swipe (`SwipeRow`, which sends or dismisses):
 * once this gesture has claimed a finger, nothing above it sees that
 * finger at all, so a flip can never also be a send. A vertical drag is
 * left alone — it is the page's scroll.
 */
export function useFlipSwipe(enabled: boolean, flip: (direction: 1 | -1) => void) {
  const gesture = useRef<{ x: number; y: number; axis: "h" | "v" | null } | null>(null);
  if (!enabled) {
    return {};
  }
  return {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "mouse") {
        return;
      }
      // Claimed from the first touch: an ancestor that starts tracking on
      // pointerdown (the row swipe) must never see this finger begin.
      e.stopPropagation();
      gesture.current = { x: e.clientX, y: e.clientY, axis: null };
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      if (!g) {
        return;
      }
      e.stopPropagation();
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (g.axis === null && (Math.abs(dx) >= LOCK_PX || Math.abs(dy) >= LOCK_PX)) {
        g.axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
        if (g.axis === "h" && typeof e.currentTarget.setPointerCapture === "function") {
          e.currentTarget.setPointerCapture(e.pointerId);
        }
      }
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      gesture.current = null;
      if (!g) {
        return;
      }
      e.stopPropagation();
      const dx = e.clientX - g.x;
      if (g.axis === "h" && Math.abs(dx) >= FLIP_PX) {
        // Like turning a page: swiping left brings the next one in.
        flip(dx < 0 ? 1 : -1);
      }
    },
    onPointerCancel: (e: PointerEvent<HTMLDivElement>) => {
      if (gesture.current) {
        e.stopPropagation();
      }
      gesture.current = null;
    },
  };
}

/** What an alternative was asked to be, in the vocabulary's words — the default is just the duo's draft. */
function alternativeWords(instruction: string | null): string {
  switch (instruction) {
    case null:
      return "your duo’s draft";
    case "shorter":
      return "shorter";
    case "cautious":
      return "more careful";
    default:
      return instruction;
  }
}

/** "1 of 3 · shorter", with ‹ › to page — the visible half of #257; ←/→ and the swipe are its other two hands. */
export function AlternativeStepper({
  index,
  count,
  instruction,
  flip,
  disabled,
}: {
  index: number;
  count: number;
  instruction: string | null;
  flip: (direction: 1 | -1) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-1 type-provenance text-[var(--muted)]" data-testid="draft-alternatives">
      <button
        aria-label="Previous alternative"
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-sm)] disabled:opacity-40"
        disabled={disabled || index === 0}
        onClick={() => flip(-1)}
        type="button"
      >
        ‹
      </button>
      <span aria-live="polite" data-testid="alternative-position">
        {index + 1} of {count} · {alternativeWords(instruction)}
      </span>
      <button
        aria-label="Next alternative"
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-sm)] disabled:opacity-40"
        disabled={disabled || index === count - 1}
        onClick={() => flip(1)}
        type="button"
      >
        ›
      </button>
    </div>
  );
}

const CHIP_LABELS: Record<ShapeInstruction, string> = {
  shorter: "Shorter",
  warmer: "Warmer",
  more_formal: "More formal",
  more_direct: "More direct",
};

/** The latest shape still standing on one candidate — what Undo takes back — or undefined when there is none. */
export function standingShape(shapes: readonly DraftShape[] | undefined, alternative: number): DraftShape | undefined {
  return (shapes ?? []).filter((shape) => shape.alternative === alternative && shape.undoneAt === null).at(-1);
}

/**
 * Shorter · Warmer · More formal · More direct (#258), under the draft:
 * one tap asks the duo to rewrite it that way, over the same sources, and
 * the new words swap in; Undo puts the previous words back. On a phone the
 * row scrolls sideways rather than wrapping — and that sideways drag is the
 * row's own, never mistaken for a swipe of anything around it.
 */
export function ShapeChips({
  shaping,
  pendingInstruction,
  undoable,
  undoing,
  disabled,
  onShape,
  onUndo,
}: {
  shaping: boolean;
  pendingInstruction: ShapeInstruction | undefined;
  undoable: DraftShape | undefined;
  undoing: boolean;
  disabled: boolean;
  onShape: (instruction: ShapeInstruction) => void;
  onUndo: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div
        aria-label="Shape this draft"
        className="-mx-1 flex flex-nowrap gap-2 overflow-x-auto px-1 md:flex-wrap md:overflow-visible"
        data-testid="shape-chips"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        role="group"
      >
        {SHAPE_INSTRUCTIONS.map((instruction) => (
          <button
            aria-busy={shaping && pendingInstruction === instruction ? true : undefined}
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border border-[var(--edge)] px-3 type-provenance text-[var(--text)] disabled:opacity-40"
            data-testid={`shape-chip-${instruction}`}
            disabled={disabled || shaping || undoing}
            key={instruction}
            onClick={() => onShape(instruction)}
            type="button"
          >
            {CHIP_LABELS[instruction]}
          </button>
        ))}
        {undoable && (
          <button
            aria-label={`Undo ${CHIP_LABELS[undoable.instruction].toLowerCase()} — back to the previous version`}
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full px-3 type-provenance text-[var(--muted)] underline disabled:opacity-40"
            data-testid="shape-undo"
            disabled={disabled || shaping || undoing}
            onClick={onUndo}
            type="button"
          >
            Undo
          </button>
        )}
      </div>
      {shaping && pendingInstruction && (
        <p className="type-provenance text-[var(--muted)]" data-testid="shape-pending" role="status">
          Making it {CHIP_LABELS[pendingInstruction].toLowerCase()}…
        </p>
      )}
    </div>
  );
}
