import { useEffect, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useCreateDraft } from "../api/queries.js";
import { readComposerBuffer, writeComposerBuffer } from "../composerBuffer.js";
import { MutationError } from "./MutationError.js";
import { useSyncStatus } from "../sync.js";

/**
 * The thread view's ask input — the owner's way into the drafting loop
 * without a terminal (`client-tech-design.md` §3.1's "thread view +
 * composer"). Disposition (Send / Edit / Ignore / answer-an-escalation)
 * stays in Review: asking is a conversation act, disposing is a triage
 * act, and the draft the daemon returns is pending either way.
 *
 * The field is a textarea (#27): a real question is rarely one line, so
 * Enter is a newline and Cmd/Ctrl-Enter submits — the chat-app convention
 * on both platforms. The typed question survives a failed submit
 * (`setQuestion("")` runs in `onSuccess` only), a cancelled one (abort is
 * the owner's choice, not a failure — so it resets, not errors), and a
 * route switch (kept in `composerBuffer` outside the component, because
 * a half-typed question is a thought in progress, not a record). AR-15
 * applies as it does in DraftCard: unreachable disables submission
 * rather than queueing it.
 */
export function Composer({ api, thread, threadLabel }: { api: DuoApiConfig; thread: string | null; threadLabel: string }) {
  const { mutation: createDraft, cancel } = useCreateDraft(api);
  const { reachable } = useSyncStatus();
  const [question, setQuestion] = useState(readComposerBuffer());
  const trimmed = question.trim();
  const disabled = trimmed.length === 0 || createDraft.isPending || !reachable;
  // An aborted fetch rejects with a DOMException named "AbortError" — the
  // owner chose to stop, so that's a reset, not a MutationError. The reset
  // lives in an effect rather than right after `cancel()`: the rejection
  // lands a tick later, and resetting synchronously would be undone by it.
  const cancelledByOwner = createDraft.error instanceof DOMException && createDraft.error.name === "AbortError";
  useEffect(() => {
    if (cancelledByOwner) {
      createDraft.reset();
    }
  }, [cancelledByOwner, createDraft]);

  return (
    <form
      className="border-t border-[var(--edge)] p-4"
      data-testid="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) {
          return;
        }
        createDraft.mutate(
          { question: trimmed, threadContext: thread },
          {
            onSuccess: () => {
              setQuestion("");
              writeComposerBuffer("");
            },
          },
        );
      }}
    >
      <div className="flex items-start gap-2">
        <textarea
          aria-label="Question for your duo"
          className="min-h-11 flex-1 resize-none rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-1 text-[var(--text)]"
          placeholder="Ask your duo…"
          rows={Math.max(1, Math.min(8, question.split("\n").length))}
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
            writeComposerBuffer(e.target.value);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="flex flex-col gap-2">
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
            data-testid="composer-submit"
            disabled={disabled}
            type="submit"
          >
            {createDraft.isPending ? "Asking…" : "Ask"}
          </button>
          {createDraft.isPending && (
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
              data-testid="composer-cancel"
              onClick={cancel}
              type="button"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 type-provenance text-[var(--faint)]" data-testid="composer-thread">
        Asking in: {threadLabel}
      </p>
      <MutationError error={cancelledByOwner ? null : createDraft.error} />
    </form>
  );
}
