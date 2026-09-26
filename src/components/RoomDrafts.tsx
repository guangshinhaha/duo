import type { DuoApiConfig } from "../api/client.js";
import { useDraftsFeed, usePendingDrafts } from "../api/queries.js";
import { conversationOf } from "../workspace/drafts.js";
import { DeliveryStateLine } from "./DeliveryStateLine.js";
import { DraftTray } from "./DraftTray.js";

/**
 * #68, re-shaped by the chat-first move (#142): the drafts of one
 * conversation, where the owner is reading it — the same daemon records the
 * waiting queue counts, filtered by the conversation their provenance names,
 * and decided through the very same logic: Send, Edit, Dismiss, the undo
 * window, the offline rule. Nothing is a second copy: a draft left alone here
 * is still counted in Waiting on you, and deciding it here clears it there,
 * because it is one draft with one outcome.
 *
 * This is deliberately NOT part of the transcript. The transcript is what
 * the room's members read, and a draft is the owner's alone until they
 * send it: it renders as a tray above the composer (`DraftTray`), in the
 * duo's own labelled block (AR-13), saying so. The surface posts nothing —
 * delivery into the conversation is the daemon's, through the channel seam
 * (digital-duo #170), so a sent draft arrives in the timeline as the
 * owner's own message from the homeserver, and this region's part
 * afterwards is only to say how the delivery went (#21).
 *
 * Only a paired member has drafts at all; the caller mounts this only then.
 */
export function RoomDrafts({ api, roomId }: { api: DuoApiConfig; roomId: string }) {
  const pending = usePendingDrafts(api);
  const feed = useDraftsFeed(api);

  const waiting = (pending.data ?? []).filter((draft) => conversationOf(draft.provenance)?.roomId === roomId);
  // The conversation's outcomes: what was sent from a draft here, and how
  // its delivery went. Read from the newest window of the draft log — the
  // recent past is what an owner checking on a delivery is asking about.
  const sent = (feed.data?.pages.flat() ?? []).filter(
    (draft) =>
      (draft.outcome === "sent" || draft.outcome === "edited") &&
      draft.delivery !== null &&
      conversationOf(draft.provenance)?.roomId === roomId,
  );

  // The wrapper is stable even when empty, so a decision moving a draft
  // from "waiting" to "sent" is one region changing, not one unmounting.
  return (
    <div data-testid="room-drafts">
      {(waiting.length > 0 || sent.length > 0) && (
        <section aria-label="Drafts from your duo" className="flex max-h-96 flex-col overflow-y-auto">
          {waiting.length > 0 && (
            <>
              <p className="border-t border-[var(--edge)] px-4 pt-3 type-provenance text-[var(--muted)]" data-testid="room-drafts-notice">
                Only you can see your duo’s drafts — nothing is posted until you send one.
              </p>
              {waiting.map((draft, index) => (
                <DraftTray key={draft.id} api={api} draft={draft} keyboard={index === 0} />
              ))}
            </>
          )}
          {sent.map((draft) => (
            <div key={draft.id} className="flex flex-col gap-1 border-t border-[var(--edge)] px-4 py-3" data-testid="room-draft-outcome">
              <p className="type-provenance text-[var(--muted)]">
                {draft.outcome === "edited" ? "You sent your edit of your duo’s draft." : "You sent your duo’s draft."}
              </p>
              <DeliveryStateLine delivery={draft.delivery} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
