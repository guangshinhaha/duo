import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DuoApiConfig } from "./client.js";

/**
 * The client half of the daemon's one push channel (client-tech-design.md
 * Part 1.1 `serve/ws.ts — one channel: draft-ready`; daemon contract in
 * digital-duo #162, contract-first like the asker page). The browser
 * `WebSocket` API cannot set an `Authorization` header, so auth happens by
 * first message — the token never rides in a URL or an access log.
 */
export type WsInbound =
  | { type: "ready" }
  | { type: "draft-ready"; draftId: string }
  // guangshinhaha/duo#285: "your duo is drafting" — a draft is being
  // composed for this room, before it exists as a draft row at all (so
  // there is no draftId yet, only the room it's for). Digital-duo fires
  // this once per workspace question that starts drafting; there is no
  // matching "stopped drafting" message — see `useDraftReadySocket`'s own
  // doc comment for how the client clears it.
  | { type: "draft-drafting"; roomId: string }
  // W-S4-9: the owner channel's two card-protocol signals
  // (`docs/workspace/cards.md` §7) — ids and state only, never content,
  // the same discipline `draft-ready` already keeps. `task-updated` fires
  // on every task state change (acknowledged, working, …); `card-updated`
  // fires whenever a card this client can read (`audience: "owner"`, §7's
  // table) changes. Each invalidates its own query root rather than
  // `["drafts"]`'s — a task or a card is never a draft.
  | { type: "task-updated"; taskId: string; roomId: string; state: string }
  | { type: "card-updated"; cardId: string; roomId: string };

const AUTH_CLOSE_CODE = 4001;
const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

function wsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  return url.toString();
}

/**
 * Keeps one WebSocket to the daemon for the life of the owner app:
 * connect → auth on open → on `draft-ready`, invalidate the §3.2 keys
 * (`["drafts"]` and `["review"]` — a new pending draft is exactly an
 * outcome-shaped write) and fire the native notification via `onDraftReady`
 * (C5's shell supplies it; the browser default does nothing).
 *
 * guangshinhaha/duo#285: on `draft-drafting`, `onDraftingStarted` hears the
 * room id — "your duo is drafting", shown only where that room surfaces
 * (App.tsx owns the socket and passes the signal down, the same way it
 * already does for `drafts`'s `RoomDrafts` slot; this hook does nothing
 * with it beyond handing it along, since what to show is a rendering
 * decision this module may not make). There is no matching "stopped
 * drafting" push — App.tsx clears it itself once the room sees any
 * activity, or after its own timeout, same honesty `draft-ready` itself
 * never needed because a draft, once created, stays queryable forever.
 *
 * W-S4-9: `task-updated`/`card-updated` invalidate `["tasks"]`/`["cards"]`
 * only — never `["drafts"]`, since a task or a card is its own kind of
 * record, read through `useTasks`/`useTask`/`useOwnerCards`
 * (`src/api/queries.ts`), not through the draft log. Carries ids and state
 * only, matching `docs/workspace/cards.md` §7's "never content" rule for
 * the owner channel.
 *
 * Reconnect has exponential backoff that resets on a successful auth —
 * §3.3: reconnect *refetches*, it never replays, so a close is repaired by
 * the same invalidation every other reader already uses. The asker page
 * (`ask.html`) never mounts this hook: an asker has no push channel, and
 * no owner surface to refresh.
 */
export function useDraftReadySocket(
  api: DuoApiConfig | null,
  onDraftReady?: (draftId: string) => void,
  onDraftingStarted?: (roomId: string) => void,
): void {
  const queryClient = useQueryClient();
  const onDraftReadyRef = useRef(onDraftReady);
  onDraftReadyRef.current = onDraftReady;
  const onDraftingStartedRef = useRef(onDraftingStarted);
  onDraftingStartedRef.current = onDraftingStarted;

  useEffect(() => {
    if (!api || typeof WebSocket === "undefined") {
      // No pairing, or no WebSocket in this environment (happy-dom in the
      // test rig; a WebView with sockets stripped): no push channel, and
      // no crash — polling-by-refetch keeps being the floor.
      return;
    }
    let socket: WebSocket | null = null;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    // Captured consts, not closed-over `api`: `connect` is a hoisted
    // function declaration, so TypeScript won't carry the null-guard's
    // narrowing into it — and the effect's deps already treat these two
    // fields as the pairing's identity.
    const { baseUrl, token } = api;

    function handleMessage(event: MessageEvent): void {
      let parsed: WsInbound;
      try {
        parsed = JSON.parse(String(event.data)) as WsInbound;
      } catch {
        return; // not for us — one channel, but the wire is still JSON-or-nothing
      }
      if (parsed.type === "ready") {
        attempts = 0; // authed cleanly: backoff resets (§3.3's reconnect-refetches)
        return;
      }
      if (parsed.type === "draft-ready") {
        // Root-key invalidation covers every §3.2 child (`["drafts", {outcome}]`, `["drafts", id]`).
        void queryClient.invalidateQueries({ queryKey: ["drafts"] });
        void queryClient.invalidateQueries({ queryKey: ["review"] });
        onDraftReadyRef.current?.(parsed.draftId);
        return;
      }
      if (parsed.type === "draft-drafting") {
        onDraftingStartedRef.current?.(parsed.roomId);
        return;
      }
      if (parsed.type === "task-updated") {
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        return;
      }
      if (parsed.type === "card-updated") {
        void queryClient.invalidateQueries({ queryKey: ["cards"] });
      }
    }

    function scheduleReconnect(event: CloseEvent): void {
      if (disposed || event.code === AUTH_CLOSE_CODE) {
        return; // a rejected token is a pairing problem, not a flaky link — retrying won't change the answer
      }
      const backoff = Math.min(BACKOFF_FIRST_MS * 2 ** attempts, BACKOFF_MAX_MS);
      attempts += 1;
      reconnectTimer = setTimeout(connect, backoff);
    }

    function connect(): void {
      socket = new WebSocket(wsUrl(baseUrl));
      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({ type: "auth", token }));
      });
      socket.addEventListener("message", handleMessage);
      socket.addEventListener("close", scheduleReconnect);
    }

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      socket?.removeEventListener("close", scheduleReconnect);
      socket?.close();
    };
    // `api` is a stable object per pairing (re-created only by the Setup
    // flow, which unmounts this effect anyway via api === null); `baseUrl`
    // and `token` are its identity in practice.
  }, [api?.baseUrl, api?.token, queryClient]);
}
