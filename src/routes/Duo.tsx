import { useMemo, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useDrafts } from "../api/queries.js";
import type { DraftRecord } from "../api/types.js";
import { ConfidenceHairline } from "../components/ConfidenceHairline.js";
import { Composer } from "../components/Composer.js";
import { toDraftPipelineResult } from "../components/DraftCard.js";
import { DuoMessage } from "../components/DuoMessage.js";
import { OwnerMessage } from "../components/OwnerMessage.js";
import { SourceList } from "../components/SourceList.js";
import { StructuredText } from "../components/StructuredText.js";
import { Timestamp } from "../components/Timestamp.js";

/** §3.1's `threadContext: null` home — one group, so unthreaded questions are never scattered singles. */
const DEFAULT_THREAD_LABEL = "General";

/** What the conversation reads for each outcome — the honest record of what actually happened, never a paraphrase. */
function outcomeLabel(draft: DraftRecord): string {
  if (draft.outcome === null && draft.escalated && draft.refused) {
    // Review shows the refusal's reason but offers no action on it —
    // "waiting on you" would promise a decision that isn't there to make.
    return "Your duo refused this one.";
  }
  switch (draft.outcome) {
    case null:
      return "Waiting on you in Review.";
    case "sent":
      return "Sent";
    case "edited":
      return "Sent (edited)";
    case "discarded":
      return "Ignored";
    case "escalation_answered":
      return "You answered it — queued as a standing-order candidate.";
  }
}

/** What the duo's side of the conversation says: the text that was actually sent when something was, the draft otherwise. */
function responseText(draft: DraftRecord): string {
  if ((draft.outcome === "sent" || draft.outcome === "edited") && draft.sentText !== null) {
    return draft.sentText;
  }
  return draft.draftText ?? "";
}

/**
 * One question-and-answer turn. The same pieces as a DraftCard, minus the
 * disposition controls (Review owns those) — this is the read-back of the
 * loop, not a second place to run it.
 */
function ThreadEntry({ draft }: { draft: DraftRecord }) {
  return (
    // flex-row so the hairline leads the entry (#32) — a gutter rule you
    // scan a column by, not a strip across the top.
    <div className="flex flex-row gap-2" data-testid="thread-entry">
      <ConfidenceHairline result={toDraftPipelineResult(draft)} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <OwnerMessage>{draft.question}</OwnerMessage>
        {draft.escalated ? (
          <div className="rounded-[var(--r-lg)] border border-dashed border-[var(--edge)] px-4 py-3 text-[var(--muted)]" data-testid="escalation-reason">
            {draft.escalationReason}
          </div>
        ) : (
          <DuoMessage>
            <StructuredText text={responseText(draft)} />
          </DuoMessage>
        )}
        <p className="flex items-center gap-2 text-xs text-[var(--faint)]" data-testid="entry-outcome">
          {outcomeLabel(draft)}
          <Timestamp iso={draft.createdAt} />
        </p>
        <SourceList sources={draft.sources} />
      </div>
    </div>
  );
}

interface ThreadGroup {
  key: string | null;
  drafts: DraftRecord[];
}

/**
 * Groups drafts by `threadContext` (null → the General group). The daemon
 * lists `ORDER BY created_at, id` ascending (`src/drafting/draft-log.ts`),
 * so each group is already in conversation order and only the groups
 * themselves need ordering: most recently active first, the way a
 * conversations list reads.
 */
function groupByThread(drafts: DraftRecord[]): ThreadGroup[] {
  const byKey = new Map<string | null, DraftRecord[]>();
  for (const draft of drafts) {
    const key = draft.threadContext ?? null;
    const list = byKey.get(key);
    if (list) {
      list.push(draft);
    } else {
      byKey.set(key, [draft]);
    }
  }
  const lastActivity = (group: ThreadGroup) => group.drafts[group.drafts.length - 1]?.createdAt ?? "";
  return [...byKey.entries()].map(([key, list]) => ({ key, drafts: list })).sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
}

/**
 * §3.1's "thread view + composer" — the conversational read of the drafting
 * loop. v1 renders the personal duo's single thread space at a fixed
 * `#duo` segment: the personal duo carries no id and `POST /drafts` never
 * took one, so there is nothing to put in `:id` until a second
 * conversational duo exists.
 */
export function Duo({ api }: { api: DuoApiConfig }) {
  const { data: drafts, isLoading, error } = useDrafts(api);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);

  const groups = useMemo(() => groupByThread(drafts ?? []), [drafts]);
  // A selected group can vanish from under the composer (a refetch that no
  // longer carries it) — fall the *posting target* back with the label, not
  // just the label, or the caption would say General while still posting
  // into the stale context.
  const selectedExists = groups.some((group) => group.key === selectedThread);
  const thread = selectedExists ? selectedThread : null;
  const selectedLabel = selectedExists && selectedThread !== null ? selectedThread : DEFAULT_THREAD_LABEL;

  if (isLoading) {
    return <div className="p-6 text-[var(--muted)]">Loading…</div>;
  }
  if (error) {
    return <div className="p-6 text-[var(--refused)]">{(error as Error).message}</div>;
  }

  return (
    <div className="flex h-full flex-col" data-testid="duo-thread">
      <div className="flex-1 overflow-y-auto p-6">
        {groups.length === 0 ? (
          <div className="p-6 text-[var(--muted)]" data-testid="duo-empty">
            No conversation yet. Ask your duo something below — your questions, its drafts and escalations, and what you sent will all read here.
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section className="flex flex-col gap-3" data-testid="thread-group" key={group.key ?? "__general__"}>
                <button
                  className={
                    selectedThread === group.key
                      ? "self-start rounded-[var(--r-sm)] bg-[var(--surface)] px-2 py-1 text-xs font-medium uppercase tracking-wide"
                      : "self-start rounded-[var(--r-sm)] px-2 py-1 text-xs font-medium uppercase tracking-wide text-[var(--muted)]"
                  }
                  data-testid="thread-group-heading"
                  onClick={() => setSelectedThread(group.key)}
                >
                  {group.key ?? DEFAULT_THREAD_LABEL}
                </button>
                {group.drafts.map((draft) => (
                  <ThreadEntry key={draft.id} draft={draft} />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
      <Composer api={api} thread={thread} threadLabel={selectedLabel} />
    </div>
  );
}
