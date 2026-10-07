import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomEntry, forwardedBodyOf } from "../src/routes/Room.js";
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
    pin: vi.fn(async () => undefined),
    unpin: vi.fn(async () => undefined),
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
 * #292: forward, pin and select — a message's own actions, following
 * #252's exact "one list, rendered two ways" pattern the rest of the
 * row's verbs already use. `RoomEntry` is exported and tested directly,
 * with no router or Matrix-seam scaffolding.
 */
describe("#292 — forwardedBodyOf", () => {
  it("says who it's from and where it came from, over the original words — never a claim the forwarder wrote it", () => {
    const message = messageFor({ eventId: "$1", senderId: OTHER, body: "refunds within 30 days" });
    expect(forwardedBodyOf(message, "Bose", "project-x")).toBe("Forwarded from Bose in project-x:\nrefunds within 30 days");
  });
});

describe("#292 — Forward", () => {
  it("shows on any message, own or not, when the shell hands down onForward", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" })}
        onForward={vi.fn()}
        {...baseProps()}
      />,
    );
    expect(within(screen.getByTestId("room-message")).getByTestId("forward-action")).toBeInTheDocument();
  });

  it("is absent without onForward, and absent on a redacted, pending or failed message", () => {
    const { rerender } = render(
      <RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" })} {...baseProps()} />,
    );
    expect(screen.queryByTestId("forward-action")).toBeNull();

    rerender(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "", redacted: true })}
        onForward={vi.fn()}
        {...baseProps()}
      />,
    );
    expect(screen.queryByTestId("forward-action")).toBeNull();

    rerender(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it", pending: true })}
        onForward={vi.fn()}
        {...baseProps()}
      />,
    );
    expect(screen.queryByTestId("forward-action")).toBeNull();

    rerender(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it", failed: true })}
        onForward={vi.fn()}
        {...baseProps()}
      />,
    );
    expect(screen.queryByTestId("forward-action")).toBeNull();
  });

  it("clicking it hands the message itself to onForward — Room owns the room-picker dialog, not this row", () => {
    const onForward = vi.fn();
    const message = messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" });
    render(<RoomEntry connection={fakeConnection()} message={message} onForward={onForward} {...baseProps()} />);
    fireEvent.click(within(screen.getByTestId("room-message")).getByTestId("forward-action"));
    expect(onForward).toHaveBeenCalledWith(message);
  });
});

describe("#292 — Pin / Unpin", () => {
  it("is absent without canPin, even on an eligible message", () => {
    render(
      <RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" })} {...baseProps()} />,
    );
    expect(screen.queryByTestId("pin-action")).toBeNull();
    expect(screen.queryByTestId("unpin-action")).toBeNull();
  });

  it("reads \"Pin to conversation\" when not pinned, and calls connection.pin with this event", async () => {
    const connection = fakeConnection();
    render(
      <RoomEntry
        canPin
        connection={connection}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" })}
        {...baseProps()}
      />,
    );
    const action = within(screen.getByTestId("room-message")).getByTestId("pin-action");
    expect(action.textContent).toBe("Pin to conversation");
    fireEvent.click(action);
    await waitFor(() => expect(connection.pin).toHaveBeenCalledWith("!project-x:workspace.example", "$1"));
  });

  it("reads \"Unpin\" when already pinned, and calls connection.unpin", async () => {
    const connection = fakeConnection();
    render(
      <RoomEntry
        canPin
        connection={connection}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" })}
        pinned
        {...baseProps()}
      />,
    );
    const action = within(screen.getByTestId("room-message")).getByTestId("unpin-action");
    expect(action.textContent).toBe("Unpin");
    fireEvent.click(action);
    await waitFor(() => expect(connection.unpin).toHaveBeenCalledWith("!project-x:workspace.example", "$1"));
  });

  it("is absent on a redacted, pending or failed message even with canPin", () => {
    const { rerender } = render(
      <RoomEntry
        canPin
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "", redacted: true })}
        {...baseProps()}
      />,
    );
    expect(screen.queryByTestId("pin-action")).toBeNull();

    rerender(
      <RoomEntry
        canPin
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it", pending: true })}
        {...baseProps()}
      />,
    );
    expect(screen.queryByTestId("pin-action")).toBeNull();
  });
});

describe("#292 — Select", () => {
  it("shows on any eligible message when the shell hands down onEnterSelection, and starts selection with this message", () => {
    const onEnterSelection = vi.fn();
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" })}
        onEnterSelection={onEnterSelection}
        {...baseProps()}
      />,
    );
    fireEvent.click(within(screen.getByTestId("room-message")).getByTestId("select-action"));
    expect(onEnterSelection).toHaveBeenCalledWith("$1");
  });

  it("while selecting, a checkbox stands in for the row's own verbs — no action menu, no sheet trigger", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" })}
        onEnterSelection={vi.fn()}
        onToggleSelect={vi.fn()}
        selecting
        {...baseProps()}
      />,
    );
    const row = screen.getByTestId("room-message");
    expect(within(row).getByTestId("room-message-select-checkbox")).toBeInTheDocument();
    expect(within(row).queryByTestId("room-message-actions")).toBeNull();
    expect(within(row).queryByTestId("room-message-actions-trigger")).toBeNull();
  });

  it("the checkbox reflects `selected`, and toggling it calls onToggleSelect with this event", () => {
    const onToggleSelect = vi.fn();
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" })}
        onToggleSelect={onToggleSelect}
        selected
        selecting
        {...baseProps()}
      />,
    );
    const checkbox = within(screen.getByTestId("room-message")).getByTestId("room-message-select-checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(onToggleSelect).toHaveBeenCalledWith("$1");
  });
});
