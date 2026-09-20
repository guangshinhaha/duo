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
  | { type: "draft-ready"; draftId: string };

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
 * Reconnect has exponential backoff that resets on a successful auth —
 * §3.3: reconnect *refetches*, it never replays, so a close is repaired by
 * the same invalidation every other reader already uses. The asker page
 * (`ask.html`) never mounts this hook: an asker has no push channel, and
 * no owner surface to refresh.
 */
export function useDraftReadySocket(api: DuoApiConfig | null, onDraftReady?: (draftId: string) => void): void {
  const queryClient = useQueryClient();
  const onDraftReadyRef = useRef(onDraftReady);
  onDraftReadyRef.current = onDraftReady;

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
