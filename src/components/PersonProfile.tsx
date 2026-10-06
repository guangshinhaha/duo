import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DuoApiConfig } from "../api/client.js";
import { useResetVoiceAdaptation, useVoiceAdaptation } from "../api/queries.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import { Mark } from "./Mark.js";
import { directoryEntryLabel, duoUserIdFor, isDuoUserId, serverNameOf } from "../workspace/identity.js";
import type { WorkspaceConnection } from "../workspace/matrix.js";

/** Two letters from a name, for a person's avatar fallback — a duo never gets this (docs/design-language.md §3.1: it gets the mark, always). */
function initialsOf(name: string): string {
  const words = name.split(/[\s,]+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join("") || "?"
  );
}

/**
 * #207's profile panel: chosen from the one search box (or the pencil
 * dialog's directory), a person or a colleague's duo reads here by what the
 * id grammar and the homeserver's own record say about them — name, handle,
 * org (the homeserver this account is on; #235's org wall is exactly that
 * boundary) — with a way to message them. A duo never renders with initials
 * or a photo (the mark, always, same as everywhere else in the product);
 * "Ask {name}'s duo" only offers for a person who has one to ask, derived
 * from the id grammar (`duoUserIdFor`), never for a duo profile itself.
 *
 * The directory entry that opened this (`name`, from wherever the member
 * found them) renders at once; `getProfile` refines it with the
 * homeserver's own record once it answers, the same "claim now, fact when
 * it lands" the rest of the surface follows for a name.
 */
export function PersonProfile({
  api = null,
  connection,
  person,
  open,
  onOpenChange,
  onMessage,
}: {
  /** #262: lets this panel read and reset the person's learned-tone adaptation. Null (no duo paired) hides that section entirely rather than erroring. */
  api?: DuoApiConfig | null;
  connection: WorkspaceConnection;
  /** Who to show — the directory entry that led here. Null while nothing is selected; the dialog then renders nothing. */
  person: { readonly userId: string; readonly name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The direct conversation with this person is open (started, or reused) — the caller navigates to it. */
  onMessage: (roomId: string) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent data-testid="person-profile">
        {person && <PersonProfileBody api={api} connection={connection} onMessage={onMessage} person={person} />}
      </DialogContent>
    </Dialog>
  );
}

/**
 * #262: "Reset learned tone" — the daemon has been quietly deriving how the
 * owner writes to THIS person from their own approved sends and edits
 * (digital-duo #279); this clears that derived adaptation on request,
 * never the messages it was learned from. Renders nothing while loading,
 * nor when the daemon has nothing at all to say yet (`sampleSize === 0`
 * and not `active`) — a section with zero signal would only be noise on
 * every other profile opened. Below the threshold but with some sends
 * already counted, a lighter progress line shows instead of the reset
 * flow: there's nothing learned yet to reset, only something to look
 * forward to. The confirm step is a single inline question, not a
 * T4-style dialog: this undoes accumulated learning, never anything
 * already sent.
 */
function VoiceAdaptationControl({ api, personId, personName }: { api: DuoApiConfig; personId: string; personName: string }) {
  const status = useVoiceAdaptation(api, personId);
  const reset = useResetVoiceAdaptation(api);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  if (!status.data) {
    return null;
  }

  const { active, features, sampleSize, threshold } = status.data;
  if (!active && sampleSize === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--edge)] pt-3" data-testid="person-profile-voice-adaptation">
      <p className="type-provenance text-[var(--muted)]">
        {active && features ? (
          <>Your duo has learned a {features.register} tone for writing to {personName}.</>
        ) : (
          <>
            Your duo is still learning how you write to {personName} — {sampleSize} of {threshold} sends so far.
          </>
        )}
      </p>
      {active &&
        features &&
        (done ? (
          <p className="type-body text-[var(--muted)]" data-testid="person-profile-reset-tone-done">
            Reset. Your duo will learn again from what you send next.
          </p>
        ) : confirming ? (
          <div className="flex flex-col gap-2" data-testid="person-profile-reset-tone-confirm">
            <p className="type-body text-[var(--muted)]">
              This clears what your duo has learned about how you write to {personName} — it won&apos;t touch anything you&apos;ve already sent.
            </p>
            <div className="flex gap-2">
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--text)] disabled:opacity-40"
                data-testid="person-profile-reset-tone-confirm-yes"
                disabled={reset.isPending}
                onClick={() => reset.mutate(personId, { onSuccess: () => setDone(true) })}
                type="button"
              >
                {reset.isPending ? "Resetting…" : "Reset"}
              </button>
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] px-3 type-body text-[var(--muted)]"
                data-testid="person-profile-reset-tone-cancel"
                onClick={() => setConfirming(false)}
                type="button"
              >
                Cancel
              </button>
            </div>
            {reset.isError && (
              <p className="type-body text-[var(--refused)]" data-testid="person-profile-reset-tone-error">
                Couldn&apos;t reset that — try again.
              </p>
            )}
          </div>
        ) : (
          <button
            className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--text)]"
            data-testid="person-profile-reset-tone"
            onClick={() => setConfirming(true)}
            type="button"
          >
            Reset learned tone
          </button>
        ))}
    </div>
  );
}

