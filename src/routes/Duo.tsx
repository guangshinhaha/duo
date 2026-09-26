import { useEffect, useMemo, useRef } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useDraftsFeed } from "../api/queries.js";
import type { DraftRecord } from "../api/types.js";
import { Composer } from "../components/Composer.js";
import { DraftTray } from "../components/DraftTray.js";
import { DuoLine } from "../components/DuoLine.js";
import { hairlineState } from "../components/ConfidenceHairline.js";
import { toDraftPipelineResult } from "../components/DraftCard.js";
import { Mark } from "../components/Mark.js";
import { OwnerMessage } from "../components/OwnerMessage.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { SourceList } from "../components/SourceList.js";
import { StructuredText } from "../components/StructuredText.js";
import { Timestamp } from "../components/Timestamp.js";

/**
 * Whether a draft is a turn of the owner's own conversation with their duo:
 * a question they asked it. A question somebody else asked belongs to the
 * chat it arrived in, and a row that predates provenance (`unknown`) is not
 * known to be either — it stays where it always was, on its own page and in
 * Waiting on you, rather than being guessed into this chat.
 */
export function isOwnTurn(draft: DraftRecord): boolean {
  return draft.provenance?.origin === "owner";
}

/** What the conversation says for each outcome — the honest record of what actually happened, never a paraphrase. */
function outcomeLabel(draft: DraftRecord): string {
  if (draft.outcome === null && draft.escalated && draft.refused) {
    return "Your duo refused this one.";
  }
  switch (draft.outcome) {
    case null:
      return "Waiting on you.";
    case "sent":
      return "Kept";
    case "edited":
      return "Kept (edited)";
    case "discarded":
      return "Dismissed";
    case "escalation_answered":
      return "You answered it — queued as a standing-order candidate.";
  }
}

/** What the duo's side says: the text that was actually kept when something was, the draft otherwise. */
function responseText(draft: DraftRecord): string {
  if ((draft.outcome === "sent" || draft.outcome === "edited") && draft.sentText !== null) {
    return draft.sentText;
  }
  return draft.draftText ?? "";
}

function dayLabel(iso: string): string {
  const when = new Date(iso);
  const today = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return same(when, today) ? "Today" : same(when, yesterday) ? "Yesterday" : when.toLocaleDateString();
}

/**
 * One turn: what you asked, on your side of the chat, and — once it has been
 * decided — what your duo said, behind its line with what it drew on
 * beneath. A turn still waiting on you has only your side here; its answer
 * is in the tray above the box you type in, because a draft is never part of
 * the transcript until it is decided (AR-14).
 */
