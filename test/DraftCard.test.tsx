import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftCard, IGNORE_UNDO_WINDOW_MS } from "../src/components/DraftCard.js";
import type { DraftRecord } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const draftRecord: DraftRecord = {
  id: "d1",
  question: "How much leave do I get?",
  threadContext: null,
  draftText: "Five days per quarter.",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.8,
  sources: [{ kind: "rule", id: "r1", label: "standing order: five days" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
  provenance: { origin: "unknown" },
};

const escalatedRecord: DraftRecord = {
  ...draftRecord,
  id: "d2",
  draftText: null,
  escalated: true,
  escalationReason: "no supporting evidence",
  refused: false,
};

const refusedRecord: DraftRecord = {
  ...draftRecord,
  id: "d3",
  draftText: null,
  escalated: true,
  escalationReason: "this topic is on your refused list",
  refused: true,
};

describe("DraftCard — Send / Edit / Ignore (the correction loop's only input)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the question as OwnerMessage and the draft as DuoMessage", () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    expect(screen.getByTestId("owner-message")).toHaveTextContent("How much leave do I get?");
    expect(screen.getByTestId("duo-message")).toHaveTextContent("Five days per quarter.");
  });

  it("Send posts the outcome as \"sent\"", async () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://test/drafts/d1/outcome", expect.objectContaining({ method: "POST" })));
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] === "http://test/drafts/d1/outcome");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ outcome: "sent" });
  });

  it("Edit reveals a textarea, and Send edited posts the edited text", async () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Edit"));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Actually, ten days." } });
    fireEvent.click(screen.getByText("Send edited"));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] === "http://test/drafts/d1/outcome");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ outcome: "edited", sentText: "Actually, ten days." });
  });

  it("Send edited is disabled when the textarea is emptied, and stays disabled for whitespace-only text", () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Edit"));
    const textarea = screen.getByRole("textbox");

    fireEvent.change(textarea, { target: { value: "" } });
    expect(screen.getByText("Send edited")).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "   " } });
    expect(screen.getByText("Send edited")).toBeDisabled();
  });

  it("Ignore posts the outcome as \"discarded\" once its undo window has lapsed", async () => {
    vi.useFakeTimers();
    try {
      renderWithClient(<DraftCard api={api} draft={draftRecord} />);
      fireEvent.click(screen.getByText("Ignore"));
      // Async advancer: the mutation itself starts in a microtask, so the
      // flush has to let microtasks run between timer callbacks.
      await vi.advanceTimersByTimeAsync(IGNORE_UNDO_WINDOW_MS);

      const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] === "http://test/drafts/d1/outcome");
      expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ outcome: "discarded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an escalated draft shows the reason and an answer box, not Send/Edit/Ignore", () => {
    renderWithClient(<DraftCard api={api} draft={escalatedRecord} />);
    expect(screen.getByTestId("escalation-reason")).toHaveTextContent("no supporting evidence");
    expect(screen.queryByText("Send")).toBeNull();
    expect(screen.getByPlaceholderText(/Answer it yourself/)).toBeInTheDocument();
  });

  it("a refused escalation hides the answer box — based on the real `refused` field, not the reason text", () => {
    renderWithClient(<DraftCard api={api} draft={refusedRecord} />);
    expect(screen.getByTestId("escalation-reason")).toHaveTextContent("this topic is on your refused list");
    expect(screen.queryByPlaceholderText(/Answer it yourself/)).toBeNull();
  });

  it("a non-refused escalation whose reason text happens to mention \"refus\" still shows the answer box", () => {
    // The regression case for the substring-matching bug this field
    // replaced: wording alone must never flip whether the box shows.
    renderWithClient(<DraftCard api={api} draft={{ ...escalatedRecord, escalationReason: "I refuse to guess with this little evidence", refused: false }} />);
    expect(screen.getByPlaceholderText(/Answer it yourself/)).toBeInTheDocument();
  });

  it("answering an escalation shows a confirmation instead of leaving the box open to a duplicate submission", async () => {
    renderWithClient(<DraftCard api={api} draft={escalatedRecord} />);
    fireEvent.change(screen.getByPlaceholderText(/Answer it yourself/), { target: { value: "Ten days." } });
    fireEvent.click(screen.getByText("Answer"));

    await waitFor(() => expect(screen.getByTestId("answer-confirmation")).toBeInTheDocument());
    expect(screen.queryByPlaceholderText(/Answer it yourself/)).toBeNull();
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => c[0] === "http://test/drafts/d2/answer")).toHaveLength(1);
  });

  it("Answer stays disabled for a whitespace-only answer", () => {
    renderWithClient(<DraftCard api={api} draft={escalatedRecord} />);
    fireEvent.change(screen.getByPlaceholderText(/Answer it yourself/), { target: { value: "   " } });
    expect(screen.getByText("Answer")).toBeDisabled();
  });

  it("answering an escalation posts to /drafts/:id/answer", async () => {
    renderWithClient(<DraftCard api={api} draft={escalatedRecord} />);
    fireEvent.change(screen.getByPlaceholderText(/Answer it yourself/), { target: { value: "Ten days." } });
    fireEvent.click(screen.getByText("Answer"));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://test/drafts/d2/answer", expect.objectContaining({ method: "POST" })));
  });
});

