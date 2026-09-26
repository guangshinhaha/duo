import { useEffect, useRef } from "react";

/**
 * The system back gesture closes a sheet before it leaves the screen behind
 * it (#153): a phone's back is the history's back, so an open sheet takes a
 * history entry of its own and popping it closes the sheet. Closing it any
 * other way (its own close button, a tap outside, Escape) drops that entry
 * again — but only while it is still the current one: if the owner went
 * somewhere from inside the sheet, going back over it would be going the
 * wrong way.
 */
export function useBackClosesSheet(open: boolean, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) {
      return;
    }
    window.history.pushState({ duoSheet: true }, "");
    const onPop = (): void => close.current();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if ((window.history.state as { duoSheet?: boolean } | null)?.duoSheet === true) {
        window.history.back();
      }
    };
  }, [open]);
}
