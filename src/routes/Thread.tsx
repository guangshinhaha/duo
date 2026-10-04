import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RouteLoading } from "../components/RouteLoading.js";
import { InfoButton } from "../shell/InfoButton.js";
import { MessageBody } from "./Room.js";
import { roomTitle } from "../shell/roomTitle.js";
import type { RoomMessage, WorkspaceConnection } from "../workspace/matrix.js";

/** #70: bring the message a search hit landed at into view — the ref runs once, when its row mounts. */
const focusIntoView = (element: HTMLElement | null): void => {
  element?.scrollIntoView?.({ block: "center" });
};

/** #211: how near the scroll container's own top counts as "scrolled to the top" — same figure Room.tsx uses, so the two pages feel the same under the finger. */
const SCROLLBACK_TRIGGER_PX = 80;

/**
 * #64: one thread — a root message and the replies that relate to it. The
 * route's address carries both halves (`#chat/<room>/thread/<root>`), so a
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
  at,
}: {
  connection: WorkspaceConnection | null;
  roomId: string;
  rootEventId: string;
  /** #70: the reply a search hit landed at — marked, and brought into view. */
  at?: string;
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

  // #70: landing at a hit also reads the window around it — a reply older
  // than the live timeline still lands. The two are one thread's evidence,
  // merged by event id (the live copy standing where both know a message).
  const around = useQuery({
    queryKey: ["workspace", "timeline", roomId, "at", at ?? ""],
    queryFn: () => connection!.timelineAt(roomId, at!),
    enabled: connection !== null && at !== undefined,
    meta: { target: "workspace" },
  });

  const room = rooms.data?.find((candidate) => candidate.roomId === roomId);
  const roomName = room ? roomTitle(room) : roomId;

  // The receipt is the room's, not the thread's — Matrix receipts at room
  // grade, so opening a thread counts as reading the conversation (#64 AC4
  // pins exactly this: the thread's own URL receipts the room).
  useEffect(() => {
    // Landing at an old reply is not reading the latest — no receipt (#70).
    if (!connection || at !== undefined || !timeline.isSuccess || timeline.data === undefined) {
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
  }, [connection, roomId, at, timeline.isSuccess, timeline.data, queryClient]);

  // #211: a thread pages the SAME room timeline the main flow does (there is
  // no separate "thread timeline" door), so scrolling to the top of one
  // extends what both read — the same `loadOlder`/scroll-position-preserving
  // mechanics as Room.tsx, without that route's unread line (a thread has no
  // read marker of its own; Matrix receipts at room grade).
  const scroller = useRef<HTMLDivElement>(null);
  const prependAdjust = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const [olderState, setOlderState] = useState<{ loading: boolean; atStart: boolean }>({ loading: false, atStart: false });

  useEffect(() => {
    setOlderState({ loading: false, atStart: false });
  }, [roomId]);

  useLayoutEffect(() => {
    const adjust = prependAdjust.current;
    const el = scroller.current;
    if (adjust && el) {
      el.scrollTop = el.scrollHeight - adjust.scrollHeight + adjust.scrollTop;
      prependAdjust.current = null;
    }
  }, [timeline.data]);

  if (!connection || timeline.isLoading || (at !== undefined && around.isLoading)) {
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

  const known = new Set(timeline.data.map((message) => message.eventId));
  const windowOnly = (around.data ?? []).filter((message) => !known.has(message.eventId));
  const messages =
    windowOnly.length === 0 ? timeline.data : [...timeline.data, ...windowOnly].sort((a, b) => a.originServerTs - b.originServerTs);
  const root = messages.find((message) => message.eventId === rootEventId) ?? null;
  const replies = messages.filter((message) => message.threadRootEventId === rootEventId);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["workspace"] });
  };
  const toggleReaction = (message: RoomMessage, key: string, mine: boolean): void => {
    void (mine ? connection.unreact(roomId, message.eventId, key) : connection.react(roomId, message.eventId, key))
      .then(() => undefined)
      .catch(() => undefined)
      .finally(refresh);
  };
  // #209: same Retry/Cancel contract as the main flow's rows — acts on
  // matrix-js-sdk's own local echo through the connection, never a second
  // copy of the reply this client invented.
  const retryMessage = (message: RoomMessage): void => {
    void connection.retry(roomId, message.eventId).catch(() => undefined).finally(refresh);
  };
  const cancelMessage = (message: RoomMessage): void => {
    connection.cancel(roomId, message.eventId);
    refresh();
  };

  // #211: same mechanics as Room.tsx's handler — see its own comment for why.
  const handleScroll = (): void => {
    if (olderState.loading || olderState.atStart) {
      return;
    }
    const el = scroller.current;
    if (!el || el.scrollTop > SCROLLBACK_TRIGGER_PX) {
      return;
    }
    prependAdjust.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
    setOlderState((state) => ({ ...state, loading: true }));
    void connection
      .loadOlder(roomId)
      .then(async (result) => {
        if (result.loadedMore) {
          await timeline.refetch();
        } else {
          prependAdjust.current = null;
        }
        setOlderState({ loading: false, atStart: result.atStart });
      })
      .catch(() => {
        prependAdjust.current = null;
        setOlderState((state) => ({ ...state, loading: false }));
      });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-[var(--edge)] px-4 py-2" data-testid="thread-header">
        <h1 className="min-w-0 truncate type-heading">{roomName} — thread</h1>
        <InfoButton />
      </header>
      <div className="flex-1 overflow-y-auto p-6" ref={scroller} onScroll={handleScroll}>
        <a
          className="inline-flex min-h-11 items-center self-start rounded-[var(--r-sm)] px-2 type-provenance uppercase text-[var(--muted)]"
          data-testid="back-to-room"
          href={`#chat/${encodeURIComponent(roomId)}`}
        >
          Back to conversation
        </a>
        {olderState.loading && (
          <p className="py-2 text-center type-provenance text-[var(--muted)]" data-testid="room-loading-older">
            Loading older messages…
          </p>
        )}
        {!olderState.loading && olderState.atStart && (
          <p className="py-2 text-center type-provenance text-[var(--muted)]" data-testid="room-beginning">
            This is the beginning of the conversation.
          </p>
        )}
        <section className="mt-2 flex flex-col gap-5" data-testid="thread-timeline">
          {root === null ? (
            <p className="text-[var(--muted)]" data-testid="thread-gone">
              {at === undefined
                ? "This thread's first message is gone — its replies keep their places."
                : "This thread's first message is outside what is loaded here — its replies keep their places."}
            </p>
          ) : (
            // Same row testid as the conversation's rows: a message is a
            // message wherever it's read (#64).
            <div data-testid="room-message">
              <MessageBody
                conversation={messages}
                message={root}
                loadMedia={connection.loadMedia}
                getUrlPreview={connection.getUrlPreview}
                onToggleReaction={toggleReaction}
                onRetry={retryMessage}
                onCancel={cancelMessage}
              />
            </div>
          )}
          {replies.map((reply) => (
            <div
              aria-current={reply.eventId === at ? "true" : undefined}
              data-focused={reply.eventId === at ? "true" : undefined}
              data-testid="room-message"
              key={reply.eventId}
              ref={reply.eventId === at ? focusIntoView : undefined}
            >
              <MessageBody
                conversation={messages}
                message={reply}
                loadMedia={connection.loadMedia}
                getUrlPreview={connection.getUrlPreview}
                onToggleReaction={toggleReaction}
                onRetry={retryMessage}
                onCancel={cancelMessage}
              />
            </div>
          ))}
        </section>
      </div>
      {root !== null && <ThreadComposer connection={connection} roomId={roomId} rootEventId={rootEventId} />}
    </div>
  );
}

/**
 * The thread's composer: same idiom and the same instant render as the
 * conversation's (#64 AC1 / #209) — matrix-js-sdk's own local echo puts the
 * reply's row in the thread the moment `replyInThread` is called, and the
 * composer clears without waiting on the homeserver. A failed reply keeps
 * its row, marked failed, with Retry and Cancel (`MessageBody`, wired
 * above) — the composer itself never held the words past Enter.
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
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const disabled = trimmed.length === 0;

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
        // #209: fire-and-forget — the reply's row (related to the root, so
        // it renders in the thread at once) carries its own "Sending…" or
        // failed state from here on; the composer clears the same frame.
        connection.replyInThread(roomId, rootEventId, body).catch(() => undefined);
        setText("");
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
          Send
        </button>
      </div>
    </form>
  );
}
