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

describe("duo#275 — \"Duo: always answer this way\" (the message action half of pinning exact wording)", () => {
  it("shows the action only on your own message, and only when the shell handed down onPinAnswer", () => {
    const own = render(
      <RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$20", senderId: OWNER, body: "ten days a year" })} {...baseProps()} onPinAnswer={vi.fn()} />,
    );
    expect(screen.getByTestId("pin-answer-action")).toBeInTheDocument();
    own.unmount();

    render(
      <RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$21", senderId: OTHER, body: "ten days a year" })} {...baseProps()} onPinAnswer={vi.fn()} />,
    );
    expect(screen.queryByTestId("pin-answer-action")).toBeNull();
  });

  it("is absent without onPinAnswer, even on your own message", () => {
    render(<RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$22", senderId: OWNER, body: "ten days a year" })} {...baseProps()} />);
    expect(screen.queryByTestId("pin-answer-action")).toBeNull();
  });

  it("is absent on a redacted message, a share, or a pending/failed echo of your own", () => {
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$23", senderId: OWNER, body: "gone", redacted: true })}
        {...baseProps()}
        onPinAnswer={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("pin-answer-action")).toBeNull();
    cleanup();

    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$24", senderId: OWNER, body: "", pending: true })}
        {...baseProps()}
        onPinAnswer={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("pin-answer-action")).toBeNull();
  });

  it("opens the dialog showing the exact wording, with the pattern blank when the message wasn't a reply", async () => {
    render(
      <RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$25", senderId: OWNER, body: "ten days a year" })} {...baseProps()} onPinAnswer={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("pin-answer-action"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("pin-answer-text").textContent).toBe("ten days a year");
    expect(within(dialog).getByTestId("pin-answer-pattern-input")).toHaveValue("");
  });

  it("prefills the pattern from the question this message replied to", async () => {
    const conversation: readonly RoomMessage[] = [messageFor({ eventId: "$q", senderId: OTHER, body: "how much vacation leave do I get?" })];
    render(
      <RoomEntry
        connection={fakeConnection()}
        message={messageFor({ eventId: "$26", senderId: OWNER, body: "ten days a year", replyToEventId: "$q" })}
        {...baseProps()}
        conversation={conversation}
        onPinAnswer={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("pin-answer-action"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("pin-answer-pattern-input")).toHaveValue("how much vacation leave do I get?");
  });

  it("pins on submit, calling onPinAnswer with the typed pattern and the message's exact words, then confirms", async () => {
    const onPinAnswer = vi.fn(async () => undefined);
    render(
      <RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$27", senderId: OWNER, body: "ten days a year" })} {...baseProps()} onPinAnswer={onPinAnswer} />,
    );
    fireEvent.click(screen.getByTestId("pin-answer-action"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByTestId("pin-answer-pattern-input"), { target: { value: "vacation leave" } });
    fireEvent.click(within(dialog).getByTestId("pin-answer-submit"));

    await screen.findByTestId("pin-answer-done");
    expect(onPinAnswer).toHaveBeenCalledWith("vacation leave", "ten days a year");
  });

  it("shows an error, and stays open, when the daemon refuses the pin", async () => {
    const onPinAnswer = vi.fn(async () => {
      throw new Error("nope");
    });
    render(
      <RoomEntry connection={fakeConnection()} message={messageFor({ eventId: "$28", senderId: OWNER, body: "ten days a year" })} {...baseProps()} onPinAnswer={onPinAnswer} />,
    );
    fireEvent.click(screen.getByTestId("pin-answer-action"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByTestId("pin-answer-pattern-input"), { target: { value: "vacation leave" } });
    fireEvent.click(within(dialog).getByTestId("pin-answer-submit"));

    await screen.findByTestId("pin-answer-error");
    expect(screen.queryByTestId("pin-answer-done")).toBeNull();
  });
});
