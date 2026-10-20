import type { ComponentType } from "react";
import type { DuoCardView } from "../../workspace/matrix.js";
import { TaskCard } from "./TaskCard.js";

/**
 * W-S4-8: `kind → component`, the one place a `DuoCardView`'s `kind` picks
 * what renders — never a chain of `if (card.kind === …)` at the call site,
 * which is how a kind gets forgotten. Phase 1 registers only `task`
 * (W-S4-7's own card); `decision` and `result` land with their own stories
 * (S5, S6), and `confirm` is never registered here at all — it is
 * owner-only for ever (`docs/workspace/cards.md` §2) and never reaches
 * this registry's caller (`RoomEntry` in `Room.tsx`), which only ever
 * holds a `DuoCardView` the Matrix seam itself refused to build for a
 * reserved or unrecognized kind in the first place.
 *
 * An unregistered kind renders `null`: the caller (`Room.tsx`) falls back
 * to the message's own plain text the same way it already does for a card
 * this client couldn't parse at all (W-S4-7's `v`/`kind` fallback) — one
 * rule for "nothing to draw a card with" rather than two.
 */
export const CARD_REGISTRY: Readonly<Partial<Record<DuoCardView["kind"], ComponentType<{ card: DuoCardView }>>>> = {
  task: TaskCard,
};

/** The component this card's `kind` renders with, or null when nothing is registered for it yet. */
export function cardComponentFor(kind: DuoCardView["kind"]): ComponentType<{ card: DuoCardView }> | null {
  return CARD_REGISTRY[kind] ?? null;
}
