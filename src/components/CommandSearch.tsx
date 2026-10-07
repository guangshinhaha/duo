import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useSearchAnswer } from "../api/queries.js";
import type { SearchAnswerHit } from "../api/types.js";
import { MessageSearchResults } from "./ConversationSearch.js";
import { PersonProfile } from "./PersonProfile.js";
import { directoryEntryLabel, duoOwnerUserIdOf, isDuoUserId } from "../workspace/identity.js";
import { roomHref } from "../workspace/links.js";
import { EMPTY_SEARCH_FILTERS, parseSearchQuery, type SearchFilters } from "../workspace/searchQuery.js";
import type { NotificationMode, RoomSummary, WorkspaceConnection } from "../workspace/matrix.js";
import { readRecentActionIds, recordRecentAction } from "../commandPaletteRecents.js";

/** How long to wait, after the member stops typing, before asking the directory — long enough that every keystroke doesn't cost a request, short enough to still feel instant. */
const PEOPLE_DEBOUNCE_MS = 150;

/** What the one search box found, by its own id — a person, else a duo's id reads a conversation's recipient the same door. */
type PersonHit = { readonly userId: string; readonly name: string };

/** duo#302: one thing the palette can DO, not find — a global verb ("New conversation") or one scoped to whichever conversation is open ("Mark … as read"). `run` is the whole dispatch: every action reuses an existing callback (`ChatList.tsx`'s own `markRead`/`setMode`, the same functions its "more" panel already calls), never a parallel mechanism. */
export interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
}

/** One row of the listbox: a conversation, a person, an action, or the hand-off to the full message search. */
type Item =
  | { readonly kind: "room"; readonly room: RoomSummary }
  | { readonly kind: "action"; readonly action: PaletteAction }
  | { readonly kind: "person"; readonly person: PersonHit }
  | { readonly kind: "messages" };

/**
 * #207: one search box that finds people, conversations and messages, with
 * suggestions as the member types. Conversations filter locally, on every
 * keystroke, from what this client already has (`findRooms`) — never a
 * network call. People come from the workspace's directory (`searchPeople`),
 * debounced, since that one does ask the homeserver. A person who already
 * has a direct conversation open shows as that conversation, not again as a
 * person — the same individual should not read twice.
 *
 * The box keeps "search what was said" rather than retiring it: typing and
 * choosing "Search messages for '…'" hands off to exactly the same
 * `MessageSearchResults` this surface always rendered (`ConversationSearch.tsx`,
 * #70), in place of the conversation list, the same way a submitted search
 * always has. Choosing a person opens their profile (`PersonProfile.tsx`);
 * choosing a conversation opens it.
 *
 * A grouped combobox (WAI-ARIA listbox pattern): the input keeps focus,
 * `aria-activedescendant` says which suggestion is current, and ↑/↓/Enter/Esc
 * move and choose without a mouse.
 *
 * duo#302 adds a fourth section, **Actions**, between Conversations and
 * People — things the palette DOES rather than finds: "New conversation",
 * "Ask my duo", "Open settings" always, and (only with a conversation open)
 * "Mark … as read"/"Mute …" for that one. Every action calls straight into
 * a callback this app already has elsewhere (`ChatList.tsx`'s own
 * `markRead`/`setMode`, the same functions its "more" panel buttons call) —
 * never a second copy of that logic. Matched by a plain case-insensitive
 * substring on the label, shown always (even with an empty query, so the
 * palette has something to offer the moment it opens), and ordered with
 * whatever was run most recently first (`commandPaletteRecents.ts`).
 *
 * Inserting a new section between two existing ones is exactly the kind of
 * change #301/#302's own process note warns about ("a real production
 * incident happened tonight from a shared-dispatch-path change") — the
 * indices every section's row and every keyboard test depends on
 * (`optionId`, `activeIndex`, "ArrowUp wraps to the last suggestion") are
 * recomputed from each section's own length below, never hand-counted, so
 * adding Actions shifts People's and the message hand-off's positions
 * without changing what reaching them by keyboard or click still does.
 */
