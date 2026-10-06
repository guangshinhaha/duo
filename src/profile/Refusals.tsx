import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useMirrorRefusals, useRemoveNeverAnswer, useSaveNeverAnswer } from "../api/queries.js";
import type { Refusal } from "../api/types.js";
import { MutationError } from "../components/MutationError.js";

const inputClass = "min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2 type-body";
const buttonClass = "inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body disabled:opacity-40";

/** Editing one rule in place: its subject and the words shown back for it. */
function EditRule({ api, refusal, onDone }: { api: DuoApiConfig; refusal: Refusal; onDone: () => void }) {
  const [subject, setSubject] = useState(refusal.heading);
  const [reason, setReason] = useState(refusal.reason);
  const save = useSaveNeverAnswer(api);
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="refusal-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (subject.trim().length > 0 && !save.isPending) {
          save.mutate({ editing: refusal.heading, input: { subject: subject.trim(), reason: reason.trim() } }, { onSuccess: onDone });
        }
      }}
    >
      <label className="flex flex-col gap-1 type-provenance text-[var(--muted)]">
        Never answers about
        <input className={inputClass} data-testid="refusal-edit-subject" onChange={(e) => setSubject(e.target.value)} value={subject} />
      </label>
      <label className="flex flex-col gap-1 type-provenance text-[var(--muted)]">
        In your words
        <textarea className={`${inputClass} py-2`} data-testid="refusal-edit-reason" onChange={(e) => setReason(e.target.value)} rows={2} value={reason} />
      </label>
      <div className="flex gap-2">
        <button className={buttonClass} data-testid="refusal-edit-save" disabled={subject.trim().length === 0 || save.isPending} type="submit">
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button className={buttonClass} onClick={onDone} type="button">
          Cancel
        </button>
      </div>
      <MutationError error={save.error} />
    </form>
  );
}

function RuleRow({ api, refusal }: { api: DuoApiConfig; refusal: Refusal }) {
  const [editing, setEditing] = useState(false);
  const remove = useRemoveNeverAnswer(api);
  if (editing) {
    return (
      <div className="shape-entry p-4" data-testid="refusal">
        <EditRule api={api} onDone={() => setEditing(false)} refusal={refusal} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 shape-entry p-4" data-testid="refusal">
      <h3 className="type-heading" data-testid="refusal-heading">
        {refusal.heading}
      </h3>
      {refusal.reason.length > 0 ? (
        <p className="type-body whitespace-pre-wrap text-[var(--muted)]" data-testid="refusal-reason">
          {refusal.reason}
        </p>
      ) : (
        <p className="type-provenance text-[var(--faint)]">No reason written.</p>
      )}
      <div className="flex gap-2 pt-1">
        <button className={buttonClass} data-testid="refusal-edit-open" onClick={() => setEditing(true)} type="button">
          Edit
        </button>
        <button
          className={buttonClass}
          data-testid="refusal-remove"
          disabled={remove.isPending}
          onClick={() => remove.mutate(refusal.heading)}
          type="button"
        >
          {remove.isPending ? "Removing…" : "Remove"}
        </button>
      </div>
      <MutationError error={remove.error} />
    </div>
  );
}

/** Adding a rule, written as the owner would say it. */
function AddRule({ api }: { api: DuoApiConfig }) {
  const [rule, setRule] = useState("");
  const save = useSaveNeverAnswer(api);
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="refusal-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (rule.trim().length > 0 && !save.isPending) {
          save.mutate({ input: { rule: rule.trim() } }, { onSuccess: () => setRule("") });
        }
      }}
    >
      <label className="flex flex-col gap-1 type-body">
        Add a rule, in your words
        <input
          className={inputClass}
          data-testid="refusal-add-input"
          onChange={(e) => {
            setRule(e.target.value);
            save.reset();
          }}
          placeholder="I never answer about budget approvals"
          value={rule}
        />
      </label>
      <button
        className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
        data-testid="refusal-add-save"
        disabled={rule.trim().length === 0 || save.isPending}
        type="submit"
      >
        {save.isPending ? "Saving…" : "Add rule"}
      </button>
      <MutationError error={save.error} />
    </form>
  );
}

/**
 * Never answers (#269, building on #53's refusals): subjects your duo always
 * passes to you, never answers — `duo/refusals.md`, the one list every check
 * already reads. Each rule is in your words: you write it ("I never answer
 * about budget approvals"), the subject it matches is read off it, and your
 * sentence is what shows back. A colleague who asks about one is told it was
 * passed to you, and nothing more. The daemon's `decided` flag still tells
 * "never asked" from "asked, and there are none".
 */
export function RefusalsSection({ api }: { api: DuoApiConfig }) {
  const refusals = useMirrorRefusals(api);

  let body: React.ReactNode = null;
  if (refusals.isLoading) {
    body = <div className="text-[var(--muted)]">Loading never-answer rules…</div>;
  } else if (refusals.error) {
    body = <div className="text-[var(--refused)]">{(refusals.error as Error).message}</div>;
  } else if (refusals.data) {
    const { decided, refusals: list } = refusals.data;
    if (!decided) {
      body = (
        <p className="type-provenance text-[var(--faint)]" data-testid="refusals-undecided">
          You haven&apos;t been asked yet what your duo must never answer. Add a rule below, or leave it empty if there&apos;s nothing.
        </p>
      );
    } else if (list.length === 0) {
      body = (
        <p className="type-provenance text-[var(--faint)]" data-testid="refusals-none">
          You reviewed this and recorded none — your duo has no never-answer rules.
        </p>
      );
    } else {
      body = (
        <div className="flex flex-col gap-3">
          {list.map((refusal) => (
            <RuleRow api={api} key={refusal.heading} refusal={refusal} />
          ))}
        </div>
      );
    }
  }

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="refusals">
      <h2 className="type-heading">Never answers{refusals.data && refusals.data.decided ? ` (${refusals.data.refusals.length})` : ""}</h2>
      <p className="type-provenance text-[var(--muted)]">Subjects your duo always passes to you. Whoever asked is told it went to you.</p>
      {body}
      {refusals.data && <AddRule api={api} />}
    </section>
  );
}
