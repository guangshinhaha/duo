import { ApiRequestError, RequestTimeoutError, type DuoApiConfig } from "./client.js";
import type { ApiError, DraftPipelineResult, RecipientRef } from "./types.js";

/** The body `POST /drafts/stream` takes — identical to `POST /drafts`' own body (`useCreateDraft`'s `input`). */
export interface StreamDraftInput {
  readonly question: string;
  readonly threadContext?: string | null;
  readonly recipient?: RecipientRef;
}

export interface StreamDraftOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Called once per revealed chunk, in the order the daemon sent them.
   * Concatenating every call's `text` reproduces the final answer (or
   * escalation reason) exactly — no re-spacing needed on this side
   * (`client-tech-design.md` §1.4's `/drafts/stream` row).
   */
  readonly onChunk?: (text: string) => void;
}

/**
 * `POST /drafts/stream` (duo#304) — self-chat's streamed sibling of
 * `POST /drafts` (`useCreateDraft`, `client.ts`'s `apiRequest`). Same
 * request body, same daemon-side side effects (one draft-log row, the
 * same-tick `draft-ready` push); the only difference is how the response
 * arrives — Server-Sent Events instead of one JSON body — so the Composer
 * can render the answer as it is revealed rather than waiting for all of
 * it. Resolves with the exact `DraftPipelineResult` `POST /drafts` would
 * have returned, read off the stream's final `done` frame.
 *
 * Deliberately not built on `apiRequest`: that helper always calls
 * `response.json()`, which would try to parse an SSE body as one JSON
 * document and throw. This duplicates its abort/timeout combining and its
 * non-2xx error handling (kept in lockstep with it on purpose) because past
 * that point the two response bodies are read completely differently.
 */
export async function streamDraft(api: DuoApiConfig, input: StreamDraftInput, options: StreamDraftOptions = {}): Promise<DraftPipelineResult> {
  const { signal: callerSignal, timeoutMs, onChunk } = options;
  // Same single-controller shape as `apiRequest` (`client.ts`): the
  // Composer's Cancel button and a timeout both need to end the one fetch,
  // and fetch accepts exactly one signal.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", forwardAbort);
    }
  }
  let timedOut = false;
  const timer =
    timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  try {
    const response = await fetch(`${api.baseUrl}/drafts/stream`, {
      method: "POST",
      body: JSON.stringify(input),
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${api.token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
    });

    if (!response.ok) {
      let body: ApiError | undefined;
      try {
        body = (await response.json()) as ApiError;
      } catch {
        body = undefined;
      }
      throw new ApiRequestError(response.status, body);
    }
    if (!response.body) {
      // No streaming body to read incrementally (an environment/polyfill
      // without a readable `response.body`) — the request itself
      // succeeded, there is just nothing to consume.
      throw new Error("The daemon's answer stream had no readable body.");
    }

    const result = await consumeDraftStream(response.body, onChunk);
    if (result === undefined) {
      // The stream ended (server closed it) before a `done` frame ever
      // arrived — not the owner's own Stop (that rejects via AbortError,
      // caught below instead) and not a timeout either: an honest failure
      // the caller should surface like any other.
      throw new Error("The daemon's answer stream ended before an answer arrived.");
    }
    return result;
  } catch (error) {
    if (timedOut && error instanceof Error && error.name === "AbortError") {
      throw new RequestTimeoutError(timeoutMs ?? 0);
    }
    throw error; // an owner abort (Cancel) stays an abort — Composer.tsx's own check reads error.name
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (callerSignal) {
      callerSignal.removeEventListener("abort", forwardAbort);
    }
  }
}

/**
 * Reads a `text/event-stream` body framed exactly as the daemon's
 * `/drafts/stream` writes it (`event: <name>\ndata: <json>\n\n`), calling
 * `onChunk` for each `chunk` frame and returning the `done` frame's
 * `DraftPipelineResult` — `undefined` if the stream ends with no `done`
 * frame (a dropped connection, or the reader being cancelled by an abort
 * that raced the natural end).
 */
async function consumeDraftStream(body: ReadableStream<Uint8Array>, onChunk: ((text: string) => void) | undefined): Promise<DraftPipelineResult | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: DraftPipelineResult | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseFrame(frame);
        if (parsed?.event === "chunk") {
          onChunk?.((parsed.data as { text: string }).text);
        } else if (parsed?.event === "done") {
          result = parsed.data as DraftPipelineResult;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Releases the reader promptly once this function is done with it,
    // whether that's a clean end or a thrown abort — mirrors `apiRequest`
    // tearing down its own fetch in `finally`. A reader already closed or
    // errored just resolves/rejects trivially; either way, nothing this
    // function does depends on which.
    void reader.cancel().catch(() => undefined);
  }
  return result;
}

function parseSseFrame(frame: string): { event: string; data: unknown } | undefined {
  const lines = frame.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));
  if (!eventLine || !dataLine) {
    return undefined;
  }
  return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
}
