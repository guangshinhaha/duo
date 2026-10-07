import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomEntry } from "../src/routes/Room.js";
import type { RoomMessage, WorkspaceConnection } from "../src/workspace/matrix.js";

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

const OWNER = "@ana:workspace.example";
const OTHER = "@bose:workspace.example";

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

describe("duo#293 — a poll renders and votes", () => {
  it("renders the question, each option's own tally as a bar width, and the total — never a percentage", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({
          eventId: "$poll1",
          senderId: OTHER,
          body: "Lunch?",
          poll: {
            question: "Lunch?",
            options: [
              { id: "a", text: "Pizza", votes: 3, mine: false },
              { id: "b", text: "Sushi", votes: 1, mine: true },
            ],
            totalVotes: 4,
            closed: false,
          },
        })}
        {...baseProps()}
      />,
    );
    expect(screen.getByTestId("poll-question")).toHaveTextContent("Lunch?");
    const options = screen.getAllByTestId("poll-option");
    expect(options).toHaveLength(2);
    expect(within(options[0]!).getByTestId("poll-option-votes")).toHaveTextContent("3");
    expect(options[1]).toHaveAttribute("aria-pressed", "true"); // this account's own vote
    expect(screen.getByTestId("poll-total-votes")).toHaveTextContent("4 votes");
    // §1.6: proportions are bar widths, never a percentage sign anywhere on the card.
    expect(screen.getByTestId("room-poll").textContent).not.toContain("%");
  });

  it("clicking an option casts this account's vote", () => {
    const connection = fakeConnection();
    render(
      <RoomEntry
        connection={connection}
        message={messageFor({
          eventId: "$poll1",
          senderId: OTHER,
          body: "Lunch?",
          poll: {
            question: "Lunch?",
            options: [
              { id: "a", text: "Pizza", votes: 0, mine: false },
              { id: "b", text: "Sushi", votes: 0, mine: false },
            ],
            totalVotes: 0,
            closed: false,
          },
        })}
        {...baseProps()}
      />,
    );
    fireEvent.click(screen.getAllByTestId("poll-option")[0]!);
    expect(connection.votePoll).toHaveBeenCalledWith("!project-x:workspace.example", "$poll1", "a");
  });

  it("only the poll's own starter sees Close poll, and closing it calls endPoll", () => {
    const connection = fakeConnection();
    const poll = {
      question: "Lunch?",
      options: [{ id: "a", text: "Pizza", votes: 0, mine: false }, { id: "b", text: "Sushi", votes: 0, mine: false }],
      totalVotes: 0,
      closed: false,
    };
    const { rerender } = render(
      <RoomEntry connection={connection} message={messageFor({ eventId: "$poll1", senderId: OTHER, body: "Lunch?", poll })} {...baseProps()} />,
    );
    expect(screen.queryByTestId("poll-close")).not.toBeInTheDocument();

    rerender(<RoomEntry connection={connection} message={messageFor({ eventId: "$poll1", senderId: OWNER, body: "Lunch?", poll })} {...baseProps()} />);
    fireEvent.click(screen.getByTestId("poll-close"));
    expect(connection.endPoll).toHaveBeenCalledWith("!project-x:workspace.example", "$poll1");
  });

  it("a closed poll disables every option and says so instead of offering Close again", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({
          eventId: "$poll1",
          senderId: OWNER,
          body: "Lunch?",
          poll: {
            question: "Lunch?",
            options: [{ id: "a", text: "Pizza", votes: 2, mine: false }],
            totalVotes: 2,
            closed: true,
          },
        })}
        {...baseProps()}
      />,
    );
    expect(screen.getAllByTestId("poll-option")[0]).toBeDisabled();
    expect(screen.getByTestId("poll-total-votes")).toHaveTextContent("Closed");
    expect(screen.queryByTestId("poll-close")).not.toBeInTheDocument();
  });
});

describe("duo#294 — a voice note renders with its transcript", () => {
  it("shows the transcript under the note, and play/scrub/speed controls above it", async () => {
    render(
      <RoomEntry
        connection={fakeConnection({ loadMedia: vi.fn(async () => new Blob(["audio bytes"], { type: "audio/webm" })) })}
        message={messageFor({
          eventId: "$voice1",
          senderId: OTHER,
          body: "let's ship it tonight",
          file: {
            name: "Voice note.webm",
            mimeType: "audio/webm",
            size: 9_000,
            url: "mxc://workspace.example/voice1",
            image: false,
            audio: true,
            durationMs: 4_200,
            transcript: "let's ship it tonight",
          },
        })}
        {...baseProps()}
      />,
    );
    expect(await screen.findByTestId("voice-note-transcript")).toHaveTextContent("let's ship it tonight");
    expect(screen.getByTestId("voice-note-play")).toBeInTheDocument();
    expect(screen.getByTestId("voice-note-scrub")).toBeInTheDocument();
    expect(screen.getByTestId("voice-note-speed")).toHaveTextContent("1×");
  });

  it("a voice note with no transcript shows none — never the generated filename standing in for one", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({
          eventId: "$voice2",
          senderId: OTHER,
          body: "Voice note.webm",
          file: { name: "Voice note.webm", mimeType: "audio/webm", size: 9_000, url: "mxc://workspace.example/voice2", image: false, audio: true, durationMs: 1_000 },
        })}
        {...baseProps()}
      />,
    );
    expect(screen.queryByTestId("voice-note-transcript")).not.toBeInTheDocument();
  });

  it("an ordinary file share still renders as the generic file card, not a voice note", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({
          eventId: "$file1",
          senderId: OTHER,
          body: "deck.pdf",
          file: { name: "deck.pdf", mimeType: "application/pdf", size: 48_000, url: "mxc://workspace.example/deck1", image: false },
        })}
        {...baseProps()}
      />,
    );
    expect(screen.getByTestId("room-file-card")).toBeInTheDocument();
    expect(screen.queryByTestId("room-voice-note")).not.toBeInTheDocument();
  });
});
