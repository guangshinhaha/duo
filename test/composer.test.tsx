import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { ASK_TIMEOUT_MS } from "../src/api/queries.js";
import { writeComposerBuffer } from "../src/composerBuffer.js";
import type { DuoApiConfig } from "../src/api/client.js";
import { composerText, pressEnter, setComposer, typeInto } from "./composerHelpers.js";

/*
 * #27: a composer that behaves like one — multiline with keyboard submit,
 * a slow draft that can be abandoned (abort + restore + usable), a hung
 * request that ends by itself with wording distinct from unreachability,
 * and a typed question that survives a route switch.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** A POST that never answers on its own and honors its abort signal the way a real fetch does. */
function stubWedgedPost(): { signal: () => AbortSignal | null | undefined; calls: ReturnType<typeof vi.fn> } {
  const state: { signal?: AbortSignal | null } = {};
  const calls = vi.fn((_url: unknown, init?: RequestInit) => {
    state.signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      state.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });
  });
  vi.stubGlobal("fetch", calls);
  return { signal: () => state.signal, calls };
}

describe("#27 — the composer takes a real question", () => {
  beforeEach(() => {
    writeComposerBuffer("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    writeComposerBuffer("");
  });

  it("#244: Shift+Enter is a new line; Enter asks, and so do Cmd-Enter and Ctrl-Enter", async () => {
    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    const field = screen.getByLabelText("Question for your duo");

    typeInto(field, "first line");
    pressEnter(field, { shiftKey: true });
    typeInto(field, "second line");
    expect(composerText(field)).toBe("first line\nsecond line");
    expect(fetch).not.toHaveBeenCalled();

    pressEnter(field);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ question: "first line\nsecond line" });
    // A successful send clears the composer.
    await waitFor(() => expect(composerText(field)).toBe(""));

    typeInto(field, "another question");
    pressEnter(field, { metaKey: true });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    setComposer(field, "and one more");
    pressEnter(field, { ctrlKey: true });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });

  it("#244: an IME candidate confirmed with Enter does not send", () => {
    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    const field = screen.getByLabelText("Question for your duo");

    typeInto(field, "日本語");
    act(() => {
      fireEvent.compositionStart(field, { data: "" });
    });
    pressEnter(field, { isComposing: true });
    act(() => {
      fireEvent.compositionEnd(field, { data: "" });
    });
    pressEnter(field, { keyCode: 229 });
    expect(fetch).not.toHaveBeenCalled();
    expect(composerText(field)).toBe("日本語");
  });

  it("#244: Enter on an empty or whitespace-only question asks nothing", () => {
    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    const field = screen.getByLabelText("Question for your duo");
    pressEnter(field);
    typeInto(field, "   ");
    pressEnter(field);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the field grows with the question and stops at a readable cap, scrolling past it", () => {
    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    const field = screen.getByLabelText("Question for your duo");
    // An editor grows with its content on its own; the cap is the class
    // that stops it (about eight lines) and lets it scroll beyond.
    expect(field).toHaveClass("max-h-48", "overflow-y-auto");
    typeInto(field, Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
    expect(composerText(field).split("\n")).toHaveLength(12);
  });

  it("the typed question survives a route switch — unmount and remount", () => {
    const first = renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    typeInto(screen.getByLabelText("Question for your duo"), "a question\nin progress");
    first.unmount();

    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    expect(composerText(screen.getByLabelText("Question for your duo"))).toBe("a question\nin progress");
  });
});

describe("#27 — a slow draft can be abandoned", () => {
  beforeEach(() => {
    writeComposerBuffer("");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    writeComposerBuffer("");
  });

  it("cancelling aborts the request, keeps the typed question, and returns the composer to usable", async () => {
    const wedged = stubWedgedPost();
    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);

    setComposer(screen.getByLabelText("Question for your duo"), "a slow question");
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toHaveTextContent("Asking…"));
    expect(screen.getByTestId("composer-cancel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("composer-cancel"));
    await waitFor(() => expect(wedged.signal()?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toHaveTextContent("Ask"));
    expect(screen.getByTestId("composer-submit")).toBeEnabled();
    // The typed question is restored to the field — cancelling a slow
    // answer must not eat the question.
    expect(composerText(screen.getByLabelText("Question for your duo"))).toBe("a slow question");
    // A cancelled ask is the owner's choice, not a failure to show.
    expect(screen.queryByTestId("mutation-error")).toBeNull();
    expect(wedged.calls).toHaveBeenCalledTimes(1);
  });
});

describe("#27 — a hung request ends by itself", () => {
  beforeEach(() => {
    writeComposerBuffer("");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    writeComposerBuffer("");
  });

  it("the timeout fails with \"the daemon did not answer\" — not the unreachable wording", async () => {
    vi.useFakeTimers();
    stubWedgedPost();
    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);

    setComposer(screen.getByLabelText("Question for your duo"), "a question that hangs");
    fireEvent.click(screen.getByTestId("composer-submit"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS);
    });
    // The timeout fires at the 60s mark, but the failure reaches React
    // one hop later: the rejection's microtask chain completes, then
    // TanStack v5's notifyManager schedules the error state through a
    // setTimeout(cb, 0) — which needs one more step of the clock to
    // fire. Nothing else is scheduled, so this advances only that.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(screen.getByTestId("mutation-error")).toHaveTextContent(/did not answer/);
    // The unreachable state is the OfflineBar's TypeError story; this is a
    // timeout, and the failure keeps the question for a retry.
    expect(composerText(screen.getByLabelText("Question for your duo"))).toBe("a question that hangs");
    expect(screen.getByTestId("composer-submit")).toBeEnabled();
  });
});
