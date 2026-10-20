import { CheckCircle2, Circle, CircleDot, XCircle } from "lucide-react";
import type { DuoCardView } from "../../workspace/matrix.js";
import { CardFrame, StateChip } from "./CardFrame.js";

/**
 * W-S4-8: a task state's fixed label, in the words `docs/workspace/cards.md`
 * §8's state machine names — `acknowledged → working → needs_decision →
 * working → done | failed`. The one source every task-state surface reads
 * from (the card chip here and the owner's task line in `RoomDrafts.tsx`),
 * so the room and the card can never disagree about what a state is called.
 */
export function taskStateLabel(state: string): string {
  switch (state) {
    case "acknowledged":
      return "Acknowledged";
    case "working":
      return "Working on it";
    case "needs_decision":
      return "Needs a decision";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    default:
      // The Matrix seam (W-S4-7) already refuses to build a `DuoCardView`
      // for a `state` it can't parse as a string at all, but a future
      // state this client doesn't know the words for yet still needs an
      // honest label rather than nothing: the wire's own word, as sent.
      return state;
  }
}

/**
 * W-S4-8: a task card's state, tone and icon together. Text labels, never
 * colour alone (accessibility): the icon beside each is decorative
 * (`aria-hidden`), and the chip's own words carry the fact.
 */
function taskChipOf(state: string): { label: string; tone: "neutral" | "progress" | "signal" | "done" | "failed"; icon: typeof Circle } {
  const label = taskStateLabel(state);
  switch (state) {
    case "working":
      return { label, tone: "progress", icon: CircleDot };
    case "needs_decision":
      return { label, tone: "signal", icon: CircleDot };
    case "done":
      return { label, tone: "done", icon: CheckCircle2 };
    case "failed":
      return { label, tone: "failed", icon: XCircle };
    default:
      return { label, tone: "neutral", icon: Circle };
  }
}

/**
 * W-S4-8: the task chip — ack, milestones, done/failed
 * (`docs/workspace/cards.md` §2/§8, PRD S4/S5). Up to 3 lines (the
 * daemon's own fixed or worded copy, §5/§8) and up to 3 milestones (§8's
 * own cap); this card never trims either — a card over either limit is the
 * daemon's own builder's bug to have refused before sending
 * (`test/workspace-cards.test.ts`, DD-side), not this render's to silently
 * mask.
 *
 * Renders with no avatar and no author name of its own: it is drawn inside
 * `RoomDuoMessage`'s attributed block (AR-13), which supplies both.
 */
export function TaskCard({ card }: { card: DuoCardView }) {
  const chip = taskChipOf(card.state);
  const Icon = chip.icon;
  return (
    <CardFrame
      chip={
        <span className="flex items-center gap-1">
          <Icon aria-hidden="true" className="size-3.5" />
          <StateChip label={chip.label} tone={chip.tone} />
        </span>
      }
      lines={card.lines}
      title={card.title}
    >
      {card.milestones.length > 0 && (
        <ol className="flex flex-col gap-1 border-t border-[var(--edge)] pt-2 type-provenance text-[var(--muted)]" data-testid="duo-card-milestones">
          {card.milestones.map((milestone, index) => (
            <li key={index} data-testid="duo-card-milestone">
              {milestone.label}
            </li>
          ))}
        </ol>
      )}
      {card.result !== null && (
        <div className="flex flex-col gap-1 border-t border-[var(--edge)] pt-2 type-body" data-testid="duo-card-result">
          <p>{card.result.text}</p>
          {card.result.links.map((link, index) => (
            <a key={index} className="underline" href={link.url} rel="noreferrer" target="_blank">
              {link.label}
            </a>
          ))}
        </div>
      )}
    </CardFrame>
  );
}
