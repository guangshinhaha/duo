import { useState } from "react";
import { ListChecks } from "lucide-react";
import type { Poll } from "../workspace/matrix.js";

/**
 * #293: a poll — question, options, live results. Proportions render as a
 * bar's own width, never a percentage (`design-language.md` §1.6's rule for
 * every derived proportion: "I mean nothing of yours a percentage might
 * imply"), and the vote count beside each option is the daemon-grade
 * honesty every other count in this product already keeps — the homeserver's
 * own figure, not a rounded guess. Voting is disabled once the poll is
 * closed, and a member's own vote is marked (`aria-pressed`, a filled ring)
 * rather than only implied by the tally.
 */
export function PollCard({
  poll,
  canClose,
  onVote,
  onClose,
}: {
  poll: Poll;
  /** #293: only the member who started this poll may close it — checked where this renders (`message.senderId === connection.userId`), never here. */
  canClose: boolean;
  onVote: (optionId: string) => void;
  onClose: () => void;
}) {
  const [closing, setClosing] = useState(false);
  return (
    <div className="flex flex-col gap-3 rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3" data-testid="room-poll">
      <p className="flex items-center gap-2 type-heading" data-testid="poll-question">
        <ListChecks aria-label="Poll" className="size-4 shrink-0 text-[var(--muted)]" />
        {poll.question}
      </p>
      <div className="flex flex-col gap-2">
        {poll.options.map((option) => {
          const width = poll.totalVotes > 0 ? Math.round((option.votes / poll.totalVotes) * 100) : 0;
          return (
            <button
              key={option.id}
              aria-pressed={option.mine}
              className="relative overflow-hidden rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-2 text-left type-body disabled:cursor-default"
              data-testid="poll-option"
              disabled={poll.closed}
              onClick={() => onVote(option.id)}
              type="button"
            >
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 bg-[var(--accent)]/15"
                style={{ width: `${width}%` }}
              />
              <span className="relative flex items-center justify-between gap-2">
                <span>
                  {option.mine && <span aria-hidden="true">✓ </span>}
                  {option.text}
                </span>
                <span className="type-provenance tabular-nums text-[var(--muted)]" data-testid="poll-option-votes">
                  {option.votes}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between type-provenance text-[var(--muted)]">
        <span data-testid="poll-total-votes">
          {poll.totalVotes} vote{poll.totalVotes === 1 ? "" : "s"}
          {poll.closed ? " · Closed" : ""}
        </span>
        {canClose && !poll.closed && (
          <button
            className="underline disabled:opacity-60"
            data-testid="poll-close"
            disabled={closing}
            onClick={() => {
              setClosing(true);
              onClose();
            }}
            type="button"
          >
            Close poll
          </button>
        )}
      </div>
    </div>
  );
}
