import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomEntry } from "../src/routes/Room.js";
import type { RoomMessage, WorkspaceConnection } from "../src/workspace/matrix.js";

afterEach(() => {
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

function fakeConnection(): WorkspaceConnection {
  return {
    userId: OWNER,
    react: vi.fn(async () => undefined),
    unreact: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    cancel: vi.fn(),
    edit: vi.fn(async () => undefined),
    loadMedia: vi.fn(async () => null),
    getUrlPreview: vi.fn(async () => null),
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

/*
 * #286: sending → sent → read on this device's own messages only —
 * `pending`/`failed` already had their own ticks (#209); this is the rest
 * of the tri-state, plus AC2's "who has read, collapsed past a few."
 */
describe("#286 — delivery and read state render on a message's own row", () => {
  it("a confirmed own message with nobody's receipt past it yet reads 'Sent'", () => {
    render(
      <RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$1", senderId: OWNER, body: "on it", readState: "sent" })} {...baseProps()} />,
    );
    const row = screen.getByTestId("room-message");
    expect(within(row).getByTestId("room-message-sent")).toHaveTextContent("Sent");
    expect(within(row).queryByTestId("room-message-read")).toBeNull();
  });

  it("once read, says so, and names who — collapsed past a few", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({
          eventId: "$2",
          senderId: OWNER,
          body: "ship it",
          readState: "read",
          readBy: [
            { userId: "@bose:workspace.example", name: "Bose" },
            { userId: "@carol:workspace.example", name: "Carol" },
            { userId: "@dan:workspace.example", name: "Dan" },
            { userId: "@erin:workspace.example", name: "Erin" },
          ],
        })}
        {...baseProps()}
      />,
    );
    const row = screen.getByTestId("room-message");
    expect(within(row).getByTestId("room-message-read")).toHaveTextContent("Read");
    expect(within(row).getByTestId("room-message-read-by")).toHaveTextContent("Bose, Carol, Dan +1");
    expect(within(row).queryByTestId("room-message-sent")).toBeNull();
  });

  it("a one-reader read names them without any collapsing", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$3", senderId: OWNER, body: "np", readState: "read", readBy: [{ userId: OTHER, name: "Bose" }] })}
        {...baseProps()}
      />,
    );
    expect(screen.getByTestId("room-message-read-by")).toHaveTextContent("Bose");
  });

  it("a pending or failed send shows its existing tick, never a delivery state on top of it", () => {
    render(<RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$4", senderId: OWNER, body: "offline", pending: true })} {...baseProps()} />);
    const row = screen.getByTestId("room-message");
    expect(within(row).getByTestId("room-message-pending")).toBeInTheDocument();
    expect(within(row).queryByTestId("room-message-sent")).toBeNull();
    expect(within(row).queryByTestId("room-message-read")).toBeNull();
  });

  it("carries no tick at all on anyone else's message — a member never sees a delivery state on words they didn't send", () => {
    render(<RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$5", senderId: OTHER, body: "what's our refund policy?" })} {...baseProps()} />);
    const row = screen.getByTestId("room-message");
    expect(within(row).queryByTestId("room-message-sent")).toBeNull();
    expect(within(row).queryByTestId("room-message-read")).toBeNull();
  });
});
