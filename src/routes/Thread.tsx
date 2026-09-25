import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RouteLoading } from "../components/RouteLoading.js";
import { MessageBody } from "./Room.js";
import { roomTitle } from "./Conversations.js";
import type { RoomMessage, WorkspaceConnection } from "../workspace/matrix.js";
import { localpartOf } from "../workspace/identity.js";

/**
 * #64: one thread — a root message and the replies that relate to it. The
 * route's address carries both halves (`#thread/<room>/<root>`), so a
 * thread is linkable from the conversation's preview and back again.
 *
 * Every row renders through the same `MessageBody` as the conversation's
 * flow, so a message reads identically wherever it's read — attribution
 * included, structural by the @duo- grammar. Reading a thread is reading
 * the room (#63's receipt holds here the same), and replies post through
 * the connection's thread verb, with the same optimistic contract the
 * conversation's composer keeps.
 */
export function ThreadView({
  connection,
  roomId,
  rootEventId,
}: {
  connection: WorkspaceConnection | null;
  roomId: string;
  rootEventId: string;
}) {
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

  // The receipt is the room's, not the thread's — Matrix receipts at room
  // grade, so opening a thread counts as reading the conversation (#64 AC4
  // pins exactly this: the thread's own URL receipts the room).
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

  if (!connection || timeline.isLoading) {
    return (
      <div className="p-6">
        <h1 className="type-heading sr-only">{roomName} — thread</h1>
        <RouteLoading variant="rows" />
      </div>
    );
  }
  if (timeline.error !== null || timeline.data === undefined) {
    return (
      <div className="p-6">
        <h1 className="type-heading sr-only">{roomName} — thread</h1>
        <p className="type-body text-[var(--escalate)]">The workspace didn&apos;t give up this thread — try again.</p>
        <button
          className="mt-3 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
          onClick={() => void timeline.refetch()}
        >
          Try again
        </button>
      </div>
    );
  }

  const root = timeline.data.find((message) => message.eventId === rootEventId) ?? null;
  const replies = timeline.data.filter((message) => message.threadRootEventId === rootEventId);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
  };
  const toggleReaction = (message: RoomMessage, key: string, mine: boolean): void => {
    void (mine ? connection.unreact(roomId, message.eventId, key) : connection.react(roomId, message.eventId, key))
      .then(() => undefined)
      .catch(() => undefined)
      .finally(refresh);
  };

  return (
    <div className="flex h-full flex-col">
      <h1 className="type-heading sr-only">{roomName} — thread</h1>
      <div className="flex-1 overflow-y-auto p-6">
        <a
          className="inline-flex min-h-11 items-center self-start rounded-[var(--r-sm)] px-2 type-provenance uppercase text-[var(--muted)]"
          data-testid="back-to-room"
          href={`#room/${encodeURIComponent(roomId)}`}
        >
          Back to conversation
        </a>
        <section className="mt-2 flex flex-col gap-5" data-testid="thread-timeline">
          {root === null ? (
            <p className="text-[var(--muted)]" data-testid="thread-gone">
              This thread&apos;s first message is gone — its replies keep their places.
            </p>
          ) : (
            // Same row testid as the conversation's rows: a message is a
            // message wherever it's read (#64).
            <div data-testid="room-message">
              <MessageBody message={root} onToggleReaction={toggleReaction} />
            </div>
          )}
          {replies.map((reply) => (
            <div data-testid="room-message" key={reply.eventId}>
              <MessageBody message={reply} onToggleReaction={toggleReaction} />
            </div>
          ))}
        </section>
      </div>
      {root !== null && <ThreadComposer connection={connection} roomId={roomId} rootEventId={rootEventId} />}
    </div>
  );
}

/** Distinguishes one optimistic reply from the next — the homeserver's event ids replace these. */
let echoSequence = 0;

/**
 * The thread's composer: same idiom and same optimistic contract as the
 * conversation's (#64 AC1), posting through the thread verb so the reply
 * belongs to the thread, never the main flow.
 */
function ThreadComposer({
  connection,
  roomId,
  rootEventId,
}: {
  connection: WorkspaceConnection;
  roomId: string;
  rootEventId: string;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();
  const disabled = trimmed.length === 0 || pending;

  return (
    <form
      className="border-t border-[var(--edge)] p-4"
      data-testid="thread-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) {
          return;
        }
        const body = trimmed;
        const echoId = `pending-thread-${(echoSequence += 1)}`;
        setPending(true);
        setError(null);
        // The optimistic copy, related to the root so it renders in the
        // thread at once; the refetch replaces it with the record and
        // re-reads the root's summary of its thread.
        queryClient.setQueryData<readonly RoomMessage[]>(["workspace", "timeline", roomId], (current) => [
          ...(current ?? []),
          {
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
            threadRootEventId: rootEventId,
            pending: true,
          },
        ]);
        connection
          .replyInThread(roomId, rootEventId, body)
          .then(() => setText(""))
          .catch(() => {
            setError("Couldn't send — try again.");
            queryClient.setQueryData<readonly RoomMessage[]>(["workspace", "timeline", roomId], (current) =>
              (current ?? []).filter((row) => row.eventId !== echoId),
            );
          })
          .finally(() => {
            setPending(false);
            // The root's summary of its thread re-reads with the record.
            void queryClient.invalidateQueries({ queryKey: ["workspace"] });
          });
      }}
    >
      <div className="flex items-start gap-2">
        <textarea
          aria-label="Reply in thread"
          className="min-h-11 flex-1 resize-none rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-1 text-[var(--text)]"
          placeholder="Reply in thread"
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
      {error && (
        <p className="mt-2 type-body text-[var(--refused)]" data-testid="thread-composer-error">
          {error}
        </p>
      )}
    </form>
  );
}