describe("#23 — the edit shows as a change, not a textarea", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function postedBody(): Record<string, unknown> {
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] === "http://test/drafts/d1/outcome");
    return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
  }

  it("editing marks what was removed and what was added, at a glance against the duo's original", () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ten days per quarter." } });

    expect(screen.getByTestId("edit-diff-removed")).toHaveTextContent("Five");
    expect(screen.getByTestId("edit-diff-added")).toHaveTextContent("Ten");
    // The untouched words still read inline between the marks.
    expect(screen.getByTestId("edit-diff")).toHaveTextContent("days per quarter.");
  });

  it("an edit that has changed nothing yet shows the duo's text with no marks", () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Edit"));

    expect(screen.queryByTestId("edit-diff-removed")).toBeNull();
    expect(screen.queryByTestId("edit-diff-added")).toBeNull();
    expect(screen.getByTestId("edit-diff")).toHaveTextContent("Five days per quarter.");
  });

  it("sending an unchanged edit records \"sent\", not \"edited\" — nothing changed is nothing changed", async () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Edit"));
    // The editor was opened and left exactly as the duo wrote it.
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://test/drafts/d1/outcome", expect.objectContaining({ method: "POST" })));
    expect(postedBody()).toEqual({ outcome: "sent" });
  });

  it("an edit typed and reverted back to the duo's text also records \"sent\"", async () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Edit"));
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "Actually, ten days." } });
    expect(screen.getByText("Send edited")).toBeInTheDocument();
    fireEvent.change(textarea, { target: { value: "Five days per quarter." } });

    await waitFor(() => expect(screen.getByText("Send")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(postedBody()).toEqual({ outcome: "sent" });
  });

  it("a whitespace-only difference is not a change — it records \"sent\"", async () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Five days per quarter.  " } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(postedBody()).toEqual({ outcome: "sent" });
  });

  it("cancelling discards the edit — reopening starts from the duo's text again", () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Actually, ten days." } });
    fireEvent.click(screen.getByText("Cancel"));

    expect(screen.getByTestId("duo-message")).toHaveTextContent("Five days per quarter.");
    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByRole("textbox")).toHaveValue("Five days per quarter.");
    expect(screen.getByTestId("edit-diff")).toHaveTextContent("Five days per quarter.");
    expect(screen.queryByTestId("edit-diff-removed")).toBeNull();
  });
});

