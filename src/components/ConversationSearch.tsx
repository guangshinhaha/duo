import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
// Type-only: `WorkspaceSearch.test.tsx`'s structural test walks this file's
// VALUE imports and refuses any that reach `src/api/*` ("the message search
// must not reach the daemon's api") — a `type` import carries no record
// across that boundary (its own words) and the regex that walks the
// closure excludes it by construction. The actual call, when there's a duo
// to make it with, is owned by `CommandSearch.tsx` (outside that closure,
// the same seam `PersonProfile.tsx`'s api calls already sit behind) and
// handed in as `onAnswer`, a plain function — never `api` itself.
import type { SearchAnswerHit, SearchAnswerResult } from "../api/types.js";
import { DuoMessage } from "./DuoMessage.js";
import { RoomDuoMessage } from "./RoomDuoMessage.js";
import { RoomPersonMessage } from "./RoomPersonMessage.js";
import { Timestamp } from "./Timestamp.js";
import { duoOwnerLabel, isDuoUserId } from "../workspace/identity.js";
import { roomHref, threadHref } from "../workspace/links.js";
import { mentionLabelOf } from "../workspace/mentions.js";
import { filterChips, matchesFilters, withoutFilter, type SearchFilters } from "../workspace/searchQuery.js";
import type { MessageSearchHit, MessageSearchPage, RoomSummary, SearchContextLine, WorkspaceConnection } from "../workspace/matrix.js";

/** duo#300: how many of the (already homeserver-ranked) filtered hits ride the answer prompt — bounded independently of the daemon's own `MAX_HITS`, so this stays a deliberate choice even if that changes. */
const ANSWER_MAX_HITS = 8;

/**
 * #70: search what was said, projected. The workspace searches the messages
 * of the conversations the member is in (the homeserver's own search —
 * membership-scoped there, not here), and each hit reads with its
 * conversation, its author, and the words around it, and opens at that
 * message in context.
 *
 * This is the SHARED search's renderer. The other search in this product —
 * what a duo knows (#46, the corpus) — is private, lives on its owner's Mac,
 * and is a different component reading a different store; nothing here
 * imports it, and nothing there imports this.
 *
 * Attribution is the room's (#60): a duo's hit renders as that duo's message
 * from its user id ("carol's duo"), a person's by their name, and every
 * context line's label comes from the same grammar — so the words of a
 * duo's answer, found by search, are still visibly the duo's.
 *
 * #207: the entry point for a search — the input, and the decision to run
 * one — moved to `CommandSearch.tsx`, the one search box that also finds
 * people and conversations. This module is now just the hand-off's answer:
 * `CommandSearch` renders this in place of the conversation list once the
 * member picks "Search messages for '…'", exactly the way this file used to
 * show it itself, and `onClear` hands control back the same way.
 *
 * duo#300: `filters` (from:/in:/before:/after:, parsed by
 * `workspace/searchQuery.ts`) narrow the hits this component already has —
 * never a second ask of the homeserver (see that module's own doc comment
 * on why: `WorkspaceSearchSeam.test.ts` pins that `searchMessages` takes no
 * room or sender scoping of its own). `onAnswer` is optional and owned by
 * `CommandSearch` (never this module — see the import comment above):
 * `undefined` with no duo paired, the same "nothing to call it with" shape
 * `onRewrite`/`onFactCheck` already use for Room.tsx's composer.
 */
