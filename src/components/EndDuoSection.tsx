import { useEffect, useId, useState } from "react";
import { ApiRequestError, type DuoApiConfig } from "../api/client.js";
import { useDescribeEnd, useEndDuo, EndNotConfirmedError } from "../api/lifecycle.js";
import type { EndDuoResult } from "../api/types.js";
import type { WorkspaceSession } from "../workspace/matrix.js";
import { useSyncStatus } from "../sync.js";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./primitives/AlertDialog.js";

/** The phrase the owner types. Not a hard-to-type secret — a deliberate act: nothing here can be confirmed by a stray click, a tap-through, or the Enter key. */
const CONFIRMATION_PHRASE = "END";

/** Who the daemon's record names as having decided it, when no one is signed in to the workspace — the route requires a non-empty name, and a device has none of its own to offer. */
const UNNAMED_DECIDER = "the owner, from a paired device";

const files = (count: number): string => `${count} ${count === 1 ? "file" : "files"}`;

/**
 * What a failed request lets this client say. The route deletes and THEN
 * audits, so a 5xx can be an ending that finished deleting and failed to
 * write its record; a network failure can be a response lost after the
 * work was done. Only a 4xx — a refusal before any deletion — is a
 * "not ended", and the wording follows exactly that: the client never
 * claims more than the daemon told it.
 */
function endFailureText(error: Error): string {
  if (error instanceof EndNotConfirmedError) {
    return error.message;
  }
  if (error instanceof ApiRequestError) {
    return error.status < 500
      ? `${error.message} Your duo was not ended.`
      : `${error.message} This device can't tell how far it got — your duo may or may not have been ended.`;
  }
  return "Your duo didn't answer, so this device can't tell whether it was ended. If it was, this device will find out the next time it asks.";
}

/** The description is a request that deletes nothing, so a failure of it always means "nothing was ended". */
function describeFailureText(error: Error): string {
  return error instanceof ApiRequestError
    ? `${error.message} Nothing was ended.`
    : "Your duo didn't answer, so nothing was ended.";
}

/**
 * #55: the kill switch, from any paired device — "instantly killable" made
 * true in practice, not just at the machine running the daemon (digital-duo
 * #181). The section is always on Settings, headed by what it does; the
 * control opens an alert dialog (#34's primitive: focus trap, Escape is
 * Cancel, a stray click outside is not an answer) that asks the daemon what
 * WOULD go and states — from its answer — what ends, what is kept, and what
 * cannot be undone, before a typed confirmation lets anything proceed.
 * Offline it is disabled and says why (AR-15): an irreversible act is never
 * queued to fire later against a duo that has moved on.
 */
export function EndDuoSection({
  api,
  session,
  onEnded,
}: {
  api: DuoApiConfig;
  session: WorkspaceSession | null;
  /** Called once, only after the daemon confirmed the end — App turns it into the ended state. */
  onEnded?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { reachable } = useSyncStatus();
  const offlineNoteId = useId();
  const decidedBy = session?.userId ?? UNNAMED_DECIDER;

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-end-duo-section">
      <h2 className="type-heading">End this duo</h2>
      <p className="type-provenance text-[var(--muted)]">
        End your duo for good from this device, without going to the machine it runs on. You'll see exactly what happens — and confirm — before anything does.
      </p>
      <AlertDialog
        open={open}
        // While the end is in flight the dialog cannot be dismissed: an
        // Escape must not bury a pending, irreversible request and its answer.
        onOpenChange={(next) => {
          if (!busy) {
            setOpen(next);
          }
        }}
      >
        <AlertDialogTrigger
          aria-describedby={reachable ? undefined : offlineNoteId}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--refused)] px-3 text-[var(--refused)] disabled:opacity-40"
          data-testid="settings-end-duo"
          disabled={!reachable}
        >
          End this duo…
        </AlertDialogTrigger>
        {!reachable && (
          <p className="type-provenance text-[var(--muted)]" data-testid="settings-end-duo-offline" id={offlineNoteId}>
            Your duo is asleep, so it can't be ended right now. It can be ended when your Mac is back.
          </p>
        )}
        <AlertDialogContent className="max-h-[calc(100dvh-3rem)] w-[calc(100vw-3rem)] max-w-md overflow-y-auto" data-testid="settings-end-duo-confirmation">
          <AlertDialogTitle className="type-heading">End this duo?</AlertDialogTitle>
          <AlertDialogDescription className="type-provenance text-[var(--muted)]">
            This ends your duo for good. What happens is listed below — read it before you go on.
          </AlertDialogDescription>
          <EndDuoBody
            api={api}
            decidedBy={decidedBy}
            hasWorkspaceSession={session !== null}
            offline={!reachable}
            onBusyChange={setBusy}
            onEnded={() => {
              setBusy(false);
              setOpen(false);
              onEnded?.();
            }}
          />
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/**
 * The dialog's content. Mounted only while the dialog is open, so each
 * opening starts over: a fresh description from the daemon, an empty phrase
 * — a confirmation typed once is not a standing authorization.
 */
