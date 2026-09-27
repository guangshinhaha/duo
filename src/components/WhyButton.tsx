import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { DraftRecord } from "../api/types.js";
import { WhyPanel } from "../shell/Inspector.js";
import { useBackClosesSheet } from "../shell/sheetHistory.js";
import { DESKTOP_QUERY, useMediaQuery } from "../shell/useMediaQuery.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";

/**
 * Why? beside a draft (#185): the why opens only when asked — a small
 * popover next to the draft on a desktop, a bottom sheet on a phone (where
 * the back gesture closes it first). Escape or a click elsewhere closes the
 * popover and hands focus back to the button. The popover is placed against
 * the window, not the transcript it sits in, so a scroll area never clips it:
 * above the button when there is more room there, below otherwise, and kept
 * inside the window's edges.
 */
const POPOVER_WIDTH = 320;
const GAP = 8;

function placeBeside(button: HTMLElement): CSSProperties {
  const rect = button.getBoundingClientRect();
  const width = Math.min(POPOVER_WIDTH, window.innerWidth - GAP * 2);
  const left = Math.min(Math.max(rect.right - width, GAP), window.innerWidth - width - GAP);
  const above = rect.top;
  const below = window.innerHeight - rect.bottom;
  return above >= below
    ? { position: "fixed", left, width, bottom: window.innerHeight - rect.top + GAP, maxHeight: above - GAP * 2 }
    : { position: "fixed", left, width, top: rect.bottom + GAP, maxHeight: below - GAP * 2 };
}
export function WhyButton({ draft }: { draft: DraftRecord }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const button = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  useBackClosesSheet(open && !desktop, () => setOpen(false));

  useEffect(() => {
    if (!open || !desktop) {
      return;
    }
    panel.current?.focus();
    const close = (): void => {
      setOpen(false);
      button.current?.focus();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (target && !panel.current?.contains(target) && !button.current?.contains(target)) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, desktop]);

  return (
    <span className="inline-flex">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex min-h-11 items-center px-1 type-provenance text-[var(--muted)] underline"
        data-testid="tray-why"
        onClick={() => {
          if (!open && desktop && button.current) {
            setPlace(placeBeside(button.current));
          }
          setOpen(!open);
        }}
        ref={button}
        type="button"
      >
        Why?
      </button>
      {desktop && open && (
        <div
          aria-label="Why your duo wrote this"
          className="z-30 overflow-y-auto shape-container p-4 shadow-lg"
          data-testid="why-popover"
          ref={panel}
          role="dialog"
          style={place}
          tabIndex={-1}
        >
          <WhyPanel draft={draft} />
        </div>
      )}
      {!desktop && (
        <Dialog onOpenChange={setOpen} open={open}>
          <DialogContent className="top-auto! bottom-0 max-h-[85dvh] overflow-y-auto" data-testid="why-sheet">
            <DialogTitle className="sr-only">Why your duo wrote this</DialogTitle>
            <DialogDescription className="sr-only">How sure your duo is, the standing order and sources it used, and who asked.</DialogDescription>
            <WhyPanel draft={draft} />
            <DialogClose className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" data-testid="why-close">
              Close
            </DialogClose>
          </DialogContent>
        </Dialog>
      )}
    </span>
  );
}
