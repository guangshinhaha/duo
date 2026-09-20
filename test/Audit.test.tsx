import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Audit } from "../src/routes/Audit.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { AuditEntry } from "../src/api/types.js";

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function entryFor(id: string, over?: Partial<AuditEntry>): AuditEntry {
  return {
    id,
    createdAt: `2026-01-0${id}T00:00:00.000Z`,
    question: `question ${id}`,
    askerRef: `asker-${id}`,
    askerResolved: true,
    declined: false,
    answerText: `answer ${id}, exactly as logged`,
    ...over,
  };
}

// Oldest first — the order GET /audit actually returns
// (`src/permissions/audit.ts`: ORDER BY created_at ASC).
const entries: AuditEntry[] = [
  entryFor("1"),
  entryFor("2", { askerRef: "someone@other.domain", askerResolved: false }),
  entryFor("3", { declined: true, answerText: "This one stays between us." }),
];

function stubAudit(list: AuditEntry[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/audit")) {
        return new Response(JSON.stringify(list), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }),
  );
}

describe("Audit — the permissions audit trail (issue #10)", () => {
  beforeEach(() => {
    stubAudit(entries);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists entries newest first with when, the question, who asked, and the answer verbatim", async () => {
    renderWithClient(<Audit api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("audit-entry")).toHaveLength(3));
    // The daemon sends oldest first; the list reads newest first.
    const questions = screen.getAllByTestId("audit-question").map((el) => el.textContent);
    expect(questions).toEqual(["question 3", "question 2", "question 1"]);
    const answers = screen.getAllByTestId("audit-answer").map((el) => el.textContent);
    expect(answers).toEqual(["This one stays between us.", "answer 2, exactly as logged", "answer 1, exactly as logged"]);
    expect(screen.getAllByTestId("audit-asker")[1]).toHaveTextContent("someone@other.domain");
    expect(screen.getAllByTestId("audit-when")).toHaveLength(3);
  });

  it("marks declined entries as declined and keeps the logged answer text as-is", async () => {
    renderWithClient(<Audit api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("audit-entry")).toHaveLength(3));
    const declined = screen.getAllByTestId("audit-entry")[0];
    expect(declined.querySelector('[data-testid="audit-declined"]')).not.toBeNull();
    expect(declined.querySelector('[data-testid="audit-answer"]')).toHaveTextContent("This one stays between us.");
  });

  it("marks unresolved askers rather than presenting the raw reference as a name", async () => {
    renderWithClient(<Audit api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("audit-entry")).toHaveLength(3));
    const unresolved = screen.getAllByTestId("audit-entry")[1];
    expect(unresolved.querySelector('[data-testid="audit-asker-unresolved"]')).not.toBeNull();
    expect(screen.getAllByTestId("audit-entry")[0].querySelector('[data-testid="audit-asker-unresolved"]')).toBeNull();
  });

  it("answers carry the duo's attribution, questions never carry the owner's", async () => {
    renderWithClient(<Audit api={api} />);
    await waitFor(() => expect(screen.getAllByTestId("audit-entry")).toHaveLength(3));
    expect(screen.getAllByTestId("duo-message")).toHaveLength(3);
    expect(screen.queryAllByTestId("owner-message")).toHaveLength(0);
  });

  it("renders an honest empty state when no one has asked yet (AR-19)", async () => {
    stubAudit([]);
    renderWithClient(<Audit api={api} />);
    await waitFor(() => expect(screen.getByTestId("audit-empty")).toBeInTheDocument());
    expect(screen.getByTestId("audit-empty")).toHaveTextContent("No one has asked this duo anything yet");
    expect(screen.queryByTestId("audit-entry")).toBeNull();
  });

  it("surfaces the daemon's error message when the route fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "unknown", message: "store locked" } }), { status: 500 })),
    );
    renderWithClient(<Audit api={api} />);
    await waitFor(() => expect(screen.getByText("store locked")).toBeInTheDocument());
  });
});
