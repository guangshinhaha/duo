import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftCard } from "../src/components/DraftCard.js";
import { Duo } from "../src/routes/Duo.js";
import { StructuredText } from "../src/components/StructuredText.js";
import { Timestamp } from "../src/components/Timestamp.js";
import type { DraftRecord } from "../src/api/types.js";
import type { DuoApiConfig } from "../src/api/client.js";

/*
 * #26: a draft reads like the message it will become — structure (lists,
 * links, code, paragraphs) rendered as structure with nothing executed,
 * time visible (recent relative, older absolute, full on hover), and
 * copy-to-clipboard with a confirmation.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const structuredText = [
  "Five days per quarter, accrued monthly.",
  "",
  "- carry over up to 10 days",
  "- expires after `12 months`",
  "- details in the [leave policy](https://example.com/policy)",
  "",
  "```",
  "const req = f(t);",
  "return q(req);",
  "```",
].join("\n");

const draft: DraftRecord = {
  id: "d1",
  question: "How much leave do I get?",
  threadContext: null,
  draftText: structuredText,
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

describe("#26 — a draft renders its structure", () => {
  it("paragraphs, lists, links, inline code, and code blocks each read as what they are", () => {
    render(<StructuredText text={structuredText} />);

    const root = screen.getByTestId("structured-text");
    expect(root).toHaveTextContent("Five days per quarter, accrued monthly.");
    const list = screen.getByTestId("structured-list");
    expect(list.querySelectorAll("li")).toHaveLength(3);
    expect(list).toHaveTextContent("carry over up to 10 days");
    const link = screen.getByTestId("structured-link");
    expect(link.getAttribute("href")).toBe("https://example.com/policy");
    expect(link).toHaveTextContent("leave policy");
    expect(screen.getByTestId("structured-code")).toHaveTextContent("12 months");
    expect(screen.getByTestId("structured-codeblock")).toHaveTextContent("return q(req);");
  });

  it("renders text the daemon sent verbatim — nothing executes, and hostile hrefs are not links", () => {
    const hostile = 'See <script>alert(1)</script> and the [bad](javascript:alert(1)) link.';
    const { container } = render(<StructuredText text={hostile} />);

    // The script tag is text the recipient reads, not markup the app runs.
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByTestId("structured-text")).toHaveTextContent("<script>alert(1)</script>");
    // A javascript: URL is rendered as the literal text, never as an anchor.
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByTestId("structured-text")).toHaveTextContent("[bad](javascript:alert(1))");
  });

  it("a draft's text renders as structure inside the card", () => {
    renderWithClient(<DraftCard api={api} draft={draft} />);
    expect(screen.getByTestId("duo-message").querySelector('[data-testid="structured-list"]')).not.toBeNull();
  });
});

describe("#26 — time is visible", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recent times read relative, with the full timestamp on hover", () => {
    vi.useFakeTimers({ now: new Date("2026-09-20T12:00:00.000Z") });
    const iso = "2026-09-20T11:55:00.000Z"; // 5 minutes ago
    render(<Timestamp iso={iso} />);
    const el = screen.getByTestId("timestamp");
    expect(el).toHaveTextContent("5m ago");
    expect(el.getAttribute("title")).toBe(iso);
  });

  it("seconds-old times are \"just now\", hours are hours", () => {
    vi.useFakeTimers({ now: new Date("2026-09-20T12:00:00.000Z") });
    const { rerender } = render(<Timestamp iso="2026-09-20T11:59:40.000Z" />);
    expect(screen.getByTestId("timestamp")).toHaveTextContent("just now");
    rerender(<Timestamp iso="2026-09-20T09:00:00.000Z" />);
    expect(screen.getByTestId("timestamp")).toHaveTextContent("3h ago");
  });

  it("older times are absolute dates, not an age in hours", () => {
    vi.useFakeTimers({ now: new Date("2026-09-20T12:00:00.000Z") });
    render(<Timestamp iso="2026-01-01T00:00:00.000Z" />);
    const label = screen.getByTestId("timestamp").textContent ?? "";
    expect(label).not.toMatch(/ago/);
    expect(label).toMatch(/\d/);
    expect(screen.getByTestId("timestamp").getAttribute("title")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("a draft carries its time, and so does every thread entry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([draft]), { status: 200 })));
    renderWithClient(<DraftCard api={api} draft={draft} />);
    expect(screen.getAllByTestId("timestamp").length).toBeGreaterThan(0);
    cleanup();

    renderWithClient(<Duo api={api} />);
    // #28: the single conversation sits in the list until picked.
    await waitFor(() => expect(screen.getAllByTestId("conversation-entry")).toHaveLength(1));
    fireEvent.click(screen.getAllByTestId("conversation-entry")[0]);
    await waitFor(() => expect(screen.getAllByTestId("thread-entry")).toHaveLength(1));
    expect(screen.getAllByTestId("timestamp")).toHaveLength(1);
  });
});

describe("#26 — text can be copied", () => {
  const writeText = vi.fn(async () => {});
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    writeText.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("copies the draft's text and confirms it copied", async () => {
    renderWithClient(<DraftCard api={api} draft={draft} />);
    fireEvent.click(screen.getByTestId("copy-draft"));

    await waitFor(() => expect(screen.getByTestId("copy-draft")).toHaveTextContent("Copied."));
    expect(writeText).toHaveBeenCalledWith(structuredText);
  });

  it("says so plainly when the clipboard refuses", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    renderWithClient(<DraftCard api={api} draft={draft} />);
    fireEvent.click(screen.getByTestId("copy-draft"));

    await waitFor(() => expect(screen.getByTestId("copy-draft")).toHaveTextContent("Couldn't copy."));
  });
});
