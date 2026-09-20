import { useMemo, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useDraftsFeed } from "../api/queries.js";
import type { DraftRecord } from "../api/types.js";
import { ConfidenceHairline } from "../components/ConfidenceHairline.js";
import { Composer } from "../components/Composer.js";
import { DeliveryStateLine } from "../components/DeliveryStateLine.js";
import { toDraftPipelineResult } from "../components/DraftCard.js";
import { DuoMessage } from "../components/DuoMessage.js";
import { OwnerMessage } from "../components/OwnerMessage.js";
import { ProvenanceLine } from "../components/ProvenanceLine.js";
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
        {/* #20: who asked, when the asker was a channel rather than you —
            placed before the response so the context reads first, and one
            click from the original when a permalink rode along. */}
        <ProvenanceLine provenance={draft.provenance} />
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
        {/* #21: whether the sent answer arrived — after the outcome, because
            the outcome stands whatever the transport did. */}
        <DeliveryStateLine delivery={draft.delivery} />
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
 * Groups drafts by `threadContext` (null → the General group). Consumes
 * ascending order — the feed reverses each newest-first page before this
 * (see `Duo` below) — so each group is already in conversation order and
 * only the groups themselves need ordering: most recently active first,
 * the way a conversations list reads.
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
 * conversational duo exists. #28 makes it navigable: the route opens on
 * the conversation list (most recently active first) and picking one
 * opens it alone, with the composer targeting whatever is open.
 * #29 pages the history underneath: the feed loads the newest window and
 * older entries arrive on demand, so the route stays fast as the draft
 * log grows.
 */
export function Duo({ api }: { api: DuoApiConfig }) {
  const feed = useDraftsFeed(api);
  // What is open: `null` is the conversation list, `{ key }` is one open
  // conversation (`key: null` = General). Not a bare string, because
  // "General is open" and "nothing is open" must not collapse into the
  // same state — the list is the route's landing view.
  const [open, setOpen] = useState<{ key: string | null } | null>(null);

  // Each page arrives newest-first (the daemon's limit shape); the view
  // reads oldest-first, and so does groupByThread. Reversing the page
  // order (page one is the newest window) and each page's entries makes
  // the concatenation ascending again — the same order the un-paged feed
  // that #29 replaced used to deliver directly.
  const drafts = useMemo(() => {
    const pages = feed.data?.pages ?? [];
    return [...pages].reverse().flatMap((page) => [...page].reverse());
  }, [feed.data]);

  const groups = useMemo(() => groupByThread(drafts), [drafts]);
  // The open conversation can vanish from a refetch that no longer carries
  // it. The view and the composer's target fall back together — never a
  // caption saying General while posting into a stale context, and never
  // an open view whose drafts are gone: General when it exists, the list
  // otherwise (General has no home to show when nothing unthreaded ever
  // happened).
  const openGroup =
    open === null ? undefined : groups.find((group) => group.key === open.key) ?? groups.find((group) => group.key === null);
  const thread = openGroup?.key ?? null;
  const threadLabel = openGroup?.key ?? DEFAULT_THREAD_LABEL;

  // isLoading covers the FIRST page only — the feed renders as soon as the
  // newest window arrives, never waiting on history behind it (#29).
  if (feed.isLoading) {
    return <div className="p-6 text-[var(--muted)]">Loading…</div>;
  }
  // Only a first-page failure blanks the route. A failed REFRESH (pages
  // already on screen) must not: swapping the feed for an error screen
  // would throw away exactly what #29's "without losing the owner's scroll
  // position" promises — the loaded pages stay rendered and the next
  // invalidation retries them.
  if (feed.error && feed.data === undefined) {
    return <div className="p-6 text-[var(--refused)]">{(feed.error as Error).message}</div>;
  }

  return (
    <div className="flex h-full flex-col" data-testid="duo-thread">
      <div className="flex-1 overflow-y-auto p-6">
        {groups.length === 0 ? (
          <div className="p-6 text-[var(--muted)]" data-testid="duo-empty">
            No conversation yet. Ask your duo something below — your questions, its drafts and escalations, and what you sent will all read here.
          </div>
        ) : openGroup ? (
          <div className="flex flex-col gap-3">
            <button
              className="self-start rounded-[var(--r-sm)] px-2 py-1 text-xs font-medium uppercase tracking-wide text-[var(--muted)]"
              data-testid="back-to-conversations"
              onClick={() => setOpen(null)}
            >
              All conversations
            </button>
            <section className="flex flex-col gap-3" data-testid="thread-group">
              <h2
                className="self-start rounded-[var(--r-sm)] bg-[var(--surface)] px-2 py-1 text-xs font-medium uppercase tracking-wide"
                data-testid="thread-group-heading"
              >
                {openGroup.key ?? DEFAULT_THREAD_LABEL}
              </h2>
              {openGroup.drafts.map((draft) => (
                <ThreadEntry key={draft.id} draft={draft} />
              ))}
            </section>
          </div>
        ) : (
          <nav aria-label="Conversations" className="flex flex-col gap-2" data-testid="conversation-list">
            {groups.map((group) => (
              <button
                className="rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 py-2 text-left text-[var(--text)]"
                data-testid="conversation-entry"
                key={group.key ?? "__general__"}
                onClick={() => setOpen({ key: group.key })}
              >
                {group.key ?? DEFAULT_THREAD_LABEL}
              </button>
            ))}
          </nav>
        )}
        {/* Older history arrives on demand (#29) — in the list view it can
            surface whole conversations that live only in unloaded pages, in
            an open conversation it extends the one being read. It disappears
            at the end of history (a short page means nothing older exists). */}
        {feed.hasNextPage ? (
          <button
            className="mx-auto mt-4 block rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1.5 text-xs text-[var(--muted)] disabled:opacity-50"
            data-testid="load-older"
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
          >
            {feed.isFetchingNextPage ? "Loading older…" : "Load older"}
          </button>
        ) : null}
      </div>
      <Composer api={api} thread={thread} threadLabel={threadLabel} />
    </div>
  );
}