export function MessageSearchResults({
  connection,
  query,
  filters,
  onFiltersChange,
  rooms,
  titleOf,
  onClear,
  onAnswer,
}: {
  connection: WorkspaceConnection;
  query: string;
  filters: SearchFilters;
  onFiltersChange: (filters: SearchFilters) => void;
  rooms: readonly RoomSummary[];
  titleOf: (room: RoomSummary) => string;
  onClear: () => void;
  /** duo#300: `undefined` with no duo paired. Owned by `CommandSearch`, never this module (see the file's own import comment). */
  onAnswer?: (input: { query: string; hits: readonly SearchAnswerHit[] }) => Promise<SearchAnswerResult>;
}) {
  const search = useInfiniteQuery({
    // Under the workspace's own key, so signing out (which clears the cache)
    // and every live invalidation treat it like the rest of the workspace.
    queryKey: ["workspace", "search", query],
    queryFn: ({ pageParam }): Promise<MessageSearchPage> => connection.searchMessages(query, pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next,
    // A search is the member's own gesture: a failure is said at once, with
    // its way to try again, not retried behind their back — and its answer
    // is not kept once nobody is looking (App.tsx keeps it out of the
    // persisted cache too): asked again, it is asked of the workspace again,
    // so a conversation the member has since left can't ride back in.
    retry: false,
    gcTime: 0,
    meta: { target: "workspace" },
  });
  const hits = search.data?.pages.flatMap((page) => page.hits) ?? [];
  const titleOfRoom = (roomId: string): string => {
    const room = rooms.find((candidate) => candidate.roomId === roomId);
    return room ? titleOf(room) : roomId;
  };
  const filteredHits = hits.filter((hit) => matchesFilters(hit, titleOfRoom(hit.roomId), filters));
  const chips = filterChips(filters);

  return (
    <div className="mt-3" data-testid="message-search-results">
      <SearchAnswer onAnswer={onAnswer} query={query} hits={filteredHits} rooms={rooms} titleOf={titleOf} />
      {chips.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1" data-testid="message-search-filters" aria-label="Search filters">
          {chips.map((chip) => (
            <li key={chip.key}>
              <button
                className="inline-flex min-h-6 items-center gap-1 rounded-full border border-[var(--edge)] bg-[var(--surface-2)] px-2 type-provenance text-[var(--text)]"
                data-testid={`message-search-filter-${chip.key}`}
                onClick={() => onFiltersChange(withoutFilter(filters, chip.key))}
                type="button"
              >
                {chip.label}
                <span aria-hidden="true">×</span>
                <span className="sr-only">Remove filter {chip.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="type-provenance uppercase text-[var(--faint)]">Said in your conversations</p>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance text-[var(--muted)]"
          data-testid="message-search-clear"
          onClick={onClear}
          type="button"
        >
          Clear search
        </button>
      </div>
      {search.isLoading && (
        <p className="mt-2 type-body text-[var(--muted)]" role="status">
          Searching…
        </p>
      )}
      {search.error !== null && (
        <div className="mt-2" data-testid="message-search-error" role="alert">
          <p className="type-body text-[var(--escalate)]">The workspace didn&apos;t search — try again.</p>
          <button
            className="mt-2 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
            onClick={() => void search.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      )}
      {search.isSuccess && hits.length === 0 && (
        <p className="mt-2 type-body text-[var(--muted)]" data-testid="message-search-empty">
          Nothing said in your conversations matches that.
        </p>
      )}
      {search.isSuccess && hits.length > 0 && filteredHits.length === 0 && (
        <p className="mt-2 type-body text-[var(--muted)]" data-testid="message-search-filtered-empty">
          Nothing matches these filters yet{search.hasNextPage ? " — try Load more, or remove a filter." : "."}
        </p>
      )}
      {filteredHits.length > 0 && (
        <ol className="mt-2 flex flex-col gap-4">
          {filteredHits.map((hit) => (
            <li key={`${hit.roomId}/${hit.eventId}`}>
              <SearchHit hit={hit} rooms={rooms} titleOf={titleOf} />
            </li>
          ))}
        </ol>
      )}
      {search.hasNextPage && (
        <button
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance text-[var(--muted)] disabled:opacity-40"
          data-testid="message-search-more"
          disabled={search.isFetchingNextPage}
          onClick={() => void search.fetchNextPage()}
          type="button"
        >
          {search.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

/**
 * duo#300: the answer on top — deliberately asked, never automatic. A plain
 * search only ever asks the workspace (`WorkspaceSearch.test.tsx`'s own
 * acceptance test pins exactly that: the daemon sees no request at all
 * until this component's own button is pressed); the member decides
 * whether running a search was "find a message" or "ask a question", and
 * only the second one costs an inference call. Asking calls
 * `POST /search/answer` with exactly the (bounded, already-filtered) hits
 * this search already has — no corpus, no second search — and renders
 * through `DuoMessage` (Hairline P1: generated text always sits behind the
 * line and under its attribution), with its sources as plain links
 * beneath it, the same `roomHref`/`threadHref` every other hit opens
 * through. Renders no button at all with no duo paired or no hits to
 * answer from.
 */
function SearchAnswer({
  onAnswer,
  query,
  hits,
  rooms,
  titleOf,
}: {
  onAnswer?: (input: { query: string; hits: readonly SearchAnswerHit[] }) => Promise<SearchAnswerResult>;
  query: string;
  hits: readonly MessageSearchHit[];
  rooms: readonly RoomSummary[];
  titleOf: (room: RoomSummary) => string;
}) {
  const bounded = hits.slice(0, ANSWER_MAX_HITS);
  const key = bounded.map((hit) => hit.eventId).join(",");
  const thisAsk = `${query}\u0000${key}`;
  // A changed query or filter set is a different question — `asked` only
  // ever names a result for exactly `thisAsk`, so narrowing or widening the
  // results after asking returns to the un-asked button rather than
  // showing a stale answer for a set of hits that's no longer on screen.
  const [asked, setAsked] = useState<{ key: string; pending: boolean; result: SearchAnswerResult | null } | null>(null);

  if (!onAnswer || bounded.length === 0) {
    return null;
  }

  if (asked === null || asked.key !== thisAsk) {
    return (
      <button
        className="mb-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--muted)]"
        data-testid="message-search-ask-answer"
        onClick={() => {
          setAsked({ key: thisAsk, pending: true, result: null });
          onAnswer({ query, hits: bounded.map((hit) => ({ id: hit.eventId, text: hit.body, from: hit.senderName })) }).then(
            (outcome) => setAsked((current) => (current?.key === thisAsk ? { key: thisAsk, pending: false, result: outcome } : current)),
            () => setAsked((current) => (current?.key === thisAsk ? { key: thisAsk, pending: false, result: null } : current)),
          );
        }}
        type="button"
      >
        Ask your duo about these results
      </button>
    );
  }

  if (asked.pending) {
    return (
      <p className="mb-3 type-body text-[var(--muted)]" data-testid="message-search-answer-loading">
        Your duo is looking for an answer…
      </p>
    );
  }

  const result = asked.result;
  // Requires `kind === "answered"` explicitly (not merely "not no_answer")
  // and a real array for `citedIds`: `apiRequest` casts the daemon's JSON
  // with no runtime check (`client.ts`'s own doc comment on `ApiRequestError`
  // says as much), so a malformed or stubbed response must read as "nothing
  // to show", never crash this surface.
  if (result === null || result.kind !== "answered" || !Array.isArray(result.citedIds)) {
    return (
      <p className="mb-3 type-body text-[var(--muted)]" data-testid="message-search-answer-none">
        Your duo couldn&apos;t find a direct answer in these results.
      </p>
    );
  }
  const cited = bounded.filter((hit) => result.citedIds.includes(hit.eventId));
  return (
    <div className="mb-3" data-testid="message-search-answer">
      <DuoMessage>{result.text}</DuoMessage>
      {cited.length > 0 && (
        <ul className="mt-1 flex flex-col gap-0.5 pl-1" aria-label="Sources">
          {cited.map((hit) => {
            const room = rooms.find((candidate) => candidate.roomId === hit.roomId);
            const title = room ? titleOf(room) : hit.roomId;
            const href = hit.threadRootEventId !== null ? threadHref(hit.roomId, hit.threadRootEventId, hit.eventId) : roomHref(hit.roomId, hit.eventId);
            return (
              <li key={hit.eventId} className="type-provenance text-[var(--faint)]">
                <a className="underline" data-testid="message-search-answer-source" href={href}>
                  {hit.senderName} in {title}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** A context line's label — the id grammar's, the way a thread preview's is: "carol's duo", never a chosen name. */
function lineLabel(line: SearchContextLine): string {
  return mentionLabelOf(line.senderId, line.senderName);
}

/** One hit: where it was said, who said it (attributed by id), the words around it, and the way in. */
function SearchHit({
  hit,
  rooms,
  titleOf,
}: {
  hit: MessageSearchHit;
  rooms: readonly RoomSummary[];
  titleOf: (room: RoomSummary) => string;
}) {
  const room = rooms.find((candidate) => candidate.roomId === hit.roomId);
  const title = room ? titleOf(room) : hit.roomId;
  const href = hit.threadRootEventId !== null ? threadHref(hit.roomId, hit.threadRootEventId, hit.eventId) : roomHref(hit.roomId, hit.eventId);
  const words = hit.body;

  return (
    <article className="flex flex-col gap-1" data-testid="message-search-hit">
      <p className="type-provenance text-[var(--muted)]" data-testid="message-search-hit-room">
        {title}
      </p>
      {hit.context.before.map((line, index) => (
        <ContextLine key={`before-${index}`} line={line} />
      ))}
      {isDuoUserId(hit.senderId) ? (
        <RoomDuoMessage ownerName={duoOwnerLabel(hit.senderId) ?? hit.senderName}>{words}</RoomDuoMessage>
      ) : (
        <RoomPersonMessage authorName={hit.senderName}>{words}</RoomPersonMessage>
      )}
      {hit.context.after.map((line, index) => (
        <ContextLine key={`after-${index}`} line={line} />
      ))}
      <p className="type-provenance text-[var(--faint)]">
        <Timestamp iso={new Date(hit.originServerTs).toISOString()} />{" "}
        <a
          aria-label={`Open this message in ${title}`}
          className="underline"
          data-testid="message-search-hit-open"
          href={href}
        >
          Open in conversation
        </a>
      </p>
    </article>
  );
}

function ContextLine({ line }: { line: SearchContextLine }) {
  return (
    <p className="truncate type-provenance text-[var(--faint)]" data-testid="message-search-context">
      {lineLabel(line)}: {line.body}
    </p>
  );
}
