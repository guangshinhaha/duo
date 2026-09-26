import type { DraftPipelineResult } from "../api/types.js";
import { HEDGE_MARGIN } from "../workspace/duoAnswer.js";

/**
 * The 2px hairline on a draft's leading edge (`client-tech-design.md` Part
 * 4) — a vertical rule in the gutter beside the entry, full entry height,
 * so a column of drafts can be scanned by state. Never a percentage —
 * `confidenceScore` is a weighted composite against a configurable
 * threshold, not a calibrated probability, so rendering "62%" would be
 * precision the number doesn't have. Four states, derived from the real
 * fields on `DraftPipelineResult` rather than a separately-maintained
 * mapping. Renders as `self-stretch` inside its parent's `flex-row`: the
 * parent owns the leading-edge placement, this owns the 2px width and the
 * colour.
 */
export function ConfidenceHairline({ result }: { result: DraftPipelineResult }) {
  const state = hairlineState(result);
  const style =
    state === "hedged"
      ? { backgroundColor: "var(--escalate)", opacity: 0.4 }
      : { backgroundColor: `var(--${colorToken(state)})` };
  return <div data-testid="confidence-hairline" data-state={state} className="w-0.5 shrink-0 self-stretch rounded-full" style={style} />;
}

export type HairlineState = "refused" | "escalated" | "hedged" | "confident";

function colorToken(state: HairlineState): string {
  switch (state) {
    case "refused":
      return "refused";
    case "escalated":
      return "escalate";
    case "confident":
      return "confident";
    case "hedged":
      return "escalate";
  }
}

export function hairlineState(result: DraftPipelineResult): HairlineState {
  if (result.kind === "escalation") {
    return result.refused ? "refused" : "escalated";
  }
  const { score, threshold } = result.confidence;
  // The margin is one value with the asker's reading of a duo's answer (#67):
  // an answer reads the same to its owner and to the colleague who asked.
  if (score < threshold + HEDGE_MARGIN) {
    return "hedged";
  }
  return "confident";
}
