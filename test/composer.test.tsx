import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { ASK_TIMEOUT_MS } from "../src/api/queries.js";
import { writeComposerBuffer } from "../src/composerBuffer.js";
import type { DuoApiConfig } from "../src/api/client.js";

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

  it("#244: Enter sends, Shift+Enter does not, and ⌘/Ctrl+Enter still send", async () => {
    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    const field = screen.getByLabelText("Question for your duo") as HTMLTextAreaElement;

    fireEvent.change(field, { target: { value: "first line\nsecond line" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    // Shift+Enter has no handler effect — nothing was scheduled, so nothing ran.
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    // A successful send clears the composer.
    await waitFor(() => expect(field).toHaveValue(""));

    fireEvent.change(field, { target: { value: "another question" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    fireEvent.change(field, { target: { value: "yet another question" } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });

  it("#244: an IME candidate confirmed with Enter does not send", () => {
    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    const field = screen.getByLabelText("Question for your duo") as HTMLTextAreaElement;

    fireEvent.change(field, { target: { value: "日本語" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(field).toHaveValue("日本語");
  });

  it("#244: Enter on an empty composer does nothing", () => {
    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    const field = screen.getByLabelText("Question for your duo");

    fireEvent.keyDown(field, { key: "Enter" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the field grows to fit the question and stops at a readable cap", () => {
    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    const field = screen.getByLabelText("Question for your duo") as HTMLTextAreaElement;
    // Number(): happy-dom returns the reflected rows attribute as a
    // string, not the IDL unsigned long.
    const rows = () => Number(field.rows);

    expect(rows()).toBe(1);
    fireEvent.change(field, { target: { value: "one\ntwo\nthree" } });
    expect(rows()).toBe(3);
    fireEvent.change(field, { target: { value: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") } });
    expect(rows()).toBe(8);
  });

  it("the typed question survives a route switch — unmount and remount", () => {
    const first = renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    fireEvent.change(screen.getByLabelText("Question for your duo"), { target: { value: "a question in progress" } });
    first.unmount();

    renderWithClient(<Composer api={api} thread={null} threadLabel="General" />);
    expect(screen.getByLabelText("Question for your duo")).toHaveValue("a question in progress");
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

    fireEvent.change(screen.getByLabelText("Question for your duo"), { target: { value: "a slow question" } });
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toHaveTextContent("Asking…"));
    expect(screen.getByTestId("composer-cancel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("composer-cancel"));
    await waitFor(() => expect(wedged.signal()?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toHaveTextContent("Ask"));
    expect(screen.getByTestId("composer-submit")).toBeEnabled();
    // The typed question is restored to the field — cancelling a slow
    // answer must not eat the question.
    expect(screen.getByLabelText("Question for your duo")).toHaveValue("a slow question");
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

    fireEvent.change(screen.getByLabelText("Question for your duo"), { target: { value: "a question that hangs" } });
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
    expect(screen.getByLabelText("Question for your duo")).toHaveValue("a question that hangs");
    expect(screen.getByTestId("composer-submit")).toBeEnabled();
  });
});
