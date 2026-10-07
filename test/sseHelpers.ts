/**
 * duo#304: builds a `Response` shaped exactly like `POST /drafts/stream`'s
 * real wire format (`client-tech-design.md` §1.4's `/drafts/stream` row) —
 * zero or more `event: chunk` frames whose `text` fields concatenate back
 * to the answer, then one `event: done` frame carrying the full
 * `DraftPipelineResult`. Test fixtures that used to hand `Composer`'s mocked
 * `fetch` a plain `POST /drafts` JSON body now hand it this instead, so
 * `streamDraft` (`src/api/draftStream.ts`) has something real to parse.
 */
export function sseDraftResponse(result: Record<string, unknown>, status = 200): Response {
  const frames: string[] = [];
  const text = typeof result.text === "string" ? result.text : "";
  for (const chunk of wordChunks(text)) {
    frames.push(`event: chunk\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
  }
  frames.push(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
  return new Response(frames.join(""), { status, headers: { "content-type": "text/event-stream" } });
}

/** Mirrors the daemon's own `wordChunks` (`src/serve/server.ts`) exactly, so a fixture's chunking matches the real wire. */
function wordChunks(text: string): string[] {
  const parts = text.split(/(\s+)/);
  const chunks: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const chunk = `${parts[i] ?? ""}${parts[i + 1] ?? ""}`;
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }
  return chunks;
}
