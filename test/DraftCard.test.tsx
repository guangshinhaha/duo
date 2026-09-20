import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftCard } from "../src/components/DraftCard.js";
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

  it("Ignore posts the outcome as \"discarded\"", async () => {
    renderWithClient(<DraftCard api={api} draft={draftRecord} />);
    fireEvent.click(screen.getByText("Ignore"));

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => c[0] === "http://test/drafts/d1/outcome");
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ outcome: "discarded" });
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
