import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState, type RefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatEditor, type ChatEditorHandle } from "../src/composer/ChatEditor.js";
import { FactCheckAssist } from "../src/composer/FactCheckAssist.js";
import { composerText, typeInto } from "./composerHelpers.js";

type FactCheckLike = { claim: string; concern: string; sourceLabel: string };

/**
 * Keeps the live composer body in React state and feeds it to
 * `FactCheckAssist`, the way `RoomComposer` actually wires the two
 * together (via `onTextChange`).
 */
function LiveHarness({ enabled, onCheck }: { enabled: boolean; onCheck: (text: string) => Promise<FactCheckLike | null> }) {
  const handle = createRef<ChatEditorHandle>();
  return <LiveHarnessInner enabled={enabled} onCheck={onCheck} handle={handle} />;
}

function LiveHarnessInner({
  enabled,
  onCheck,
  handle,
}: {
  enabled: boolean;
  onCheck: (text: string) => Promise<FactCheckLike | null>;
  handle: RefObject<ChatEditorHandle | null>;
}) {
  const [text, setText] = useState("");
  return (
    <>
      <ChatEditor
        ariaLabel="Message test"
        editorRef={handle}
        mode="markdown"
        placeholder="Message test"
        onSubmit={() => undefined}
        onTextChange={setText}
      />
      <FactCheckAssist editorRef={handle} enabled={enabled} text={text} onCheck={onCheck} />
    </>
  );
}

describe("#264 — FactCheckAssist", () => {
  it("never calls the daemon when disabled, however much is typed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCheck = vi.fn();
    render(<LiveHarness enabled={false} onCheck={onCheck} />);
    const field = screen.getByLabelText("Message test");
    typeInto(field, "let's meet Friday");
    await vi.advanceTimersByTimeAsync(2000);
    expect(onCheck).not.toHaveBeenCalled();
    expect(field.querySelector('[data-testid="fact-check-flag"]')).toBeNull();
    vi.useRealTimers();
  });

  it("debounces: a check fires once typing pauses, not on every keystroke", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCheck = vi.fn().mockResolvedValue(null);
    render(<LiveHarness enabled onCheck={onCheck} />);
    const field = screen.getByLabelText("Message test");

    typeInto(field, "Friday");
    await vi.advanceTimersByTimeAsync(200);
    expect(onCheck).not.toHaveBeenCalled();
    typeInto(field, " works");
    await vi.advanceTimersByTimeAsync(200);
    expect(onCheck).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1200);
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onCheck).toHaveBeenCalledWith("Friday works");
    vi.useRealTimers();
  });

  it("a flag lands as an underline, and never blocks typing or sending further", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCheck = vi.fn().mockResolvedValue({ claim: "Friday", concern: "The doc says Thursday.", sourceLabel: "standing order" });
    render(<LiveHarness enabled onCheck={onCheck} />);
    const field = screen.getByLabelText("Message test");

    typeInto(field, "let's meet Friday");
    await vi.advanceTimersByTimeAsync(1200);

    expect(field.querySelector('[data-testid="fact-check-flag"]')).not.toBeNull();
    // Still a perfectly ordinary, editable field — nothing about the flag disables input.
    expect(field).toHaveAttribute("contenteditable", "true");
    typeInto(field, " ok");
    expect(composerText(field)).toContain("ok");
    vi.useRealTimers();
  });

  it("hovering a flagged span shows a card with its source; leaving hides it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCheck = vi.fn().mockResolvedValue({ claim: "Friday", concern: "The doc says Thursday.", sourceLabel: "standing order: meets Thursday" });
    render(<LiveHarness enabled onCheck={onCheck} />);
    const field = screen.getByLabelText("Message test");
    typeInto(field, "let's meet Friday");
    await vi.advanceTimersByTimeAsync(1200);
    vi.useRealTimers();

    const mark = field.querySelector('[data-testid="fact-check-flag"]')!;
    fireEvent.mouseOver(mark);
    const card = await screen.findByTestId("fact-check-card");
    expect(card).toHaveTextContent("The doc says Thursday.");
    expect(card).toHaveTextContent("standing order: meets Thursday");

    fireEvent.mouseOut(mark, { relatedTarget: document.body });
    expect(screen.queryByTestId("fact-check-card")).toBeNull();
  });

  it("turning the feature off clears an existing mark", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCheck = vi.fn().mockResolvedValue({ claim: "Friday", concern: "x", sourceLabel: "y" });
    const { rerender } = render(<LiveHarness enabled onCheck={onCheck} />);
    const field = screen.getByLabelText("Message test");
    typeInto(field, "let's meet Friday");
    await vi.advanceTimersByTimeAsync(1200);
    expect(field.querySelector('[data-testid="fact-check-flag"]')).not.toBeNull();

    rerender(<LiveHarness enabled={false} onCheck={onCheck} />);
    await act(async () => undefined);
    expect(field.querySelector('[data-testid="fact-check-flag"]')).toBeNull();
    vi.useRealTimers();
  });

  it("a failed check never throws and never shows a flag", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onCheck = vi.fn().mockRejectedValue(new Error("daemon unreachable"));
    render(<LiveHarness enabled onCheck={onCheck} />);
    const field = screen.getByLabelText("Message test");
    typeInto(field, "let's meet Friday");
    await vi.advanceTimersByTimeAsync(1200);
    expect(field.querySelector('[data-testid="fact-check-flag"]')).toBeNull();
    vi.useRealTimers();
  });
});
