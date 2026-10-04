import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { handleComposerKeyDown } from "../src/composerKeyDown.js";

/*
 * #244: the one rule every composer textarea shares, tested once against a
 * bare form so the three real composers (Composer.tsx, Room.tsx,
 * Thread.tsx) only need a thin smoke test each — see composer.test.tsx and
 * Workspace.test.tsx's "#244" describes.
 */
function renderBareComposer(onSubmit: () => void) {
  return render(
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <textarea aria-label="Message" onKeyDown={handleComposerKeyDown} />
    </form>,
  );
}

describe("#244 — handleComposerKeyDown", () => {
  it("Enter alone submits the form", () => {
    const onSubmit = vi.fn();
    renderBareComposer(onSubmit);
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter does not submit — the browser inserts a newline instead", () => {
    const onSubmit = vi.fn();
    renderBareComposer(onSubmit);
    const field = screen.getByLabelText("Message") as HTMLTextAreaElement;
    const event = fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    // The default wasn't prevented — jsdom/happy-dom still report the
    // keydown as "allowed to do its default thing" when nothing called
    // preventDefault, which is what lets the browser insert the newline.
    expect(event).toBe(true);
  });

  it("⌘-Enter and Ctrl-Enter still submit, same as plain Enter", () => {
    const onSubmit = vi.fn();
    renderBareComposer(onSubmit);
    const field = screen.getByLabelText("Message");
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("an IME candidate confirmed with Enter (isComposing) does not submit", () => {
    const onSubmit = vi.fn();
    renderBareComposer(onSubmit);
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("falls back to keyCode 229 for a browser that doesn't set isComposing reliably", () => {
    const onSubmit = vi.fn();
    renderBareComposer(onSubmit);
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("a key other than Enter does nothing", () => {
    const onSubmit = vi.fn();
    renderBareComposer(onSubmit);
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "a" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter on an empty composer does nothing beyond submitting — the form's own guard decides, not the handler", () => {
    // The handler's job is only to call requestSubmit(); whether that goes
    // anywhere is each form's own onSubmit guard (emptiness, pending,
    // reachability). Here the bare form has no such guard, so this just
    // confirms requestSubmit() re-runs onSubmit rather than, say, silently
    // doing nothing when the field is empty.
    const onSubmit = vi.fn();
    renderBareComposer(onSubmit);
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
