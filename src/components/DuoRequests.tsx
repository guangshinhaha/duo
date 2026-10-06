import { useEffect, useRef, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useDecideDuoRequest, useDuoRequests } from "../api/queries.js";
import type { DuoRequest } from "../api/types.js";
import { notifyDuoRequest } from "../notifications.js";
import { useSyncStatus } from "../sync.js";
import { isDuoUserId, localpartOf } from "../workspace/identity.js";

/** Who is asking, by the id grammar — never a display name the inviter chose. */
export function requesterLabel(request: Pick<DuoRequest, "inviterId">): string | null {
  return request.inviterId === null ? null : localpartOf(request.inviterId);
}

/**
 * #315: "a colleague's first message to your duo waits for your OK." The
 * requests your daemon is holding (digital-duo #192 — a duo joins a
 * conversation only on its owner's allow), each with what the colleague
 * asked when their client carried it, and the three decisions: Allow (the
 * duo answers in that conversation), Allow and always allow this person
 * (their later one-to-one conversations skip this), and Decline (the
 * colleague is told, politely, in the daemon's words). Disabled, never
 * queued, while the daemon can't be reached (AR-15).
 */
export function DuoRequests({ api }: { api: DuoApiConfig }) {
  const requests = useDuoRequests(api);
  const decide = useDecideDuoRequest(api);
  const { reachable } = useSyncStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = requests.data ?? [];
  if (rows.length === 0) {
    return null;
  }
  const act = (request: DuoRequest, decision: "allow" | "always" | "decline"): void => {
    setBusy(request.roomId);
    setError(null);
    decide.mutate(
      { roomId: request.roomId, decision },
      {
        onError: (failure) => setError(failure instanceof Error ? failure.message : "That didn't go through — try again."),
        onSettled: () => setBusy(null),
      },
    );
  };
  return (
    <section aria-label="Requests to talk to your duo" className="flex flex-col gap-2 px-2 pb-2" data-testid="duo-requests">
      <p className="px-1 type-provenance uppercase text-[var(--muted)]">Requests</p>
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="duo-request-error" role="alert">
          {error}
        </p>
      )}
      {rows.map((request) => {
        const who = requesterLabel(request) ?? "A colleague";
        const disabled = !reachable || busy !== null;
        const oneToOne = request.direct === true && request.inviterId !== null && !isDuoUserId(request.inviterId);
        return (
          <div className="shape-entry flex flex-col gap-2 px-3 py-2" data-testid="duo-request" key={request.roomId}>
            <p className="type-body text-[var(--text)]" data-testid="duo-request-title">
              {oneToOne ? `${who} wants to ask your duo` : `${who} invited your duo to ${request.name ?? "a conversation"}`}
            </p>
            {request.reason ? (
              <blockquote className="border-l-2 border-[var(--edge)] pl-2 type-body text-[var(--muted)] whitespace-pre-line" data-testid="duo-request-preview">
                {request.reason}
              </blockquote>
            ) : (
              <p className="type-provenance text-[var(--faint)]" data-testid="duo-request-no-preview">
                {oneToOne ? "They haven't said anything yet." : `${request.joinedMemberCount} ${request.joinedMemberCount === 1 ? "person" : "people"} in it so far.`}
              </p>
            )}
            <p className="type-provenance text-[var(--faint)]">Your duo doesn&apos;t answer there until you allow it.</p>
            <div className="flex flex-wrap gap-2">
              <button
                className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
                data-testid="duo-request-allow"
                disabled={disabled}
                type="button"
                onClick={() => act(request, "allow")}
              >
                {busy === request.roomId ? "Working…" : "Allow"}
              </button>
              {oneToOne && (
                <button
                  className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] border border-[var(--accent)] px-3 type-body text-[var(--accent)] disabled:opacity-40"
                  data-testid="duo-request-always"
                  disabled={disabled}
                  type="button"
                  onClick={() => act(request, "always")}
                >
                  Allow and always allow {who}
                </button>
              )}
              <button
                className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--muted)] disabled:opacity-40"
                data-testid="duo-request-decline"
                disabled={disabled}
                type="button"
                onClick={() => act(request, "decline")}
              >
                Decline
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * #315: a new request reaches the owner while the app is open — a
 * notification per request not yet told about this run, the way
 * ConfirmationWatcher tells about a staged action. Only a list read from
 * the daemon in this run counts (a rehydrated one may be stale). Renders
 * nothing, and decides nothing: a notification is a way to be told.
 */
export function DuoRequestWatcher({ api }: { api: DuoApiConfig }) {
  const { data, isFetchedAfterMount, isError } = useDuoRequests(api);
  const told = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!data || !isFetchedAfterMount || isError) {
      return;
    }
    const ids = new Set(data.map((request) => request.roomId));
    const fresh = data.filter((request) => !told.current.has(request.roomId));
    told.current = new Set([...told.current].filter((id) => ids.has(id)));
    for (const request of fresh) {
      told.current.add(request.roomId);
      void notifyDuoRequest(requesterLabel(request));
    }
  }, [data, isFetchedAfterMount, isError]);
  return null;
}
