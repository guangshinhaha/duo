import type { ReactNode } from "react";
import { DuoLine } from "./DuoLine.js";

// The runtime AR-13 boundary lives in duoBoundary.tsx (so DuoLine can set it
// without a cycle); these re-exports keep every existing import working.
export { DuoAuthoredBoundary, useAssertNotInsideDuoMessage } from "./duoBoundary.js";

/**
 * Renders duo-generated text. `concept.md`: "always labelled … it never
 * poses as you." `client-tech-design.md` §3.4 promotes that from a
 * guideline to a structural rule: this component has no `avatar` prop —
 * there is nothing to pass — so a Slack-shaped chat bubble that puts the
 * owner's own avatar on generated text is impossible to build with it, not
 * merely discouraged.
 *
 * `OwnerMessage` (or any person-identity component) must never render
 * inside this component's children, anywhere in the codebase — enforced
 * two ways: statically by `eslint.config.js`'s lint rule for the direct
 * case, and at runtime by the boundary `DuoLine` sets (duoBoundary.tsx) for
 * every case, including through a wrapper component the lint rule can't see
 * through. In a shared room the same contract is carried by
 * `RoomDuoMessage` / `DuoMessageReference` (#60), which render through the
 * same `DuoLine`.
 *
 * Hairline (#140): the duo's voice is the only voice behind a line, so the
 * line is the label — the container is `DuoLine`'s, not a tinted box.
 */
export function DuoMessage({ children }: { children: ReactNode }) {
  return (
    <DuoLine label="Your duo" testId="duo-message" attributionTestId="duo-message-attribution">
      {children}
    </DuoLine>
  );
}
