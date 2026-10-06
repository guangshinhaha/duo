import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord, DuoRequest } from "../src/api/types.js";
import { DuoConversationBanner } from "../src/components/DuoConversationBanner.js";
import { DuoRequests, DuoRequestWatcher } from "../src/components/DuoRequests.js";
import { EscalationCard, isColleagueEscalation } from "../src/components/EscalationCard.js";
import { MessageBody } from "../src/routes/Room.js";
import { PUBLIC_PASSED_ON_MESSAGE, PUBLIC_REFUSAL_MESSAGE } from "../src/workspace/duoAnswer.js";
import { duoConversationOf, questionOutcomes, questionOutcomeWords } from "../src/workspace/duoConversation.js";
import type { RoomMessage, RoomSummary, WorkspaceConnection } from "../src/workspace/matrix.js";

const sync = vi.hoisted(() => ({ reachable: true }));
vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync.js")>();
  return { ...actual, useSyncStatus: () => ({ reachable: sync.reachable, lastSyncedAt: null }) };
});
const notified = vi.hoisted(() => ({ calls: [] as (string | null)[] }));
vi.mock("../src/notifications.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/notifications.js")>();
  return { ...actual, notifyDuoRequest: async (asker: string | null) => void notified.calls.push(asker) };
});

/*
 * guangshinhaha/duo#313, #314, #315 — colleagues talking to someone's duo:
 * it is always labelled, every question shows its outcome (and updates when
 * the owner answers a passed-on one), a passed-on question reaches its owner
 * with everything, and a first message waits for the owner's OK.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };
const ME = "@bob:workspace.example";
const DUO = "@duo-wei:workspace.example";
const WEI = "@wei:workspace.example";
const ATTRIBUTION = "\n\n— wei's duo speaking here, not wei directly.";

function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function message(eventId: string, senderId: string, body: string, extra: Partial<RoomMessage> = {}): RoomMessage {
  return {
    eventId,
    roomId: "!ask:workspace.example",
    senderId,
    senderName: senderId,
    body,
    parts: null,
    originServerTs: 1_700_000_000_000,
    edited: false,
    redacted: false,
    reactions: [],
    thread: null,
    threadRootEventId: null,
    replyToEventId: null,
    ...extra,
  } as RoomMessage;
}

const answer = (eventId: string) =>
  message(eventId, DUO, `Use the runbook.\n\n— wei's duo speaking here, not wei directly. Confidence: 0.90. Based on evidence from today.`);
const passOn = (eventId: string) => message(eventId, DUO, `${PUBLIC_PASSED_ON_MESSAGE}${ATTRIBUTION}`);
const refusal = (eventId: string) => message(eventId, DUO, `${PUBLIC_REFUSAL_MESSAGE}${ATTRIBUTION}`);

function room(over: Partial<RoomSummary> = {}): Pick<RoomSummary, "members" | "invitedMembers" | "declinedDuos" | "name"> {
  return { name: null, members: [{ userId: DUO, name: null, ownerName: "Wei" }], invitedMembers: [], ...over };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#313 — a colleague always knows it's the duo", () => {
  it("reads a conversation with a colleague's duo, and its owner coming in to answer keeps it one", () => {
    expect(duoConversationOf(room(), ME)).toMatchObject({ duoUserId: DUO, ownerUserId: WEI, ownerLabel: "Wei", state: "answering" });
    expect(duoConversationOf(room({ members: [{ userId: DUO, name: null, ownerName: "Wei" }, { userId: WEI, name: "Wei" }] }), ME)?.state).toBe("answering");
  });

  it("is not a duo conversation for your own duo, a group, or nobody", () => {
    expect(duoConversationOf(room(), WEI)).toBeNull();
    expect(duoConversationOf(room({ members: [{ userId: DUO, name: null }, { userId: "@carol:workspace.example", name: "Carol" }] }), ME)).toBeNull();
    expect(duoConversationOf(room({ members: [] }), ME)).toBeNull();
  });

  it("says when it's waiting on the owner's OK, and when the duo declined — in the duo's own words", () => {
    expect(duoConversationOf(room({ members: [], invitedMembers: [{ userId: DUO, name: null }] }), ME)?.state).toBe("waiting");
    const declined = duoConversationOf(room({ members: [], declinedDuos: [{ userId: DUO, reason: "Thanks for reaching out." }] }), ME);
    expect(declined).toMatchObject({ state: "declined", declineReason: "Thanks for reaching out." });
  });

  it("the banner labels the duo and its limits, persistently, with the waiting and declined states", () => {
    const { rerender } = render(<DuoConversationBanner conversation={duoConversationOf(room(), ME)!} />);
    expect(screen.getByTestId("duo-conversation-label")).toHaveTextContent("Wei's duo — answers within limits Wei set.");
    rerender(<DuoConversationBanner conversation={duoConversationOf(room({ members: [], invitedMembers: [{ userId: DUO, name: null }] }), ME)!} />);
    expect(screen.getByTestId("duo-conversation-waiting")).toHaveTextContent("Waiting for wei's OK");
    rerender(<DuoConversationBanner conversation={duoConversationOf(room({ members: [], declinedDuos: [{ userId: DUO, reason: "Please message wei directly." }] }), ME)!} />);
    expect(screen.getByTestId("duo-conversation-declined")).toHaveTextContent("Please message wei directly.");
  });
});

describe("#313 — each question shows its outcome, and a passed-on one updates when the owner answers", () => {
  it("pairs questions with the duo's replies in order, bursts included", () => {
    const conversation = [
      message("$q1", ME, "Where's the runbook?"),
      message("$q2", ME, "And who approves budgets?"),
      answer("$a1"),
      passOn("$a2"),
      message("$q3", ME, "What about salaries?"),
      refusal("$a3"),
      message("$q4", ME, "One more?"),
    ];
    const outcomes = questionOutcomes(conversation, DUO);
    expect(Object.fromEntries(outcomes)).toEqual({ $q1: "answered", $q2: "passed-on", $q3: "declined", $q4: "with-duo" });
  });

  it("a passed-on question reads replied once the owner speaks after the pass-on", () => {
    const before = [message("$q1", ME, "Who approves budgets?"), passOn("$a1")];
    expect(questionOutcomes(before, DUO).get("$q1")).toBe("passed-on");
    const after = [...before, message("$w1", WEI, "That's Priya — I've looped her in.")];
    const outcomes = questionOutcomes(after, DUO);
    expect(outcomes.get("$q1")).toBe("replied");
    // The owner's own words are never a question to their duo.
    expect(outcomes.has("$w1")).toBe(false);
    expect(questionOutcomeWords("replied", "Wei")).toBe("Passed to Wei — Wei replied");
    expect(questionOutcomeWords("passed-on", "Wei")).toBe("Passed to Wei — waiting on them");
    expect(questionOutcomeWords("declined", "Wei")).toBe("Declined");
  });

  it("the row shows the outcome beside the question, and the duo's message stays labelled as the duo's", () => {
    const noop = async () => null;
    const conversation = [message("$q1", ME, "Who approves budgets?"), passOn("$a1")];
    render(
      <>
        <MessageBody
          conversation={conversation}
          getUrlPreview={noop as unknown as WorkspaceConnection["getUrlPreview"]}
          loadMedia={noop}
          message={conversation[0]!}
          questionOutcome={{ outcome: "passed-on", words: questionOutcomeWords("passed-on", "wei") }}
        />
        <MessageBody conversation={conversation} getUrlPreview={noop as unknown as WorkspaceConnection["getUrlPreview"]} loadMedia={noop} message={conversation[1]!} />
      </>,
    );
    expect(screen.getByTestId("room-question-outcome")).toHaveTextContent("Passed to wei — waiting on them");
    expect(screen.getByTestId("room-duo-message-attribution")).toHaveTextContent("wei's duo");
  });
});

const escalated: DraftRecord = {
  id: "d1",
  question: "Who approves the laptop budget?",
  threadContext: null,
  draftText: null,
  escalated: true,
  escalationReason: "I'd escalate this one: no standing order or past exchange in the corpus covers this question at all.",
  confidenceScore: 0,
  sources: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
  provenance: { origin: "channel", channelKind: "workspace", askerRef: ME, threadId: "!ask:workspace.example", permalink: "https://matrix.to/#/!ask%3Aworkspace.example/%24q1" },
  delivery: null,
  publicOutcome: "passed_on",
  passOnReason: "I'd escalate this one: no standing order or past exchange in the corpus covers this question at all.",
};
const withAttempt: DraftRecord = {
  ...escalated,
  id: "d2",
  escalated: false,
  escalationReason: null,
  draftText: "Finance approves anything over $2k.",
  passOnReason: `I drafted an answer, but "topic-budget" isn't a topic you've let me answer on my own yet.`,
};

function fakeConnection() {
  return {
    joinRoom: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
  } as unknown as WorkspaceConnection & { joinRoom: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
}

function calls() {
  return (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => ({
    url: String(call[0]),
    body: (call[1] as RequestInit | undefined)?.body ? JSON.parse((call[1] as RequestInit).body as string) : undefined,
  }));
}

describe("#314 — a passed-on question reaches you with everything", () => {
  beforeEach(() => {
    sync.reachable = true;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
  });

  it("is a colleague's pass-on only with a conversation to answer in", () => {
    expect(isColleagueEscalation(escalated)).toBe(true);
    expect(isColleagueEscalation({ ...escalated, provenance: { origin: "owner" } })).toBe(false);
    expect(isColleagueEscalation({ ...escalated, publicOutcome: "answered" })).toBe(false);
  });

  it("shows the question, who asked, the duo's attempt, and why it stopped", () => {
    mount(<EscalationCard api={api} connection={fakeConnection()} draft={withAttempt} rooms={[]} />);
    expect(screen.getByTestId("escalation-card-asker")).toHaveTextContent("Your duo passed bob's question to you.");
    expect(screen.getByTestId("escalation-card-question")).toHaveTextContent("Who approves the laptop budget?");
    expect(screen.getByTestId("escalation-card-attempt")).toHaveTextContent("Finance approves anything over $2k.");
    expect(screen.getByTestId("escalation-card-attempt-label")).toHaveTextContent("Your duo");
    expect(screen.getByTestId("escalation-card-reason")).toHaveTextContent(`"topic-budget" isn't a topic you've let me answer on my own yet`);
  });

  it("says plainly when the duo made no attempt — and still says why", () => {
    mount(<EscalationCard api={api} connection={fakeConnection()} draft={escalated} rooms={[]} />);
    expect(screen.getByTestId("escalation-card-no-attempt")).toBeInTheDocument();
    expect(screen.getByTestId("escalation-card-reason")).toHaveTextContent("no standing order or past exchange");
  });

  it("Reply starts from the attempt and posts it back into the same conversation, as you — brought in by your duo", async () => {
    const connection = fakeConnection();
    mount(<EscalationCard api={api} connection={connection} draft={withAttempt} rooms={[]} />);
    fireEvent.click(screen.getByTestId("escalation-card-reply"));
    expect(screen.getByTestId("escalation-card-reply-text")).toHaveValue("Finance approves anything over $2k.");
    fireEvent.click(screen.getByTestId("escalation-card-send"));
    await waitFor(() => expect(screen.getByTestId("escalation-card-sent")).toBeInTheDocument());
    expect(calls()[0]).toEqual({ url: "http://test/workspace/rooms/!ask%3Aworkspace.example/invite-owner", body: undefined });
    expect(connection.joinRoom).toHaveBeenCalledWith("!ask:workspace.example");
    expect(connection.send).toHaveBeenCalledWith("!ask:workspace.example", "Finance approves anything over $2k.");
    expect(calls()[1]).toEqual({ url: "http://test/drafts/d2/outcome", body: { outcome: "sent", ownerDelivered: true } });
  });

  it("an escalation's reply is recorded as its answer, and a room you hold needs no invite", async () => {
    const connection = fakeConnection();
    const held = [{ roomId: "!ask:workspace.example", members: [{ userId: ME, name: "Bob" }] }] as unknown as RoomSummary[];
    mount(<EscalationCard api={api} connection={connection} draft={escalated} rooms={held} />);
    expect(screen.getByTestId("escalation-card-asker")).toHaveTextContent("Bob's question");
    fireEvent.click(screen.getByTestId("escalation-card-reply"));
    expect(screen.getByTestId("escalation-card-reply-text")).toHaveValue("");
    fireEvent.change(screen.getByTestId("escalation-card-reply-text"), { target: { value: "Priya approves those." } });
    fireEvent.click(screen.getByTestId("escalation-card-send"));
    await waitFor(() => expect(screen.getByTestId("escalation-card-sent")).toBeInTheDocument());
    expect(connection.joinRoom).not.toHaveBeenCalled();
    expect(connection.send).toHaveBeenCalledWith("!ask:workspace.example", "Priya approves those.");
    expect(calls()).toEqual([{ url: "http://test/drafts/d1/answer", body: { answer: "Priya approves those." } }]);
  });

  it("an edited attempt is recorded as edited, with the words you sent", async () => {
    const connection = fakeConnection();
    mount(<EscalationCard api={api} connection={connection} draft={withAttempt} rooms={[]} />);
    fireEvent.click(screen.getByTestId("escalation-card-reply"));
    fireEvent.change(screen.getByTestId("escalation-card-reply-text"), { target: { value: "Finance, over $2k — I'll confirm." } });
    fireEvent.click(screen.getByTestId("escalation-card-send"));
    await waitFor(() => expect(screen.getByTestId("escalation-card-sent")).toBeInTheDocument());
    expect(calls().at(-1)).toEqual({ url: "http://test/drafts/d2/outcome", body: { outcome: "edited", sentText: "Finance, over $2k — I'll confirm.", ownerDelivered: true } });
  });

  it("Send is disabled, never queued, while the daemon can't be reached", () => {
    sync.reachable = false;
    mount(<EscalationCard api={api} connection={fakeConnection()} draft={withAttempt} rooms={[]} />);
    fireEvent.click(screen.getByTestId("escalation-card-reply"));
    expect(screen.getByTestId("escalation-card-send")).toBeDisabled();
  });
});

const request: DuoRequest = {
  roomId: "!ask:workspace.example",
  inviterId: ME,
  name: null,
  joinedMemberCount: 1,
  reason: "Where's the deploy runbook?",
  direct: true,
  receivedAt: "2026-01-01T00:00:00.000Z",
};

describe("#315 — a colleague's first message waits for your OK", () => {
  beforeEach(() => {
    sync.reachable = true;
    notified.calls = [];
  });

  function serve(invites: DuoRequest[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/workspace/invites") ? new Response(JSON.stringify({ invites }), { status: 200 }) : new Response(JSON.stringify({}), { status: 200 }),
      ),
    );
  }

  it("lists a pending request with its preview, and nothing at all when there are none", async () => {
    serve([request]);
    mount(<DuoRequests api={api} />);
    expect(await screen.findByTestId("duo-request-title")).toHaveTextContent("bob wants to ask your duo");
    expect(screen.getByTestId("duo-request-preview")).toHaveTextContent("Where's the deploy runbook?");
    cleanup();
    serve([]);
    const { container } = mount(<DuoRequests api={api} />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="duo-requests"]')).toBeNull();
  });

  it.each([
    ["duo-request-allow", "allow", { always: false }],
    ["duo-request-always", "allow", { always: true }],
  ] as const)("%s allows the duo to answer there", async (testId, route, body) => {
    serve([request]);
    mount(<DuoRequests api={api} />);
    fireEvent.click(await screen.findByTestId(testId));
    await waitFor(() => expect(calls().some((call) => call.url.endsWith(`/${route}`))).toBe(true));
    expect(calls().find((call) => call.url.endsWith(`/${route}`))).toEqual({ url: `http://test/workspace/invites/!ask%3Aworkspace.example/${route}`, body });
  });

  it("Decline refuses it — the daemon tells the colleague politely", async () => {
    serve([request]);
    mount(<DuoRequests api={api} />);
    fireEvent.click(await screen.findByTestId("duo-request-decline"));
    await waitFor(() => expect(calls().some((call) => call.url.endsWith("/refuse"))).toBe(true));
  });

  it("offers 'always allow' only for a person's one-to-one conversation", async () => {
    serve([{ ...request, direct: false, name: "Launch planning", joinedMemberCount: 3, reason: null }]);
    mount(<DuoRequests api={api} />);
    expect(await screen.findByTestId("duo-request-title")).toHaveTextContent("bob invited your duo to Launch planning");
    expect(screen.queryByTestId("duo-request-always")).toBeNull();
  });

  it("the decisions wait while the daemon can't be reached", async () => {
    sync.reachable = false;
    serve([request]);
    mount(<DuoRequests api={api} />);
    expect(await screen.findByTestId("duo-request-allow")).toBeDisabled();
    expect(screen.getByTestId("duo-request-decline")).toBeDisabled();
  });

  it("a new request notifies once, naming who asked", async () => {
    serve([request]);
    mount(<DuoRequestWatcher api={api} />);
    await waitFor(() => expect(notified.calls).toEqual(["bob"]));
  });
});
