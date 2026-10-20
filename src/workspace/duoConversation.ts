import { escalationOf, readDuoAnswer, type RoomMessageLike } from "./duoAnswer.js";
import { duoOwnerLabel, duoOwnerUserIdOf, isDuoUserId, localpartOf } from "./identity.js";
import type { DuoCardView, RoomSummary } from "./matrix.js";

/**
 * #313: a conversation with a colleague's duo, read from what the room
 * already holds — never a field the wire doesn't carry.
 *
 * A room is a duo conversation when its other parties are exactly one
 * colleague's duo, plus (once they've come in to answer something it passed
 * on, #314) that duo's own owner. Whose duo it is comes from the id grammar
 * (`@duo-wei` → Wei), never from a name the duo account could set.
 *
 * Its state: `answering` once the duo is in; `waiting` while the duo is still
 * invited — its owner hasn't let it into this conversation yet (#315); and
 * `declined` when the duo turned the invitation down, with the daemon's own
 * words for why, verbatim.
 */
export interface DuoConversation {
  readonly duoUserId: string;
  readonly ownerUserId: string;
  /** The owner's name as this room knows it, else the id grammar's label. */
  readonly ownerLabel: string;
  readonly state: "answering" | "waiting" | "declined";
  /** The duo's own words on declining — null unless declined, and null when it gave none. */
  readonly declineReason: string | null;
}

export function duoConversationOf(room: Pick<RoomSummary, "members" | "invitedMembers" | "declinedDuos" | "name">, selfId: string | null): DuoConversation | null {
  const joined = room.members;
  const invited = room.invitedMembers ?? [];
  const parties = [...joined, ...invited];
  const duos = parties.filter((member) => isDuoUserId(member.userId));
  if (duos.length === 0) {
    const declined = room.declinedDuos?.[0];
    if (declined === undefined || parties.length > 0 || room.declinedDuos!.length !== 1) {
      return null;
    }
    const ownerUserId = duoOwnerUserIdOf(declined.userId);
    if (ownerUserId === null || ownerUserId === selfId) {
      return null;
    }
    return {
      duoUserId: declined.userId,
      ownerUserId,
      ownerLabel: duoOwnerLabel(declined.userId) ?? localpartOf(declined.userId),
      state: "declined",
      declineReason: declined.reason,
    };
  }
  if (duos.length !== 1) {
    return null;
  }
  const duo = duos[0]!;
  const ownerUserId = duoOwnerUserIdOf(duo.userId);
  // Your own duo in a room is not "a colleague's duo" — and anyone else here makes it a group.
  if (ownerUserId === null || ownerUserId === selfId || !parties.every((member) => member.userId === duo.userId || member.userId === ownerUserId)) {
    return null;
  }
  const ownerMember = parties.find((member) => member.userId === ownerUserId);
  return {
    duoUserId: duo.userId,
    ownerUserId,
    ownerLabel: duo.ownerName ?? ownerMember?.name ?? duoOwnerLabel(duo.userId) ?? localpartOf(duo.userId),
    state: joined.some((member) => member.userId === duo.userId) ? "answering" : "waiting",
    declineReason: null,
  };
}

/**
 * What became of one question a colleague put to the duo (#313): still with
 * the duo, answered, passed to its owner (waiting on them, or replied), or
 * declined. Null for anything that isn't such a question.
 */
export type QuestionOutcome = "with-duo" | "answered" | "passed-on" | "replied" | "declined";

interface ConversationMessage extends RoomMessageLike {
  readonly file?: unknown;
  /**
   * W-S4-10: the card this message IS, when it's a `duo.card` the Matrix
   * seam (W-S4-7) projected — only `kind`/`state` matter here, never the
   * card's own words (`title`/`lines`/`result`), which this module has no
   * business reading: a question's outcome is read off STRUCTURE (who
   * spoke, in what order, and now a task card's own state machine), the
   * same stance the text path already takes with `readDuoAnswer`.
   */
  readonly card?: Pick<DuoCardView, "kind" | "state"> | undefined;
}