describe("#30 — a self-asked draft answers you, it doesn't reply to anyone", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const selfAsked: DraftRecord = { ...draftRecord, id: "s1", provenance: { origin: "owner" } };
  const channelAsked: DraftRecord = {
    ...draftRecord,
    id: "c1",
    provenance: { origin: "channel", channelKind: "slack", askerRef: "U123", threadId: "C01", permalink: null },
  };

  function postedOutcomeBody(path: string): Record<string, unknown> {
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] === `http://test/${path}`);
    return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
  }

  it("an owner-origin draft offers Keep / Edit / Ignore — no Send to a recipient that does not exist", () => {
    renderWithClient(<DraftCard api={api} draft={selfAsked} />);
    expect(screen.getByText("Keep", { selector: "button" })).toBeInTheDocument();
    expect(screen.getByText("Edit", { selector: "button" })).toBeInTheDocument();
    expect(screen.getByText("Ignore", { selector: "button" })).toBeInTheDocument();
    expect(screen.queryByText(/^Send/, { selector: "button" })).toBeNull();

    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Actually, ten days." } });
    expect(screen.getByText("Keep edited", { selector: "button" })).toBeInTheDocument();
    expect(screen.queryByText(/^Send/, { selector: "button" })).toBeNull();
  });

  it("keeping an edit to your own draft records the same edited outcome and sentText as any channel draft", async () => {
    renderWithClient(<DraftCard api={api} draft={selfAsked} />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Actually, ten days." } });
    fireEvent.click(screen.getByText("Keep edited"));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://test/drafts/s1/outcome", expect.objectContaining({ method: "POST" })));
    expect(postedOutcomeBody("drafts/s1/outcome")).toEqual({ outcome: "edited", sentText: "Actually, ten days." });
  });

  it("keeping the duo's text as-is records plain \"sent\" — the loop is unchanged, only the words are new", async () => {
    renderWithClient(<DraftCard api={api} draft={selfAsked} />);
    fireEvent.click(screen.getByText("Keep"));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(postedOutcomeBody("drafts/s1/outcome")).toEqual({ outcome: "sent" });
  });

  it("ignoring your own draft says \"not final yet\" — nothing was ever being sent anywhere", () => {
    vi.useFakeTimers();
    try {
      renderWithClient(<DraftCard api={api} draft={selfAsked} />);
      fireEvent.click(screen.getByText("Ignore"));
      expect(screen.getByTestId("ignore-window")).toHaveTextContent("Ignoring — not final yet.");
      expect(screen.getByText("Undo")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a channel-borne draft keeps Send / Send edited exactly, and its payload is today's payload", async () => {
    renderWithClient(<DraftCard api={api} draft={channelAsked} />);
    expect(screen.getByText("Send", { selector: "button" })).toBeInTheDocument();
    expect(screen.queryByText(/Keep/, { selector: "button" })).toBeNull();

    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Actually, ten days." } });
    fireEvent.click(screen.getByText("Send edited"));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(postedOutcomeBody("drafts/c1/outcome")).toEqual({ outcome: "edited", sentText: "Actually, ten days." });
  });

  it("a record the stale cache served before provenance existed renders with today's vocabulary, not a crash", () => {
    // duo-cache rehydrates up to a week of history, and a record cached
    // before #169 carries no provenance key at all — that rehydrated
    // render happens BEFORE the refetch replaces the data, so it must
    // succeed or the healing refetch never fires. The wire type stays
    // required; the cache is simply older than the field.
    const staleCached = { ...draftRecord, provenance: undefined } as unknown as DraftRecord;
    renderWithClient(<DraftCard api={api} draft={staleCached} />);
    expect(screen.getByText("Send", { selector: "button" })).toBeInTheDocument();
    expect(screen.getByText("Edit", { selector: "button" })).toBeInTheDocument();
    expect(screen.getByText("Ignore", { selector: "button" })).toBeInTheDocument();
    expect(screen.queryByText(/Keep/, { selector: "button" })).toBeNull();
  });

  it("a channel-borne draft's ignore window still says \"not sent yet\" — the wording split is provenance-based, not cosmetic", () => {
    vi.useFakeTimers();
    try {
      renderWithClient(<DraftCard api={api} draft={channelAsked} />);
      fireEvent.click(screen.getByText("Ignore"));
      expect(screen.getByTestId("ignore-window")).toHaveTextContent("Ignoring — not sent yet.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("#24 — a mis-click on Ignore is recoverable", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Ignore opens an undo window instead of posting — the discard is held client-side, not sent", () => {
    vi.useFakeTimers();
    try {
      renderWithClient(<DraftCard api={api} draft={draftRecord} />);
      fireEvent.click(screen.getByText("Ignore"));

      // AC2: the window holds the mutation before sending it — nothing is
      // on the wire while undo is still possible.
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.getByTestId("ignore-window")).toBeInTheDocument();
      expect(screen.getByText("Undo")).toBeInTheDocument();
      // The action row is replaced by the window — no second Ignore, no Send.
      expect(screen.queryByText("Send", { selector: "button" })).toBeNull();
      expect(screen.queryByText("Edit", { selector: "button" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Undo within the window reverses it — the draft stays in Review and nothing is ever posted", () => {
    vi.useFakeTimers();
    try {
      renderWithClient(<DraftCard api={api} draft={draftRecord} />);
      fireEvent.click(screen.getByText("Ignore"));
      fireEvent.click(screen.getByText("Undo"));

      // The card is back: the draft never left Review, and its controls
      // returned exactly as they were.
      expect(screen.getByText("Send", { selector: "button" })).toBeInTheDocument();
      expect(screen.getByText("Ignore", { selector: "button" })).toBeInTheDocument();
      expect(screen.queryByTestId("ignore-window")).toBeNull();

      // Well past the window: the cancelled discard must never fire.
      vi.advanceTimersByTime(IGNORE_UNDO_WINDOW_MS * 3);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the window lapsing posts the held discard exactly once, after the full window", async () => {
    vi.useFakeTimers();
    try {
      renderWithClient(<DraftCard api={api} draft={draftRecord} />);
      fireEvent.click(screen.getByText("Ignore"));

      await vi.advanceTimersByTimeAsync(IGNORE_UNDO_WINDOW_MS - 1);
      expect(fetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const outcomeCalls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => c[0] === "http://test/drafts/d1/outcome");
      expect(outcomeCalls).toHaveLength(1);
      expect(JSON.parse((outcomeCalls[0]![1] as RequestInit).body as string)).toEqual({ outcome: "discarded" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("#20 — a draft says who asked, and where they asked it", () => {
  const channelProvenance = {
    origin: "channel",
    channelKind: "slack",
    askerRef: "U04ARLJ9P",
    threadId: "C07H3Q2NA",
    permalink: "https://acme.slack.com/archives/C07H3Q2NA/p1726482364000100",
  } as const;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the asker and the adapter's channel label, the daemon's strings verbatim", () => {
    renderWithClient(<DraftCard api={api} draft={{ ...draftRecord, provenance: channelProvenance }} />);
    // Verbatim — no capitalisation, no client-side channel registry: adding a
    // channel in the core must need no change here.
    expect(screen.getByTestId("draft-origin")).toHaveTextContent("Asked by U04ARLJ9P in slack");
  });

  it("carries the permalink as the one click back to the original message", () => {
    renderWithClient(<DraftCard api={api} draft={{ ...draftRecord, provenance: channelProvenance }} />);
    const link = screen.getByRole("link", { name: "View original" });
    expect(link).toHaveAttribute("href", "https://acme.slack.com/archives/C07H3Q2NA/p1726482364000100");
    // The owner's application opens it, not this client.
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("a channel draft without a permalink shows the attribution and no link", () => {
    renderWithClient(
      <DraftCard api={api} draft={{ ...draftRecord, provenance: { ...channelProvenance, permalink: null } }} />,
    );
    expect(screen.getByTestId("draft-origin")).toHaveTextContent("Asked by U04ARLJ9P in slack");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("a channel-borne question that escalated still says who asked it", () => {
    renderWithClient(<DraftCard api={api} draft={{ ...escalatedRecord, provenance: channelProvenance }} />);
    expect(screen.getByTestId("draft-origin")).toHaveTextContent("Asked by U04ARLJ9P in slack");
  });

  it("a self-asked draft invents no asker and no channel", () => {
    renderWithClient(<DraftCard api={api} draft={{ ...draftRecord, provenance: { origin: "owner" } }} />);
    expect(screen.queryByTestId("draft-origin")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("a legacy draft without provenance degrades quietly — no 'unknown' chrome", () => {
    renderWithClient(<DraftCard api={api} draft={{ ...draftRecord, provenance: { origin: "unknown" } }} />);
    expect(screen.queryByTestId("draft-origin")).toBeNull();
    // The persisted cache can also serve the field entirely absent (#86's
    // staleness belt): same quiet degradation.
    const staleCached = { ...draftRecord, provenance: undefined } as unknown as DraftRecord;
    const { unmount } = renderWithClient(<DraftCard api={api} draft={staleCached} />);
    expect(screen.queryByTestId("draft-origin")).toBeNull();
    unmount();
  });
});