function Turn({ draft }: { draft: DraftRecord }) {
  const pending = draft.outcome === null && !(draft.escalated && draft.refused);
  return (
    <div className="flex flex-col gap-2" data-testid="thread-entry">
      <OwnerMessage bubble>{draft.question}</OwnerMessage>
      {!pending && (
        <>
          <div className="max-w-[90%]">
            <DuoLine
              attributionTestId="duo-line-attribution"
              label="Your duo"
              meta={<Timestamp iso={draft.createdAt} />}
              state={hairlineState(toDraftPipelineResult(draft))}
              testId="duo-answer"
            >
              {draft.escalated ? (
                <p className="type-body text-[var(--muted)]" data-testid="escalation-reason">
                  {draft.escalationReason}
                </p>
              ) : (
                <StructuredText text={responseText(draft)} />
              )}
            </DuoLine>
          </div>
          <SourceList sources={draft.sources} />
          <p className="type-provenance text-[var(--faint)]" data-testid="entry-outcome">
            {outcomeLabel(draft)}
            {draft.threadContext ? ` · about ${draft.threadContext}` : ""}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Your duo, as a chat (docs/design-language.md §6.2, epic #138): one
 * continuous conversation, pinned first in your chats and always there,
 * with or without a workspace. Ask it anything below; what you asked reads
 * on your side, and its answers on its side — always behind its line, with
 * the sources it drew on underneath. An answer waiting on you (Keep, Edit,
 * Dismiss) is the tray above the box you type in, exactly as in any chat.
 *
 * This is the read-back of the loop and where its asking lives; the thread
 * context a question may carry (`threadContext`) is metadata on its answer,
 * no longer a place you navigate to. History pages in underneath (#29): the
 * newest window first, older turns on demand. Tapping the name opens the
 * duo's profile.
 */
export function Duo({ api }: { api: DuoApiConfig }) {
  const feed = useDraftsFeed(api);

  // Each page arrives newest-first (the daemon's limit shape); a chat reads
  // oldest-first. Reversing the page order (page one is the newest window)
  // and each page's entries makes the concatenation ascending again.
  const turns = useMemo(() => {
    const pages = feed.data?.pages ?? [];
    return [...pages].reverse().flatMap((page) => [...page].reverse()).filter(isOwnTurn);
  }, [feed.data]);
  const waiting = turns.filter((draft) => draft.outcome === null && !(draft.escalated && draft.refused));

  // A chat opens at its end, and stays there as turns arrive.
  const scroller = useRef<HTMLDivElement | null>(null);
  const lastId = turns[turns.length - 1]?.id;
  useEffect(() => {
    const el = scroller.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lastId]);

  // isLoading covers the FIRST page only — the chat renders as soon as the
  // newest window arrives, never waiting on history behind it (#29).
  if (feed.isLoading) {
    return <RouteLoading />;
  }
  // Only a first-page failure blanks the route. A failed REFRESH (pages
  // already on screen) must not: swapping the chat for an error screen would
  // throw away what #29 promises — the loaded pages stay and the next
  // invalidation retries them.
  if (feed.error && feed.data === undefined) {
    return <RouteError api={api} error={feed.error} onRetry={() => void feed.refetch()} />;
  }

  let previousDay = "";
  return (
    <div className="flex h-full flex-col" data-testid="duo-thread">
      <header className="flex items-center gap-3 border-b border-[var(--edge)] px-4 py-3">
        <span
          aria-hidden="true"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)]"
        >
          <Mark />
        </span>
        <div className="flex min-w-0 flex-col">
          {/* #39: the page's h1 is the duo's name — and the way into its profile. */}
          <h1 className="type-heading">
            <a className="rounded-[var(--r-sm)]" data-testid="duo-profile-link" href="#duo/profile">
              Your duo
            </a>
          </h1>
          <p className="type-provenance text-[var(--faint)]">Only you can see this chat</p>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-4" ref={scroller}>
        {/* Older history arrives on demand (#29), at the top where older things are. */}
        {feed.hasNextPage ? (
          <button
            className="mx-auto mb-4 flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance text-[var(--muted)] disabled:opacity-50"
            data-testid="load-older"
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
          >
            {feed.isFetchingNextPage ? "Loading older…" : "Load older"}
          </button>
        ) : null}
        {turns.length === 0 ? (
          <div className="p-6 text-[var(--muted)]" data-testid="duo-empty">
            Ask your duo anything below. What you ask and what it answers read here, and only you can see this chat.
          </div>
        ) : (
          // #33: gap-5 is Part 4's density — 20px between speakers, the air that makes a handful of considered turns read as considered.
          <section className="flex flex-col gap-5" data-testid="thread-group">
            {turns.map((draft) => {
              const day = dayLabel(draft.createdAt);
              const divider = day !== previousDay;
              previousDay = day;
              return (
                <div className="flex flex-col gap-5" key={draft.id}>
                  {divider && <p className="self-center type-identifier text-[var(--faint)]">{day}</p>}
                  <Turn draft={draft} />
                </div>
              );
            })}
          </section>
        )}
      </div>
      {/* Answers waiting on you: above the composer, never in the transcript (AR-14). */}
      {waiting.length > 0 && (
        <div className="flex max-h-96 flex-col overflow-y-auto" data-testid="duo-drafts">
          {waiting.map((draft, index) => (
            <DraftTray api={api} draft={draft} key={draft.id} keyboard={index === 0} />
          ))}
        </div>
      )}
      <Composer api={api} thread={null} />
    </div>
  );
}
