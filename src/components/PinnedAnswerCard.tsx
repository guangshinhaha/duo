import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useDeletePinnedAnswer, useEditPinnedAnswer } from "../api/queries.js";
import type { PinnedAnswer } from "../api/types.js";
import { MutationError } from "./MutationError.js";
import { OwnerMessage } from "./OwnerMessage.js";
import { useSyncStatus } from "../sync.js";

/**
 * One pinned answer (duo#275): the owner's own exact wording for a
 * question/topic, outranking every standing order. The wording is the
 * owner's own words (most often copied straight off a message they sent),
 * so it renders in `OwnerMessage` — never `DuoMessage` — the same
 * structural rule `vocabulary.md` holds everywhere else: a duo's surfaces
 * never blur whose voice a block of text is.
 *
 * Unlike a standing order (AR-18: read and disposition only, no free-text
 * editing — `duo/rules/*.md` on the Mac is the source of truth), a pinned
 * answer IS owner-authored from the client by design — the whole feature
 * is the owner choosing its exact words — so editing here is in scope and
 * calls the daemon's own `POST /mirror/pinned-answers/:id/edit`.
 */
export function PinnedAnswerCard({ api, pinned }: { api: DuoApiConfig; pinned: PinnedAnswer }) {
  const editPinned = useEditPinnedAnswer(api);
  const deletePinned = useDeletePinnedAnswer(api);
  const [editing, setEditing] = useState(false);
  const [pattern, setPattern] = useState(pinned.pattern);
  const [answerText, setAnswerText] = useState(pinned.answerText);
  const { reachable } = useSyncStatus();
  const dirty = pattern.trim().length === 0 || answerText.trim().length === 0;

  if (deletePinned.isSuccess) {
    return (
      <p className="motion-rise type-provenance text-[var(--muted)]" data-testid="pinned-answer-removed" role="status">
        Unpinned. Your duo will go back to answering this on its own.
      </p>
    );
  }

  if (editing) {
    return (
      <form
        className="flex flex-col gap-2 shape-entry p-4"
        data-testid="pinned-answer-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) {
            return;
          }
          editPinned.mutate(
            { id: pinned.id, pattern: pattern.trim(), answerText: answerText.trim() },
            { onSuccess: () => setEditing(false) },
          );
        }}
      >
        <label className="flex flex-col gap-1 type-provenance text-[var(--muted)]">
          Question or topic
          <input
            className="rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 py-2 type-body text-[var(--text)]"
            data-testid="pinned-answer-pattern-input"
            onChange={(event) => setPattern(event.target.value)}
            value={pattern}
          />
        </label>
        <label className="flex flex-col gap-1 type-provenance text-[var(--muted)]">
          Exact wording
          <textarea
            className="min-h-24 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 py-2 type-body text-[var(--text)]"
            data-testid="pinned-answer-text-input"
            onChange={(event) => setAnswerText(event.target.value)}
            value={answerText}
          />
        </label>
        <div className="flex gap-2">
          <button
            className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1 text-[var(--bg)] disabled:opacity-40"
            data-testid="pinned-answer-save"
            disabled={dirty || editPinned.isPending || !reachable}
            type="submit"
          >
            Save
          </button>
          <button
            className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-[var(--muted)]"
            data-testid="pinned-answer-cancel"
            onClick={() => {
              setPattern(pinned.pattern);
              setAnswerText(pinned.answerText);
              setEditing(false);
            }}
            type="button"
          >
            Cancel
          </button>
        </div>
        <MutationError error={editPinned.error} />
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2 shape-entry p-4" data-testid="pinned-answer-card">
      <p className="type-provenance text-[var(--muted)]" data-testid="pinned-answer-pattern">
        Pinned to: {pinned.pattern}
      </p>
      <OwnerMessage>{pinned.answerText}</OwnerMessage>
      {pinned.sourceLabel && (
        <p className="type-provenance text-[var(--faint)]" data-testid="pinned-answer-source">
          {pinned.sourceLabel}
        </p>
      )}
      <div className="flex gap-2">
        <button
          className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-[var(--muted)]"
          data-testid="pinned-answer-edit"
          onClick={() => setEditing(true)}
          type="button"
        >
          Edit
        </button>
        <button
          className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-[var(--muted)] disabled:opacity-40"
          data-testid="pinned-answer-remove"
          disabled={deletePinned.isPending || !reachable}
          onClick={() => deletePinned.mutate({ id: pinned.id })}
          type="button"
        >
          Unpin
        </button>
      </div>
      <MutationError error={deletePinned.error} />
    </div>
  );
}
