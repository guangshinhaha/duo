import type { DuoApiConfig } from "../api/client.js";
import { useDraftsFeed, usePendingDrafts } from "../api/queries.js";
import { conversationOf } from "../workspace/drafts.js";
import { DeliveryStateLine } from "./DeliveryStateLine.js";
import { Collapse, useLeaving } from "./Collapse.js";
import { DraftTray } from "./DraftTray.js";
import { Mark } from "./Mark.js";
import { useStickToEnd } from "../shell/stickToEnd.js";
import { useHeldRooms } from "../shell/waiting.js";
import type { WorkspaceConnection } from "../workspace/matrix.js";
import { EscalationCard, isColleagueEscalation } from "./EscalationCard.js";

/**
 * #68, re-shaped by the chat-first move (#142): the drafts of one
 * conversation, where the owner is reading it — the same daemon records the
 * waiting queue counts, filtered by the conversation their provenance names,
 * and decided through the very same logic: Send, Edit, Dismiss, the undo
 * window, the offline rule. Nothing is a second copy: a draft left alone here
 * is still counted in Waiting on you, and deciding it here clears it there,
 * because it is one draft with one outcome.
 *
 * It sits at the end of the owner's own view of the transcript (#183) and is
 * never part of what the room's members read: a draft is the owner's alone
 * until they send it, so it renders unsent (`DraftTray`), in the duo's own
 * labelled block (AR-13), saying so. The surface posts nothing —
 * delivery into the conversation is the daemon's, through the channel seam
 * (digital-duo #170), so a sent draft arrives in the timeline as the
 * owner's own message from the homeserver, and this region's part
 * afterwards is only to say how the delivery went (#21).
 *
 * Only a paired member has drafts at all; the caller mounts this only then.
 */
/** How long "Delivered." stays at the end of a conversation after the send it confirms. */
const DELIVERED_NEWS_MS = 5 * 60_000;

export function RoomDrafts({
  api,
  roomId,
  connection = null,
  drafting = false,
}: {
  api: DuoApiConfig;
  roomId: string;
  connection?: WorkspaceConnection | null;
  /**
   * #285: "your duo is drafting" — App.tsx's own read of the daemon's
   * `draft-drafting` push for this room (see its own doc comment for why
   * it lives there). Shown only while there's nothing already waiting:
   * once a draft (or an escalation) exists, that IS the answer to "is it
   * drafting", rendered as it always was.
   */
  drafting?: boolean;
}) {
  const pending = usePendingDrafts(api);
  const rooms = useHeldRooms(connection);
  const feed = useDraftsFeed(api);

  const waitingNow = (pending.data ?? []).filter((draft) => conversationOf(draft.provenance)?.roomId === roomId);
  // A decided draft folds away instead of vanishing, as its outcome appears below it (motion-plan B1).
  const waiting = useLeaving(waitingNow, (draft) => draft.id);
  // The shortcuts belong to the first draft that is staying, not one still folding away above it.
  const firstLive = waiting.findIndex((row) => !row.leaving);
  // The conversation's outcomes: what was sent from a draft here, and how
  // its delivery went. Read from the newest window of the draft log — the
  // recent past is what an owner checking on a delivery is asking about.
  // Only while there is news (#183 review): a delivered reply is already in
  // the transcript as the owner's own message, so an old "Delivered." at the
  // end would read as newer than it is. In flight or failed always shows;
  // delivered shows just after the send, as its confirmation.
  const now = Date.now();
  const sent = (feed.data?.pages.flat() ?? []).filter(
    (draft) =>
      (draft.outcome === "sent" || draft.outcome === "edited") &&
      draft.delivery !== null &&
      (draft.delivery.state !== "delivered" || now - Date.parse(draft.outcomeRecordedAt ?? "") < DELIVERED_NEWS_MS) &&
      conversationOf(draft.provenance)?.roomId === roomId,
  );
  // A draft arriving brings the chat to its end, so the draft ⏎/E/X act on is on screen.
  const end = useStickToEnd<HTMLDivElement>(waitingNow.map((draft) => draft.id).join(","));

  // The wrapper is stable even when empty, so a decision moving a draft
  // from "waiting" to "sent" is one region changing, not one unmounting.
  return (
    <div data-testid="room-drafts" ref={end}>
      {/* #285: never implies the duo IS the owner — it's attributed exactly like any other duo activity, with the duo's own working mark, never a typing dot borrowed from a person. */}
      {drafting && waiting.length === 0 && (
        <p className="mt-5 flex items-center gap-2 type-provenance text-[var(--muted)] motion-rise" data-testid="room-drafting-indicator">
          <Mark working /> Your duo is drafting…
        </p>
      )}
      {(waiting.length > 0 || sent.length > 0) && (
        <section aria-label="Drafts from your duo" className="mt-5 flex flex-col gap-4">
          {sent.map((draft) => (
            <div key={draft.id} className="flex flex-col items-end gap-1 self-end motion-rise" data-testid="room-draft-outcome">
              <p className="type-provenance text-[var(--muted)]">
                {draft.outcome === "edited" ? "You sent your edit of your duo’s draft." : "You sent your duo’s draft."}
              </p>
              <DeliveryStateLine delivery={draft.delivery} />
            </div>
          ))}
          {waiting.map(({ item: draft, leaving }, index) => (
            <Collapse key={draft.id} leaving={leaving}>
              {/* #314: a colleague's question your duo passed to you is answered as
                  yourself, in this conversation — the duo can't post your words. */}
              {isColleagueEscalation(draft) ? (
                <EscalationCard api={api} connection={connection} draft={draft} rooms={rooms} />
              ) : (
                <DraftTray api={api} draft={draft} keyboard={index === firstLive} />
              )}
            </Collapse>
          ))}
        </section>
      )}
    </div>
  );
}
