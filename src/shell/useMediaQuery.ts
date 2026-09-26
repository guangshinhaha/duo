import { useEffect, useState } from "react";

/**
 * Whether a CSS media query currently matches, live. The shell uses it to
 * decide *what is mounted* (a phone shows the chat list or a chat, one at a
 * time; a desktop shows both), which CSS alone can't do without keeping both
 * in the tree. Where `matchMedia` doesn't exist (a bare test DOM) the answer
 * is `false` — the narrow layout — so a surface rendered on its own is the
 * only thing in the tree.
 */
export function useMediaQuery(query: string): boolean {
  const read = (): boolean => (typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** Tailwind's `md` breakpoint: the width at which the list and the chat sit side by side. */
export const DESKTOP_QUERY = "(min-width: 768px)";
