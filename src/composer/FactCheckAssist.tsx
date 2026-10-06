import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import type { ChatEditorHandle } from "./ChatEditor.js";

/** #264's own "debounce a second or so" — long enough that a fast typist never fires a check per keystroke, short enough that a pause in typing still gets checked before Send. */
const FACT_CHECK_DEBOUNCE_MS = 1000;

/**
 * #264: "your duo quietly checks your own reply for a wrong fact before
 * you send" — mounted alongside a `ChatEditor` (never inside it; it drives
 * the editor purely through `ChatEditorHandle`, the same arm's-length
 * relationship `RewriteMenu.tsx` has). Two independent jobs:
 *
 * 1. Debounces `text` (the composer's own body, already tracked by its
 *    host via `onTextChange` — this doesn't re-derive a change signal of
 *    its own) and, only when `enabled`, calls `onCheck`. A flag lands as
 *    an underline via `applyFactCheck`; its absence clears any mark that
 *    was there. Off by default (the issue's own acceptance criteria) —
 *    `enabled` is this component's only gate, set by a Settings toggle
 *    one level up.
 * 2. Shows the flag's source on hover, focus or tap — plain event
 *    delegation on the editor's own root element (`getRootElement`),
 *    reading the attributes `FactCheckNode.ts`'s `decorate()` already put
 *    on the DOM, rather than this component needing to know Lexical's
 *    node structure at all.
 *
 * Never blocks Send: this never touches `onSubmit`, disables nothing, and
 * a failed or slow check just means no flag shows — the composer works
 * exactly as it would with the feature off.
 */
export function FactCheckAssist({
  editorRef,
  text,
  enabled,
  onCheck,
}: {
  editorRef: RefObject<ChatEditorHandle | null>;
  /** The composer's current body. */
  text: string;
  enabled: boolean;
  onCheck: (text: string) => Promise<{ claim: string; concern: string; sourceLabel: string } | null>;
}) {
  const [card, setCard] = useState<{ concern: string; sourceLabel: string; rect: DOMRect } | null>(null);
  const requestId = useRef(0);
  const lastChecked = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      editorRef.current?.applyFactCheck(null);
      lastChecked.current = null;
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      editorRef.current?.applyFactCheck(null);
      lastChecked.current = "";
      return;
    }
    if (trimmed === lastChecked.current) {
      return;
    }
    const id = ++requestId.current;
    const timer = window.setTimeout(() => {
      onCheck(trimmed).then(
        (flag) => {
          if (id !== requestId.current) {
            return; // a later keystroke's check has already superseded this one
          }
          lastChecked.current = trimmed;
          editorRef.current?.applyFactCheck(flag);
        },
        () => {
          // Never surfaces an error of its own, and never blocks anything
          // — a failed check reads exactly like "nothing to flag".
          if (id === requestId.current) {
            lastChecked.current = trimmed;
          }
        },
      );
    }, FACT_CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, text, onCheck, editorRef]);

  useEffect(() => {
    const root = editorRef.current?.getRootElement();
    if (!root || !enabled) {
      return;
    }
    const show = (event: Event) => {
      const target = (event.target as HTMLElement | null)?.closest('[data-testid="fact-check-flag"]');
      if (!target) {
        return;
      }
      setCard({
        concern: target.getAttribute("data-fact-check-concern") ?? "",
        sourceLabel: target.getAttribute("data-fact-check-source") ?? "",
        rect: target.getBoundingClientRect(),
      });
    };
    const hide = (event: Event) => {
      const related = (event as FocusEvent | MouseEvent).relatedTarget as Node | null;
      if (related && root.contains(related)) {
        return;
      }
      setCard(null);
    };
    root.addEventListener("mouseover", show);
    root.addEventListener("mouseout", hide);
    root.addEventListener("focusin", show);
    root.addEventListener("focusout", hide);
    // Tap, on a device with no hover at all — #264's "Phone: a small
    // marker above the composer; tap for the source" simplified to the
    // same card, shown on the span itself rather than a separate marker.
    root.addEventListener("click", show);
    return () => {
      root.removeEventListener("mouseover", show);
      root.removeEventListener("mouseout", hide);
      root.removeEventListener("focusin", show);
      root.removeEventListener("focusout", hide);
      root.removeEventListener("click", show);
    };
  }, [editorRef, enabled]);

  if (!enabled || !card) {
    return null;
  }

  return createPortal(
    <div
      className="fixed z-20 max-w-xs rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] p-2 type-provenance text-[var(--text)] shadow-lg"
      data-testid="fact-check-card"
      role="tooltip"
      style={{ left: card.rect.left, top: card.rect.bottom + 4 }}
    >
      <p>{card.concern}</p>
      <p className="mt-1 text-[var(--muted)]">{card.sourceLabel}</p>
    </div>,
    document.body,
  );
}