/**
 * W-S4-10: a task card's own state (`docs/workspace/cards.md` §8), read as
 * the outcome vocabulary text already reads a completed/passed-on answer —
 * `acknowledged`/`working`/`needs_decision` are all still with the owner
 * (`passed-on`; an edit later moves the SAME card to `done`, which is what
 * makes a passed-on question update live the same way a text pass-on
 * updating via `escalationOf` already does — no separate "replied" case
 * for a card: §8's `done` is "an answer that arrives after the ack", the
 * duo's own completion, not the owner personally replying in the room).
 * `failed` claims nothing either way, the same stance a reply the text path
 * can't read already takes.
 */
function cardOutcomeOf(card: Pick<DuoCardView, "kind" | "state">): QuestionOutcome | null {
  if (card.kind !== "task") {
    return null;
  }
  switch (card.state) {
    case "acknowledged":
    case "working":
    case "needs_decision":
      return "passed-on";
    case "done":
      return "answered";
    default:
      return null;
  }
}

/**
 * Pairs each of the asker's questions with the duo's reply to it, in order:
 * the daemon answers every question exactly once, oldest first, so the n-th
 * duo message after a burst of questions answers the n-th of them. A
 * passed-on reply then reads its own state from the owner speaking after it
 * (`escalationOf`), which is what updates a question live when they answer.
 *
 * W-S4-10: a duo task card answering a question reads the same way — its
 * own `card.state` (not its fallback `body`) decides the outcome, so a
 * card whose fallback body never matches `readDuoAnswer`'s composed-text
 * shape (the ack-timer's "Looking into this…", or a `done` card's result
 * text) still resolves to the outcome it is, rather than "no claim". A
 * passed-on TEXT reply's fallback body (the `acknowledged` state built
 * from a `passed_on` outcome, `docs/workspace/cards.md` §5) already equals
 * `PUBLIC_PASSED_ON_MESSAGE` byte for byte, so `readDuoAnswer` alone would
 * even get that one case right — the card check runs first regardless, so
 * every task-card state (not just that one) resolves off the state machine
 * directly, never off a string match that happens to agree with it today.
 */
export function questionOutcomes(conversation: readonly ConversationMessage[], duoUserId: string): ReadonlyMap<string, QuestionOutcome> {
  const ownerUserId = duoOwnerUserIdOf(duoUserId);
  const outcomes = new Map<string, QuestionOutcome>();
  const open: string[] = [];
  for (const message of conversation) {
    if (message.redacted || message.pending === true) {
      continue;
    }
    if (message.senderId === duoUserId) {
      const question = open.shift();
      if (question === undefined) {
        continue;
      }
      const cardOutcome = message.card !== undefined ? cardOutcomeOf(message.card) : null;
      if (cardOutcome !== null) {
        outcomes.set(question, cardOutcome);
        continue;
      }
      const reading = readDuoAnswer(message.body);
      if (reading === null) {
        // A reply the client can't read as an outcome (a failure notice): no claim either way.
        outcomes.delete(question);
        continue;
      }
      outcomes.set(
        question,
        reading.kind === "answered" ? "answered" : reading.kind === "refused" ? "declined" : escalationOf(message, conversation) === "followed-up" ? "replied" : "passed-on",
      );
      continue;
    }
    if (message.senderId === ownerUserId || isDuoUserId(message.senderId) || message.file !== undefined || message.body.trim() === "") {
      continue;
    }
    open.push(message.eventId);
    outcomes.set(message.eventId, "with-duo");
  }
  return outcomes;
}

/** The words a question's outcome reads in — the daemon names "declined" for the asker's side (vocabulary.md). */
export function questionOutcomeWords(outcome: QuestionOutcome, ownerLabel: string): string {
  switch (outcome) {
    case "with-duo":
      return `With ${ownerLabel}'s duo`;
    case "answered":
      return `Answered by ${ownerLabel}'s duo`;
    case "passed-on":
      return `Passed to ${ownerLabel} — waiting on them`;
    case "replied":
      return `Passed to ${ownerLabel} — ${ownerLabel} replied`;
    case "declined":
      return "Declined";
  }
}
