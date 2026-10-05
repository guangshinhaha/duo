import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

/** Makes `useTouchPrimary` (src/shell/useMediaQuery.ts) read as a touch-first device: coarse pointer, no hover, no fine pointer alongside it. */
function stubTouchPrimary(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia,
  );
}

/*
 * #252: the permanent action row (React, Reply in thread, Copy link, Reply,
 * Edit, Delete) becomes a hover/keyboard-focus toolbar on a pointer device,
 * and a long-press sheet on a touch one — never both shown, and never gone
 * from a keyboard either way. `RoomEntry` is exported (the same move
 * `MessageBody` already made for #213) so these render it directly, with no
 * router or Matrix-seam scaffolding: it's a pure function of its props.
 */
describe("#252 — desktop: a hover/focus toolbar, not a permanent row", () => {
  it("the toolbar is hidden until the row is hovered, and hides again on leave", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$1", senderId: OTHER, body: "ship it" })}
        {...baseProps()}
      />,
    );
    const row = screen.getByTestId("room-message");
    const toolbar = () => within(row).getByTestId("room-message-actions");

    expect(toolbar().className).toContain("opacity-0");
    expect(toolbar().className).not.toContain("opacity-100");

    fireEvent.mouseEnter(row);
    expect(toolbar().className).toContain("opacity-100");

    fireEvent.mouseLeave(row);
    expect(toolbar().className).toContain("opacity-0");
  });

  it("a keyboard reaches the same buttons without ever hovering — focusing one reveals the toolbar, and it's a real, clickable button throughout", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$2", senderId: OWNER, body: "the policy doc says 30 days" })}
        {...baseProps()}
      />,
    );
    const row = screen.getByTestId("room-message");
    const editButton = within(row).getByRole("button", { name: "Edit" });

    // Never hidden from the DOM or from AT — only dimmed for an eye that
    // hasn't hovered or focused it yet (tokens.css's own law: a pointer
    // click never summons a focus ring, but Tab always finds the control).
    expect(within(row).getByTestId("room-message-actions").className).toContain("opacity-0");

    fireEvent.focus(editButton);
    expect(within(row).getByTestId("room-message-actions").className).toContain("opacity-100");

    fireEvent.click(editButton);
    expect(within(row).getByTestId("room-message-edit")).toBeInTheDocument();

    fireEvent.blur(editButton, { relatedTarget: document.body });
    // Still visible: an edit in progress counts as "active", same as the
    // existing onActiveChange rule for the virtualizer keeping it mounted.
    expect(within(row).getByTestId("room-message-actions").className).toContain("opacity-100");
  });

  it("tabbing between two of the row's own buttons never flickers the toolbar closed", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$3", senderId: OWNER, body: "sure thing" })}
        {...baseProps()}
      />,
    );
    const row = screen.getByTestId("room-message");
    const react = within(row).getByRole("button", { name: "React" });
    const edit = within(row).getByRole("button", { name: "Edit" });

    fireEvent.focus(react);
    expect(within(row).getByTestId("room-message-actions").className).toContain("opacity-100");

    // Moving focus to a sibling inside the same row: blur names the new
    // target as `relatedTarget`, which is still inside the row.
    fireEvent.blur(react, { relatedTarget: edit });
    fireEvent.focus(edit);
    expect(within(row).getByTestId("room-message-actions").className).toContain("opacity-100");
  });

  it("stays visible while the reaction picker it opened is still open, even once the mouse has left the row", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$4", senderId: OTHER, body: "nice" })}
        {...baseProps()}
      />,
    );
    const row = screen.getByTestId("room-message");
    fireEvent.mouseEnter(row);
    fireEvent.click(within(row).getByRole("button", { name: "React" }));
    expect(within(row).getByTestId("reaction-picker")).toBeInTheDocument();

    fireEvent.mouseLeave(row);
    // The picker it opened is still live — #252's "an open menu or picker
    // counts as active" rule, read through the same `onActiveChange` #248
    // already uses to keep a mid-edit row mounted off screen.
    expect(within(row).getByTestId("room-message-actions").className).toContain("opacity-100");
    expect(within(row).getByTestId("reaction-picker")).toBeInTheDocument();
  });

  it("Edit and Delete show only on your own message — someone else's carries React, Reply in thread, Copy link and Reply, nothing that changes or removes their words", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$5", senderId: OTHER, body: "not mine" })}
        {...baseProps()}
      />,
    );
    const row = screen.getByTestId("room-message");
    expect(within(row).getByRole("button", { name: "React" })).toBeInTheDocument();
    expect(within(row).getByText("Reply in thread")).toBeInTheDocument();
    expect(within(row).getByTestId("room-message-copy-link")).toBeInTheDocument();
    expect(within(row).getByTestId("reply-action")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("#252 — touch: a long-press sheet, not a permanent row or a tap", () => {
  it("a quick tap does nothing — no sheet opens", () => {
    stubTouchPrimary();
    vi.useFakeTimers();
    try {
      render(
        <RoomEntry
          connection={fakeConnection()}
          message={messageFor({ eventId: "$6", senderId: OWNER, body: "quick tap" })}
          {...baseProps()}
        />,
      );
      const bubble = screen.getByTestId("room-message-bubble");
      const base = { pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 10 };
      fireEvent.pointerDown(bubble, base);
      fireEvent.pointerUp(bubble, base);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a long press opens the same actions as a sheet, with Edit/Delete for your own message", () => {
    stubTouchPrimary();
    vi.useFakeTimers();
    try {
      render(
        <RoomEntry
          connection={fakeConnection()}
          message={messageFor({ eventId: "$7", senderId: OWNER, body: "hold me" })}
          {...baseProps()}
        />,
      );
      const bubble = screen.getByTestId("room-message-bubble");
      fireEvent.pointerDown(bubble, { pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const menu = screen.getByRole("menu");
      expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "React",
        "Reply in thread",
        "Copy link",
        "Reply",
        "Edit",
        "Delete",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a hold that drifts like a scroll before the timer fires never opens the sheet", () => {
    stubTouchPrimary();
    vi.useFakeTimers();
    try {
      render(
        <RoomEntry
          connection={fakeConnection()}
          message={messageFor({ eventId: "$8", senderId: OWNER, body: "scrolling past" })}
          {...baseProps()}
        />,
      );
      const bubble = screen.getByTestId("room-message-bubble");
      fireEvent.pointerDown(bubble, { pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(bubble, { pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 60 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a keyboard reaches the sheet too, through a trigger that's invisible until it's focused", async () => {
    stubTouchPrimary();
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$9", senderId: OWNER, body: "from a keyboard" })}
        {...baseProps()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Message actions" });
    expect(trigger.className).toContain("sr-only");
    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").length).toBeGreaterThan(0);
  });

  it("Edit/Delete are absent from the sheet for someone else's message", () => {
    stubTouchPrimary();
    vi.useFakeTimers();
    try {
      render(
        <RoomEntry
          connection={fakeConnection()}
          message={messageFor({ eventId: "$10", senderId: OTHER, body: "not mine either" })}
          {...baseProps()}
        />,
      );
      const bubble = screen.getByTestId("room-message-bubble");
      fireEvent.pointerDown(bubble, { pointerId: 1, pointerType: "touch", button: 0, clientX: 10, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      const menu = screen.getByRole("menu");
      const labels = within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent);
      expect(labels).not.toContain("Edit");
      expect(labels).not.toContain("Delete");
    } finally {
      vi.useRealTimers();
    }
  });
});
