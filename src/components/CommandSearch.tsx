import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { MessageSearchResults } from "./ConversationSearch.js";
import { PersonProfile } from "./PersonProfile.js";
import { directoryEntryLabel, duoOwnerUserIdOf, isDuoUserId } from "../workspace/identity.js";
import { roomHref } from "../workspace/links.js";
import type { RoomSummary, WorkspaceConnection } from "../workspace/matrix.js";

/** How long to wait, after the member stops typing, before asking the directory — long enough that every keystroke doesn't cost a request, short enough to still feel instant. */
const PEOPLE_DEBOUNCE_MS = 150;

/** What the one search box found, by its own id — a person, else a duo's id reads a conversation's recipient the same door. */
type PersonHit = { readonly userId: string; readonly name: string };

/** One row of the listbox: a conversation, a person, or the hand-off to the full message search. */
type Item = { readonly kind: "room"; readonly room: RoomSummary } | { readonly kind: "person"; readonly person: PersonHit } | { readonly kind: "messages" };

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
 */
export function CommandSearch({
  connection,
  rooms,
  titleOf,
  onStartedConversation,
  children,
}: {
  connection: WorkspaceConnection;
  rooms: readonly RoomSummary[];
  /** How a conversation reads under its title — the list's own rule, so a suggestion says the same name the list does. */
  titleOf: (room: RoomSummary) => string;
  /** A direct conversation was opened (started, or reused) from a person's suggestion or their profile — the caller navigates to it. */
  onStartedConversation: (roomId: string) => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [roomMatches, setRoomMatches] = useState<readonly RoomSummary[]>([]);
  const [peopleMatches, setPeopleMatches] = useState<readonly PersonHit[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [messageQuery, setMessageQuery] = useState<string | null>(null);
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

  const items: readonly Item[] = useMemo(() => {
    const list: Item[] = roomMatches.map((room) => ({ kind: "room", room }) as const);
    if (trimmed !== "") {
      for (const person of visiblePeople) {
        list.push({ kind: "person", person });
      }
      list.push({ kind: "messages" });
    }
    return list;
  }, [roomMatches, visiblePeople, trimmed]);

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
    } else {
      setMessageQuery(trimmed);
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
          share a sentence. */}
      <p className="type-provenance text-[var(--faint)]" data-testid="command-search-scope">
        Finds people, conversations, and what&apos;s been said — on the workspace.
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
          {trimmed !== "" && (visiblePeople.length > 0 || peopleLoading) && (
            <li role="presentation">
              <p className="type-provenance uppercase text-[var(--faint)]" data-testid="command-search-section-people">
                People
              </p>
              <ul aria-label="People" className="mt-1 flex flex-col gap-1" role="group">
                {visiblePeople.map((person, personIndex) => {
                  const index = roomMatches.length + personIndex;
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
          onClear={() => {
            setMessageQuery(null);
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
