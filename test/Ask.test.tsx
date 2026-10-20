// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ask } from "../src/routes/Ask.js";
import type { PublicAnswered, PublicDeclinedRefused, PublicPassedOn } from "../src/api/types.js";

// The asker page is deliberately outside TanStack Query — one POST, no
// cache — so no QueryClient wrapper here, unlike the owner-surface tests.

function linkTo(host = "http://test", token = "asktok") {
  window.location.hash = `#host=${encodeURIComponent(host)}&token=${encodeURIComponent(token)}`;
}

// The fixtures mirror digital-duo #159's asker-visible envelope exactly:
// `{duo, kind, text}` for every outcome, `sources` only on an answered
// one, and none of the device-principal-only fields (`draftId`,
// `confidence`, `evidenceAgeDays`, `ownerNotice`) — the daemon composes
// all of those into `text` before an asker ever sees it.
const answered: PublicAnswered = {
  duo: "personal",
  kind: "answered",
  text: "Yes — leave is 20 days.\n\nSources:\n  - [the owner's own standing order] standing order on leave\n\n— Sam's duo speaking here, not Sam directly. Confidence: 0.82. Based on evidence up to 4 day(s) old.",
  sources: [
    { kind: "rule", id: "r1", label: "standing order on leave" },
    { kind: "evidence", id: "e1", label: "policy doc" },
  ],
};

const passedOn: PublicPassedOn = {
  duo: "personal",
  kind: "passed_on",
  text: "I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.",
};

const declined: PublicDeclinedRefused = {
  duo: "personal",
  kind: "declined_refused",
  text: "That's not something I speak for the owner on. I've passed it on to them, without saying anything more about it here.",
};

/** A fetch mock whose first call (the page-load probe) succeeds, so the question box renders. The probe's 400 is the semantically meaningful constant: auth passed, body rejected. */
function probeThen(submitResponse: () => Response) {
  const fetchMock = vi.fn();
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: { code: "bad_request", message: "question is required and must be a non-empty string" } }), { status: 400 }),
  );
  fetchMock.mockImplementation(async () => submitResponse());
  return fetchMock;
}

/** Renders the page and waits out the page-load link check, so the question box exists. */
async function renderReady(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(<Ask />);
  await waitFor(() => expect(screen.getByTestId("ask")).toBeInTheDocument());
}

async function ask(question = "How many leave days?") {
  fireEvent.change(screen.getByTestId("ask-question"), { target: { value: question } });
  fireEvent.click(screen.getByTestId("ask-submit"));
}

