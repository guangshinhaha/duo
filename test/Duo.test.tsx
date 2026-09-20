import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Duo } from "../src/routes/Duo.js";
import { writeComposerBuffer } from "../src/composerBuffer.js";
import type { DraftRecord } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";

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
    provenance: { origin: "unknown" },
    delivery: null,
    ...over,
  };
}

// Ascending createdAt, the order the daemon's `ORDER BY created_at, id`
// actually returns — the grouping under test consumes that order directly.
const drafts: DraftRecord[] = [
  draftFor("1", { threadContext: "leave", createdAt: "2026-01-01T00:00:00.000Z" }),
  draftFor("2", { createdAt: "2026-01-02T00:00:00.000Z", outcome: "sent", sentText: "sent as drafted" }),
  draftFor("3", { createdAt: "2026-01-03T00:00:00.000Z", outcome: "edited", sentText: "the edited text that was sent" }),
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
// without it, the plain ascending list. Every drafts stub in this file
// speaks it, the way the daemon now does.
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

describe("#28 — pick a conversation, then read it", () => {
  beforeEach(() => {
    stubDraftsResponse(drafts);
    writeComposerBuffer("");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows conversations as a list on open, most recently active first, with one General entry for unthreaded drafts", async () => {
    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));
    // "leave" holds the newest activity (draft 5) so it leads; the two
    // unthreaded drafts share ONE General entry instead of scattering
    // into singles — and on the list, no thread's entries render yet.
    const labels = screen.getAllByTestId("conversation-entry").map((el) => el.textContent);
    expect(labels).toEqual(["leave", "General"]);
    expect(screen.queryByTestId("thread-entry")).toBeNull();
  });

  it("picking a conversation opens it alone, and back returns to the list", async () => {
    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));

    fireEvent.click(screen.getAllByTestId("conversation-entry")[0]);
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(3));
    expect(screen.getByText("question 1")).toBeInTheDocument();
    expect(screen.queryByText("question 2")).toBeNull();
    expect(screen.getByTestId("thread-group-heading")).toHaveTextContent("leave");
    expect(screen.queryByTestId("conversation-list")).toBeNull();

    fireEvent.click(screen.getByTestId("back-to-conversations"));
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));
    expect(screen.queryByTestId("thread-entry")).toBeNull();
  });

  it("a vanished thread falls back to General — the view and the composer's target together", async () => {
    let list = drafts;
    let captured: { question: string; threadContext: string | null } | null = null;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/drafts")) {
        captured = JSON.parse(init.body as string);
        list = drafts.filter((d) => d.threadContext === null); // the next GET loses "leave" entirely
        return Promise.resolve(
          new Response(JSON.stringify({ kind: "draft", draftId: "x", text: "t", sources: [], confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 } }), { status: 201 }),
        );
      }
      return pagedResponse(String(url), list);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("conversation-entry")[0]);
    await waitFor(() => expect(screen.getByTestId("composer-thread")).toHaveTextContent("Asking in: leave"));

    fireEvent.change(screen.getByLabelText("Question for your duo"), { target: { value: "asked while leave is open" } });
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured).toEqual({ question: "asked while leave is open", threadContext: "leave" });

    // The refetch drops every "leave" draft: the open view lands on
    // General, and the composer's target follows it there.
    await waitFor(() => expect(screen.getByTestId("composer-thread")).toHaveTextContent("Asking in: General"));
    await waitFor(() => expect(screen.getByText("question 2")).toBeInTheDocument());
    expect(screen.queryByText("question 1")).toBeNull();
  });
});

