import { useState } from "react";
import { RoomDuoMessage } from "../components/RoomDuoMessage.js";
import { RoomPersonMessage } from "../components/RoomPersonMessage.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { SaveToLaterDialog } from "../components/SaveToLaterDialog.js";
import { Timestamp } from "../components/Timestamp.js";
import { activeLaterItems, markLaterDone, snoozeLaterItem, useLaterItems } from "../shell/later.js";
import { duoOwnerLabel, isDuoUserId } from "../workspace/identity.js";
import { roomHref } from "../workspace/links.js";
import { useHeldRooms } from "../shell/waiting.js";
import { roomTitle } from "../shell/roomTitle.js";
import type { LaterItem, RoomSummary, WorkspaceConnection } from "../workspace/matrix.js";

/**
 * duo#299: "Later" — a saved message, or the owner's own unsent words,
 * each with an optional reminder. Read from this account's own data
 * (`duo.later.items`, `shell/later.ts`), the same account-data door
 * `Mentions.tsx`'s own list of `@mentions` is a sibling of, not a stand-in
 * for: a mention is the homeserver's own fact ("someone addressed you");
 * Later is the owner's own choice to keep something, with nothing about it
 * that a homeserver has any reason to know.
 *
 * "Due" (a reminder whose time has passed and hasn't fired) sorts first,
 * then the rest by reminder time, then the undated saves in the order they
 * were made — `activeLaterItems`'s own order. Marking one done never
 * deletes it: it stays in the account's record, simply filtered out here,
 * the same stance Dismiss and a resolved rule already take elsewhere.
 */

function laterHref(item: LaterItem): string {
  return item.eventId !== null ? roomHref(item.roomId, item.eventId) : roomHref(item.roomId);
}

function dueNow(item: LaterItem, now: Date): boolean {
  return item.remindAt !== null && item.remindAt <= now.toISOString();
}

function LaterRow({
  item,
  rooms,
  onDone,
  onSnooze,
}: {
  item: LaterItem;
  rooms: readonly RoomSummary[];
  onDone: (id: string) => void;
  onSnooze: (id: string, remindAt: string | null) => void;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const room = rooms.find((candidate) => candidate.roomId === item.roomId);
  const title = room ? roomTitle(room) : item.roomId;
  const due = dueNow(item, new Date());

  return (
    <li>
      <article className="shape-entry flex flex-col gap-2 p-4" data-due={due} data-testid="later-item">
        <div className="flex items-center justify-between gap-2">
          <p className="type-provenance text-[var(--muted)]" data-testid="later-room">
            {title}
          </p>
          <div className="flex items-center gap-3">
            {item.remindAt !== null && (
              <span className={`type-provenance ${due ? "text-[var(--escalate)]" : "text-[var(--muted)]"}`} data-testid="later-remind-at">
                {due ? "Due" : "Reminds"} <Timestamp iso={item.remindAt} />
              </span>
            )}
            <Timestamp iso={item.createdAt} />
          </div>
        </div>
        {item.kind === "note" ? (
          <p className="type-body text-[var(--text)]" data-testid="later-note">
            <span className="type-provenance text-[var(--muted)]">Your note — </span>
            {item.preview}
          </p>
        ) : isDuoUserId(item.senderId ?? "") ? (
          <RoomDuoMessage ownerName={duoOwnerLabel(item.senderId ?? "") ?? item.senderName ?? "a duo"}>{item.preview}</RoomDuoMessage>
        ) : (
          <RoomPersonMessage authorName={item.senderName ?? "Someone"}>{item.preview}</RoomPersonMessage>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <a
            aria-label={`Open in ${title}`}
            className="inline-flex min-h-8 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-provenance text-[var(--muted)]"
            data-testid="later-open"
            href={laterHref(item)}
          >
            Open
          </a>
          <button
            className="inline-flex min-h-8 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-provenance text-[var(--muted)]"
            data-testid="later-snooze"
            onClick={() => setSnoozeOpen(true)}
            type="button"
          >
            Snooze
          </button>
          <button
            className="inline-flex min-h-8 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-provenance text-[var(--muted)]"
            data-testid="later-done"
            onClick={() => onDone(item.id)}
            type="button"
          >
            Done
          </button>
        </div>
      </article>
      <SaveToLaterDialog
        onOpenChange={setSnoozeOpen}
        onSave={async (remindAt) => {
          onSnooze(item.id, remindAt);
        }}
        open={snoozeOpen}
        preview={item.preview}
      />
    </li>
  );
}

export function Later({ connection }: { connection: WorkspaceConnection | null }) {
  const rooms = useHeldRooms(connection);
  const later = useLaterItems(connection);
  const items = activeLaterItems(later.items);

  if (!connection || later.isLoading) {
    return (
      <div className="p-6">
        <h1 className="type-heading">Later</h1>
        <RouteLoading slowNote="Reading what you've saved…" variant="rows" />
      </div>
    );
  }

  return (
    <div className="p-6" data-testid="later-page">
      <h1 className="type-heading">Later</h1>
      <p className="type-provenance text-[var(--faint)]">
        What you saved to come back to — a message, or words you weren&apos;t ready to send. Due reminders lead.
      </p>
      {items.length === 0 ? (
        <p className="mt-4 type-body text-[var(--muted)]" data-testid="later-empty">
          Nothing saved. Save a message from its own menu, or words from the composer, and it lands here.
        </p>
      ) : (
        <ol className="mt-4 flex flex-col gap-3" data-testid="later-list">
          {items.map((item) => (
            <LaterRow
              item={item}
              key={item.id}
              onDone={(id) => later.update(markLaterDone(later.items, id))}
              onSnooze={(id, remindAt) => later.update(snoozeLaterItem(later.items, id, remindAt))}
              rooms={rooms}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
