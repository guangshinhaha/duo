import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomEntry } from "../src/routes/Room.js";
import type { DuoCardView, RoomMessage, WorkspaceConnection } from "../src/workspace/matrix.js";

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const OWNER = "@ana:workspace.example";
const DUO = "@duo-ana:workspace.example";
const ASKER = "@bose:workspace.example";

function messageFor(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId" | "senderId" | "body">): RoomMessage {
  return {
    roomId: "!project-x:workspace.example",
    senderName: "",
    originServerTs: 1_700_000_000_000,
    edited: false,
    redacted: false,
    reactions: [],
    thread: null,
    threadRootEventId: null,
    replyToEventId: null,
    parts: null,
    ...over,
  };
}

function taskCard(over: Partial<DuoCardView> = {}): DuoCardView {
  return {
    cardId: "c_01J000",
    kind: "task",
    state: "acknowledged",
    taskId: "t_01J000",
    requester: ASKER,
    title: "Checking with Ana",
    lines: ["Passed to Ana. You'll get a reply here."],
    options: [],
    chosen: null,
    milestones: [],
    result: null,
    expiresAt: null,
    ...over,
  };
}

function fakeConnection(over: Partial<WorkspaceConnection> = {}): WorkspaceConnection {
  return {
    userId: OWNER,
    react: vi.fn(async () => undefined),
    unreact: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    cancel: vi.fn(),
    edit: vi.fn(async () => undefined),
    loadMedia: vi.fn(async () => null),
    getUrlPreview: vi.fn(async () => null),
    votePoll: vi.fn(async () => undefined),
    endPoll: vi.fn(async () => undefined),
    sendCardResponse: vi.fn(async () => undefined),
    ...over,
  } as unknown as WorkspaceConnection;
}

function baseProps() {
  return {
    roomId: "!project-x:workspace.example",
    refresh: vi.fn(),
    conversation: [] as readonly RoomMessage[],
    onDelete: vi.fn(),
    onReply: vi.fn(),
    onJumpToReply: vi.fn(),
    onActiveChange: vi.fn(),
  };
}

describe("W-S4-8 — the task card renders inside the duo's attributed block", () => {
  it("shows the title, the lines, and a text state chip — never colour alone", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$card1", senderId: DUO, body: "Looking into this — I'll update this message.", card: taskCard() })}
        {...baseProps()}
      />,
    );
    const duoMessage = screen.getByTestId("room-duo-message");
    const card = within(duoMessage).getByTestId("duo-card");
    expect(within(card).getByTestId("duo-card-title")).toHaveTextContent("Checking with Ana");
    expect(within(card).getByTestId("duo-card-lines")).toHaveTextContent("Passed to Ana. You'll get a reply here.");
    // The chip's own text carries the state — not a colour swatch alone.
    expect(within(card).getByTestId("duo-card-chip")).toHaveTextContent("Acknowledged");
  });

  it("renders each task state as its own text label", () => {
    const states: Array<[DuoCardView["state"], string]> = [
      ["acknowledged", "Acknowledged"],
      ["working", "Working on it"],
      ["needs_decision", "Needs a decision"],
      ["done", "Done"],
      ["failed", "Failed"],
    ];
    for (const [state, label] of states) {
      cleanup();
      render(
        <RoomEntry
          connection={fakeConnection()}
          message={messageFor({ eventId: `$card-${state}`, senderId: DUO, body: "x", card: taskCard({ state }) })}
          {...baseProps()}
        />,
      );
      expect(screen.getByTestId("duo-card-chip")).toHaveTextContent(label);
    }
  });

  it("shows up to 3 milestones, each its own line", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({
          eventId: "$card1",
          senderId: DUO,
          body: "x",
          card: taskCard({
            state: "working",
            milestones: [
              { state: "acknowledged", label: "Passed to Ana", ts: 1 },
              { state: "working", label: "Ana is looking at it", ts: 2 },
            ],
          }),
        })}
        {...baseProps()}
      />,
    );
    const milestones = screen.getAllByTestId("duo-card-milestone");
    expect(milestones).toHaveLength(2);
    expect(milestones[0]).toHaveTextContent("Passed to Ana");
    expect(milestones[1]).toHaveTextContent("Ana is looking at it");
  });

  it("shows the result text and its links once the task is done", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({
          eventId: "$card1",
          senderId: DUO,
          body: "Refunds within 30 days.",
          card: taskCard({
            state: "done",
            result: { text: "Refunds within 30 days.", links: [{ label: "Ana's reply", url: "https://matrix.to/#/!room/$event" }], files: [] },
          }),
        })}
        {...baseProps()}
      />,
    );
    const result = screen.getByTestId("duo-card-result");
    expect(result).toHaveTextContent("Refunds within 30 days.");
    expect(within(result).getByRole("link", { name: "Ana's reply" })).toHaveAttribute("href", "https://matrix.to/#/!room/$event");
  });

  it("renders with no avatar — the attribution is RoomDuoMessage's alone, never a person component inside it", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$card1", senderId: DUO, body: "x", card: taskCard() })}
        {...baseProps()}
      />,
    );
    const duoMessage = screen.getByTestId("room-duo-message");
    // RoomDuoMessage/DuoLine structurally carry no avatar prop at all
    // (AR-13) — the only visual mark is the duo Mark, never an <img> or
    // initials, and there is exactly one attribution line for this message.
    expect(within(duoMessage).queryAllByRole("img")).toHaveLength(0);
    expect(within(duoMessage).getAllByTestId("room-duo-message-attribution")).toHaveLength(1);
  });

  it("an unregistered kind falls back to the caller's plain text, not a blank card", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({
          eventId: "$card1",
          senderId: DUO,
          body: "Chosen by Ana.",
          card: taskCard({ kind: "decision", state: "chosen" }),
        })}
        {...baseProps()}
      />,
    );
    expect(screen.queryByTestId("duo-card")).toBeNull();
    expect(screen.getByTestId("room-duo-message")).toHaveTextContent("Chosen by Ana.");
  });
});
