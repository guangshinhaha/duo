import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import { isDuoUserId, duoOwnerLabel, localpartOf } from "../workspace/identity.js";
import type { WorkspaceConnection } from "../workspace/matrix.js";

/**
 * #214: making a project a room — name it, optionally give it a topic, and
 * invite colleagues before it opens (or skip that and invite later from the
 * room itself). Two kinds: a private group (`connection.createRoom`,
 * invite-only) or a channel (`connection.createChannel`: open to the
 * member's own organisation through its Space, and listed there, so
 * colleagues can find and join it without an invite). The same dialog also
 * browses the organisation's existing channels (`connection.channels`) and
 * joins one — the "find" half of a channel.
 *
 * Each invite is its own call, not one invite list on `createRoom`: the org
 * wall refuses a room's creation OUTRIGHT if any invite in it crosses an
 * org (`duo_org_wall/rules.py`'s `may_create_room`), which would otherwise
 * cost the whole room over one bad pick. Inviting one at a time means a
 * refused colleague is just that — refused — and the room, and everyone
 * else already invited, stand.
 */
export function NewRoomDialog({
  connection,
  open = true,
  onOpenChange,
  onCreated,
}: {
  connection: WorkspaceConnection;
  open?: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (roomId: string) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent data-testid="new-room-dialog">
        <NewRoomBody connection={connection} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

type RoomChoice = "group" | "channel";

function NewRoomBody({ connection, onCreated }: { connection: WorkspaceConnection; onCreated: (roomId: string) => void }) {
  const [browsing, setBrowsing] = useState(false);
  const [choice, setChoice] = useState<RoomChoice>("group");
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Once a room exists, invites happen against ITS id — the form moves from
  // "name this room" to "who's in it", in one dialog.
  const [roomId, setRoomId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly { userId: string; name: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [invited, setInvited] = useState<readonly string[]>([]);
  const [inviting, setInviting] = useState<string | null>(null);
  const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({});

  const create = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) {
      return;
    }
    setCreating(true);
    setCreateError(null);
    (choice === "channel" ? connection.createChannel(trimmed, topic) : connection.createRoom(trimmed, topic))
      .then((id) => setRoomId(id))
      .catch((error: unknown) => setCreateError(error instanceof Error ? error.message : "Couldn't create the room — try again."))
      .finally(() => setCreating(false));
  };

  const search = (event: FormEvent): void => {
    event.preventDefault();
    const term = query.trim();
    if (!term || searching) {
      return;
    }
    setSearching(true);
    setSearchError(null);
    connection
      .searchPeople(term)
      .then((people) => setResults(people))
      .catch(() => setSearchError("The workspace didn't answer — try again."))
      .finally(() => setSearching(false));
  };

  const invite = (userId: string): void => {
    if (!roomId || inviting !== null) {
      return;
    }
    setInviting(userId);
    setInviteErrors((errors) => {
      const next = { ...errors };
      delete next[userId];
      return next;
    });
    connection
      .invite(roomId, userId)
      .then(() => setInvited((list) => [...list, userId]))
      // The org wall's own refusal (e.g. a cross-org colleague) — surfaced
      // beside that person, not as a blanket "something went wrong": the
      // room and every other invite already sent still stand.
      .catch((error: unknown) =>
        setInviteErrors((errors) => ({ ...errors, [userId]: error instanceof Error ? error.message : "Couldn't invite them — try again." })),
      )
      .finally(() => setInviting(null));
  };

  if (browsing) {
    return <BrowseChannels connection={connection} onBack={() => setBrowsing(false)} onJoined={onCreated} />;
  }

  if (roomId === null) {
    const channel = choice === "channel";
    return (
      <>
        <DialogTitle>{channel ? "New channel" : "New group"}</DialogTitle>
        <DialogDescription>Name it for what it&apos;s about — you&apos;ll invite people next.</DialogDescription>
        <form className="flex flex-col gap-2" onSubmit={create}>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Who can join</legend>
            {(
              [
                { value: "group", label: "Private group", hint: "Only people you invite can join." },
                { value: "channel", label: "Channel", hint: "Anyone in your organisation can find it and join." },
              ] as const
            ).map((option) => (
              <label
                className="shape-entry flex min-h-11 cursor-pointer items-start gap-2 px-3 py-2 type-body text-[var(--text)]"
                data-testid={`new-room-kind-${option.value}`}
                key={option.value}
              >
                <input
                  checked={choice === option.value}
                  className="mt-1"
                  name="new-room-kind"
                  onChange={() => {
                    setChoice(option.value);
                    setCreateError(null);
                  }}
                  type="radio"
                  value={option.value}
                />
                <span className="flex flex-col">
                  {option.label}
                  <span className="type-provenance text-[var(--muted)]">{option.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1 type-body">
            Name
            <input
              aria-label={channel ? "Channel name" : "Group name"}
              autoFocus
              className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
              onChange={(e) => {
                setName(e.target.value);
                setCreateError(null);
              }}
              placeholder="Project X"
              value={name}
            />
          </label>
          <label className="flex flex-col gap-1 type-body">
            Topic (optional)
            <input
              aria-label={channel ? "Channel topic" : "Group topic"}
              className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What it's for"
              value={topic}
            />
          </label>
          {createError && (
            <p className="type-body text-[var(--refused)]" data-testid="new-room-error">
              {createError}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              className="mr-auto inline-flex min-h-11 items-center justify-center px-1 type-body text-[var(--accent)] underline-offset-2 hover:underline"
              data-testid="new-room-browse"
              onClick={() => setBrowsing(true)}
              type="button"
            >
              Browse channels
            </button>
            <DialogClose asChild>
              <button className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" type="button">
                Cancel
              </button>
            </DialogClose>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
              data-testid="new-room-create"
              disabled={creating || name.trim().length === 0}
              type="submit"
            >
              {creating ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </>
    );
  }

  return (
    <>
      <DialogTitle>Invite people to {name.trim()}</DialogTitle>
      <DialogDescription>Search your workspace for colleagues to add — or skip this and invite them later from the room.</DialogDescription>
      <form className="flex gap-2" onSubmit={search}>
        <input
          aria-label="Search people"
          className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
          placeholder="Name or id"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSearchError(null);
          }}
        />
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
          disabled={searching || query.trim().length === 0}
          type="submit"
        >
          {searching ? "Searching…" : "Search"}
        </button>
      </form>
      {searchError && (
        <p className="type-body text-[var(--refused)]" data-testid="new-room-search-error">
          {searchError}
        </p>
      )}
      {results !== null && results.length === 0 && (
        <p className="type-body text-[var(--muted)]" data-testid="new-room-none">
          No one found.
        </p>
      )}
      {results !== null && results.length > 0 && (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {results.map((person) => {
            const already = invited.includes(person.userId);
            return (
              <div className="flex flex-col gap-1" key={person.userId}>
                <button
                  className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-left type-body text-[var(--text)] disabled:opacity-40"
                  data-testid="new-room-person"
                  disabled={inviting !== null || already}
                  onClick={() => invite(person.userId)}
                  type="button"
                >
                  {labelFor(person)} {already && "— Invited"}
                </button>
                {inviteErrors[person.userId] && (
                  <p className="type-body text-[var(--refused)]" data-testid="new-room-invite-error">
                    {inviteErrors[person.userId]}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)]"
          data-testid="new-room-done"
          onClick={() => onCreated(roomId)}
          type="button"
        >
          Done
        </button>
      </div>
    </>
  );
}

/**
 * #214: the organisation's channels — the org Space's children, as the
 * homeserver's own hierarchy lists them (only ones this member may join
 * ever appear). One already joined offers "Open"; any other, "Join", which
 * is a plain join that lands in the channel. A refusal (the org wall's own
 * sentence) shows beside that channel, the way an invite refusal does.
 */
function BrowseChannels({
  connection,
  onBack,
  onJoined,
}: {
  connection: WorkspaceConnection;
  onBack: () => void;
  onJoined: (roomId: string) => void;
}) {
  const channels = useQuery({
    queryKey: ["workspace", "channels"],
    queryFn: () => connection.channels(),
    meta: { target: "workspace" },
    // A refusal here (no org Space, the hierarchy refused) is the answer,
    // not a blip — show it now; Back and Browse again asks afresh.
    retry: false,
  });
  const [joining, setJoining] = useState<string | null>(null);
  const [joinErrors, setJoinErrors] = useState<Record<string, string>>({});

  const join = (roomId: string): void => {
    if (joining !== null) {
      return;
    }
    setJoining(roomId);
    setJoinErrors((errors) => {
      const next = { ...errors };
      delete next[roomId];
      return next;
    });
    connection
      .joinChannel(roomId)
      .then(() => onJoined(roomId))
      .catch((error: unknown) =>
        setJoinErrors((errors) => ({ ...errors, [roomId]: error instanceof Error ? error.message : "Couldn't join the channel — try again." })),
      )
      .finally(() => setJoining(null));
  };

  const rows = channels.data ?? [];
  return (
    <>
      <DialogTitle>Your organisation&apos;s channels</DialogTitle>
      <DialogDescription>Channels anyone in your organisation can find and join.</DialogDescription>
      {channels.isPending && <p className="type-body text-[var(--muted)]">Looking…</p>}
      {channels.isError && (
        <p className="type-body text-[var(--refused)]" data-testid="channels-error" role="alert">
          {channels.error instanceof Error ? channels.error.message : "The workspace didn't answer — try again."}
        </p>
      )}
      {channels.isSuccess && rows.length === 0 && (
        <p className="type-body text-[var(--muted)]" data-testid="channels-none">
          No channels yet — make one with &ldquo;Channel&rdquo;.
        </p>
      )}
      {rows.length > 0 && (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {rows.map((channel) => (
            <div className="flex flex-col gap-1" key={channel.roomId}>
              <div className="shape-entry flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-testid="channel-row">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate type-body text-[var(--text)]" data-testid="channel-row-title">
                    {channel.name ?? "Unnamed channel"}
                  </span>
                  <span className="truncate type-provenance text-[var(--muted)]">
                    {channel.topic ? `${channel.topic} · ` : ""}
                    {channel.memberCount === 1 ? "1 member" : `${channel.memberCount} members`}
                  </span>
                </div>
                {channel.joined ? (
                  <button
                    className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--muted)]"
                    data-testid="channel-row-open"
                    onClick={() => onJoined(channel.roomId)}
                    type="button"
                  >
                    Open
                  </button>
                ) : (
                  <button
                    className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
                    data-testid="channel-row-join"
                    disabled={joining !== null}
                    onClick={() => join(channel.roomId)}
                    type="button"
                  >
                    {joining === channel.roomId ? "Joining…" : "Join"}
                  </button>
                )}
              </div>
              {joinErrors[channel.roomId] && (
                <p className="type-body text-[var(--refused)]" data-testid="channel-join-error">
                  {joinErrors[channel.roomId]}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
          data-testid="channels-back"
          onClick={onBack}
          type="button"
        >
          Back
        </button>
      </div>
    </>
  );
}

/** Who a directory entry reads as: a duo by its owner (from the id's grammar), a person by their name. */
function labelFor(person: { userId: string; name: string }): string {
  if (isDuoUserId(person.userId)) {
    return `${duoOwnerLabel(person.userId) ?? localpartOf(person.userId)}'s duo`;
  }
  return person.name;
}
