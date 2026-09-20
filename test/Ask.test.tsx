import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ask } from "../src/routes/Ask.js";
import type { PublicAnswered, PublicAnswerOutcome, PublicPassedOn } from "../src/api/types.js";

// The asker page is deliberately outside TanStack Query — one POST, no
// cache — so no QueryClient wrapper here, unlike the owner-surface tests.

function linkTo(host = "http://test", token = "asktok") {
  window.location.hash = `#host=${encodeURIComponent(host)}&token=${encodeURIComponent(token)}`;
}

const answered: PublicAnswered = {
  kind: "answered",
  draftId: "d1",
  logEntryId: "l1",
  text: "Yes — leave is 20 days.\n\nAnswered from the owner's standing order on leave, with confidence stated plainly.",
  sources: [
    { kind: "rule", id: "r1", label: "standing order on leave" },
    { kind: "evidence", id: "e1", label: "policy doc" },
  ],
  confidence: { score: 0.82, passesThreshold: true, threshold: 0.6 },
  topicId: "t1",
  evidenceAgeDays: 4,
};

const passedOn: PublicPassedOn = {
  kind: "passed_on",
  draftId: "d2",
  logEntryId: "l2",
  message: "I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.",
  topicId: undefined,
  ownerNotice: "Someone asked about salary bands — outside what you've granted me to answer publicly.",
};

const declined: Extract<PublicAnswerOutcome, { kind: "declined_refused" }> = {
  kind: "declined_refused",
  draftId: "d3",
  logEntryId: "l3",
  message:
    "That's not something I speak for the owner on. I've passed it on to them, without saying anything more about it here.",
};

async function ask(question = "How many leave days?") {
  fireEvent.change(screen.getByTestId("ask-question"), { target: { value: question } });
  fireEvent.click(screen.getByTestId("ask-submit"));
}

describe("Ask — the no-install asker page (duo #1/#2, contract-first on digital-duo #157/#159)", () => {
  beforeEach(() => {
    linkTo();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("posts the question to the daemon's /ask with the link's ask token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answered), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Ask />);
    await ask("How many leave days?");

    await waitFor(() => expect(screen.getByTestId("duo-answer")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/ask",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer asktok" }),
      }),
    );
    // The stub itself takes no params (matching every other test's idiom),
    // so the recorded init argument is read through a tuple cast.
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ question: "How many leave days?" });
  });

  it("renders an answered outcome verbatim, attributed to the duo — never as the asker's or the owner's own words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(answered), { status: 200 })));
    render(<Ask />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("duo-answer")).toBeInTheDocument());
    expect(screen.getByTestId("duo-answer-attribution")).toHaveTextContent("the owner's duo");
    expect(screen.getByTestId("duo-answer")).toHaveTextContent("leave is 20 days");
    // The hairline — never a percentage numeral — rides along on the answer.
    expect(screen.getByTestId("confidence-hairline")).toBeInTheDocument();
    expect(screen.getByTestId("duo-answer")).not.toHaveTextContent("%");
    expect(screen.getByTestId("duo-answer-evidence-age")).toHaveTextContent("4 days old");
  });

  it("renders the passed-on message verbatim and never surfaces the owner notice (it is addressed to the owner, #55)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(passedOn), { status: 200 })));
    render(<Ask />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("ask-passed-on")).toBeInTheDocument());
    expect(screen.getByTestId("ask-passed-on")).toHaveTextContent(
      "I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.",
    );
    expect(document.body.textContent).not.toContain("salary bands");
  });

  it("renders the refusal message verbatim, distinct from passed-on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(declined), { status: 200 })));
    render(<Ask />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("ask-declined")).toBeInTheDocument());
    expect(screen.getByTestId("ask-declined")).toHaveTextContent(
      "That's not something I speak for the owner on.",
    );
  });

  it("shows the daemon's own error message when the ask token is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "AskTokenExpiredError", message: "This ask link has expired — ask the owner for a new one." } }),
            { status: 401 },
          ),
      ),
    );
    render(<Ask />);
    await ask();

    await waitFor(() => expect(screen.getByTestId("ask-error")).toBeInTheDocument());
    expect(screen.getByTestId("ask-error")).toHaveTextContent("This ask link has expired — ask the owner for a new one.");
  });

  it("renders an honest missing-link state when the hash carries no connection details", () => {
    window.location.hash = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<Ask />);

    expect(screen.getByTestId("ask-missing-link")).toHaveTextContent("no connection details");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
