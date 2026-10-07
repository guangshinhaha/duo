import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatchUpCard } from "../src/components/CatchUpCard.js";
import { catchUpAllowedForRoom } from "../src/catchUpPrefs.js";
import type { RoomMessage } from "../src/workspace/matrix.js";

function message(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId">): RoomMessage {
  return {
    roomId: "!r:workspace.example",
    senderId: "@alice:workspace.example",
    senderName: "Alice",
    body: "hi",
    parts: null,
    originServerTs: 1,
    edited: false,
    redacted: false,
    reactions: [],
    thread: null,
    threadRootEventId: null,
    ...over,
  } as RoomMessage;
}

describe("duo#280 — CatchUpCard", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("calls onCatchUp with the unread window's from/text pairs, and renders the loading state first", () => {
    const onCatchUp = vi.fn().mockReturnValue(new Promise(() => undefined));
    render(
      <CatchUpCard
        messages={[message({ eventId: "$1", senderName: "Alice", body: "how's the release going" }), message({ eventId: "$2", senderName: "Bob", body: "let's ship Friday" })]}
        onCatchUp={onCatchUp}
        onJumpToMessage={vi.fn()}
        roomId="!r:workspace.example"
      />,
    );
    expect(onCatchUp).toHaveBeenCalledWith([
      { from: "Alice", text: "how's the release going" },
      { from: "Bob", text: "let's ship Friday" },
    ]);
    expect(screen.getByTestId("catch-up-loading")).toBeInTheDocument();
  });

  it("renders bullets once the daemon answers, each clickable and jumping to its source message", async () => {
    const onCatchUp = vi.fn().mockResolvedValue({ bullets: [{ index: 1, text: "Decided to ship Friday." }], oneLine: "Ship date moved to Friday." });
    const onJumpToMessage = vi.fn();
    render(
      <CatchUpCard
        messages={[message({ eventId: "$1" }), message({ eventId: "$2" })]}
        onCatchUp={onCatchUp}
        onJumpToMessage={onJumpToMessage}
        roomId="!r:workspace.example"
      />,
    );
    const bullet = await screen.findByTestId("catch-up-bullet");
    expect(bullet).toHaveTextContent("Decided to ship Friday.");
    fireEvent.click(bullet);
    expect(onJumpToMessage).toHaveBeenCalledWith("$2");
  });

  it("falls back to the one-line gist when there are no bullets", async () => {
    const onCatchUp = vi.fn().mockResolvedValue({ bullets: [], oneLine: "Nothing much happened." });
    render(<CatchUpCard messages={[message({ eventId: "$1" })]} onCatchUp={onCatchUp} onJumpToMessage={vi.fn()} roomId="!r:workspace.example" />);
    expect(await screen.findByTestId("catch-up-one-line")).toHaveTextContent("Nothing much happened.");
  });

  it("renders nothing on a daemon failure (never a visible error over this conservative a feature)", async () => {
    const onCatchUp = vi.fn().mockRejectedValue(new Error("catch_up_unavailable"));
    const { container } = render(<CatchUpCard messages={[message({ eventId: "$1" })]} onCatchUp={onCatchUp} onJumpToMessage={vi.fn()} roomId="!r:workspace.example" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="catch-up-card"]')).toBeNull();
  });

  it("Dismiss hides the card for this unread batch, in this session", async () => {
    const onCatchUp = vi.fn().mockResolvedValue({ bullets: [], oneLine: "Nothing much happened." });
    render(<CatchUpCard messages={[message({ eventId: "$1" })]} onCatchUp={onCatchUp} onJumpToMessage={vi.fn()} roomId="!r:workspace.example" />);
    await screen.findByTestId("catch-up-one-line");
    fireEvent.click(screen.getByTestId("catch-up-dismiss"));
    expect(screen.queryByTestId("catch-up-card")).toBeNull();
  });

  it('"Turn off for this chat" persists the per-room preference and dismisses', async () => {
    localStorage.clear();
    const onCatchUp = vi.fn().mockResolvedValue({ bullets: [], oneLine: "Nothing much happened." });
    render(<CatchUpCard messages={[message({ eventId: "$1" })]} onCatchUp={onCatchUp} onJumpToMessage={vi.fn()} roomId="!r:workspace.example" />);
    await screen.findByTestId("catch-up-one-line");
    fireEvent.click(screen.getByTestId("catch-up-turn-off-room"));
    expect(screen.queryByTestId("catch-up-card")).toBeNull();
    expect(catchUpAllowedForRoom("!r:workspace.example")).toBe(false);
  });

  it("renders nothing with an empty unread window", () => {
    render(<CatchUpCard messages={[]} onCatchUp={vi.fn()} onJumpToMessage={vi.fn()} roomId="!r:workspace.example" />);
    expect(screen.queryByTestId("catch-up-card")).toBeNull();
  });
});
