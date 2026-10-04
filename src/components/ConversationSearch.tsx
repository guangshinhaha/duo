import { useInfiniteQuery } from "@tanstack/react-query";
import { RoomDuoMessage } from "./RoomDuoMessage.js";
import { RoomPersonMessage } from "./RoomPersonMessage.js";
import { Timestamp } from "./Timestamp.js";
import { duoOwnerLabel, isDuoUserId } from "../workspace/identity.js";
import { roomHref, threadHref } from "../workspace/links.js";
import { mentionLabelOf } from "../workspace/mentions.js";
import type { MessageSearchHit, MessageSearchPage, RoomSummary, SearchContextLine, WorkspaceConnection } from "../workspace/matrix.js";

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
 */
export function MessageSearchResults({
  connection,
  query,
  rooms,
  titleOf,
  onClear,
}: {
  connection: WorkspaceConnection;
  query: string;
  rooms: readonly RoomSummary[];
  titleOf: (room: RoomSummary) => string;
  onClear: () => void;
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

  return (
    <div className="mt-3" data-testid="message-search-results">
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
      {hits.length > 0 && (
        <ol className="mt-2 flex flex-col gap-4">
          {hits.map((hit) => (
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
