import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useConfirmT4, usePendingT4 } from "../api/queries.js";
import type { PendingT4RequestForJudgement } from "../api/types.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/primitives/AlertDialog.js";
import { DuoMessage } from "../components/DuoMessage.js";
import { MutationError } from "../components/MutationError.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { useSyncStatus } from "../sync.js";

/** Why a request cannot be confirmed right now — null when it can. Three honest reasons, none of them a queue. */
type Unavailable = "asleep" | "checking" | "failed" | null;

const UNAVAILABLE_TEXT: Record<Exclude<Unavailable, null>, string> = {
  // The daemon line's own wording (#58's bar) — the same state, said the same way.
  asleep: "Your duo is asleep — you can confirm this when your Mac is back. It will not be held and sent later.",
  checking: "Checking with your duo that this is still waiting…",
  failed: "Couldn't check with your duo just now. Try again in a moment.",
};

/**
 * One staged irreversible step, stated in full before anything can be done
 * about it (#52 AC2): what will happen (the registered action's own
 * description), to what (the topic), and whether it can be undone — all of
 * it in the daemon's words, all of it ahead of the one control on the card,
 * and that control does not confirm: it opens the question, which restates
 * the consequence again above its affirmative button.
 *
 * A request whose action the registry can no longer describe has nothing
 * true to say about what would happen, so it gets no control at all rather
 * than a button over a blank.
 */
function ConfirmationCard({
  request,
  unavailable,
  pending,
  error,
  onConfirm,
}: {
  request: PendingT4RequestForJudgement;
  unavailable: Unavailable;
  /** Any confirmation is in flight — one at a time, so a second press cannot become a second action. */
  pending: boolean;
  error: Error | null;
  onConfirm: (request: PendingT4RequestForJudgement) => void;
}) {
  const action = request.action;

  return (
    <section
      aria-label={action ? `Waiting for your confirmation: ${action.description}` : "Waiting for your confirmation"}
      className="shape-entry flex flex-col gap-3 p-4"
      data-testid="confirmation-card"
    >
      <h2 className="type-heading">Waiting for your confirmation</h2>
      {action ? (
        <dl className="flex flex-col gap-2 type-body">
          <div>
            <dt className="type-provenance text-[var(--muted)]">What will happen</dt>
            <dd data-testid="confirmation-action">{action.description}</dd>
          </div>
          <div>
            <dt className="type-provenance text-[var(--muted)]">To what</dt>
            <dd className="type-identifier" data-testid="confirmation-topic">
              {request.topicId}
            </dd>
          </div>
          <div>
            <dt className="type-provenance text-[var(--muted)]">Can it be undone?</dt>
            <dd data-testid="confirmation-undo">{action.reversible ? "This can be undone." : "This cannot be undone."}</dd>
          </div>
        </dl>
      ) : (
        <p className="type-body" data-testid="confirmation-undescribed">
          Your duo can't say what this would do, so it can't be confirmed here.
        </p>
      )}
      {/* AR-13: the reasoning is the duo's own words, labelled as such. */}
      <DuoMessage>{request.reasoning}</DuoMessage>
      {action && (
        <p className="type-provenance text-[var(--muted)]" data-testid="confirmation-meta">
          audience {action.audience} · {action.obligates ? "obligates you" : "does not obligate you"}
        </p>
      )}
      {action && (
        <div className="flex flex-col gap-2">
          {/* The card's only control opens the question — it is not the
              confirmation, and no gesture on the card is. */}
          <AlertDialog>
            <AlertDialogTrigger
              aria-label={`Review and confirm: ${action.description}`}
              className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)] disabled:opacity-40"
              data-testid="confirmation-review"
              disabled={unavailable !== null}
            >
              Review and confirm…
            </AlertDialogTrigger>
            <AlertDialogContent className="w-[calc(100vw-3rem)] max-w-md" data-testid="confirmation-dialog">
              <AlertDialogTitle className="type-heading">
                {action.reversible ? "Confirm this action?" : "Confirm this irreversible action?"}
              </AlertDialogTitle>
              <AlertDialogDescription className="type-body" data-testid="confirmation-question">
                {action.description}, to {request.topicId}. {action.reversible ? "This can be undone." : "This cannot be undone."} Nothing has
                happened yet: confirming is what makes it happen.
              </AlertDialogDescription>
              {unavailable !== null && (
                <p className="type-provenance text-[var(--escalate)]" data-testid="confirmation-dialog-unavailable">
                  {UNAVAILABLE_TEXT[unavailable]}
                </p>
              )}
              {/* Cancel first, and Radix focuses it on open: pressing Enter
                  the instant the question appears answers "no". */}
              <div className="flex flex-wrap gap-2">
                <AlertDialogCancel
                  className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
                  data-testid="confirmation-cancel"
                >
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--refused)] px-3 text-white disabled:opacity-40"
                  data-testid="confirmation-confirm"
                  disabled={unavailable !== null || pending}
                  onClick={() => onConfirm(request)}
                >
                  Confirm
                </AlertDialogAction>
              </div>
            </AlertDialogContent>
          </AlertDialog>
          {unavailable !== null && (
            <p className="type-provenance text-[var(--muted)]" data-testid="confirmation-unavailable">
              {UNAVAILABLE_TEXT[unavailable]}
            </p>
          )}
        </div>
      )}
      <MutationError error={error} />
    </section>
  );
}

