import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RoomDuoMessage } from "../components/RoomDuoMessage.js";
import { RoomPersonMessage } from "../components/RoomPersonMessage.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { Timestamp } from "../components/Timestamp.js";
import { roomTitle } from "./Conversations.js";
import type { RoomMessage, WorkspaceConnection } from "../workspace/matrix.js";
import { duoOwnerLabel, isDuoUserId } from "../workspace/identity.js";

/**
 * #62 + #63: one conversation — the timeline and the composer. Who said
 * what is read STRUCTURALLY: a duo-shaped sender (`@duo-<owner>`,
 * identity.ts) renders as the multi-party `RoomDuoMessage` with the
 * possessive attribution ("carol's duo") derived from the id, and a person
 * renders `RoomPersonMessage` by their name. A display name can claim
 * anything; the user-id grammar cannot — which is the whole of AR-13 in a
 * shared room.
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
          {timeline.data.length === 0 ? (
            <p className="text-[var(--muted)]" data-testid="room-empty">
              Nothing here yet — say something below.
            </p>
          ) : (
            timeline.data.map((message) => <RoomEntry key={message.eventId} message={message} />)
          )}
        </section>
      </div>
      <RoomComposer connection={connection} roomId={roomId} roomName={roomName} />
    </div>
  );
}

/** One message, by what the id says the sender IS — person or duo, never a guess from names. */
function RoomEntry({ message }: { message: RoomMessage }) {
  const fromDuo = isDuoUserId(message.senderId);
  return (
    <div className="flex flex-col gap-1">
      {fromDuo ? (
        <RoomDuoMessage ownerName={duoOwnerLabel(message.senderId) ?? message.senderName}>{message.body}</RoomDuoMessage>
      ) : (
        <RoomPersonMessage authorName={message.senderName}>{message.body}</RoomPersonMessage>
      )}
      <p className="type-provenance text-[var(--faint)]">
        <Timestamp iso={new Date(message.originServerTs).toISOString()} />
      </p>
    </div>
  );
}

/**
 * The member's half of the room: a person saying something, in the chat-app
 * idiom this client already uses for asking (#27 — Enter is a newline,
 * Cmd/Ctrl-Enter submits). A failed send keeps the text and says so; the
 * message is on the record when the homeserver has it, not before.
 */
function RoomComposer({ connection, roomId, roomName }: { connection: WorkspaceConnection; roomId: string; roomName: string }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();
  const disabled = trimmed.length === 0 || pending;

  return (
    <form
      className="border-t border-[var(--edge)] p-4"
      data-testid="room-composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) {
          return;
        }
        setPending(true);
        setError(null);
        connection
          .send(roomId, trimmed)
          .then(() => setText(""))
          .catch(() => setError("Couldn't send — try again."))
          .finally(() => setPending(false));
      }}
    >
      <div className="flex items-start gap-2">
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
      {error && (
        <p className="mt-2 type-body text-[var(--refused)]" data-testid="room-composer-error">
          {error}
        </p>
      )}
    </form>
  );
}
