import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DuoApiConfig } from "../api/client.js";
import { inviteOwnerInto, useAnswerEscalation, useRecordOutcome } from "../api/queries.js";
import type { DraftRecord } from "../api/types.js";
import { useSyncStatus } from "../sync.js";
import { conversationOf, roomHref } from "../workspace/drafts.js";
import { localpartOf } from "../workspace/identity.js";
import type { RoomSummary, WorkspaceConnection } from "../workspace/matrix.js";
import { DuoLine } from "./DuoLine.js";

/**
 * A colleague's question your duo passed to you, from a workspace
 * conversation: its provenance names the room (a `matrix.to` address) and
 * the daemon recorded that the colleague was told it went to you.
 */
export function isColleagueEscalation(draft: DraftRecord): boolean {
  return draft.provenance?.origin === "channel" && conversationOf(draft.provenance) !== null && draft.publicOutcome === "passed_on" && !draft.refused;
}

/** The duo's attempt, when it made one — an escalation drafted nothing to show. */
export function attemptOf(draft: Pick<DraftRecord, "escalated" | "draftText">): string | null {
  return !draft.escalated && draft.draftText !== null && draft.draftText.trim() !== "" ? draft.draftText : null;
}

/** Who asked, as this member's rooms know them, else the id grammar's own label — never the raw id. */
export function askerNameOf(draft: DraftRecord, rooms: readonly Pick<RoomSummary, "members">[]): string {
  const ref = draft.provenance?.origin === "channel" ? draft.provenance.askerRef : null;
  if (ref === null) {
    return "A colleague";
  }
  for (const room of rooms) {
    const member = room.members.find((candidate) => candidate.userId === ref);
    if (member?.name) {
      return member.name;
    }
  }
  return localpartOf(ref);
}

/**
 * #314: "a passed-on question reaches you with everything." The question, who
 * asked, your duo's attempt if it made one (behind its line, labelled — it is
 * the duo's text until you send it), and why it stopped, in the daemon's own
 * words. Reply starts from the attempt and goes back into the conversation
 * the question came from, as your own message: the duo can't post your words,
 * so you answer from your own workspace account — brought into the
 * conversation by your duo when you aren't in it yet — and the daemon is then
 * told you did (an escalation becomes a standing-order candidate, as any
 * answered escalation does; an attempt you sent is recorded as delivered).
 */
export function EscalationCard({
  api,
  draft,
  connection,
  rooms,
}: {
  api: DuoApiConfig;
  draft: DraftRecord;
  connection: WorkspaceConnection | null;
  rooms: readonly RoomSummary[];
}) {
  const queryClient = useQueryClient();
  const answerEscalation = useAnswerEscalation(api);
  const recordOutcome = useRecordOutcome(api);
  const { reachable } = useSyncStatus();
  const attempt = attemptOf(draft);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState(attempt ?? "");
  const [phase, setPhase] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const roomId = conversationOf(draft.provenance)!.roomId;
  const held = rooms.some((room) => room.roomId === roomId);
  const asker = askerNameOf(draft, rooms);
  const reason = draft.passOnReason ?? draft.escalationReason;

  const send = async (): Promise<void> => {
    const words = text.trim();
    if (words === "" || connection === null) {
      return;
    }
    setPhase("sending");
    setError(null);
    try {
      if (!held) {
        // Your duo brings you in; you join as yourself. An invite that fails
        // because you're already there is no reason not to try the join.
        await inviteOwnerInto(api, roomId).catch(() => undefined);
        await connection.joinRoom(roomId);
      }
      await connection.send(roomId, words);
    } catch (failure) {
      setPhase("idle");
      setError(failure instanceof Error ? `Couldn't post your reply — ${failure.message}` : "Couldn't post your reply — try again.");
      return;
    }
    try {
      if (draft.escalated) {
        await answerEscalation.mutateAsync({ draftId: draft.id, answer: words });
      } else {
        const edited = words !== (attempt ?? "").trim();
        await recordOutcome.mutateAsync({ draftId: draft.id, outcome: edited ? "edited" : "sent", ...(edited ? { sentText: words } : {}), ownerDelivered: true });
      }
    } catch (failure) {
      // The reply is in the conversation; only the duo's record of it failed.
      setError(failure instanceof Error ? `Your reply was posted, but your duo didn't record it — ${failure.message}` : "Your reply was posted, but your duo didn't record it.");
    }
    setPhase("sent");
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
  };

  return (
    <article className="shape-container flex flex-col gap-3 p-4" data-testid="escalation-card">
      <p className="type-provenance text-[var(--muted)]" data-testid="escalation-card-asker">
        {`Your duo passed ${asker}'s question to you.`}
      </p>
      <blockquote className="type-body text-[var(--text)] whitespace-pre-line" data-testid="escalation-card-question">
        {draft.question}
      </blockquote>
      {attempt !== null ? (
        <DuoLine attributionTestId="escalation-card-attempt-label" label="Your duo" meta="its attempt · not sent" state="escalated" testId="escalation-card-attempt">
          <p className="whitespace-pre-line">{attempt}</p>
        </DuoLine>
      ) : (
        <p className="type-provenance text-[var(--faint)]" data-testid="escalation-card-no-attempt">
          Your duo didn&apos;t draft an answer to this one.
        </p>
      )}
      <div data-testid="escalation-card-reason">
        <p className="type-provenance uppercase text-[var(--faint)]">Why it stopped</p>
        <p className="type-body text-[var(--muted)]">{reason ?? "Your duo didn't record why."}</p>
      </div>
      {phase === "sent" ? (
        <p className="type-provenance text-[var(--muted)]" data-testid="escalation-card-sent" role="status">
          {`Sent — ${asker} sees your reply in your conversation.`}
          {" "}
          <a className="underline" href={roomHref(roomId)}>
            Open the conversation
          </a>
        </p>
      ) : replying ? (
        <div className="flex flex-col gap-2">
          <label className="type-provenance text-[var(--muted)]" htmlFor={`escalation-reply-${draft.id}`}>
            {`Your reply to ${asker} — it posts as you, in the conversation they asked in.`}
          </label>
          <textarea
            className="min-h-24 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] p-2 type-body"
            data-testid="escalation-card-reply-text"
            id={`escalation-reply-${draft.id}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex gap-2">
            <button
              className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
              data-testid="escalation-card-send"
              disabled={!reachable || connection === null || text.trim() === "" || phase === "sending"}
              type="button"
              onClick={() => void send()}
            >
              {phase === "sending" ? "Sending…" : "Send"}
            </button>
            <button
              className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--muted)]"
              type="button"
              onClick={() => setReplying(false)}
            >
              Cancel
            </button>
          </div>
          {connection === null && <p className="type-provenance text-[var(--faint)]">Sign in to your workspace to reply in the conversation.</p>}
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            className="inline-flex min-h-11 items-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)]"
            data-testid="escalation-card-reply"
            type="button"
            onClick={() => {
              setText(attempt ?? "");
              setReplying(true);
            }}
          >
            Reply
          </button>
          {held && (
            <a className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" href={roomHref(roomId)}>
              Open the conversation
            </a>
          )}
        </div>
      )}
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="escalation-card-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
