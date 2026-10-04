import { RoomDuoMessage } from "../components/RoomDuoMessage.js";
import { RoomPersonMessage } from "../components/RoomPersonMessage.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { Timestamp } from "../components/Timestamp.js";
import { duoOwnerLabel, isDuoUserId } from "../workspace/identity.js";
import { roomHref, threadHref } from "../workspace/links.js";
import type { MentionHit, RoomSummary, WorkspaceConnection } from "../workspace/matrix.js";
import { useMentions } from "../shell/mentions.js";
import { roomTitle } from "../shell/roomTitle.js";
import { useHeldRooms } from "../shell/waiting.js";

/**
 * #222: one place for every mention across conversations. This is the raw
 * `@mentions` of the member — the homeserver's own highlight notifications
 * — never the duo's drafts: "Waiting on you" (shell/waiting.ts) is a
 * different list, for a different question ("what does my duo need me to
 * decide"), and the two are kept apart on purpose (see `MentionHit`'s own
 * doc in workspace/matrix.ts). Opening a row lands at that exact message in
 * its conversation, in context (#70's `at` address — the same mechanism a
 * search hit uses); a thread's mention opens its thread with the mention
 * marked.
 *
 * A row's "Dismiss" is local to this device: the homeserver tracks whether
 * a receipt has passed the event (`read`, shown as a visual cue only), but
 * has no verb for "stop showing me this one" at an arbitrary past event —
 * so clearing a row is this view's own, client-side bookkeeping.
 */

function MentionRow({
  hit,
  rooms,
  onDismiss,
}: {
  hit: MentionHit;
  rooms: readonly RoomSummary[];
  onDismiss: (eventId: string) => void;
}) {
  const room = rooms.find((candidate) => candidate.roomId === hit.roomId);
  const title = room ? roomTitle(room) : hit.roomId;
  const href = hit.threadRootEventId !== null ? threadHref(hit.roomId, hit.threadRootEventId, hit.eventId) : roomHref(hit.roomId, hit.eventId);

  return (
    <li>
      <article className="shape-entry flex flex-col gap-2 p-4" data-read={hit.read} data-testid="mention-item">
        <div className="flex items-center justify-between gap-2">
          <p className="type-provenance text-[var(--muted)]" data-testid="mention-room">
            {title}
          </p>
          <div className="flex items-center gap-3">
            <Timestamp iso={new Date(hit.originServerTs).toISOString()} />
            <button
              className="inline-flex min-h-8 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-provenance text-[var(--muted)]"
              data-testid="mention-dismiss"
              onClick={() => onDismiss(hit.eventId)}
              type="button"
            >
              Dismiss
            </button>
          </div>
        </div>
        {isDuoUserId(hit.senderId) ? (
          <RoomDuoMessage ownerName={duoOwnerLabel(hit.senderId) ?? hit.senderName}>{hit.body}</RoomDuoMessage>
        ) : (
          <RoomPersonMessage authorName={hit.senderName}>{hit.body}</RoomPersonMessage>
        )}
        <a
          aria-label={`Open this mention in ${title}`}
          className="self-start type-provenance text-[var(--muted)] underline"
          data-testid="mention-open"
          href={href}
        >
          Open in conversation
        </a>
      </article>
    </li>
  );
}

export function Mentions({ connection }: { connection: WorkspaceConnection | null }) {
  const rooms = useHeldRooms(connection);
  const mentions = useMentions(connection);

  if (!connection || mentions.isLoading) {
    return (
      <div className="p-6">
        <h1 className="type-heading">Mentions</h1>
        <RouteLoading slowNote="Reading mentions from the workspace…" variant="rows" />
      </div>
    );
  }
  if (mentions.error) {
    return (
      <div className="p-6">
        <h1 className="type-heading">Mentions</h1>
        <p className="type-body text-[var(--escalate)]" data-testid="mentions-error">
          The workspace didn&apos;t answer — try again.
        </p>
        <button
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
          data-testid="mentions-retry"
          onClick={mentions.refetch}
          type="button"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="p-6" data-testid="mentions-page">
      <h1 className="type-heading">Mentions</h1>
      <p className="type-provenance text-[var(--faint)]">Everywhere you were mentioned, across your conversations — newest first.</p>
      {mentions.items.length === 0 ? (
        <p className="mt-4 type-body text-[var(--muted)]" data-testid="mentions-empty">
          Nobody has mentioned you yet.
        </p>
      ) : (
        <ol className="mt-4 flex flex-col gap-3" data-testid="mentions-list">
          {mentions.items.map((hit) => (
            <MentionRow hit={hit} key={`${hit.roomId}/${hit.eventId}`} onDismiss={mentions.dismiss} rooms={rooms} />
          ))}
        </ol>
      )}
    </div>
  );
}
