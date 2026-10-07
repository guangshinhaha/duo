import { useEffect, useRef, useState } from "react";
import type { RoomMessage } from "../workspace/matrix.js";
import { setCatchUpOffForRoom } from "../catchUpPrefs.js";
import { DuoLine } from "./DuoLine.js";

/**
 * duo#280: the catch-up card — a short, dismissible summary above the
 * unread line in a busy conversation (digital-duo#279). Rendered through
 * `DuoLine` (`state="neutral"`, the form the design language reserves for
 * "a notice, a digest" — this is exactly that, not a confidence-scored
 * draft), so it carries the same structural attribution every other
 * duo-authored block does and can never be mistaken for a message in the
 * room (AC "never posted into the room — visible only to you").
 *
 * The summary is fetched once per unread batch (keyed by the oldest
 * unread message's event id — a genuinely new batch of unread messages
 * gets a fresh card even if this one was dismissed) and remembered as
 * dismissed in `sessionStorage`, not `localStorage`: a dismissal is "I've
 * seen this catch-up", which a fresh tab/restart should ask again, the
 * same posture #268's held-send undo window takes toward anything that
 * should not silently outlive the session that decided it.
 */

interface Bullet {
  readonly index: number;
  readonly text: string;
}

interface CatchUpResult {
  readonly bullets: readonly Bullet[];
  readonly oneLine: string;
}

export function CatchUpCard({
  roomId,
  messages,
  onCatchUp,
  onJumpToMessage,
}: {
  roomId: string;
  /** The unread window, oldest first — exactly what the card summarizes and what a bullet's index resolves against. */
  messages: readonly RoomMessage[];
  onCatchUp: (messages: readonly { from: string; text: string }[]) => Promise<CatchUpResult>;
  onJumpToMessage: (eventId: string) => void;
}) {
  const dismissStorageKey = `duo.catch-up-dismissed.${roomId}`;
  const batchKey = messages[0]?.eventId ?? "";
  const [dismissedBatch, setDismissedBatch] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(dismissStorageKey);
    } catch {
      return null;
    }
  });
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ready"; result: CatchUpResult } | { kind: "error" }>({ kind: "loading" });
  const requestedBatch = useRef<string | null>(null);
  const live = batchKey !== "" && batchKey !== dismissedBatch;

  useEffect(() => {
    if (!live || requestedBatch.current === batchKey) {
      return;
    }
    requestedBatch.current = batchKey;
    setState({ kind: "loading" });
    onCatchUp(messages.map((message) => ({ from: message.senderName, text: message.body })))
      .then((result) => setState({ kind: "ready", result }))
      .catch(() => setState({ kind: "error" }));
    // `messages`/`onCatchUp` are fresh closures every render; `batchKey`
    // alone (guarded by `requestedBatch`) decides whether a new request is
    // due, so they are deliberately left out of this effect's own deps.
  }, [batchKey, live]);

  if (!live) {
    return null;
  }

  const dismiss = (): void => {
    try {
      sessionStorage.setItem(dismissStorageKey, batchKey);
    } catch {
      // Private window, blocked storage: the card just shows again next render — never a crash over a lost preference.
    }
    setDismissedBatch(batchKey);
  };

  // A 503 (no inference provider) or any other failure reads exactly like
  // "below the threshold" — no card — never a visible error over a feature
  // this conservative: `/compose/rewrite`/`/compose/explain` take the same
  // stance on their own unavailable errors.
  if (state.kind === "error") {
    return null;
  }

  return (
    <div className="mb-3" data-testid="catch-up-card">
      <DuoLine aside="only you can see this" attributionTestId="catch-up-attribution" label="Your duo" meta="catch-up" state="neutral" testId="catch-up-line">
        {state.kind === "loading" ? (
          <p className="type-provenance text-[var(--muted)]" data-testid="catch-up-loading">
            Catching you up…
          </p>
        ) : state.result.bullets.length > 0 ? (
          <ul className="flex flex-col gap-2" data-testid="catch-up-bullets">
            {state.result.bullets.map((bullet, i) => {
              const eventId = messages[bullet.index]?.eventId;
              return (
                <li className="type-body" key={`${bullet.index}-${i}`}>
                  {eventId ? (
                    <button
                      className="text-left underline decoration-[var(--faint)] underline-offset-2"
                      data-testid="catch-up-bullet"
                      onClick={() => onJumpToMessage(eventId)}
                      type="button"
                    >
                      {bullet.text}
                    </button>
                  ) : (
                    bullet.text
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="type-body" data-testid="catch-up-one-line">
            {state.result.oneLine}
          </p>
        )}
        <div className="mt-2 flex items-center gap-3 type-provenance text-[var(--faint)]">
          <button
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] px-2"
            data-testid="catch-up-dismiss"
            onClick={dismiss}
            type="button"
          >
            Dismiss
          </button>
          <button
            className="min-h-11 rounded-[var(--r-sm)] px-2 underline"
            data-testid="catch-up-turn-off-room"
            onClick={() => {
              setCatchUpOffForRoom(roomId, true);
              dismiss();
            }}
            type="button"
          >
            Turn off for this chat
          </button>
        </div>
      </DuoLine>
    </div>
  );
}
