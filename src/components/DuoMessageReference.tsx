import type { ReactNode } from "react";
import { DuoLine } from "./DuoLine.js";

/**
 * A reference to a duo's message from another context (#60): a quote block,
 * a reply header, a notification, a search hit. One component for all of
 * them, because a label that survives only in the main timeline is not a
 * label — wherever a duo's text is shown, the attribution travels with it,
 * in the same possessive form as `RoomDuoMessage` ("Ana's duo").
 *
 * It renders through the same `DuoLine` (and so sets the same boundary) as
 * the timeline rendering, so a person-identity component can no more hide
 * inside a quote of a duo's message than inside the message itself.
 */
export function DuoMessageReference({ ownerName, children }: { ownerName: string; children: ReactNode }) {
  return (
    <DuoLine
      label={`${ownerName}'s duo`}
      testId="duo-message-reference"
      attributionTestId="duo-message-reference-attribution"
      compact
    >
      {children}
    </DuoLine>
  );
}
