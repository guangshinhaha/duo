import type { ReactNode } from "react";
import type { HairlineState } from "./ConfidenceHairline.js";
import { DuoAuthoredBoundary } from "./duoBoundary.js";
import { Mark } from "./Mark.js";

/**
 * A duo-authored block's line colour. The four confidence states are the
 * draft hairline's; `signal` is reserved for a card that needs the owner's
 * decision (Hairline: Signal means action available and nothing else);
 * `neutral` is a duo answer with no confidence reading (a notice, a
 * digest, a colleague's answer whose reading is worded beneath it).
 */
export type DuoLineState = HairlineState | "signal" | "neutral";

function lineColour(state: DuoLineState): { colour: string; opacity: number } {
  switch (state) {
    case "confident":
      return { colour: "var(--confident)", opacity: 1 };
    case "hedged":
      return { colour: "var(--escalate)", opacity: 0.4 };
    case "escalated":
      return { colour: "var(--escalate)", opacity: 1 };
    case "refused":
      return { colour: "var(--refused)", opacity: 1 };
    case "signal":
      return { colour: "var(--accent)", opacity: 1 };
    case "neutral":
      return { colour: "var(--faint)", opacity: 1 };
  }
}

/**
 * Every piece of duo-generated text renders through this — the Hairline
 * form of the AR-13 labelling contract (docs/design-language.md P1: "the
 * duo always writes behind a line"). It carries the attribution line (the
 * mark, whose duo it is, and what it is doing) above a block with the
 * duo's square-edged shape and a leading line in the block's state colour.
 *
 * There is no `avatar`, `initials` or owner-name prop: nothing to pass, so
 * a duo block posing as a person is impossible to build with it. It is also
 * the only component that sets `DuoAuthoredBoundary` (a source-scan test in
 * `DuoLine.test.tsx` pins that), so "renders duo text" and "renders through
 * DuoLine" are one fact.
 *
 * `label` is the possessive attribution ("Your duo", "Ana's duo" — the
 * three phrasings vocabulary.md pins). `meta` is the state and time after
 * it ("draft · 2m"). Test ids are per call site so each existing surface
 * keeps the ids its tests already pin.
 */
export function DuoLine({
  label,
  meta,
  state = "neutral",
  testId,
  attributionTestId,
  compact = false,
  children,
}: {
  label: string;
  meta?: string;
  state?: DuoLineState;
  testId: string;
  attributionTestId: string;
  compact?: boolean;
  children: ReactNode;
}) {
  const { colour, opacity } = lineColour(state);
  return (
    <div data-testid={testId} data-duo-line={state}>
      <div className="mb-1 flex items-center gap-2 type-provenance text-[var(--muted)]" data-testid={attributionTestId}>
        <Mark />
        <span>{label}</span>
        {meta ? <span className="text-[var(--faint)]">{meta}</span> : null}
      </div>
      <div
        className={`shape-duo-line ${compact ? "py-2 pl-4 pr-3" : "py-3 pl-4 pr-4"} type-body text-[var(--text)]`}
        style={{ ["--duo-line" as string]: colour, ["--duo-line-opacity" as string]: opacity }}
      >
        <DuoAuthoredBoundary>{children}</DuoAuthoredBoundary>
      </div>
    </div>
  );
}