function PersonProfileBody({
  api,
  connection,
  person,
  onMessage,
}: {
  api: DuoApiConfig | null;
  connection: WorkspaceConnection;
  person: { readonly userId: string; readonly name: string };
  onMessage: (roomId: string) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profile = useQuery({
    queryKey: ["workspace", "profile", person.userId],
    queryFn: () => connection.getProfile(person.userId),
    meta: { target: "workspace" },
  });

  const duo = isDuoUserId(person.userId);
  const label = directoryEntryLabel({ userId: person.userId, name: profile.data?.name ?? person.name });
  const org = serverNameOf(person.userId) || null;

  const message = (userId: string): void => {
    if (starting) {
      return;
    }
    setStarting(true);
    setError(null);
    connection
      .startDirect(userId)
      .then((roomId) => onMessage(roomId))
      .catch(() => setError("Couldn't start the conversation — try again."))
      .finally(() => setStarting(false));
  };

  // A duo's own profile has no duo of its own to ask — the owner's duo IS
  // the entity on screen. For a person, offer it only when the grammar can
  // derive one (every `@local:server` id can).
  const theirDuoId = duo ? null : duoUserIdFor(person.userId);

  return (
    <>
      <DialogDescription className="sr-only">{person.userId}</DialogDescription>
      <div className="flex items-center gap-3">
        {duo ? (
          <span
            aria-hidden="true"
            className="inline-flex size-12 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)]"
          >
            <Mark />
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="inline-flex size-12 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)] type-identifier text-[var(--muted)]"
            data-testid="person-profile-avatar"
          >
            {initialsOf(label)}
          </span>
        )}
        <div className="flex min-w-0 flex-col">
          <DialogTitle asChild>
            <p className="truncate type-heading" data-testid="person-profile-name">
              {label}
            </p>
          </DialogTitle>
          <p className="truncate type-provenance text-[var(--muted)]" data-testid="person-profile-handle">
            {person.userId}
          </p>
          {org && (
            <p className="truncate type-provenance text-[var(--faint)]" data-testid="person-profile-org">
              {org}
            </p>
          )}
        </div>
      </div>
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="person-profile-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
          data-testid="person-profile-message"
          disabled={starting}
          onClick={() => message(person.userId)}
          type="button"
        >
          {starting ? "Opening…" : "Message"}
        </button>
        {theirDuoId && (
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--text)] disabled:opacity-40"
            data-testid="person-profile-ask-duo"
            disabled={starting}
            onClick={() => message(theirDuoId)}
            type="button"
          >
            Ask {label}&apos;s duo
          </button>
        )}
      </div>
      {/* #262: a person's own learned-tone adaptation — never a duo's (there's no "writing to" a duo in this sense), and nothing to read without a paired duo to ask. */}
      {!duo && api && <VoiceAdaptationControl api={api} personId={person.userId} personName={label} />}
      <DialogClose asChild>
        <button className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body">
          Close
        </button>
      </DialogClose>
    </>
  );
}