describe("Duo — the thread view and composer (issue #8)", () => {
  beforeEach(() => {
    stubDraftsResponse(drafts);
    // #27: the composer keeps typed-but-unsent text in a module-level
    // buffer so it survives route switches — which also means one test's
    // typing would pre-fill the next test's mount. Each test starts clean.
    writeComposerBuffer("");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads each entry as a conversation turn: question as the owner, response as the duo, outcome named", async () => {
    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("conversation-entry")[1]); // General holds draft 3
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(2));
    const edited = screen.getByText("the edited text that was sent").closest('[data-testid="thread-entry"]')!;
    expect(edited).not.toBeNull();
    expect(edited.querySelector('[data-testid="owner-message"]')).toHaveTextContent("question 3");
    expect(edited.querySelector('[data-testid="duo-message"]')).toHaveTextContent("Your duo");
    expect(edited.querySelector('[data-testid="entry-outcome"]')).toHaveTextContent("Sent (edited)");
    // The superseded draft text never reads as the conversation.
    expect(edited.querySelector('[data-testid="duo-message"]')).not.toHaveTextContent("draft 3");
  });

  it("shows the sent text for a sent-as-drafted entry, not the draft text", async () => {
    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("conversation-entry")[1]); // General holds draft 2
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(2));
    const sent = screen.getByText("sent as drafted").closest('[data-testid="thread-entry"]')!;
    expect(sent.querySelector('[data-testid="entry-outcome"]')).toHaveTextContent("Sent");
    expect(sent.querySelector('[data-testid="duo-message"]')).not.toHaveTextContent("draft 2");
  });

  it("renders escalations in the dashed Review idiom with their outcome, never as duo words", async () => {
    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("conversation-entry")[0]); // "leave" holds draft 4
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(3));
    const escalated = screen.getByText("no supporting evidence").closest('[data-testid="thread-entry"]')!;
    expect(escalated.querySelector('[data-testid="escalation-reason"]')).toHaveTextContent("no supporting evidence");
    expect(escalated.querySelector('[data-testid="duo-message"]')).toBeNull();
    expect(escalated.querySelector('[data-testid="entry-outcome"]')).toHaveTextContent("standing-order candidate");
  });

  it("names pending and ignored entries honestly", async () => {
    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("conversation-entry")[0]); // "leave" holds drafts 1 and 5
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(3));
    expect(screen.getByText("Waiting on you in Review.")).toBeInTheDocument();
    expect(screen.getByText("Ignored")).toBeInTheDocument();
  });

  it("labels a refused escalation as refused, not as waiting on the owner", async () => {
    stubDraftsResponse([
      draftFor("r", {
        escalated: true,
        draftText: null,
        escalationReason: "this topic is on your refused list",
        refused: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("conversation-entry")[0]);
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(1));
    expect(screen.getByTestId("entry-outcome")).toHaveTextContent("Your duo refused this one.");
    expect(screen.queryByText("Waiting on you in Review.")).toBeNull();
  });

  it("renders an honest empty state when no drafts exist (AR-19)", async () => {
    stubDraftsResponse([]);
    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getByTestId("duo-empty")).toBeInTheDocument());
    expect(screen.getByTestId("duo-empty")).toHaveTextContent("No conversation yet");
    expect(screen.queryByTestId("thread-group")).toBeNull();
    expect(screen.queryByTestId("conversation-list")).toBeNull();
  });

  it("submits a question to POST /drafts, clears the input on success, and the new draft reads back", async () => {
    let posts = 0;
    let list = drafts;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/drafts")) {
        posts += 1;
        const body = JSON.parse(init.body as string) as { question: string; threadContext: string | null };
        const created = draftFor("new", { question: body.question, threadContext: body.threadContext, createdAt: "2026-01-06T00:00:00.000Z" });
        list = [...list, created];
        return new Response(
          JSON.stringify({ kind: "draft", draftId: "new", text: created.draftText, sources: created.sources, confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 } }),
          { status: 201 },
        );
      }
      return pagedResponse(String(url), list);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("conversation-entry")[1]); // ask from inside General
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(2));

    fireEvent.change(screen.getByLabelText("Question for your duo"), { target: { value: "  How much leave do I get?  " } });
    fireEvent.click(screen.getByTestId("composer-submit"));

    await waitFor(() => expect(posts).toBe(1));
    const sent = JSON.parse((fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")?.[1] as { body: string }).body) as {
      question: string;
      threadContext: string | null;
    };
    // Trimmed, and targeted at the General group (null threadContext) by default.
    expect(sent).toEqual({ question: "How much leave do I get?", threadContext: null });
    // The refetched list renders the new question as its own entry.
    await waitFor(() => expect(screen.getByText("How much leave do I get?")).toBeInTheDocument());
    expect(screen.getByLabelText("Question for your duo")).toHaveValue("");
  });

  it("targets the open conversation's context when asking from it (#28)", async () => {
    let captured: { question: string; threadContext: string | null } | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/drafts")) {
        captured = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ kind: "draft", draftId: "x", text: "t", sources: [], confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 } }), { status: 201 });
      }
      return pagedResponse(String(url), drafts);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));
    expect(screen.getByTestId("composer-thread")).toHaveTextContent("General");

    fireEvent.click(screen.getAllByTestId("conversation-entry")[0]);
    expect(screen.getByTestId("composer-thread")).toHaveTextContent("Asking in: leave");

    fireEvent.change(screen.getByLabelText("Question for your duo"), { target: { value: "more leave questions" } });
    fireEvent.click(screen.getByTestId("composer-submit"));
    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured).toEqual({ question: "more leave questions", threadContext: "leave" });
  });

  it("keeps the typed question and shows the failure when the submit fails", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/drafts")) {
        return new Response(JSON.stringify({ error: { code: "unknown", message: "store locked" } }), { status: 500 });
      }
      return pagedResponse(String(url), drafts);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));

    fireEvent.change(screen.getByLabelText("Question for your duo"), { target: { value: "a question worth keeping" } });
    fireEvent.click(screen.getByTestId("composer-submit"));

    await waitFor(() => expect(screen.getByTestId("mutation-error")).toHaveTextContent("store locked"));
    expect(screen.getByLabelText("Question for your duo")).toHaveValue("a question worth keeping");
  });

  it("disables submission for whitespace-only questions and while a submit is in flight", async () => {
    let resolvePost!: (value: Response) => void;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/drafts")) {
        return new Promise<Response>((resolve) => {
          resolvePost = resolve;
        });
      }
      return pagedResponse(String(url), drafts);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithClient(<Duo api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(2));

    const input = screen.getByLabelText("Question for your duo");
    const submit = screen.getByTestId("composer-submit") as HTMLButtonElement;
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: "   " } });
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: "real question" } });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    // One question, one draft: submission is blocked while in flight, and
    // the button says what is happening instead of inviting a second POST.
    await waitFor(() => expect(submit).toBeDisabled());
    expect(submit).toHaveTextContent("Asking…");

    resolvePost(new Response(JSON.stringify({ kind: "draft", draftId: "x", text: "t", sources: [], confidence: { score: 0.9, passesThreshold: true, threshold: 0.55 } }), { status: 201 }));
    await waitFor(() => expect(screen.getByTestId("composer-submit")).toHaveTextContent("Ask"));
  });
});

