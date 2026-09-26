import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, X } from "lucide-react";
import { RoomDuoMessage } from "../components/RoomDuoMessage.js";
import { RoomPersonMessage } from "../components/RoomPersonMessage.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { SharedFileCard } from "../components/SharedFileCard.js";
import { Timestamp } from "../components/Timestamp.js";
import { roomTitle } from "./Conversations.js";
import { addressed, mentionLabelOf, type MessageMention } from "../workspace/mentions.js";
import type { RoomMemberRef, RoomMessage, SharedFile, WorkspaceConnection } from "../workspace/matrix.js";
import { duoOwnerLabel, isDuoUserId, localpartOf } from "../workspace/identity.js";
import { formatBytes, shareRefusalOf, stageFile, type StagedShare } from "../workspace/sharing.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/primitives/Dialog.js";

/**
 * #62 + #63 + #64: one conversation — the timeline, the message verbs, and
 * the composer. Who said what is read STRUCTURALLY: a duo-shaped sender
 * (`@duo-<owner>`, identity.ts) renders as the multi-party
 * `RoomDuoMessage` with the possessive attribution ("carol's duo") derived
 * from the id, and a person renders `RoomPersonMessage` by their name. A
 * display name can claim anything; the user-id grammar cannot — which is
 * the whole of AR-13 in a shared room.
 *
 * The verbs (#64) are all homeserver operations — edit, delete, react,
 * reply-in-thread move the server's own state, and the surface renders the
 * next answer, never a local pretense of one. The one deliberate local
 * half is the optimistic send (#64 AC1): the sender's words render
 * immediately, marked as on their way, and the homeserver's echo replaces
 * them.
 *
 * Opening the conversation is also reading it (#63): the read position is
 * a receipt on the member's account, sent once the timeline has loaded —
 * the homeserver's own durable state, which is why the unread badge clears
 * on every device, not just here.
 *
 * Live arrivals land through the query cache: the subscription invalidates
 * the timeline, the refetch is the truth, and no message is ever spliced
 * in from a second source.
 */

/** The reaction keys the picker offers — a fixed, readable set, not a free-text field. */
const REACTION_CHOICES = ["👍", "❤️", "😂", "🎉", "👀", "✅"] as const;

/** The quiet per-row action idiom — present for a keyboard, unloud for an eye. */
const rowActionClass =
  "inline-flex min-h-9 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-provenance text-[var(--muted)]";

/** A thread's own address: both halves encoded whole, the grammar is the route's (#64). */
export function threadHref(roomId: string, rootEventId: string): string {
  return `#thread/${encodeURIComponent(roomId)}/${encodeURIComponent(rootEventId)}`;
}

/** The latest reply's author as the id says they are — "carol's duo" from `@duo-carol`, never a chosen name. */
function threadPreviewLabel(reply: { senderId: string; senderName: string }): string {
  return mentionLabelOf(reply.senderId, reply.senderName);
}

/**
 * #65: one mention pill. A duo's pill IS the duo — its label re-derived
 * from the user id here at the render site (the projection already did;
 * this is the same structural rule holding at the last inch, so no lying
 * delivered label can put the owner's name on the duo), carried visually
 * by the dashed border the duo's own messages use. A person's pill is
 * solid and reads the label the projection resolved. The pill's text is
 * the addressed words the body carries — the same "@" the composer's pick
 * left there.
 */
function MentionPill({ userId, label }: { userId: string; label: string }) {
  return (
    <span
      className={`rounded-[var(--r-sm)] border px-1 ${
        isDuoUserId(userId)
          ? "border-dashed border-[var(--edge)] bg-[var(--surface-2)] text-[var(--text)]"
          : "border-[var(--accent)] text-[var(--text)]"
      }`}
      data-mentioned-user={userId}
      data-testid="room-mention"
    >
      {addressed(userId, label)}
    </span>
  );
}

/** The message's words for rendering: the plain body, or its parts with a pill at each mention (#65). */
function messageWords(message: RoomMessage): ReactNode {
  if (message.parts === null) {
    return message.body;
  }
  return message.parts.map((part, index) =>
    part.kind === "mention" ? <MentionPill key={index} label={part.label} userId={part.userId} /> : part.text,
  );
}

