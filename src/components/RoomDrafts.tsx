import type { DuoApiConfig } from "../api/client.js";
import { useDraftsFeed, usePendingDrafts } from "../api/queries.js";
import { conversationOf } from "../workspace/drafts.js";
import { DeliveryStateLine } from "./DeliveryStateLine.js";
import { DraftCard } from "./DraftCard.js";

/**
 * #68: the drafts of one conversation, where the owner is reading it —
 * the same daemon records Review shows, filtered by the conversation their
 * provenance names, and decided through the very same card: Send, Edit,
 * Ignore, the undo window, the offline rule. Nothing is a second copy:
 * Review stays the durable home (AR-14) — a draft left alone here is still
 * in its queue with its count — and deciding it here clears it there,
 * because it is one draft with one outcome.
 *
 * This is deliberately NOT part of the transcript. The transcript is what
 * the room's members read, and a draft is the owner's alone until they
 * send it: it renders in its own region, in the duo's own labelled
 * container (AR-13), beside a sentence saying so. The surface posts
 * nothing — delivery into the conversation is the daemon's, through the
 * channel seam (digital-duo #170), so a sent draft arrives in the timeline
 * as the owner's own message from the homeserver, and this region's part
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
        <section aria-label="Drafts from your duo" className="flex max-h-80 flex-col gap-3 overflow-y-auto border-t border-[var(--edge)] p-4">
          {waiting.length > 0 && (
            <>
              <p className="type-provenance text-[var(--muted)]" data-testid="room-drafts-notice">
                Waiting on you. Only you can see your duo’s drafts — nothing is posted until you send one, and left alone they stay in Review.
              </p>
              {waiting.map((draft) => (
                <DraftCard key={draft.id} api={api} draft={draft} />
              ))}
            </>
          )}
          {sent.map((draft) => (
            <div key={draft.id} className="flex flex-col gap-1" data-testid="room-draft-outcome">
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
