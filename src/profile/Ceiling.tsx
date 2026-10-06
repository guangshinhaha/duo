import { CLASSIFICATION_LEVELS, type ClassificationLevel } from "../api/types.js";

/** The GSCS tiers as people say them. */
export const CLASSIFICATION_WORDS: Readonly<Record<ClassificationLevel, string>> = {
  official_open: "Official (Open)",
  official_closed: "Official (Closed)",
  restricted: "Restricted",
  confidential: "Confidential",
  secret: "Secret",
};

/**
 * #269 AC4 ("the classification ceiling blocks sources above it from any
 * answer"): already true end to end, enforced by the daemon at ingest and
 * again at answer time (digital-duo's `permissions/classification.ts`,
 * `drafting/context.ts`) — material above the ceiling is excluded from
 * drafting, not merely hidden in the UI. There is deliberately no picker
 * here: digital-duo#48's own acceptance criteria make the ceiling "set by
 * configuration under policy control, not by the owner in the UI," the same
 * way `duo import`'s own `discardedAboveCeiling` count (see
 * `routes/Onboarding.tsx`) is reported, never chosen, from this client. This
 * section says what the limit is and that it isn't yours to move, rather
 * than offering a control the daemon has no route for and policy forbids.
 */
export function CeilingSection() {
  return (
    <section className="shape-container flex flex-col gap-2 p-4" data-testid="ceiling">
      <h2 className="type-heading">Classification ceiling</h2>
      <p className="type-provenance text-[var(--muted)]" data-testid="ceiling-explainer">
        Your duo only answers from material your organisation has cleared it to use — anywhere from {CLASSIFICATION_WORDS[CLASSIFICATION_LEVELS[0]]} up to{" "}
        {CLASSIFICATION_WORDS[CLASSIFICATION_LEVELS[CLASSIFICATION_LEVELS.length - 1]]}. This ceiling is set by policy, not by you — your duo can&apos;t
        loosen it from here. A question that can only be answered from material above it is passed to you instead, with that reason.
      </p>
    </section>
  );
}
