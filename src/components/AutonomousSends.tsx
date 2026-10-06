import { useEffect, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useAutonomousSends, useStopAutonomousSend } from "../api/queries.js";
import type { DraftRecord, ScheduledSend } from "../api/types.js";
import { requestEditOnOpen } from "../editOnOpen.js";
import { useSyncStatus } from "../sync.js";
import { DuoLine } from "./DuoLine.js";
import { MutationError } from "./MutationError.js";

/** Who an autonomous reply is to, in words: the named recipient, else the channel's own reference for the asker. */
export function replyRecipientName(draft: DraftRecord): string {
  if (draft.recipient?.name) {
    return draft.recipient.name;
  }
  return draft.provenance?.origin === "channel" ? draft.provenance.askerRef : "them";
}

/** Whole seconds left until `sendAt`, never below 0. */
export function secondsLeft(sendAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(sendAt) - now) / 1000));
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const isHeld = (send: unknown): send is ScheduledSend =>
  typeof send === "object" &&
  send !== null &&
  (send as ScheduledSend).autonomous === true &&
  typeof (send as ScheduledSend).sendAt === "string" &&
  typeof (send as ScheduledSend).draft === "object" &&
  (send as ScheduledSend).draft !== null;

const button =
  "inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body disabled:opacity-40";
const primary = "inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40";

/**
 * #268: the live strip in Waiting on you — every reply your duo is about to
 * send by itself under autonomy you granted (#266), with how long is left
 * and the two ways to take it back. Stop: nothing is posted, and the
 * question waits on you as a normal draft. Edit: the same stop, then the
 * draft opens in the editor so what goes out is your own words. Both are the
 * daemon's — the hold lives there, not on this device, so Stop works from
 * any device and a closed laptop never sends anything early or late.
 *
 * Renders nothing when nothing is held. Stop/Edit are disabled while the
 * daemon is unreachable (the same AR-15 rule as Send): a tap that cannot
 * reach the daemon would be a Stop that stopped nothing.
 */
export function AutonomousSends({ api }: { api: DuoApiConfig }) {
  const held = useAutonomousSends(api);
  const stop = useStopAutonomousSend(api);
  const { reachable } = useSyncStatus();
  const sends = Array.isArray(held.data) ? held.data.filter(isHeld) : [];
  const now = useNow(sends.length > 0);
  const [gone, setGone] = useState<string | null>(null);
  if (sends.length === 0 && gone === null) {
    return null;
  }

  const act = (draftId: string, action: "stop" | "edit"): void => {
    setGone(null);
    stop.mutate(
      { draftId, action },
      {
        onSuccess: () => {
          if (action === "edit") {
            requestEditOnOpen(draftId);
            window.location.hash = `#draft/${encodeURIComponent(draftId)}`;
          }
        },
        onError: (error) => {
          // 404: the window ended first — the reply went. Say so; never imply it was stopped.
          if ((error as { status?: number }).status === 404) {
            setGone(draftId);
          }
        },
      },
    );
  };

  return (
    <section aria-label="Your duo is about to send" aria-live="polite" className="flex max-w-xl flex-col gap-3" data-testid="autonomous-sends">
      {sends.map((send) => {
        const left = secondsLeft(send.sendAt, now);
        const who = replyRecipientName(send.draft);
        return (
          <div className="flex flex-col gap-2" data-testid="autonomous-send" key={send.draftId}>
            <DuoLine attributionTestId="autonomous-send-attribution" label="Your duo" state="signal" testId="autonomous-send-line">
              <div className="flex flex-col gap-1">
                <p className="type-body" data-testid="autonomous-send-countdown">
                  {left > 0 ? `Answering ${who} in ${left}s — you said I could.` : `Sending to ${who} now…`}
                </p>
                <p className="type-body text-[var(--text)]">{send.draft.draftText}</p>
                <p className="type-provenance text-[var(--faint)]">In reply to: {send.draft.question}</p>
              </div>
            </DuoLine>
            <div className="flex flex-wrap gap-2">
              <button
                className={primary}
                data-testid="autonomous-send-stop"
                disabled={!reachable || stop.isPending}
                onClick={() => act(send.draftId, "stop")}
                type="button"
              >
                Stop
              </button>
              <button
                className={button}
                data-testid="autonomous-send-edit"
                disabled={!reachable || stop.isPending}
                onClick={() => act(send.draftId, "edit")}
                type="button"
              >
                Edit
              </button>
            </div>
          </div>
        );
      })}
      {gone !== null && (
        <p className="type-provenance text-[var(--muted)]" data-testid="autonomous-send-gone" role="status">
          Too late to stop that one — it has already been sent.
        </p>
      )}
      {stop.error && (stop.error as { status?: number }).status !== 404 && <MutationError error={stop.error} />}
    </section>
  );
}
