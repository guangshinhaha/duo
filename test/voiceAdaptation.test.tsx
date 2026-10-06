import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { useCreateDraft, useResetVoiceAdaptation, useVoiceAdaptation } from "../src/api/queries.js";

/*
 * Issue #262's client-side wiring: a draft request carries the recipient
 * when the caller actually knows one (digital-duo #279's `POST /drafts`
 * `recipient` field), and a person's learned tone can be read and reset
 * through `GET`/`DELETE /people/:id/voice-adaptation`.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function okDraftResponse() {
  return new Response(
    JSON.stringify({ kind: "draft", draftId: "d1", text: "", sources: [], confidence: { score: 1, passesThreshold: true, threshold: 0.5 } }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("issue #262 — sending a draft's recipient", () => {
  it("includes { id, name } in the POST body when the caller knows one", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => okDraftResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCreateDraft(api), { wrapper: wrapper(newClient()) });

    act(() => {
      result.current.mutation.mutate({ question: "how do I reply to Wei?", recipient: { id: "@wei:example.com", name: "Wei" } });
    });

    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.recipient).toEqual({ id: "@wei:example.com", name: "Wei" });
  });

  it("never sends a recipient when the caller has none to name (the owner's own private chat)", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => okDraftResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCreateDraft(api), { wrapper: wrapper(newClient()) });

    act(() => {
      result.current.mutation.mutate({ question: "what's our pto policy?", threadContext: null });
    });

    await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("recipient");
  });
});

describe("issue #262 — reading and resetting a person's learned tone", () => {
  it("useVoiceAdaptation reads GET /people/:id/voice-adaptation, URL-encoding the id", async () => {
    const body = {
      recipientId: "@wei:example.com",
      recipientName: "Wei",
      sampleSize: 8,
      threshold: 5,
      active: true,
      features: { register: "formal" },
      resetAt: null,
    };
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toBe(`${api.baseUrl}/people/%40wei%3Aexample.com/voice-adaptation`);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useVoiceAdaptation(api, "@wei:example.com"), { wrapper: wrapper(newClient()) });

    await waitFor(() => expect(result.current.data).toEqual(body));
  });

  it("a member with no paired duo never asks — the query stays idle", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useVoiceAdaptation(null, "@wei:example.com"), { wrapper: wrapper(newClient()) });

    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("useResetVoiceAdaptation DELETEs the same route and invalidates only that person's cached status", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = newClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useResetVoiceAdaptation(api), { wrapper: wrapper(client) });

    act(() => {
      result.current.mutate("@wei:example.com");
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls).toEqual([{ url: `${api.baseUrl}/people/%40wei%3Aexample.com/voice-adaptation`, method: "DELETE" }]);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["people", "@wei:example.com", "voice-adaptation"] });
  });
});