describe("#20 — the thread says who asked, and where they asked it", () => {
  beforeEach(() => {
    writeComposerBuffer("");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a channel-borne entry shows the asker and channel verbatim, with the permalink one click away", async () => {
    stubDraftsResponse([
      draftFor("1", {
        createdAt: "2026-01-01T00:00:00.000Z",
        provenance: {
          origin: "channel",
          channelKind: "slack",
          askerRef: "U04ARLJ9P",
          threadId: "C07H3Q2NA",
          permalink: "https://acme.slack.com/archives/C07H3Q2NA/p1726482364000100",
        },
      }),
    ]);
    renderWithClient(<Duo api={api} />);
    fireEvent.click((await screen.findAllByTestId("conversation-entry"))[0]);
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(1));

    expect(screen.getByTestId("draft-origin")).toHaveTextContent("Asked by U04ARLJ9P in slack");
    const link = screen.getByRole("link", { name: "View original" });
    expect(link).toHaveAttribute("href", "https://acme.slack.com/archives/C07H3Q2NA/p1726482364000100");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("entries you asked yourself carry no attribution, and legacy ones degrade quietly", async () => {
    stubDraftsResponse([
      draftFor("1", { createdAt: "2026-01-01T00:00:00.000Z", provenance: { origin: "owner" } }),
      draftFor("2", { createdAt: "2026-01-02T00:00:00.000Z" }), // fixture default: unknown
    ]);
    renderWithClient(<Duo api={api} />);
    fireEvent.click((await screen.findAllByTestId("conversation-entry"))[0]);
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(2));

    expect(screen.queryByTestId("draft-origin")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("#21 — Send shows whether the answer arrived", () => {
  const channelAsked = {
    origin: "channel",
    channelKind: "slack",
    askerRef: "U04ARLJ9P",
    threadId: null,
    permalink: null,
  } as const;

  beforeEach(() => {
    writeComposerBuffer("");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openSingle(draft: DraftRecord) {
    stubDraftsResponse([draft]);
    renderWithClient(<Duo api={api} />);
    fireEvent.click((await screen.findAllByTestId("conversation-entry"))[0]);
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(1));
  }

  it("a delivered reply says so on its entry", async () => {
    await openSingle(
      draftFor("1", {
        createdAt: "2026-01-01T00:00:00.000Z",
        outcome: "sent",
        sentText: "sent as drafted",
        provenance: channelAsked,
        delivery: { state: "delivered" },
      }),
    );
    expect(screen.getByTestId("entry-outcome")).toHaveTextContent("Sent");
    expect(screen.getByTestId("delivery-state")).toHaveTextContent("Delivered.");
  });

  it("an in-flight delivery says so", async () => {
    await openSingle(
      draftFor("1", {
        createdAt: "2026-01-01T00:00:00.000Z",
        outcome: "sent",
        sentText: "sent as drafted",
        provenance: channelAsked,
        delivery: { state: "pending" },
      }),
    );
    expect(screen.getByTestId("delivery-state")).toHaveTextContent("In flight");
  });

  it("a failed delivery shows the daemon's reason — and the edit it carried is still plainly recorded", async () => {
    await openSingle(
      draftFor("1", {
        createdAt: "2026-01-01T00:00:00.000Z",
        outcome: "edited",
        sentText: "the edited text that was sent",
        provenance: channelAsked,
        delivery: { state: "failed", reason: 'no connected adapter for channel kind "slack"' },
      }),
    );
    // The correction stands: the outcome, and the text actually sent, render
    // as they always did — the failure is about transport only.
    expect(screen.getByTestId("entry-outcome")).toHaveTextContent("Sent (edited)");
    expect(screen.getByText("the edited text that was sent")).toBeInTheDocument();
    // The reason is the daemon's string, verbatim.
    expect(screen.getByTestId("delivery-state")).toHaveTextContent(
      'Couldn’t deliver — no connected adapter for channel kind "slack"',
    );
  });

  it("a self-asked question shows no delivery — it was never going anywhere", async () => {
    await openSingle(
      draftFor("1", {
        createdAt: "2026-01-01T00:00:00.000Z",
        outcome: "sent",
        sentText: "sent as drafted",
        provenance: { origin: "owner" },
        delivery: null,
      }),
    );
    expect(screen.getByTestId("entry-outcome")).toHaveTextContent("Sent");
    expect(screen.queryByTestId("delivery-state")).toBeNull();
  });

  it("offers no retry — the daemon exposes none, and a resend is not this client's to invent", async () => {
    await openSingle(
      draftFor("1", {
        createdAt: "2026-01-01T00:00:00.000Z",
        outcome: "sent",
        sentText: "sent as drafted",
        provenance: channelAsked,
        delivery: { state: "failed", reason: 'no connected adapter for channel kind "slack"' },
      }),
    );
    expect(screen.getByTestId("delivery-state")).toBeInTheDocument();
    expect(screen.queryByText(/retry/i)).toBeNull();
    expect(screen.queryByText(/resend/i)).toBeNull();
  });
});