export function Room({ connection, roomId }: { connection: WorkspaceConnection | null; roomId: string }) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!connection) {
      return;
    }
    return connection.subscribe((changedRoomId) => {
      void queryClient.invalidateQueries({ queryKey: ["workspace", "timeline", changedRoomId] });
    });
  }, [connection, queryClient]);

  const rooms = useQuery({
    queryKey: ["workspace", "rooms"],
    queryFn: () => connection?.rooms() ?? Promise.resolve([]),
    enabled: connection !== null,
    meta: { target: "workspace" },
  });
  const timeline = useQuery({
    queryKey: ["workspace", "timeline", roomId],
    queryFn: () => connection!.timeline(roomId),
    enabled: connection !== null,
    meta: { target: "workspace" },
  });

  const room = rooms.data?.find((candidate) => candidate.roomId === roomId);
  const roomName = room ? roomTitle(room) : roomId;

  // Reading is an account-level fact: receipt the room's latest event once
  // the timeline is in hand, then let the list re-read the server's
  // accounting. A failed receipt leaves the room usable — the next open
  // tries again, and nothing local pretends it happened.
  useEffect(() => {
    if (!connection || !timeline.isSuccess || timeline.data === undefined) {
      return;
    }
    let cancelled = false;
    void connection
      .markRead(roomId)
      .then(() => {
        if (!cancelled) {
          void queryClient.invalidateQueries({ queryKey: ["workspace", "rooms"] });
        }
      })
      .catch(() => {
        // The unread badge keeps telling the truth; nothing else breaks.
      });
    return () => {
      cancelled = true;
    };
  }, [connection, roomId, timeline.isSuccess, timeline.data, queryClient]);

  // After a verb, the server's next answer is the only record: one
  // invalidation of the workspace's whole query tree, and every reader of
  // it (list, flow, previews) re-reads.
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
  };

  const [deleteTarget, setDeleteTarget] = useState<RoomMessage | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (!connection || timeline.isLoading) {
    return (
      <div className="p-6">
        <h1 className="type-heading sr-only">{roomName}</h1>
        <RouteLoading variant="rows" />
      </div>
    );
  }
  if (timeline.error !== null || timeline.data === undefined) {
    return (
      <div className="p-6">
        <h1 className="type-heading sr-only">{roomName}</h1>
        <p className="type-body text-[var(--escalate)]">The workspace didn&apos;t give up this conversation — try again.</p>
        <button
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
          onClick={() => void timeline.refetch()}
        >
          Try again
        </button>
      </div>
    );
  }

  // The main flow carries the roots; a thread's replies belong to the
  // thread, present here only as the root's summary of them.
  const mainFlow = timeline.data.filter((message) => message.threadRootEventId === null);

  return (
    <div className="flex h-full flex-col">
      <h1 className="type-heading sr-only">{roomName}</h1>
      <div className="flex-1 overflow-y-auto p-6">
        <a
          className="inline-flex min-h-11 items-center self-start rounded-[var(--r-sm)] px-2 type-provenance uppercase text-[var(--muted)]"
          data-testid="back-to-conversations"
          href="#conversations"
        >
          All conversations
        </a>
        <section className="mt-2 flex flex-col gap-5" data-testid="room-timeline">
          {mainFlow.length === 0 ? (
            <p className="text-[var(--muted)]" data-testid="room-empty">
              Nothing here yet — say something below.
            </p>
          ) : (
            mainFlow.map((message) => (
              <RoomEntry
                key={message.eventId}
                message={message}
                connection={connection}
                roomId={roomId}
                refresh={refresh}
                onDelete={(message) => {
                  setDeleteError(null);
                  setDeleteTarget(message);
                }}
              />
            ))
          )}
        </section>
      </div>
      <RoomComposer connection={connection} roomId={roomId} roomName={roomName} members={room?.members ?? []} />
      {/* A delete asks first: the words go for everyone, and the surface
          says so in the same words it will show afterwards. */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
      >
        {deleteTarget && (
          <DialogContent data-testid="delete-message-dialog">
            <DialogTitle>Delete this message?</DialogTitle>
            <DialogDescription>
              The words go for everyone in the conversation and cannot come back — the row stays behind, saying a message was struck.
            </DialogDescription>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
                data-testid="delete-message-cancel"
                onClick={() => setDeleteTarget(null)}
              >
                Keep it
              </button>
              <button
                className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] bg-[var(--escalate)] px-3 text-[var(--bg)] type-body"
                data-testid="delete-message-confirm"
                disabled={deleteBusy}
                onClick={() => {
                  const target = deleteTarget;
                  if (!target) {
                    return;
                  }
                  setDeleteBusy(true);
                  setDeleteError(null);
                  // A delete the workspace refuses must not close the ask
                  // behind it: the words still stand on the server, and the
                  // member deserves to hear the refusal where they acted.
                  void connection
                    .delete(roomId, target.eventId)
                    .then(() => {
                      setDeleteTarget(null);
                    })
                    .catch(() => {
                      setDeleteError("The workspace didn't take that — try again.");
                    })
                    .finally(() => {
                      setDeleteBusy(false);
                      refresh();
                    });
                }}
              >
                {deleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
            {deleteError && (
              <p className="mt-3 type-body text-[var(--refused)]" data-testid="delete-message-error">
                {deleteError}
              </p>
            )}
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

/**
 * One message's reading half — attribution by the id's grammar, the words,
 * the edit mark, the pending mark, the server's time, and the reactions
 * under it. Shared by the conversation's flow and the thread view (#64),
 * so a message reads identically wherever it's read; the conversation's
 * rows add the verbs around it, the thread view adds its own composer.
 * #66: a share renders as the SharedFileCard inside the same attribution
 * containers — a file message is a message, by whoever shared it.
 */
export function MessageBody({
  message,
  loadMedia,
  onToggleReaction,
}: {
  message: RoomMessage;
  /** The member's own authenticated fetch of a shared file's bytes — the connection's, passed down so this stays a pure render. */
  loadMedia: (url: string) => Promise<Blob | null>;
  onToggleReaction?: (message: RoomMessage, key: string, mine: boolean) => void;
}) {
  const fromDuo = isDuoUserId(message.senderId);
  if (message.redacted) {
    // A struck message keeps its place and says so — the timeline never
    // reshuffles to hide that something was said.
    return (
      <div className="flex flex-col gap-1">
        <p
          className="rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3 type-body text-[var(--faint)] italic"
          data-testid="room-message-deleted"
        >
          Message deleted
        </p>
        <p className="type-provenance text-[var(--faint)]">
          <Timestamp iso={new Date(message.originServerTs).toISOString()} />
        </p>
      </div>
    );
  }
  const content =
    message.file === undefined ? (
      messageWords(message)
    ) : (
      <SharedFileCard file={message.file} loadMedia={loadMedia} />
    );
  return (
    <div className="flex flex-col gap-1">
      {fromDuo ? (
        <RoomDuoMessage ownerName={duoOwnerLabel(message.senderId) ?? message.senderName}>{content}</RoomDuoMessage>
      ) : (
        <RoomPersonMessage authorName={message.senderName}>{content}</RoomPersonMessage>
      )}
      <p className="type-provenance text-[var(--faint)]">
        <Timestamp iso={new Date(message.originServerTs).toISOString()} />
        {message.edited && (
          <span className="ml-1" data-testid="room-message-edited">
            (edited)
          </span>
        )}
        {message.pending && (
          <span className="ml-1" data-testid="room-message-pending">
            Sending…
          </span>
        )}
      </p>
      {message.reactions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {message.reactions.map((reaction) => (
            <button
              key={reaction.key}
              className={`inline-flex min-h-9 items-center gap-1 rounded-full border px-2 type-provenance ${
                reaction.mine ? "border-[var(--accent)] text-[var(--text)]" : "border-[var(--edge)] text-[var(--muted)]"
              }`}
              data-testid="room-reaction"
              disabled={onToggleReaction === undefined}
              onClick={() => onToggleReaction?.(message, reaction.key, reaction.mine)}
            >
              <span aria-hidden="true">{reaction.key}</span> {reaction.count}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One row of the conversation's flow: the message, the verbs this member
 * may perform on it, and the thread it may have gathered. Own messages
 * (by sender id, never by display name) carry Edit and Delete; React and
 * Reply-in-thread are everyone's; the thread preview is the root's
 * summary, attributed structurally like any sender.
 */
function RoomEntry({
  message,
  connection,
  roomId,
  refresh,
  onDelete,
}: {
  message: RoomMessage;
  connection: WorkspaceConnection;
  roomId: string;
  refresh: () => void;
  onDelete: (message: RoomMessage) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = message.senderId === connection.userId;

  // Every verb ends the same way: hand it to the homeserver, then re-read
  // the server's answer — the local copy never stands in for the record.
  const run = (op: Promise<void>): void => {
    setBusy(true);
    setError(null);
    op
      .then(() => undefined)
      .catch(() => setError("The workspace didn't take that — try again."))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };

  return (
    <div className="flex flex-col gap-1" data-testid="room-message">
      <MessageBody
        message={message}
        loadMedia={connection.loadMedia}
        onToggleReaction={(target, key, mine) =>
          run(mine ? connection.unreact(roomId, target.eventId, key) : connection.react(roomId, target.eventId, key))
        }
      />
      {message.thread !== null && message.thread.replyCount > 0 && message.thread.latestReply !== null && (
        <p className="type-provenance text-[var(--muted)]" data-testid="room-thread-preview">
          {threadPreviewLabel(message.thread.latestReply)}: {message.thread.latestReply.body} ·{" "}
          {message.thread.replyCount} {message.thread.replyCount === 1 ? "reply" : "replies"}{" "}
          <a className="underline" data-testid="open-thread" href={threadHref(roomId, message.eventId)}>
            Open thread
          </a>
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        <button
          className={rowActionClass}
          disabled={busy || message.redacted}
          onClick={() => setPickerOpen((open) => !open)}
        >
          React
        </button>
        <a className={rowActionClass} href={threadHref(roomId, message.eventId)}>
          Reply in thread
        </a>
        {own && !message.redacted && message.file === undefined && (
          <button
            className={rowActionClass}
            disabled={busy}
            onClick={() => {
              setDraft(message.body);
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
        {own && !message.redacted && (
          <button className={rowActionClass} disabled={busy} onClick={() => onDelete(message)}>
            Delete
          </button>
        )}
      </div>
      {pickerOpen && !message.redacted && (
        <div className="flex flex-wrap gap-1" data-testid="reaction-picker">
          {REACTION_CHOICES.map((key) => (
            <button
              key={key}
              aria-label={`React ${key}`}
              className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-body"
              disabled={busy}
              onClick={() => {
                setPickerOpen(false);
                run(connection.react(roomId, message.eventId, key));
              }}
            >
              {key}
            </button>
          ))}
        </div>
      )}
      {editing && (
        <form
          className="flex flex-col gap-2"
          data-testid="room-message-edit"
          onSubmit={(e) => {
            e.preventDefault();
            const body = draft.trim();
            if (body.length === 0) {
              return;
            }
            setEditing(false);
            run(connection.edit(roomId, message.eventId, body));
          }}
        >
          <textarea
            aria-label="Edit message"
            className="min-h-22 flex-1 resize-none rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-1 text-[var(--text)]"
            rows={Math.max(1, Math.min(8, draft.split("\n").length))}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
          />
          <div className="flex justify-end gap-2">
            <button
              className="inline-flex min-h-9 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance"
              disabled={busy}
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(message.body);
              }}
            >
              Cancel
            </button>
            <button
              className="inline-flex min-h-9 items-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] type-provenance disabled:opacity-40"
              disabled={busy || draft.trim().length === 0}
              type="submit"
            >
              Save
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="room-message-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** One member the composer can offer as a mention — a person by their name, a duo by whose it is. */
interface MentionCandidate {
  readonly userId: string;
  readonly label: string;
  readonly kind: "person" | "duo";
}

/**
 * Who a mention can address (#65): the room's own members, the member
 * themself excepted. The label is structural the way every attribution is —
 * a duo offers as "{owner}'s duo" from the @duo- grammar, never from a
 * display name a sender chose, and the kind marker says what each offer IS
 * before the picker commits to it.
 */
function mentionCandidatesOf(members: readonly RoomMemberRef[], selfId: string): readonly MentionCandidate[] {
  return members
    .filter((member) => member.userId !== selfId)
    .map((member) => ({
      userId: member.userId,
      // The label comes from the one home of the rule — a duo offers as
      // "{owner}'s duo" from the @duo- grammar, never from a display name.
      label: mentionLabelOf(member.userId, member.name ?? localpartOf(member.userId)),
      kind: isDuoUserId(member.userId) ? "duo" : "person",
    }));
}

/**
 * The mention being typed, read from the text's end: the run after the last
 * whitespace, when it starts with "@". The composer works at the caret
 * people actually type at — the end — and keeps no caret state of its own.
 */
function mentionTokenAtEnd(text: string): string | null {
  const start = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n")) + 1;
  const token = text.slice(start);
  return token.startsWith("@") ? token : null;
}

/** Distinguishes one optimistic copy from the next — the homeserver's event ids replace these. */
let echoSequence = 0;

/**
 * The member's half of the room: a person saying something, in the chat-app
 * idiom this client already uses for asking (#27 — Enter is a newline,
 * Cmd/Ctrl-Enter submits). #64 AC1: the words render immediately as the
 * sender's own marked copy, and the homeserver's echo replaces them; a
 * failed send takes the copy back and keeps the text. #65: an "@" the
 * member types offers the room's members — people and the duos present,
 * clearly distinguished — and the picks ride the wire as m.mentions.
 * failed send takes the copy back and keeps the text.
 *
 * #66 adds the share: files attach here, refuse or stage by this app's own
 * named share limits, then ride the submit — each attachment uploads and
 * sends as its own `m.file`/`m.image` message, in order, BEFORE the text.
 * That order is the backend's association convention made visible (core
 * #190: the asker's own contiguous file messages immediately preceding
 * their question in the same room), so "attach, then ask" is exactly what
 * the wire carries. Sharing is not importing — the upload goes to the
 * homeserver's media store for the people in the room, and nothing here
 * can reach any daemon's corpus.
 */
function RoomComposer({
  connection,
  roomId,
  roomName,
  members,
}: {
  connection: WorkspaceConnection;
  roomId: string;
  roomName: string;
  members: readonly RoomMemberRef[];
}) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<StagedShare[]>([]);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The picks made from the offer; only those whose addressed words still
  // stand in the text at send time ride the wire — what the message
  // doesn't say, the wire doesn't claim. The pick carries its label beside
  // its id: the seam derives each pill's anchor from the pair, a duo's
  // from the id's grammar alone.
  const [picks, setPicks] = useState<readonly MessageMention[]>([]);
  const trimmed = text.trim();
  const disabled = (trimmed.length === 0 && attachments.length === 0) || pending;
  const duos = members.filter((member) => isDuoUserId(member.userId));

  const appendEcho = (row: RoomMessage): void => {
    queryClient.setQueryData<readonly RoomMessage[]>(["workspace", "timeline", roomId], (current) => [...(current ?? []), row]);
  };
  const dropEchoes = (ids: readonly string[]): void => {
    if (ids.length === 0) {
      return;
    }
    const drop = new Set(ids);
    queryClient.setQueryData<readonly RoomMessage[]>(["workspace", "timeline", roomId], (current) =>
      (current ?? []).filter((row) => !drop.has(row.eventId)),
    );
  };
  const echoRow = (eventId: string, shared: SharedFile): RoomMessage => ({
    eventId,
    roomId,
    senderId: connection.userId,
    senderName: localpartOf(connection.userId),
    body: shared.name,
    parts: null,
    file: shared,
    originServerTs: Date.now(),
    edited: false,
    redacted: false,
    reactions: [],
    thread: null,
    threadRootEventId: null,
    pending: true,
  });

  /** Stages what this app will share and says why about what it won't — the refusal names the limit and keeps everything. */
  const stage = (files: FileList): void => {
    // Snapshot before the first await: resetting the input's value after
    // handing its FileList over empties the live list, and the member's
    // pick must not depend on that timing.
    const picked = [...files];
    void (async () => {
      const staged: StagedShare[] = [];
      const refusals: string[] = [];
      for (const file of picked) {
        const refusal = shareRefusalOf({ name: file.name, size: file.size, mimeType: file.type }, attachments.length + staged.length);
        if (refusal === null) {
          staged.push(await stageFile(file));
        } else {
          refusals.push(refusal);
        }
      }
      if (staged.length > 0) {
        setAttachments((current) => [...current, ...staged]);
      }
      if (refusals.length > 0) {
        setError(refusals.join(" "));
      }
    })();
  };

  const token = mentionTokenAtEnd(text);
  const offer =
    token === null
      ? null
      : mentionCandidatesOf(members, connection.userId).filter((candidate) => {
          const fragment = token.slice(1).toLowerCase();
          return candidate.label.toLowerCase().startsWith(fragment) || localpartOf(candidate.userId).toLowerCase().startsWith(fragment);
        });
  const pickMention = (candidate: MentionCandidate): void => {
    // The half-typed token goes, the chosen label lands with its trailing
    // space — the text now says the mention in words people read.
    setText(text.replace(/@[^@\s]*$/, `${addressed(candidate.userId, candidate.label)} `));
    setPicks((current) => [...current.filter((pick) => pick.userId !== candidate.userId), { userId: candidate.userId, label: candidate.label }]);
  };

  return (
    <form
      className="border-t border-[var(--edge)] p-4"
      data-testid="room-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) {
          return;
        }
        const body = trimmed;
        const toShare = attachments;
        const livePicks = picks.filter((pick) => text.includes(addressed(pick.userId, pick.label)));
        setPending(true);
        setError(null);
        // The share walks one attachment at a time, in the order staged,
        // and stops at the first thing the workspace refuses: the rest stay
        // attached and the words stay typed, because a question sent past a
        // failed share would ride the wrong set of files — the member
        // decides again, with the reason stated (#66 AC4).
        void (async () => {
          let completedEchoes: string[] = [];
          const unfinishedEchoes: string[] = [];
          let sharedCount = 0;
          try {
            for (const staged of toShare) {
              setStatus(`Uploading ${staged.name}…`);
              const shared = await connection.uploadFile(staged, (sent, total) => {
                setStatus(total > 0 ? `Uploading ${staged.name}… ${Math.round((sent / total) * 100)}%` : `Uploading ${staged.name}…`);
              });
              const echoId = `pending-${(echoSequence += 1)}`;
              unfinishedEchoes.push(echoId);
              appendEcho(echoRow(echoId, shared));
              setStatus(`Sharing ${staged.name}…`);
              await connection.sendFile(roomId, shared);
              completedEchoes = [...completedEchoes, echoId];
              sharedCount += 1;
            }
            if (body.length > 0) {
              // The question goes last and contiguous: the association
              // convention is the asker's own file messages immediately
              // preceding their text, same sender, same room.
              const echoId = `pending-${(echoSequence += 1)}`;
              unfinishedEchoes.push(echoId);
              appendEcho({
                eventId: echoId,
                roomId,
                senderId: connection.userId,
                senderName: localpartOf(connection.userId),
                body,
                parts: null,
                originServerTs: Date.now(),
                edited: false,
                redacted: false,
                reactions: [],
                thread: null,
                threadRootEventId: null,
                pending: true,
              });
              await (livePicks.length > 0 ? connection.send(roomId, body, livePicks) : connection.send(roomId, body));
              completedEchoes = [...completedEchoes, echoId];
            }
            setText("");
            setPicks([]);
            setAttachments([]);
          } catch (error) {
            // The optimistic copies of what never became the homeserver's
            // record go; what did complete keeps its copy until the
            // subscription's refetch lands the real rows.
            dropEchoes(unfinishedEchoes.filter((id) => !completedEchoes.includes(id)));
            setAttachments(toShare.slice(sharedCount));
            setError(
              sharedCount < toShare.length
                ? `The workspace didn't take ${toShare[sharedCount]!.name}. ${error instanceof Error && error.message.length > 0 ? `${error.message} ` : ""}It's still attached and your words are still here. Try again.`
                : "Couldn't send — try again.",
            );
          } finally {
            setPending(false);
            setStatus(null);
          }
        })();
      }}
    >
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1" data-testid="attachment-row">
          {attachments.map((attachment, index) => (
            <span
              className="inline-flex min-h-9 items-center gap-1 rounded-full border border-[var(--edge)] px-2 type-provenance text-[var(--text)]"
              data-testid="attachment-chip"
              key={`${attachment.name}-${index}`}
            >
              <Paperclip aria-label="Attachment" className="size-3.5 shrink-0" />
              <span className="break-all">
                {attachment.name} · {formatBytes(attachment.size)}
              </span>
              <button
                className="inline-flex items-center rounded-full px-1 text-[var(--muted)]"
                data-testid="attachment-remove"
                disabled={pending}
                onClick={() => setAttachments((current) => current.filter((_, at) => at !== index))}
                type="button"
              >
                <X aria-label={`Remove ${attachment.name}`} className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-start gap-2">
        <input
          aria-label="Attach files"
          className="sr-only"
          data-testid="attach-file-input"
          multiple
          ref={fileInput}
          type="file"
          onChange={(e) => {
            if (e.currentTarget.files !== null) {
              stage(e.currentTarget.files);
            }
            // Reset so picking the same file again after removing it fires.
            e.currentTarget.value = "";
          }}
        />
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)] disabled:opacity-40"
          disabled={pending}
          onClick={() => fileInput.current?.click()}
          type="button"
        >
          <Paperclip aria-label="Attach files" className="size-4" />
        </button>
        <textarea
          aria-label={`Message ${roomName}`}
          className="min-h-11 flex-1 resize-none rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-1 text-[var(--text)]"
          placeholder={`Message ${roomName}`}
          rows={Math.max(1, Math.min(8, text.split("\n").length))}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
          disabled={disabled}
          type="submit"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
      {offer !== null && offer.length > 0 && (
        <div className="mt-2 flex flex-col gap-1" data-testid="mention-offer">
          {offer.map((candidate) => (
            <button
              key={candidate.userId}
              className="inline-flex min-h-11 items-center gap-2 self-start rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2 type-body"
              data-testid="mention-option"
              type="button"
              onClick={() => pickMention(candidate)}
            >
              <span
                aria-hidden="true"
                className="rounded-full border border-[var(--edge)] px-2 type-provenance text-[var(--muted)]"
                data-testid="mention-kind"
              >
                {candidate.kind}
              </span>
              {candidate.label}
            </button>
          ))}
        </div>
      )}
      {status !== null && (
        <p className="mt-2 type-provenance text-[var(--muted)]" data-testid="room-composer-status">
          {status}
        </p>
      )}
      {attachments.length > 0 && (
        <p className="mt-2 type-provenance text-[var(--muted)]" data-testid="attachment-note">
          {duos.length > 0
            ? `${duos.map((duo) => `${duoOwnerLabel(duo.userId) ?? localpartOf(duo.userId)}'s duo`).join(", ")} can read what you attach here when you ask next — text files up to 32 KiB ground the answer (the duo's own reading cap, smaller than this app's share limits); images are shared for people, and a duo can't read images yet — an open provider decision. Sharing never imports: nothing enters any duo's corpus.`
            : "Attachments share with the people in this conversation — no duo is here. Sharing never imports: nothing enters any duo's corpus."}
        </p>
      )}
      {error && (
        <p className="mt-2 type-body text-[var(--refused)]" data-testid="room-composer-error">
          {error}
        </p>
      )}
    </form>
  );
}
