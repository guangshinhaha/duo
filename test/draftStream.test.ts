import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, RequestTimeoutError, type DuoApiConfig } from "../src/api/client.js";
import { streamDraft } from "../src/api/draftStream.js";

/*
 * duo#304: `streamDraft` is `POST /drafts/stream`'s one client-side reader
 * — `Composer.tsx` (via `useCreateDraftStream`) is its one caller, but the
 * SSE parsing itself (partial frames across reads, non-2xx errors, a
 * missing body, a stream that ends with no `done` frame, an owner abort)
 * is worth pinning directly rather than only through a rendered component.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };
const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A streaming body built from whole SSE frames, delivered across as many `read()`s as `frames` has entries — one real network read per element. */
function streamOf(frames: readonly string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) {
        controller.enqueue(encoder.encode(frames[i]!));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

/** The same body, but split into arbitrary byte-level pieces mid-frame — proves the buffer handles a frame arriving in fragments, not just whole. */
function fragmentedStreamOf(text: string, fragmentSize: number): ReadableStream<Uint8Array> {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + fragmentSize));
      offset += fragmentSize;
    },
  });
}

describe("streamDraft (duo#304)", () => {
  it("resolves with the done frame's DraftPipelineResult, calling onChunk for every chunk in order", async () => {
    const result = { kind: "draft", draftId: "d1", text: "Five days per quarter.", sources: [], confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 } };
    const body = streamOf([
      `event: chunk\ndata: ${JSON.stringify({ text: "Five " })}\n\n`,
      `event: chunk\ndata: ${JSON.stringify({ text: "days " })}\n\n`,
      `event: chunk\ndata: ${JSON.stringify({ text: "per quarter." })}\n\n`,
      `event: done\ndata: ${JSON.stringify(result)}\n\n`,
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));

    const seen: string[] = [];
    const resolved = await streamDraft(api, { question: "q" }, { onChunk: (text) => seen.push(text) });

    expect(seen).toEqual(["Five ", "days ", "per quarter."]);
    expect(resolved).toEqual(result);
  });

  it("reconstructs a frame delivered across several fragmented reads", async () => {
    const result = { kind: "draft", draftId: "d2", text: "ok", sources: [], confidence: { score: 1, passesThreshold: true, threshold: 0.55 } };
    const text = `event: chunk\ndata: ${JSON.stringify({ text: "ok" })}\n\nevent: done\ndata: ${JSON.stringify(result)}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(fragmentedStreamOf(text, 7), { status: 200, headers: { "content-type": "text/event-stream" } })),
    );

    const seen: string[] = [];
    const resolved = await streamDraft(api, { question: "q" }, { onChunk: (chunk) => seen.push(chunk) });
    expect(seen).toEqual(["ok"]);
    expect(resolved).toEqual(result);
  });

  it("streams an escalation as a single done frame with no chunk frames", async () => {
    const result = { kind: "escalation", draftId: "d3", reason: "no evidence", refused: false };
    const body = streamOf([`event: done\ndata: ${JSON.stringify(result)}\n\n`]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    const onChunk = vi.fn();
    const resolved = await streamDraft(api, { question: "q" }, { onChunk });
    expect(onChunk).not.toHaveBeenCalled();
    expect(resolved).toEqual(result);
  });

  it("throws ApiRequestError on a non-2xx response, reading its JSON error body (never trying to parse it as SSE)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "bad_request", message: "question is required" } }), { status: 400 })),
    );
    await expect(streamDraft(api, { question: "" })).rejects.toMatchObject({ name: "ApiRequestError", code: "bad_request", status: 400 } satisfies Partial<ApiRequestError> & { status: number });
  });

  it("throws when the stream ends with no done frame at all", async () => {
    const body = streamOf([`event: chunk\ndata: ${JSON.stringify({ text: "partial" })}\n\n`]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    await expect(streamDraft(api, { question: "q" })).rejects.toThrow(/ended before an answer arrived/);
  });

  it("rejects with the same AbortError the caller's own abort sent — an owner Stop stays an abort, not a generic failure", async () => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        controller.enqueue(encoder.encode(`event: chunk\ndata: ${JSON.stringify({ text: "partial " })}\n\n`));
        // Never closes — the owner's Stop is what ends this read.
      },
    });
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => controllerRef?.error(new DOMException("The operation was aborted.", "AbortError")));
      return Promise.resolve(new Response(stream, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const pending = streamDraft(api, { question: "q" }, { signal: controller.signal, onChunk: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the first chunk land before stopping
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out as RequestTimeoutError, not an unreachability error, when the daemon never answers", async () => {
    vi.useFakeTimers();
    const stub = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    });
    vi.stubGlobal("fetch", stub);

    const pending = streamDraft(api, { question: "q" }, { timeoutMs: 1000 });
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });

  it("throws plainly when the response has no readable body at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, body: null }) as unknown as Response),
    );
    await expect(streamDraft(api, { question: "q" })).rejects.toThrow(/no readable body/);
  });
});
