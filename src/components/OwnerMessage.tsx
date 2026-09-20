import type { ReactNode } from "react";
import { useAssertNotInsideDuoMessage } from "./DuoMessage.js";

/**
 * Renders the owner's own words — a sent reply, a typed question. The only
 * component in this codebase that may carry the owner's identity
 * (`DuoMessage`'s doc comment explains why that split exists).
 */
export function OwnerMessage({ children }: { children: ReactNode }) {
  useAssertNotInsideDuoMessage("OwnerMessage");
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
