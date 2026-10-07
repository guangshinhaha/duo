import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useEditKnowledgeRecord, useExcludeEvidence, useRestoreEvidence } from "../api/queries.js";
import type { KnowledgeRecord } from "../api/types.js";
import { useSyncStatus } from "../sync.js";
import { MutationError } from "./MutationError.js";

// Date only, not a precise timestamp — same register Knows.tsx's own
// `formatDate` already uses for the last import, and Copy.test.ts's #149
// house style ("owner-facing times are relative by default") reserves an
// exact `toLocaleString`/`toLocaleTimeString` stamp for a handful of named
// surfaces where the precise time IS the promise (a scheduled send, an
// away-until). A record's provenance is "which day", not "which second".
const formatDate = (iso: string): string => new Date(iso).toLocaleDateString();

/**
 * duo#273 (digital-duo#286): one raw record as the Knows tab's browser
 * lists it — a single imported fact or exchange, with where it came from,
 * editable and removable in place. Modeled directly on `PinnedAnswerCard`
 * (the edit-in-place shape) and `SourceRemoveButton` (the remove/restore
 * verbs): "Remove" here is the exact same `useExcludeEvidence` mutation
 * that button already calls, not a second delete — removing a record from
 * this browser and removing it inline from a draft's Why panel are one
 * decision, reversible from either place.
 */
export function KnowledgeRecordCard({ api, record }: { api: DuoApiConfig; record: KnowledgeRecord }) {
  const editRecord = useEditKnowledgeRecord(api);
  const excludeEvidence = useExcludeEvidence(api);
  const restoreEvidence = useRestoreEvidence(api);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(record.text);
  const { reachable } = useSyncStatus();
  const dirty = text.trim().length === 0;

  if (editing) {
    return (
      <form
        className="flex flex-col gap-2 shape-entry p-4"
        data-testid="knowledge-record-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) {
            return;
          }
          editRecord.mutate({ id: record.id, text: text.trim() }, { onSuccess: () => setEditing(false) });
        }}
      >
        <textarea
          className="min-h-24 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 py-2 type-body text-[var(--text)]"
          data-testid="knowledge-record-text-input"
          onChange={(event) => setText(event.target.value)}
          value={text}
        />
        <div className="flex gap-2">
          <button
            className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1 text-[var(--bg)] disabled:opacity-40"
            data-testid="knowledge-record-save"
            disabled={dirty || editRecord.isPending || !reachable}
            type="submit"
          >
            Save
          </button>
          <button
            className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-[var(--muted)]"
            data-testid="knowledge-record-cancel"
            onClick={() => {
              setText(record.text);
              setEditing(false);
            }}
            type="button"
          >
            Cancel
          </button>
        </div>
        <MutationError error={editRecord.error} />
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2 shape-entry p-4" data-testid="knowledge-record-card">
      <div className="flex justify-between type-provenance text-[var(--faint)]" data-testid="knowledge-record-provenance">
        <span>
          {record.source} · {formatDate(record.timestamp)}
        </span>
        {record.editedAt && <span data-testid="knowledge-record-edited-marker">edited {formatDate(record.editedAt)}</span>}
      </div>
      <p className="whitespace-pre-wrap type-body text-[var(--text)]" data-testid="knowledge-record-text">
        {record.text}
      </p>
      {record.excluded ? (
        <p className="type-provenance text-[var(--muted)]" data-testid="knowledge-record-excluded-note">
          Removed. Won't be used by your duo again.
        </p>
      ) : null}
      <div className="flex gap-2">
        {!record.excluded && (
          <button
            className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-[var(--muted)]"
            data-testid="knowledge-record-edit"
            onClick={() => setEditing(true)}
            type="button"
          >
            Edit
          </button>
        )}
        {record.excluded ? (
          <button
            className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-[var(--muted)] disabled:opacity-40"
            data-testid="knowledge-record-restore"
            disabled={restoreEvidence.isPending || !reachable}
            onClick={() => restoreEvidence.mutate({ recordId: record.id })}
            type="button"
          >
            Restore
          </button>
        ) : (
          <button
            className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-[var(--muted)] disabled:opacity-40"
            data-testid="knowledge-record-remove"
            disabled={excludeEvidence.isPending || !reachable}
            onClick={() => excludeEvidence.mutate({ recordId: record.id })}
            type="button"
          >
            Remove
          </button>
        )}
      </div>
      <MutationError error={excludeEvidence.error ?? restoreEvidence.error} />
    </div>
  );
}