export function CommandSearch({
  api = null,
  connection,
  rooms,
  titleOf,
  onStartedConversation,
  onNewConversation,
  activeRoom = null,
  onMarkRead,
  onSetNotificationMode,
  children,
}: {
  /** #262: handed straight through to the person profile this search can open — lets it read and reset that person's learned-tone adaptation. */
  api?: DuoApiConfig | null;
  connection: WorkspaceConnection;
  rooms: readonly RoomSummary[];
  /** How a conversation reads under its title — the list's own rule, so a suggestion says the same name the list does. */
  titleOf: (room: RoomSummary) => string;
  /** A direct conversation was opened (started, or reused) from a person's suggestion or their profile — the caller navigates to it. */
  onStartedConversation: (roomId: string) => void;
  /** duo#302: the global "New conversation" action — omitted, the action isn't offered (there's always somewhere this should come from; it's optional only so a caller with nowhere to put the dialog isn't forced to stub one). */
  onNewConversation?: () => void;
  /** duo#302: whichever conversation is open right now, if any — gates the conversation-scoped actions ("Mark … as read", "Mute …"); `null` (nothing open, or the caller doesn't track this) simply omits them. */
  activeRoom?: RoomSummary | null;
  /** duo#302: the exact function `ChatList.tsx`'s own "Mark as read" button already calls — reused, not re-implemented. */
  onMarkRead?: (room: RoomSummary) => void;
  /** duo#302: the exact function `ChatList.tsx`'s own notification `<select>` already calls. */
  onSetNotificationMode?: (room: RoomSummary, mode: NotificationMode) => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  // duo#300: the answer-on-top's call is owned here, never by
  // `ConversationSearch.tsx` (`WorkspaceSearch.test.tsx`'s own structural
  // test: the message search must not reach the daemon's api) — same seam
  // `PersonProfile.tsx`'s own api calls already sit behind. `onAnswer` is
  // `undefined` with no duo paired, matching `onRewrite`/`onFactCheck`'s
  // shape in `App.tsx` for Room.tsx's composer.
  const searchAnswerMutation = useSearchAnswer(api);
  const onAnswer = api ? (input: { query: string; hits: readonly SearchAnswerHit[] }) => searchAnswerMutation.mutateAsync(input) : undefined;
  const [roomMatches, setRoomMatches] = useState<readonly RoomSummary[]>([]);
  const [peopleMatches, setPeopleMatches] = useState<readonly PersonHit[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [messageQuery, setMessageQuery] = useState<string | null>(null);
  // duo#300: from:/in:/before:/after:, parsed out of the query at the moment
  // the member hands off to "Search messages for '…'" — narrows the hits
  // `MessageSearchResults` already has, never a second ask of the workspace.
  const [messageFilters, setMessageFilters] = useState<SearchFilters>(EMPTY_SEARCH_FILTERS);
  const [selectedPerson, setSelectedPerson] = useState<PersonHit | null>(null);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = query.trim();

  // Conversations: local to what this client already has — every keystroke,
  // no debounce, because `findRooms` never asks the network (#207 AC:
  // "local room filtering updates on every keystroke with no network call").
  useEffect(() => {
    let cancelled = false;
    connection
      .findRooms(trimmed)
      .then((found) => {
        if (!cancelled) {
          setRoomMatches(found);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRoomMatches([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection, trimmed]);

  // People: the directory is a network ask, so this one waits for a pause in typing.
  useEffect(() => {
    if (trimmed === "") {
      setPeopleMatches([]);
      setPeopleLoading(false);
      return;
    }
    setPeopleLoading(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      connection
        .searchPeople(trimmed)
        .then((people) => {
          if (!cancelled) {
            setPeopleMatches(people);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setPeopleMatches([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setPeopleLoading(false);
          }
        });
    }, PEOPLE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connection, trimmed]);

  // A person who already has a direct conversation open reads as that
  // conversation (it's already among `roomMatches` when the query matches
  // them — `findRooms` matches a direct room on its partner's name too),
  // never twice.
  const directPartnerIds = useMemo(
    () => new Set(rooms.filter((room) => room.kind === "direct" && room.members.length === 1).map((room) => room.members[0]!.userId)),
    [rooms],
  );
  // #247: a colleague's duo belongs to that colleague, not a second result —
  // when the owner's own row is also among the matches, the duo's hit is
  // redundant (their row's "Ask their duo", from `PersonProfile`, already
  // reaches it); a duo found with no matching owner row stays, so a search
  // that only turned up the duo's own id doesn't go dark.
  const ownerIdsFound = useMemo(() => new Set(peopleMatches.filter((person) => !isDuoUserId(person.userId)).map((person) => person.userId)), [peopleMatches]);
  const visiblePeople = useMemo(
    () =>
      peopleMatches.filter((person) => {
        if (directPartnerIds.has(person.userId)) {
          return false;
        }
        const ownerId = duoOwnerUserIdOf(person.userId);
        return ownerId === null || !ownerIdsFound.has(ownerId);
      }),
    [peopleMatches, directPartnerIds, ownerIdsFound],
  );

  // duo#302: bumped after `recordRecentAction` so the ordering below (which
  // reads `readRecentActionIds()` directly — there's nowhere else that
  // state lives) recomputes once the palette has just run something,
  // without this component owning a second copy of the recent list itself.
  const [recentTick, setRecentTick] = useState(0);

  // duo#302: the global verbs, always on offer, plus — only with a
  // conversation open — the two this app already has a callback for.
  // Fuzzy-ish: a plain case-insensitive substring on the label, the same
  // matching strength `findRooms`/`searchPeople`'s own callers already
  // accept from this box.
  const allActions: readonly PaletteAction[] = useMemo(() => {
    const list: PaletteAction[] = [];
    if (onNewConversation) {
      list.push({ id: "new-conversation", label: "New conversation", run: onNewConversation });
    }
    list.push({ id: "ask-my-duo", label: "Ask my duo", run: () => { window.location.hash = "#duo"; } });
    list.push({ id: "open-settings", label: "Open settings", run: () => { window.location.hash = "#settings"; } });
    if (activeRoom) {
      const title = titleOf(activeRoom);
      if (onMarkRead) {
        list.push({ id: "mark-read", label: `Mark ${title} as read`, run: () => onMarkRead(activeRoom) });
      }
      if (onSetNotificationMode) {
        list.push(
          activeRoom.muted
            ? { id: "unmute", label: `Unmute ${title}`, run: () => onSetNotificationMode(activeRoom, "all") }
            : { id: "mute", label: `Mute ${title}`, run: () => onSetNotificationMode(activeRoom, "nothing") },
        );
      }
    }
    return list;
  }, [onNewConversation, activeRoom, onMarkRead, onSetNotificationMode, titleOf]);

  const filteredActions: readonly PaletteAction[] = useMemo(() => {
    const lower = trimmed.toLowerCase();
    const matching = lower === "" ? allActions : allActions.filter((action) => action.label.toLowerCase().includes(lower));
    const recentIds = readRecentActionIds();
    const byId = new Map(matching.map((action) => [action.id, action] as const));
    const recentFirst: PaletteAction[] = [];
    for (const id of recentIds) {
      const action = byId.get(id);
      if (action) {
        recentFirst.push(action);
        byId.delete(id);
      }
    }
    return [...recentFirst, ...matching.filter((action) => byId.has(action.id))];
    // `recentTick` isn't read — it's the deliberate signal to recompute
    // once the palette has just run something, the same "re-derive from an
    // outside store on a tick" shape `watchSections`'s callers use.
  }, [allActions, trimmed, recentTick]);

  const items: readonly Item[] = useMemo(() => {
    const list: Item[] = roomMatches.map((room) => ({ kind: "room", room }) as const);
    for (const action of filteredActions) {
      list.push({ kind: "action", action });
    }
    if (trimmed !== "") {
      for (const person of visiblePeople) {
        list.push({ kind: "person", person });
      }
      list.push({ kind: "messages" });
    }
    return list;
  }, [roomMatches, filteredActions, visiblePeople, trimmed]);

  // The highlighted suggestion always lands somewhere sensible: on the
  // first row when the list just appeared or changed shape, nowhere when
  // there is nothing to land on.
  useEffect(() => {
    setActiveIndex((current) => {
      if (items.length === 0) {
        return -1;
      }
      return current < 0 || current >= items.length ? 0 : current;
    });
  }, [items]);

  const optionId = (index: number): string => `${listboxId}-option-${index}`;
  const activeId = activeIndex >= 0 && activeIndex < items.length ? optionId(activeIndex) : undefined;

  const activate = (item: Item): void => {
    setOpen(false);
    if (item.kind === "room") {
      window.location.hash = roomHref(item.room.roomId);
    } else if (item.kind === "person") {
      setSelectedPerson(item.person);
    } else if (item.kind === "action") {
      item.action.run();
      recordRecentAction(item.action.id);
      setRecentTick((tick) => tick + 1);
    } else {
      const parsed = parseSearchQuery(trimmed);
      setMessageFilters(parsed.filters);
      setMessageQuery(parsed.term);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (items.length === 0 ? -1 : (i + 1) % items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => (items.length === 0 ? -1 : (i - 1 + items.length) % items.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[activeIndex];
      if (item) {
        activate(item);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  // A mousedown on an option fires before the input's blur — without this,
  // the dropdown would close (on blur) before the click that was meant to
  // choose something ever lands.
  const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

  // Independent of whether a message search is already showing: typing
  // again (even to refine an answered search) reopens suggestions, so
  // choosing "Search messages for '…'" a second time replaces the first
  // search's results rather than being unreachable once results exist.
  const showDropdown = open;

  return (
    <div className="mt-3 flex flex-col gap-1" data-testid="command-search" role="search" aria-label="Search the workspace">
      <input
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={showDropdown}
        aria-label="Search the workspace"
        className="min-h-11 w-full rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 text-[var(--text)]"
        data-testid="command-search-input"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder="Search people, conversations, and what was said"
        ref={inputRef}
        role="combobox"
        type="text"
        value={query}
      />
      {/* What this finds, in the member's terms — the corpus search (⌘K,
          docs/design-language.md §5.7) says its own scope, and the two never
          share a sentence. duo#300: the filter syntax named here, once, is
          the same four tokens `workspace/searchQuery.ts` parses — this is
          the one place a member learns it exists. */}
      <p className="type-provenance text-[var(--faint)]" data-testid="command-search-scope">
        Finds people, conversations, and what&apos;s been said — on the workspace. Narrow messages
        with from:, in:, before:, after:.
      </p>
      {showDropdown && (
        <ul aria-label="Suggestions" className="flex flex-col gap-2" data-testid="command-search-listbox" id={listboxId} role="listbox">
          {/* No conversation or person matched — said independently of the
              messages row below, which is always offered once there's a
              query to hand off. */}
          {roomMatches.length === 0 && visiblePeople.length === 0 && trimmed !== "" && !peopleLoading && (
            <li className="type-body text-[var(--muted)]" data-testid="command-search-empty" role="presentation">
              Nothing found.
            </li>
          )}
          {roomMatches.length > 0 && (
            <li role="presentation">
              <p className="type-provenance uppercase text-[var(--faint)]" data-testid="command-search-section-conversations">
                {trimmed === "" ? "Recent" : "Conversations"}
              </p>
              <ul aria-label="Conversations" className="mt-1 flex flex-col gap-1" role="group">
                {roomMatches.map((room, index) => (
                  <li
                    aria-selected={items[index]?.kind === "room" && index === activeIndex}
                    className={`min-h-11 cursor-pointer rounded-[var(--r-sm)] px-3 py-2 type-body text-[var(--text)] ${index === activeIndex ? "bg-[var(--surface-2)]" : ""}`}
                    data-testid="command-search-room"
                    id={optionId(index)}
                    key={room.roomId}
                    onClick={() => activate({ kind: "room", room })}
                    onMouseDown={keepFocus}
                    role="option"
                  >
                    {titleOf(room)}
                  </li>
                ))}
              </ul>
            </li>
          )}
          {/* duo#302: always offered, query or not — a global verb list
              plus (only with a conversation open) the two reused from
              `ChatList.tsx`. Sits between Conversations and People; its own
              length is folded into every index after it below, never
              hand-counted. */}
          {filteredActions.length > 0 && (
            <li role="presentation">
              <p className="type-provenance uppercase text-[var(--faint)]" data-testid="command-search-section-actions">
                Actions
              </p>
              <ul aria-label="Actions" className="mt-1 flex flex-col gap-1" role="group">
                {filteredActions.map((action, actionIndex) => {
                  const index = roomMatches.length + actionIndex;
                  return (
                    <li
                      aria-selected={index === activeIndex}
                      className={`min-h-11 cursor-pointer rounded-[var(--r-sm)] px-3 py-2 type-body text-[var(--text)] ${index === activeIndex ? "bg-[var(--surface-2)]" : ""}`}
                      data-testid="command-search-action"
                      id={optionId(index)}
                      key={action.id}
                      onClick={() => activate({ kind: "action", action })}
                      onMouseDown={keepFocus}
                      role="option"
                    >
                      {action.label}
                    </li>
                  );
                })}
              </ul>
            </li>
          )}
          {trimmed !== "" && (visiblePeople.length > 0 || peopleLoading) && (
            <li role="presentation">
              <p className="type-provenance uppercase text-[var(--faint)]" data-testid="command-search-section-people">
                People
              </p>
              <ul aria-label="People" className="mt-1 flex flex-col gap-1" role="group">
                {visiblePeople.map((person, personIndex) => {
                  const index = roomMatches.length + filteredActions.length + personIndex;
                  return (
                    <li
                      aria-selected={index === activeIndex}
                      className={`min-h-11 cursor-pointer rounded-[var(--r-sm)] px-3 py-2 type-body text-[var(--text)] ${index === activeIndex ? "bg-[var(--surface-2)]" : ""}`}
                      data-testid="command-search-person"
                      id={optionId(index)}
                      key={person.userId}
                      onClick={() => activate({ kind: "person", person })}
                      onMouseDown={keepFocus}
                      role="option"
                    >
                      {directoryEntryLabel(person)}
                    </li>
                  );
                })}
                {peopleLoading && (
                  <li className="type-provenance text-[var(--muted)]" data-testid="command-search-people-loading" role="presentation">
                    Searching people…
                  </li>
                )}
              </ul>
            </li>
          )}
          {trimmed !== "" && (
            <li
              aria-selected={items.length - 1 === activeIndex}
              className={`min-h-11 cursor-pointer rounded-[var(--r-sm)] px-3 py-2 type-body text-[var(--muted)] ${items.length - 1 === activeIndex ? "bg-[var(--surface-2)]" : ""}`}
              data-testid="command-search-messages"
              id={optionId(items.length - 1)}
              onClick={() => activate({ kind: "messages" })}
              onMouseDown={keepFocus}
              role="option"
            >
              Search messages for &quot;{trimmed}&quot;
            </li>
          )}
        </ul>
      )}
      {messageQuery !== null ? (
        <MessageSearchResults
          connection={connection}
          filters={messageFilters}
          onAnswer={onAnswer}
          onFiltersChange={setMessageFilters}
          onClear={() => {
            setMessageQuery(null);
            setMessageFilters(EMPTY_SEARCH_FILTERS);
            setQuery("");
          }}
          query={messageQuery}
          rooms={rooms}
          titleOf={titleOf}
        />
      ) : (
        !showDropdown && children
      )}
      <PersonProfile
        api={api}
        connection={connection}
        onMessage={(roomId) => {
          setSelectedPerson(null);
          onStartedConversation(roomId);
        }}
        onOpenChange={(next) => {
          if (!next) {
            setSelectedPerson(null);
          }
        }}
        open={selectedPerson !== null}
        person={selectedPerson}
      />
    </div>
  );
}
