import { EyeOff } from "lucide-react";
import type { DuoApiConfig } from "../api/client.js";
import { useClearRoomOffTheRecord, useMarkRoomOffTheRecord, useRoomOffTheRecord } from "../api/queries.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger } from "./primitives/AlertDialog.js";
import { MutationError } from "./MutationError.js";

/**
 * duo#274: "don't learn from this conversation." The room header's own
 * slot — `Room.tsx` sits on the share path and may never import
 * `src/api/*` (`test/WorkspaceMatrixSeam.test.ts`'s structural pin), so
 * this component owns the daemon calls itself, the same way `RoomDrafts`
 * does, and App.tsx mounts it as a plain slot keyed by the open room.
 *
 * Marking is a two-step act (docs/design-language.md P5: irreversible acts
 * take two steps with Cancel focused) because the daemon purges what it
 * already learned from the room in the same call — that purge cannot be
 * undone. Lifting the marker is NOT behind a confirm: it only stops future
 * exclusion, nothing is restored by it either way, so there is nothing
 * destructive to guard against (the same reasoning a rule's "Set aside" or
 * a correction's reject needs none).
 *
 * Renders nothing until the read settles — a quiet absence, not a flicker
 * (docs/design-language.md: skeletons only past 150ms, and this is a
 * header control nobody should see jump).
 */
export function OffTheRecordControl({ api, roomId }: { api: DuoApiConfig; roomId: string }) {
  const status = useRoomOffTheRecord(api, roomId);
  const mark = useMarkRoomOffTheRecord(api);
  const clear = useClearRoomOffTheRecord(api);

  if (status.data === undefined) {
    return null;
  }

  if (status.data.offTheRecord) {
    return (
      <span className="flex items-center gap-2" data-testid="off-the-record-marker">
        <span className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--edge)] px-2 py-1 type-provenance text-[var(--muted)]">
          <EyeOff aria-hidden="true" size={13} />
          Off the record — your duo doesn't learn from this
        </span>
        <button
          className="min-h-9 type-provenance text-[var(--muted)] underline disabled:opacity-40"
          data-testid="off-the-record-clear"
          disabled={clear.isPending}
          onClick={() => clear.mutate({ roomId })}
          type="button"
        >
          {clear.isPending ? "Resuming…" : "Resume learning"}
        </button>
        <MutationError error={clear.error} />
      </span>
    );
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger
        aria-label="Mark this conversation off the record…"
        className="inline-flex min-h-9 items-center gap-1 type-provenance text-[var(--muted)] underline"
        data-testid="off-the-record-trigger"
      >
        <EyeOff aria-hidden="true" size={13} />
        Off the record…
      </AlertDialogTrigger>
      <AlertDialogContent className="w-[calc(100vw-3rem)] max-w-md" data-testid="off-the-record-confirmation">
        <AlertDialogTitle className="type-heading">Mark this conversation off the record?</AlertDialogTitle>
        <AlertDialogDescription className="type-provenance text-[var(--muted)]">
          Your duo stops learning from anything said here from now on, and this clears out what it already learned from this conversation so far — any rule
          candidate still waiting on your review, and any rule already written from an edit here. The conversation itself is unaffected, and you can turn
          this back on later, but what's cleared here can't be brought back.
        </AlertDialogDescription>
        <MutationError error={mark.error} />
        <div className="flex gap-2">
          <AlertDialogAction
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--refused)] px-3 text-white"
            data-testid="off-the-record-confirm"
            onClick={() => mark.mutate({ roomId })}
          >
            Mark off the record
          </AlertDialogAction>
          <AlertDialogCancel
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
            data-testid="off-the-record-cancel"
          >
            Cancel
          </AlertDialogCancel>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
