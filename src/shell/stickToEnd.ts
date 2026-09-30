import { useEffect, useRef, type RefObject } from "react";

/**
 * A chat opens at its end and stays there as things arrive (#183 review): the
 * newest message — and the duo's draft after it — is what the owner came to
 * see, and ⏎/E/X act on that draft, so it must never be off screen. Scrolls
 * the element's nearest scrolling ancestor (or the element itself, when it
 * scrolls) to the bottom whenever `key` changes; `enabled` false leaves the
 * scroll alone (a search result opened at an older message). The first
 * scroll is instant; later ones are smooth (docs/motion-plan.md B7).
 */
export function useStickToEnd<T extends HTMLElement>(key: string, enabled = true): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const opened = useRef(false);
  useEffect(() => {
    if (!enabled || !ref.current) {
      return;
    }
    const el = ref.current;
    const scroller = el.classList.contains("overflow-y-auto") ? el : el.closest<HTMLElement>(".overflow-y-auto");
    if (scroller) {
      // Opening lands at the end at once; what arrives afterwards glides
      // there, unless the owner asked for less motion.
      const glide =
        opened.current && typeof scroller.scrollTo === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (glide) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
      } else {
        scroller.scrollTop = scroller.scrollHeight;
      }
      opened.current = true;
    }
  }, [key, enabled]);
  return ref;
}
