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
 * duo#299: "Save to Later" — a message's own action, the same "one list,
 * rendered two ways" shape (#252) every other row verb here follows, and
 * the same optional-callback convention #292's own Forward action takes
 * (`RoomForwardPinSelect.test.tsx`'s own tests, mirrored here): `Room`
 * owns the reminder dialog, this row only ever hands the message up.
 */
describe("duo#299 — Save to Later (the message action)", () => {
  it("shows on any message, own or not, when the shell hands down onSaveLater", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" })}
        onSaveLater={vi.fn()}
        {...baseProps()}
      />,
    );
    expect(within(screen.getByTestId("room-message")).getByTestId("save-later-action")).toBeInTheDocument();
  });

  it("is absent without onSaveLater, and absent on a redacted, pending or failed message", () => {
    const { rerender } = render(
      <RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" })} {...baseProps()} />,
    );
    expect(screen.queryByTestId("save-later-action")).toBeNull();

    rerender(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "", redacted: true })}
        onSaveLater={vi.fn()}
        {...baseProps()}
      />,
    );
    expect(screen.queryByTestId("save-later-action")).toBeNull();

    rerender(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it", pending: true })}
        onSaveLater={vi.fn()}
        {...baseProps()}
      />,
    );
    expect(screen.queryByTestId("save-later-action")).toBeNull();

    rerender(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it", failed: true })}
        onSaveLater={vi.fn()}
        {...baseProps()}
      />,
    );
    expect(screen.queryByTestId("save-later-action")).toBeNull();
  });

  it("shows on the owner's own message too — saving your own words for later is as much the point", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OWNER, body: "sure thing" })}
        onSaveLater={vi.fn()}
        {...baseProps()}
      />,
    );
    expect(within(screen.getByTestId("room-message")).getByTestId("save-later-action")).toBeInTheDocument();
  });

  it("clicking it hands the message itself to onSaveLater — Room owns the reminder dialog, not this row", () => {
    const onSaveLater = vi.fn();
    const message = messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" });
    render(<RoomEntry connection={fakeConnection()} message={message} onSaveLater={onSaveLater} {...baseProps()} />);

    within(screen.getByTestId("room-message")).getByTestId("save-later-action").click();

    expect(onSaveLater).toHaveBeenCalledWith(message);
  });
});
