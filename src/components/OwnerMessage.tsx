import type { ReactNode } from "react";
import { useAssertNotInsideDuoMessage } from "./DuoMessage.js";

/**
 * Renders the owner's own words — a sent reply, a typed question. The only
 * component in this codebase that may carry the owner's identity
 * (`DuoMessage`'s doc comment explains why that split exists).
 */
export function OwnerMessage({ children, bubble = false }: { children: ReactNode; bubble?: boolean }) {
  useAssertNotInsideDuoMessage("OwnerMessage");
  if (bubble) {
    // In a chat the owner's side is a bubble at the trailing edge — the way a
    // message you sent reads anywhere — with the "You" carried for assistive
    // technology rather than printed on every line. Still the owner's
    // identity, so it is still this component and still barred from the duo's.
    return (
      <div
        className="ml-auto max-w-[80%] rounded-[var(--r-lg)] rounded-br-[var(--r-sm)] bg-[var(--surface-2)] px-4 py-2 type-body text-[var(--text)]"
        data-testid="owner-message"
      >
        <span className="sr-only">You: </span>
        {children}
      </div>
    );
  }
  return (
    // #33: the owner's words stand unboxed — of the two voices, only the
    // duo's arrives in a container (§1.6: duo output is structurally
    // distinct, "a different container, not a badge on the same one"), so
    // the box itself is the label, and the owner's question reads as the
    // thing being answered rather than another card in the pile.
    <div data-testid="owner-message" className="type-body text-[var(--text)]">
      <div className="mb-1 type-provenance text-[var(--muted)]">You</div>
      <div>{children}</div>
    </div>
  );
}
