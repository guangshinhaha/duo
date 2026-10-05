import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RouteLoading } from "../components/RouteLoading.js";
import { InfoButton } from "../shell/InfoButton.js";
import { ChatTimelineList, useChatTimeline } from "../shell/useChatTimeline.js";
import { MessageBody } from "./Room.js";
import { roomTitle } from "../shell/roomTitle.js";
import type { RoomMessage, WorkspaceConnection } from "../workspace/matrix.js";
import { ChatEditor, type ChatEditorHandle } from "../composer/ChatEditor.js";

/** #211: how near the scroll container's own top counts as "scrolled to the top" — same figure Room.tsx uses, so the two pages feel the same under the finger. */
const SCROLLBACK_TRIGGER_PX = 80;

/** #248: the virtualizer's first guesses, before a row is measured — same figures as Room.tsx's. */
const MESSAGE_ROW_ESTIMATE_PX = 96;
const STATUS_ROW_ESTIMATE_PX = 40;

/** One row of a thread's transcript (#248): the beginning-of-history note, the root (or the note that it's gone), or a reply. */
type ThreadRow =
  | { readonly kind: "beginning" }
  | { readonly kind: "gone" }
  | { readonly kind: "message"; readonly message: RoomMessage };

function threadRowKey(row: ThreadRow): string {
  return row.kind === "message" ? row.message.eventId : `:${row.kind}`;
}

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
  // extends what both read — the same `loadOlder` mechanics as Room.tsx,
  // without that route's unread line (a thread has no read marker of its
  // own; Matrix receipts at room grade). The place-keeping on a prepend is
  // the virtualizer's (`useChatTimeline`), same as the conversation's.
  const [olderState, setOlderState] = useState<{ loading: boolean; atStart: boolean }>({ loading: false, atStart: false });

  useEffect(() => {
    setOlderState({ loading: false, atStart: false });
  }, [roomId]);

  // The live timeline and the window around a hit, merged by event id (the
  // live copy standing where both know a message).
  const messages = useMemo(() => {
    const live = timeline.data ?? [];
    const known = new Set(live.map((message) => message.eventId));
    const windowOnly = (around.data ?? []).filter((message) => !known.has(message.eventId));
    return windowOnly.length === 0 ? live : [...live, ...windowOnly].sort((a, b) => a.originServerTs - b.originServerTs);
  }, [timeline.data, around.data]);
  const root = messages.find((message) => message.eventId === rootEventId) ?? null;
  const rows = useMemo((): ThreadRow[] => {
    const list: ThreadRow[] = [];
    if (!olderState.loading && olderState.atStart) {
      list.push({ kind: "beginning" });
    }
    list.push(root === null ? { kind: "gone" } : { kind: "message", message: root });
    for (const message of messages) {
      if (message.threadRootEventId === rootEventId) {
        list.push({ kind: "message", message });
      }
    }
    return list;
  }, [messages, root, rootEventId, olderState]);
  // The first look (once per open): a search landing (#70) centres its
  // reply; otherwise the thread opens at its end, the latest reply. Only
  // once it has does an arrival at the end pull the view along.
  const openKey = `${roomId}\u0000${rootEventId}\u0000${at ?? ""}`;
  const [landed, setLanded] = useState<string | null>(null);
  const timelineView = useChatTimeline({
    count: rows.length,
    getKey: useCallback((index: number) => threadRowKey(rows[index]!), [rows]),
    estimateSize: useCallback((index: number) => (rows[index]!.kind === "message" ? MESSAGE_ROW_ESTIMATE_PX : STATUS_ROW_ESTIMATE_PX), [rows]),
    follow: landed === openKey,
  });
  const loaded = timeline.data !== undefined && (at === undefined || around.data !== undefined);
  const lastKey = rows.length > 0 ? threadRowKey(rows[rows.length - 1]!) : "";
  const ownLatest = (() => {
    const last = rows.at(-1);
    return last?.kind === "message" && connection !== null && last.message.senderId === connection.userId && last.message.pending === true;
  })();
  useEffect(() => {
    if (!loaded || !timelineView.ready || landed === openKey) {
      return;
    }
    // Same as the conversation's: a hit waits for a read that holds it (the
    // persisted copy may not); the end never needs to.
    const targetIndex = at === undefined ? -1 : rows.findIndex((row) => row.kind === "message" && row.message.eventId === at);
    if (at !== undefined && targetIndex < 0 && !(timeline.isFetchedAfterMount && around.isFetchedAfterMount)) {
      return;
    }
    setLanded(openKey);
    if (targetIndex >= 0) {
      timelineView.scrollToRow(targetIndex);
    } else if (at === undefined) {
      timelineView.scrollToEnd();
    }
  });
  // The member's own reply goes to the end, wherever they were reading.
  useEffect(() => {
    if (ownLatest) {
      timelineView.scrollToEnd();
    }
    // Keyed on the newest row alone: a fresh own echo, once.
  }, [lastKey]);

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
    if (landed !== openKey || olderState.loading || olderState.atStart) {
      return;
    }
    const el = timelineView.scrollerRef.current;
    if (!el || el.scrollTop > SCROLLBACK_TRIGGER_PX) {
      return;
    }
    setOlderState((state) => ({ ...state, loading: true }));
    void connection
      .loadOlder(roomId)
      .then(async (result) => {
        if (result.loadedMore) {
          await timeline.refetch();
        }
        setOlderState({ loading: false, atStart: result.atStart });
      })
      .catch(() => {
        setOlderState((state) => ({ ...state, loading: false }));
      });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-[var(--edge)] px-4 py-2" data-testid="thread-header">
        <h1 className="min-w-0 truncate type-heading">{roomName} — thread</h1>
        <InfoButton />
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* #211: a page on its way — floating, same as the conversation's, so it never shifts the rows. */}
        {olderState.loading && (
          <p
            className="pointer-events-none absolute top-2 left-1/2 z-10 -translate-x-1/2 rounded-full border border-[var(--edge)] bg-[var(--surface)] px-3 py-1 type-provenance text-[var(--muted)]"
            data-testid="room-loading-older"
          >
            Loading older messages…
          </p>
        )}
        <div className="relative flex-1 overflow-y-auto px-6" data-testid="thread-scroller" ref={timelineView.scrollerRef} onScroll={handleScroll}>
          <a
            className="mt-6 inline-flex min-h-11 items-center self-start rounded-[var(--r-sm)] px-2 type-provenance uppercase text-[var(--muted)]"
            data-testid="back-to-room"
            href={`#chat/${encodeURIComponent(roomId)}`}
          >
            Back to conversation
          </a>
          <ChatTimelineList
            count={rows.length}
            testId="thread-timeline"
            timeline={timelineView}
            renderRow={(index) => {
              const row = rows[index]!;
              switch (row.kind) {
                case "beginning":
                  return (
                    <p className="py-2 text-center type-provenance text-[var(--muted)]" data-testid="room-beginning">
                      This is the beginning of the conversation.
                    </p>
                  );
                case "gone":
                  return (
                    <p className="text-[var(--muted)]" data-testid="thread-gone">
                      {at === undefined
                        ? "This thread's first message is gone — its replies keep their places."
                        : "This thread's first message is outside what is loaded here — its replies keep their places."}
                    </p>
                  );
                case "message":
                  // Same row testid as the conversation's rows: a message is a
                  // message wherever it's read (#64).
                  return (
                    <div
                      aria-current={row.message.eventId === at ? "true" : undefined}
                      data-focused={row.message.eventId === at ? "true" : undefined}
                      data-testid="room-message"
                    >
                      <MessageBody
                        conversation={messages}
                        message={row.message}
                        loadMedia={connection.loadMedia}
                        getUrlPreview={connection.getUrlPreview}
                        onToggleReaction={toggleReaction}
                        onRetry={retryMessage}
                        onCancel={cancelMessage}
                      />
                    </div>
                  );
              }
            }}
          />
          <div className="pb-6" ref={timelineView.footerRef} />
        </div>
      </div>
      {root !== null && <ThreadComposer connection={connection} roomId={roomId} rootEventId={rootEventId} />}
    </div>
  );
}

/**
 * The thread's composer: same editor (#248), same keys (#244) and the same
 * instant render as the conversation's (#64 AC1 / #209) — matrix-js-sdk's own local echo puts the
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
  const form = useRef<HTMLFormElement | null>(null);
  const editor = useRef<ChatEditorHandle | null>(null);
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const disabled = trimmed.length === 0;

  return (
    <form
      className="border-t border-[var(--edge)] p-4"
      data-testid="thread-composer"
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) {
          return;
        }
        const body = (editor.current?.read().body ?? text).trim();
        // #209: fire-and-forget — the reply's row (related to the root, so
        // it renders in the thread at once) carries its own "Sending…" or
        // failed state from here on; the composer clears the same frame.
        connection.replyInThread(roomId, rootEventId, body).catch(() => undefined);
        editor.current?.clear();
      }}
    >
      <div className="flex items-start gap-2">
        {/* #248: plain mode — a thread reply's wire shape carries no
            formatting (`replyInThread` sends `body` alone), so the editor
            doesn't style what the message won't. */}
        <ChatEditor
          ariaLabel="Reply in thread"
          editorRef={editor}
          mode="plain"
          placeholder="Reply in thread"
          onSubmit={() => form.current?.requestSubmit()}
          onTextChange={setText}
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