function EndDuoBody({
  api,
  decidedBy,
  hasWorkspaceSession,
  offline,
  onBusyChange,
  onEnded,
}: {
  api: DuoApiConfig;
  decidedBy: string;
  hasWorkspaceSession: boolean;
  offline: boolean;
  onBusyChange: (busy: boolean) => void;
  onEnded: () => void;
}) {
  const describe = useDescribeEnd(api, decidedBy);
  const end = useEndDuo(api, decidedBy, onEnded);
  const [phrase, setPhrase] = useState("");
  const phraseId = useId();
  const { mutate: describeEnd } = describe;
  useEffect(() => {
    describeEnd();
  }, [describeEnd]);
  useEffect(() => {
    onBusyChange(end.isPending);
  }, [end.isPending, onBusyChange]);

  const preview: EndDuoResult | undefined = describe.data;
  const nothingToEnd = preview !== undefined && preview.storePaths.length === 0 && preview.duoDirPaths.length === 0;
  const canConfirm = preview !== undefined && !nothingToEnd && phrase.trim() === CONFIRMATION_PHRASE && !end.isPending && !offline;

  return (
    <div className="flex flex-col gap-3">
      {describe.isPending && (
        <p className="type-provenance text-[var(--muted)]" data-testid="end-duo-loading" role="status">
          Asking your duo what would be deleted…
        </p>
      )}
      {describe.error && (
        <p className="type-provenance text-[var(--refused)]" data-testid="settings-end-duo-error" role="alert">
          {describeFailureText(describe.error)}
        </p>
      )}
      {nothingToEnd && (
        <p className="type-provenance text-[var(--muted)]" data-testid="end-duo-nothing">
          Your duo reports nothing left to delete, so there is nothing to end.
        </p>
      )}
      {preview && !nothingToEnd && (
        <>
          <section className="flex flex-col gap-1" data-testid="end-duo-ends">
            <h3 className="type-heading text-[var(--text)]">What ends</h3>
            <ul className="flex list-disc flex-col gap-1 pl-5 type-provenance text-[var(--muted)]">
              <li>Your duo stops answering — here and on every paired device. Every pairing to it, this one included, stops working.</li>
              <li>
                Deleted: {files(preview.storePaths.length)} of what your duo knows, and {files(preview.duoDirPaths.length)} built from it.
              </li>
            </ul>
            {/* The daemon's own lists, verbatim — "exactly what happens" is checkable, not paraphrased. */}
            <details className="type-provenance text-[var(--muted)]" data-testid="end-duo-files">
              <summary className="min-h-11 cursor-pointer py-2">Show the files</summary>
              <FileList dir={preview.storeDataDir} paths={preview.storePaths} />
              <FileList dir={preview.duoDir} paths={preview.duoDirPaths} />
            </details>
          </section>
          <section className="flex flex-col gap-1" data-testid="end-duo-kept">
            <h3 className="type-heading text-[var(--text)]">What is kept</h3>
            <ul className="flex list-disc flex-col gap-1 pl-5 type-provenance text-[var(--muted)]">
              <li>A record that your duo was ended, and that {decidedBy} decided it. It is kept, not deleted with the rest.</li>
              {hasWorkspaceSession && (
                <li>Your workspace sign-in and your conversations there. They are separate from your duo and stay as they are.</li>
              )}
            </ul>
          </section>
          <section className="flex flex-col gap-1" data-testid="end-duo-irreversible">
            <h3 className="type-heading text-[var(--refused)]">What cannot be undone</h3>
            <p className="type-provenance text-[var(--muted)]">
              Ending cannot be undone — not from here, and not from anywhere in this app. There is no restore, and pairing again does not bring your duo back.
            </p>
          </section>
          <div className="flex flex-col gap-1">
            <label className="type-provenance text-[var(--muted)]" htmlFor={phraseId}>
              Type {CONFIRMATION_PHRASE} to confirm
            </label>
            <input
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
              data-testid="settings-end-duo-phrase"
              disabled={end.isPending}
              id={phraseId}
              onChange={(e) => setPhrase(e.target.value)}
              spellCheck={false}
              value={phrase}
            />
          </div>
        </>
      )}
      {offline && preview && (
        <p className="type-provenance text-[var(--muted)]" role="status">
          Your duo is asleep, so it can't be ended right now.
        </p>
      )}
      {end.error && (
        <p className="type-provenance text-[var(--refused)]" data-testid="settings-end-duo-error" role="alert">
          {endFailureText(end.error)}
        </p>
      )}
      <div className="flex gap-2">
        {preview && !nothingToEnd && (
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--refused)] px-3 text-white disabled:opacity-40"
            data-testid="settings-end-duo-confirm"
            disabled={!canConfirm}
            onClick={() => {
              if (canConfirm) {
                end.mutate();
              }
            }}
            type="button"
          >
            {end.isPending ? "Ending…" : "End this duo for good"}
          </button>
        )}
        <AlertDialogCancel
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
          data-testid="settings-end-duo-cancel"
          disabled={end.isPending}
        >
          Cancel
        </AlertDialogCancel>
      </div>
    </div>
  );
}

function FileList({ dir, paths }: { dir: string; paths: readonly string[] }) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="type-identifier break-all text-[var(--text)]">{dir}</div>
      <ul className="flex flex-col gap-1 pl-3">
        {paths.map((path) => (
          <li className="type-identifier break-all" key={path}>
            {path}
          </li>
        ))}
      </ul>
    </div>
  );
}