/**
 * The confirmation moment (#52, digital-duo #180): the staged irreversible
 * steps, each awaiting the owner's explicit yes (`concept.md` §6 — "never
 * autonomous, product principle, not a limitation"). The owner is by the
 * design's premise not at the terminal where the daemon's stdin is; this is
 * the surface that can be both the notification's destination and the dialog.
 *
 * It adds no behaviour the daemon lacks. The daemon lists the requests and
 * runs the confirmation exactly once; this screen reads the list, states
 * each consequence in the daemon's own words, and asks. There is no
 * "confirm all", no shortcut, no default answer — and, per AR-15, no
 * confirming from a cache: a request is confirmable only once THIS visit has
 * heard from the daemon and the daemon is still answering. A confirmation
 * that fired later against moved context is precisely the failure the T4
 * guard exists to prevent, so an unreachable daemon refuses, never queues.
 */
export function ConfirmationsPanel({ api, quietWhenEmpty = false }: { api: DuoApiConfig; quietWhenEmpty?: boolean }) {
  const { data: requests, isLoading, error, isError, isFetchedAfterMount, refetch } = usePendingT4(api);
  const confirm = useConfirmT4(api);
  const { reachable } = useSyncStatus();
  // What was confirmed this visit — the request itself leaves the daemon's
  // waiting list the moment it runs, so what happened is kept here to be
  // said, not inferred from an absence.
  const [confirmed, setConfirmed] = useState<{ id: string; description: string }[]>([]);

  // Hosted inside Your duo's chat, loading and failing are silent: the chat is
  // not a page that owes the owner a spinner or an error screen for one card.
  if (isLoading) {
    return quietWhenEmpty ? null : <RouteLoading />;
  }
  if (error && !requests) {
    return quietWhenEmpty ? null : <RouteError api={api} error={error} onRetry={() => void refetch()} />;
  }

  // Not confirmable from a cache: the list must have been read from the
  // daemon since this screen opened, and the daemon must still be answering.
  const unavailable: Unavailable = !reachable ? "asleep" : isError ? "failed" : !isFetchedAfterMount ? "checking" : null;
  const waiting = requests ?? [];

  // Hosted inside Your duo's chat, an empty panel says nothing at all.
  if (quietWhenEmpty && waiting.length === 0 && confirmed.length === 0) {
    return null;
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4" data-testid="confirmations-panel">
      <div className="flex flex-col gap-4">
        {confirmed.map((done) => (
          <p className="type-body" data-testid="confirmation-done" key={done.id} role="status">
            Confirmed — {done.description}.
          </p>
        ))}
        {waiting.length === 0 ? (
          <div className="text-[var(--muted)]" data-testid="confirmations-empty">
            Nothing is waiting for your confirmation. When your duo reaches a step it will not take without you, it lands here.
          </div>
        ) : (
          <div className="shape-container flex flex-col gap-4 p-4" data-testid="confirmations-list">
            {waiting.map((request) => (
              <ConfirmationCard
                error={confirm.variables === request.id ? confirm.error : null}
                key={request.id}
                onConfirm={(target) =>
                  confirm.mutate(target.id, {
                    onSuccess: () =>
                      setConfirmed((previous) => [...previous, { id: target.id, description: target.action?.description ?? target.actionId }]),
                  })
                }
                pending={confirm.isPending}
                request={request}
                unavailable={unavailable}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The Confirmations page: the panel, with its own heading and room. */
export function Confirmations({ api }: { api: DuoApiConfig }) {
  return (
    <div className="p-6">
      <h1 className="type-heading sr-only">Confirmations</h1>
      <ConfirmationsPanel api={api} />
    </div>
  );
}
