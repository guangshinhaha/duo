import { useEffect, useRef, type RefObject } from "react";

/**
 * A chat opens at its end and stays there as things arrive (#183 review): the
 * newest message — and the duo's draft after it — is what the owner came to
 * see, and ⏎/E/X act on that draft, so it must never be off screen. Scrolls
 * the element's nearest scrolling ancestor (or the element itself, when it
 * scrolls) to the bottom whenever `key` changes; `enabled` false leaves the
 * scroll alone (a search result opened at an older message).
 */
export function useStickToEnd<T extends HTMLElement>(key: string, enabled = true): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!enabled || !ref.current) {
      return;
    }
    const el = ref.current;
    const scroller = el.classList.contains("overflow-y-auto") ? el : el.closest<HTMLElement>(".overflow-y-auto");
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [key, enabled]);
  return ref;
}
