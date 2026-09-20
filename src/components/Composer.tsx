import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useCreateDraft } from "../api/queries.js";
import { MutationError } from "./MutationError.js";
import { useSyncStatus } from "../sync.js";

/**
 * The thread view's ask input — the owner's way into the drafting loop
 * without a terminal (`client-tech-design.md` §3.1's "thread view +
 * composer"). Disposition (Send / Edit / Ignore / answer-an-escalation)
 * stays in Review: asking is a conversation act, disposing is a triage
 * act, and the draft the daemon returns is pending either way.
 *
 * The typed question survives a failed submit — `setQuestion("")` runs in
 * `onSuccess` only — because losing a typed question to a dropped
 * connection is exactly the moment it hurts most. AR-15 applies as it does
 * in DraftCard: unreachable disables submission rather than queueing it.
 */
export function Composer({ api, thread, threadLabel }: { api: DuoApiConfig; thread: string | null; threadLabel: string }) {
  const createDraft = useCreateDraft(api);
  const { reachable } = useSyncStatus();
  const [question, setQuestion] = useState("");
  const trimmed = question.trim();
  const disabled = trimmed.length === 0 || createDraft.isPending || !reachable;

  return (
    <form
      className="border-t border-[var(--edge)] p-4"
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) {
          return;
        }
        createDraft.mutate({ question: trimmed, threadContext: thread }, { onSuccess: () => setQuestion("") });
      }}
    >
      <div className="flex gap-2">
        <input
          aria-label="Question for your duo"
          className="flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-1.5 text-[var(--text)]"
          placeholder="Ask your duo…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button
          className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1.5 text-white disabled:opacity-40"
          data-testid="composer-submit"
          disabled={disabled}
          type="submit"
        >
          {createDraft.isPending ? "Asking…" : "Ask"}
        </button>
      </div>
      <p className="mt-2 text-xs text-[var(--faint)]" data-testid="composer-thread">
        Asking in: {threadLabel}
      </p>
      <MutationError error={createDraft.error} />
    </form>
  );
}
