import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import { plainPreview } from "../workspace/duoAnswer.js";
import { mentionLabelOf } from "../workspace/mentions.js";
import type { RoomMessage } from "../workspace/matrix.js";

/**
 * #292: one pinned event, as this device can say it — resolved against
 * whatever conversation window is in hand (the room's own timeline for
 * `PinnedBar`, nothing at all for `Inspector`'s standing list), never a
 * network fetch of its own: a pin the member hasn't scrolled to yet simply
 * reads as "Pinned message" rather than guessing its words.
 */
function pinnedLabelOf(eventId: string, conversation: readonly RoomMessage[]): string {
  const message = conversation.find((candidate) => candidate.eventId === eventId);
  if (!message) {
    return "Pinned message";
  }
  return `${mentionLabelOf(message.senderId, message.senderName)}: ${plainPreview(message.body)}`;
}

/**
 * #292: the pinned list itself — shared by the conversation's own bar
 * (below) and the room's Info panel (`Inspector.tsx`'s `RoomInfo`, where
 * there's no loaded timeline to read snippets from), so "what's pinned
 * here" reads the same wherever it's asked. Unpin shows only for whoever
 * the room's own power levels let (`RoomSummary.canEdit.pins`, #223's
 * convention) — the control simply isn't there for anyone else, rather
 * than inviting a predictable refusal.
 */
export function PinnedMessagesList({
  pinnedEventIds,
  conversation = [],
  canUnpin,
  onJump,
  onUnpin,
}: {
  pinnedEventIds: readonly string[];
  conversation?: readonly RoomMessage[];
  canUnpin: boolean;
  onJump: (eventId: string) => void;
  onUnpin: (eventId: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-2" data-testid="pinned-messages-list">
      {pinnedEventIds.map((eventId) => (
        <li className="flex items-center justify-between gap-2 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-2" key={eventId}>
          <button
            className="min-w-0 flex-1 truncate text-left type-body text-[var(--text)]"
            data-testid="pinned-message-jump"
            onClick={() => onJump(eventId)}
            type="button"
          >
            {pinnedLabelOf(eventId, conversation)}
          </button>
          {canUnpin && (
            <button
              className="shrink-0 underline type-provenance text-[var(--muted)]"
              data-testid="pinned-message-unpin"
              onClick={() => onUnpin(eventId)}
              type="button"
            >
              Unpin
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * #292: the bar at the top of a conversation that has pinned anything — how
 * many, and the latest one's words, collapsed until asked; a tap opens the
 * full list (above) in a dialog, where Jump brings one into view and Unpin
 * (gated the same way) takes it back. Renders nothing for a room that's
 * pinned nothing — the caller doesn't need its own guard for that.
 */
export function PinnedBar({
  pinnedEventIds,
  conversation,
  canUnpin,
  onJump,
  onUnpin,
}: {
  pinnedEventIds: readonly string[];
  conversation: readonly RoomMessage[];
  canUnpin: boolean;
  onJump: (eventId: string) => void;
  onUnpin: (eventId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (pinnedEventIds.length === 0) {
    return null;
  }
  const latestEventId = pinnedEventIds[pinnedEventIds.length - 1]!;
  return (
    <div className="border-b border-[var(--edge)] bg-[var(--surface-2)] px-4 py-2">
      <button
        className="flex min-h-9 w-full items-center gap-2 type-provenance text-[var(--muted)]"
        data-testid="pinned-bar"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span aria-hidden="true">📌</span>
        <span className="min-w-0 truncate">
          {pinnedEventIds.length === 1 ? "1 pinned message" : `${pinnedEventIds.length} pinned messages`} —{" "}
          {pinnedLabelOf(latestEventId, conversation)}
        </span>
      </button>
      <Dialog onOpenChange={setOpen} open={open}>
        {open && (
          <DialogContent data-testid="pinned-messages-dialog">
            <DialogTitle>Pinned messages</DialogTitle>
            <DialogDescription>Pinned to this conversation — visible to everyone here.</DialogDescription>
            <PinnedMessagesList
              canUnpin={canUnpin}
              conversation={conversation}
              onJump={(eventId) => {
                setOpen(false);
                onJump(eventId);
              }}
              onUnpin={onUnpin}
              pinnedEventIds={pinnedEventIds}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