describe("Ask — the no-install asker page (duo #1/#2, on digital-duo #158/#159)", () => {
  beforeEach(() => {
    linkTo();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.location.hash = "";
  });

  it("probes the link with a zero-question POST on load — auth runs before body validation, so a 400 means the token is good", async () => {
    const fetchMock = probeThen(() => new Response(JSON.stringify(answered), { status: 200 }));
    await renderReady(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/ask",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer asktok" }),
      }),
    );
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ question: "" });
  });

  it("posts the question to the daemon's /ask with the link's ask token", async () => {
    const fetchMock = probeThen(() => new Response(JSON.stringify(answered), { status: 200 }));
    await renderReady(fetchMock);
    await ask("How many leave days?");

    await waitFor(() => expect(screen.getByTestId("duo-answer")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer asktok");
    expect(JSON.parse(init.body as string)).toEqual({ question: "How many leave days?" });
  });

  it("renders an answered outcome verbatim — attribution, sources, confidence, and evidence age all arrive inside the daemon's text", async () => {
    await renderReady(probeThen(() => new Response(JSON.stringify(answered), { status: 200 })));
    await ask();

    await waitFor(() => expect(screen.getByTestId("duo-answer")).toBeInTheDocument());
    expect(screen.getByTestId("duo-answer-attribution")).toHaveTextContent("the owner's duo");
    expect(screen.getByTestId("duo-answer")).toHaveTextContent("leave is 20 days");
    // Nothing the daemon didn't compose: no structured-confidence hairline,
    // no age line, no percentage numeral this page drew itself.
    expect(screen.queryByTestId("confidence-hairline")).not.toBeInTheDocument();
    expect(screen.queryByTestId("duo-answer-evidence-age")).not.toBeInTheDocument();
    expect(screen.getByTestId("duo-answer")).not.toHaveTextContent("%");
  });

  it("renders the passed-on text verbatim", async () => {
    await renderReady(probeThen(() => new Response(JSON.stringify(passedOn), { status: 200 })));
    await ask();

    await waitFor(() => expect(screen.getByTestId("ask-passed-on")).toBeInTheDocument());
    expect(screen.getByTestId("ask-passed-on")).toHaveTextContent(
      "I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.",
    );
  });

  it("renders the refusal text verbatim, distinct from passed-on", async () => {
    await renderReady(probeThen(() => new Response(JSON.stringify(declined), { status: 200 })));
    await ask();

    await waitFor(() => expect(screen.getByTestId("ask-declined")).toBeInTheDocument());
    expect(screen.getByTestId("ask-declined")).toHaveTextContent(
      "That's not something I speak for the owner on.",
    );
  });

  it("shows the daemon's own message when a link dies between the probe and the submit", async () => {
    await renderReady(probeThen(() => new Response(
      JSON.stringify({ error: { code: "unauthorized", message: "Invalid, expired, or revoked token." } }),
      { status: 401 },
    )));
    await ask();

    await waitFor(() => expect(screen.getByTestId("ask-error")).toBeInTheDocument());
    expect(screen.getByTestId("ask-error")).toHaveTextContent("Invalid, expired, or revoked token.");
  });

  it("fails a dead link at open time, honestly, with no question box (#2's expired-link criterion)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "unauthorized", message: "Invalid, expired, or revoked token." } }),
          { status: 401 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Ask />);

    await waitFor(() => expect(screen.getByTestId("ask-dead-link")).toBeInTheDocument());
    expect(screen.getByTestId("ask-dead-link")).toHaveTextContent("no longer valid");
    expect(screen.getByTestId("ask-dead-link")).toHaveTextContent("expired or been revoked");
    expect(screen.queryByTestId("ask-question")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still shows the question box when the probe fails for a reason that says nothing about the link", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await renderReady(fetchMock);
    expect(screen.getByTestId("ask-question")).toBeInTheDocument();
  });

  it("keeps the question box when the probe is rate-limited — 429 says nothing about the link, unlike 401", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many failed authentication attempts. Try again later." } }), { status: 429 }),
    );
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(answered), { status: 200 }));
    await renderReady(fetchMock);
    await ask();

    await waitFor(() => expect(screen.getByTestId("duo-answer")).toBeInTheDocument());
    expect(screen.queryByTestId("ask-dead-link")).not.toBeInTheDocument();
  });

  it("shows no question box while the link check is still in flight", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    render(<Ask />);

    expect(screen.getByTestId("ask-checking")).toBeInTheDocument();
    expect(screen.queryByTestId("ask-question")).not.toBeInTheDocument();
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

describe("W-S4-9 — a visitor (ask-token) session never calls the owner's task routes", () => {
  it("Ask.tsx imports neither queries.ts (useTasks/useOwnerCards live there) nor /tasks or /cards by name", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const source = readFileSync(join(root, "src/routes/Ask.tsx"), "utf8");
    // The asker page is deliberately outside TanStack Query altogether (see
    // this file's own header comment) — it never imports api/queries.ts at
    // all, so there is no route into useTasks/useTask/useOwnerCards from
    // here, by construction rather than by a runtime guard that could drift.
    expect(source).not.toMatch(/from ["']\.\.\/api\/queries\.js["']/);
    expect(source).not.toMatch(/\/tasks\b/);
    expect(source).not.toMatch(/\/cards\b/);
  });
});
