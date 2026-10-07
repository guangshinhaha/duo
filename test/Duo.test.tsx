import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Duo } from "../src/routes/Duo.js";
import { writeComposerBuffer } from "../src/composerBuffer.js";
import type { DraftRecord } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";
import { composerText, setComposer } from "./composerHelpers.js";
import { sseDraftResponse } from "./sseHelpers.js";
import { writeSuggestionChipsEnabled } from "../src/suggestionsPrefs.js";

/*
 * Your duo, as a chat (#144): one continuous conversation — what you asked
 * on your side, what it said on its side behind its line, and the answer
 * waiting on you as a tray above the box you type in. It is the read-back of
 * the loop (#8, #29) and where asking lives; the picker of conversations
 * (#28) is gone, and a question somebody else asked is never here (#20).
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function draftFor(id: string, over?: Partial<DraftRecord>): DraftRecord {
  return {
    id,
    question: `question ${id}`,
    threadContext: null,
    draftText: `draft ${id}`,
    escalated: false,
    escalationReason: null,
    confidenceScore: 0.8,
    sources: [{ kind: "rule", id: `r-${id}`, label: `rule for ${id}` }],
    createdAt: "2026-01-01T00:00:00.000Z",
    outcome: null,
    outcomeRecordedAt: null,
    sentText: null,
    refused: false,
    escalationThreshold: 0.55,
    provenance: { origin: "owner" },
    delivery: null,
    ...over,
  };
}

// Ascending createdAt, the order the daemon's `ORDER BY created_at, id` returns.
const drafts: DraftRecord[] = [
  draftFor("1", { threadContext: "leave", createdAt: "2026-01-01T00:00:00.000Z" }),
  draftFor("2", { createdAt: "2026-01-02T00:00:00.000Z", outcome: "sent", sentText: "sent as drafted" }),
  draftFor("3", { createdAt: "2026-01-03T00:00:00.000Z", outcome: "edited", sentText: "the edited text that was kept" }),
  draftFor("4", {
    threadContext: "leave",
    createdAt: "2026-01-04T00:00:00.000Z",
    escalated: true,
    draftText: null,
    escalationReason: "no supporting evidence",
    outcome: "escalation_answered",
  }),
  draftFor("5", { threadContext: "leave", createdAt: "2026-01-05T00:00:00.000Z", outcome: "discarded" }),
];

// The merged GET /drafts paging contract (#29, digital-duo #203): with
// `limit`, a newest-first window under the exclusive `before` ceiling;
// without it, the plain ascending list.
function pagedResponse(href: string, list: DraftRecord[]): Promise<Response> {
  const { searchParams } = new URL(href);
  const before = searchParams.get("before");
  let rows = list.filter((d) => (before === null ? true : d.createdAt < before));
  const rawLimit = searchParams.get("limit");
  if (rawLimit !== null) {
    rows = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Number(rawLimit));
  }
  return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
}

function stubDraftsResponse(list: DraftRecord[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL) => pagedResponse(String(url), list)),
  );
}

const turnFor = (text: string) => screen.getByText(text).closest('[data-testid="thread-entry"]') as HTMLElement;

beforeEach(() => {
  stubDraftsResponse(drafts);
  // #27: the composer keeps typed-but-unsent text in a module-level buffer so it
  // survives route switches — one test's typing would pre-fill the next mount.
  writeComposerBuffer("");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // duo#305: a test that turns suggestion chips off (`suggestionsPrefs.ts`,
  // localStorage-backed) must not leak that choice into the next test.
  localStorage.clear();
});

describe("#144 — your duo is one continuous chat", () => {
  it("opens on the chat itself: the duo's name is the page's heading and the way into its profile, and it says only you can see it", async () => {
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Your duo");
    expect(within(heading).getByTestId("duo-profile-link")).toHaveAttribute("href", "#duo/profile");
    expect(screen.getByText("Only you can see this chat")).toBeInTheDocument();
    // No picker of conversations, no "All conversations": one chat.
    expect(screen.queryByTestId("conversation-list")).toBeNull();
    expect(screen.queryByTestId("back-to-conversations")).toBeNull();
    expect(screen.queryByTestId("composer-thread")).toBeNull();
  });

  it("reads each turn with your question on your side and the duo's answer behind its line, the outcome named", async () => {
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    const edited = turnFor("the edited text that was kept");
    expect(within(edited).getByTestId("owner-message")).toHaveTextContent("question 3");
    const answer = within(edited).getByTestId("duo-answer");
    expect(answer).toHaveAttribute("data-duo-line", "confident");
    expect(within(answer).getByTestId("duo-line-attribution")).toHaveTextContent("Your duo");
    expect(within(edited).getByTestId("entry-outcome")).toHaveTextContent("Kept (edited)");
    // The superseded draft text never reads as the conversation.
    expect(edited).not.toHaveTextContent("draft 3");
  });

  it("shows the kept text for an answer kept as drafted, not the draft's own", async () => {
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    const kept = turnFor("sent as drafted");
    expect(within(kept).getByTestId("entry-outcome")).toHaveTextContent("Kept");
    expect(within(kept).getByTestId("duo-answer")).not.toHaveTextContent("draft 2");
  });

  it("puts what it drew on under every answer, at zero clicks to see how many", async () => {
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    expect(within(turnFor("sent as drafted")).getByText("Drew on 1 source")).toBeInTheDocument();
  });

  it("renders an escalation as the duo's reason behind its own line, with its outcome — never as its words of advice", async () => {
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    const escalated = screen.getByText("no supporting evidence").closest('[data-testid="thread-entry"]') as HTMLElement;
    expect(within(escalated).getByTestId("duo-answer")).toHaveAttribute("data-duo-line", "escalated");
    expect(within(escalated).getByTestId("escalation-reason")).toHaveTextContent("no supporting evidence");
    expect(within(escalated).getByTestId("entry-outcome")).toHaveTextContent("standing-order candidate");
  });

  it("names a dismissed answer honestly, and shows the thread context as metadata on the answer", async () => {
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    const dismissed = screen.getAllByTestId("entry-outcome").find((node) => node.textContent?.includes("Dismissed"));
    expect(dismissed).toBeDefined();
    expect(dismissed).toHaveTextContent("about leave");
  });

  it("an answer waiting on you is a message right under your question, with its buttons under it — one transcript, no second strip (#182)", async () => {
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    const waiting = turnFor("question 1");
    expect(within(waiting).getByTestId("owner-message")).toHaveTextContent("question 1");
    expect(within(waiting).queryByTestId("entry-outcome")).toBeNull();
    expect(screen.queryByTestId("duo-drafts")).toBeNull();
    const tray = within(waiting).getByTestId("draft-tray");
    // An answer to you, not an outgoing message: not dashed as unsent.
    expect(tray).not.toHaveAttribute("data-unsent");
    expect(tray).toHaveTextContent("draft 1");
    // Self-asked, so its verbs are Keeps: nobody is being sent anything.
    expect(within(tray).getByRole("button", { name: "Keep" })).toBeInTheDocument();
  });

  it("keeps a refused question's outcome as refused, not as waiting on the owner", async () => {
    stubDraftsResponse([
      draftFor("r", { escalated: true, draftText: null, escalationReason: "this topic is on your refused list", refused: true }),
    ]);
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    expect(screen.getByTestId("entry-outcome")).toHaveTextContent("Your duo refused this one.");
    expect(screen.getByTestId("duo-answer")).toHaveAttribute("data-duo-line", "refused");
    // Nothing to decide: no tray for a refusal.
    expect(screen.queryByTestId("draft-tray")).toBeNull();
  });

  it("renders an honest empty state when nothing has been asked (AR-19)", async () => {
    stubDraftsResponse([]);
    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getByTestId("duo-empty")).toBeInTheDocument());
    expect(screen.getByTestId("duo-empty")).toHaveTextContent("Ask your duo anything");
    expect(screen.queryByTestId("thread-group")).toBeNull();
    expect(screen.getByTestId("composer")).toBeInTheDocument();
  });

  it("is only your own conversation: a question somebody else asked belongs to its chat, and a legacy row is not guessed into this one (#20)", async () => {
    stubDraftsResponse([
      draftFor("mine"),
      draftFor("theirs", { provenance: { origin: "channel", channelKind: "slack", askerRef: "U1", threadId: null, permalink: null } }),
      draftFor("old", { provenance: { origin: "unknown" } }),
    ]);
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    expect(screen.getAllByTestId("thread-entry")).toHaveLength(1);
    expect(screen.getByText("question mine")).toBeInTheDocument();
    expect(screen.queryByText("question theirs")).toBeNull();
    expect(screen.queryByText("question old")).toBeNull();
  });

  it("decides a waiting answer right here — Keep posts the outcome the correction loop reads", async () => {
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) =>
      init?.method === "POST" ? Promise.resolve(new Response("{}", { status: 200 })) : pagedResponse(String(url), [draftFor("only")]),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWithClient(<Duo api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://test/drafts/only/outcome", expect.objectContaining({ method: "POST" })));
  });
});

describe("duo#306 — a settled duo message still carries a real action (Why?)", () => {
  it("offers Why? on a settled turn, not just a pending one", async () => {
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    const kept = turnFor("sent as drafted");
    expect(within(kept).getByTestId("tray-why")).toBeInTheDocument();
  });

  it("never offers Send or Edit on a settled turn — only the one action left to take, understanding why", async () => {
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    const kept = turnFor("sent as drafted");
    expect(within(kept).queryByRole("button", { name: "Send" })).toBeNull();
    expect(within(kept).queryByRole("button", { name: "Keep" })).toBeNull();
    expect(within(kept).queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

describe("duo#305 — suggested questions and follow-ups", () => {
  it("AC1: an empty chat offers starters from GET /suggestions/starters, and tapping one asks it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/suggestions/starters")) {
        return new Response(JSON.stringify({ starters: ["What do you know about Leave policy?"] }), { status: 200 });
      }
      if (init?.method === "POST" && href.endsWith("/drafts/stream")) {
        return sseDraftResponse({ kind: "draft", draftId: "new", text: "Five days a quarter.", sources: [], confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 } });
      }
      return pagedResponse(href, []);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("duo-empty");
    const chip = await screen.findByRole("button", { name: "What do you know about Leave policy?" });
    fireEvent.click(chip);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://test/drafts/stream", expect.objectContaining({ method: "POST" })));
    const sent = JSON.parse(
      (fetchMock.mock.calls.find(([href, init]) => (init as RequestInit | undefined)?.method === "POST" && String(href).endsWith("/drafts/stream"))?.[1] as {
        body: string;
      }).body,
    ) as { question: string };
    expect(sent.question).toBe("What do you know about Leave policy?");
  });

  it("AC3: turning suggestion chips off hides starters, even when the daemon offers them", async () => {
    writeSuggestionChipsEnabled(false);
    const fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.endsWith("/suggestions/starters")) {
        return new Response(JSON.stringify({ starters: ["What do you know about Leave policy?"] }), { status: 200 });
      }
      return pagedResponse(href, []);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("duo-empty");
    expect(screen.queryByTestId("starter-chips")).toBeNull();
  });

  it("AC2: the latest settled answer offers up to three follow-ups from POST /suggestions/follow-ups, and tapping one asks it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (init?.method === "POST" && href.endsWith("/suggestions/follow-ups")) {
        return new Response(JSON.stringify({ followUps: ["Does it roll over?"] }), { status: 200 });
      }
      if (init?.method === "POST" && href.endsWith("/drafts/stream")) {
        return sseDraftResponse({ kind: "draft", draftId: "new", text: "No, it doesn't roll over.", sources: [], confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 } });
      }
      return pagedResponse(href, drafts);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    const chip = await screen.findByRole("button", { name: "Does it roll over?" });
    // The latest turn only — not every settled answer in the history.
    expect(screen.queryAllByTestId("follow-up-chips")).toHaveLength(1);
    fireEvent.click(chip);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("http://test/drafts/stream", expect.objectContaining({ method: "POST" })));
  });

  it("AC3: turning suggestion chips off hides follow-ups too", async () => {
    writeSuggestionChipsEnabled(false);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url);
      if (init?.method === "POST" && href.endsWith("/suggestions/follow-ups")) {
        return new Response(JSON.stringify({ followUps: ["Does it roll over?"] }), { status: 200 });
      }
      return pagedResponse(href, drafts);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    expect(screen.queryByTestId("follow-up-chips")).toBeNull();
    expect(fetchMock.mock.calls.some(([href]) => String(href).endsWith("/suggestions/follow-ups"))).toBe(false);
  });

  it("never offers follow-ups for an escalation — passed-on or refused, neither is an answer to follow up on", async () => {
    stubDraftsResponse([
      draftFor("esc", { escalated: true, draftText: null, escalationReason: "below confidence threshold", outcome: "escalation_answered" }),
    ]);
    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    expect(screen.queryByTestId("follow-up-chips")).toBeNull();
  });
});

describe("Duo — asking (issue #8)", () => {
  it("submits a question to POST /drafts, clears the input on success, and the new turn reads back", async () => {
    let posts = 0;
    let list = drafts;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/drafts/stream")) {
        posts += 1;
        const body = JSON.parse(init.body as string) as { question: string; threadContext: string | null };
        const created = draftFor("new", { question: body.question, threadContext: body.threadContext, createdAt: "2026-01-06T00:00:00.000Z" });
        list = [...list, created];
        return sseDraftResponse({ kind: "draft", draftId: "new", text: created.draftText, sources: created.sources, confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 } });
      }
      return pagedResponse(String(url), list);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");

    setComposer(screen.getByLabelText("Question for your duo"), "  How much leave do I get?  ");
    fireEvent.click(screen.getByTestId("composer-submit"));

    await waitFor(() => expect(posts).toBe(1));
    // duo#305: FollowUpChips may also POST /suggestions/follow-ups for the
    // existing last turn on mount — filter to the stream call specifically,
    // the way `posts` above already does, rather than "the first POST".
    const sent = JSON.parse(
      (fetchMock.mock.calls.find(([url, init]) => (init as RequestInit | undefined)?.method === "POST" && String(url).endsWith("/drafts/stream"))?.[1] as {
        body: string;
      }).body,
    ) as {
      question: string;
      threadContext: string | null;
    };
    // Trimmed, and no thread context: one chat, no picker to target.
    expect(sent).toEqual({ question: "How much leave do I get?", threadContext: null });
    await waitFor(() => expect(screen.getByText("How much leave do I get?")).toBeInTheDocument());
    expect(composerText(screen.getByLabelText("Question for your duo"))).toBe("");
  });

  it("keeps the typed question and shows the failure when the submit fails", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/drafts/stream")) {
        return new Response(JSON.stringify({ error: { code: "unknown", message: "store locked" } }), { status: 500 });
      }
      return pagedResponse(String(url), drafts);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");

    setComposer(screen.getByLabelText("Question for your duo"), "a question worth keeping");
    fireEvent.click(screen.getByTestId("composer-submit"));

    await waitFor(() => expect(screen.getByTestId("mutation-error")).toHaveTextContent("store locked"));
    expect(composerText(screen.getByLabelText("Question for your duo"))).toBe("a question worth keeping");
  });

  it("disables submission for whitespace-only questions and while a submit is in flight", async () => {
    let resolvePost!: (value: Response) => void;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/drafts/stream")) {
        return new Promise<Response>((resolve) => {
          resolvePost = resolve;
        });
      }
      return pagedResponse(String(url), drafts);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");

    const input = screen.getByLabelText("Question for your duo");
    const submit = screen.getByTestId("composer-submit") as HTMLButtonElement;
    expect(submit).toBeDisabled();

    setComposer(input, "   ");
    expect(submit).toBeDisabled();

    setComposer(input, "real question");
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    // One question, one draft: submission is blocked while in flight, and the
    // button says what is happening instead of inviting a second POST.
    await waitFor(() => expect(submit).toBeDisabled());
    expect(submit).toHaveTextContent("Asking…");

    resolvePost(sseDraftResponse({ kind: "draft", draftId: "x", text: "t", sources: [], confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 } }));
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toHaveTextContent("Ask"));
  });

  it("duo#304: renders the answer incrementally as it streams, then the real turn replaces the live bubble", async () => {
    const encoder = new TextEncoder();
    let list = drafts;
    // Manually gated, rather than timer-paced: each `gate.next()` releases
    // exactly one more frame, so the test controls the pacing instead of
    // racing real (or fake) timers against `waitFor`.
    let releaseNext: (() => void) | undefined;
    const gate = () => new Promise<void>((resolve) => (releaseNext = resolve));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/drafts/stream")) {
        const body = JSON.parse(init.body as string) as { question: string };
        const created = draftFor("streamed", { question: body.question, draftText: "Five days per quarter.", createdAt: "2026-01-07T00:00:00.000Z" });
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(`event: chunk\ndata: ${JSON.stringify({ text: "Five " })}\n\n`));
            await gate();
            controller.enqueue(encoder.encode(`event: chunk\ndata: ${JSON.stringify({ text: "days " })}\n\n`));
            await gate();
            controller.enqueue(encoder.encode(`event: chunk\ndata: ${JSON.stringify({ text: "per quarter." })}\n\n`));
            const done = {
              kind: "draft",
              draftId: "streamed",
              text: created.draftText,
              sources: [],
              confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 },
            };
            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify(done)}\n\n`));
            controller.close();
            list = [...list, created];
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return pagedResponse(String(url), list);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    setComposer(screen.getByLabelText("Question for your duo"), "how much leave");
    fireEvent.click(screen.getByTestId("composer-submit"));

    // The live bubble shows up with the first chunk already in it...
    await waitFor(() => expect(screen.getByTestId("duo-stream-answer")).toHaveTextContent("Five"));
    expect(screen.getByTestId("duo-stream-answer")).not.toHaveTextContent("per quarter.");

    // ...grows as each further chunk is released...
    releaseNext?.();
    await waitFor(() => expect(screen.getByTestId("duo-stream-answer")).toHaveTextContent("Five days"));
    expect(screen.getByTestId("duo-stream-answer")).not.toHaveTextContent("per quarter.");

    // ...and once it finishes, the full text reads somewhere in the
    // transcript — either still the live bubble, or the real turn that
    // replaced it.
    releaseNext?.();
    await waitFor(() => expect(screen.getByText("Five days per quarter.")).toBeInTheDocument());
  });

  it("duo#304: Stop ends the reveal but keeps what already streamed in", async () => {
    const encoder = new TextEncoder();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/drafts/stream")) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller;
            controller.enqueue(encoder.encode(`event: chunk\ndata: ${JSON.stringify({ text: "Five " })}\n\n`));
            // Deliberately never closes — Stop is what ends this, not the server.
          },
        });
        init?.signal?.addEventListener("abort", () => controllerRef?.error(new DOMException("The operation was aborted.", "AbortError")));
        return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
      }
      return pagedResponse(String(url), drafts);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await screen.findByTestId("thread-group");
    setComposer(screen.getByLabelText("Question for your duo"), "how much leave");
    fireEvent.click(screen.getByTestId("composer-submit"));

    await waitFor(() => expect(screen.getByTestId("duo-stream-answer")).toHaveTextContent("Five"));
    fireEvent.click(screen.getByTestId("composer-cancel"));

    // Stop only ends the reveal (and returns the composer to usable) — it
    // never erases what had already streamed in.
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toHaveTextContent("Ask"));
    expect(screen.getByTestId("duo-stream-answer")).toHaveTextContent("Five");
    expect(screen.queryByTestId("mutation-error")).toBeNull();
  });
});
