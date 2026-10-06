import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { UNDO_COMMAND } from "lexical";
import { ChatEditor, type ChatEditorHandle } from "../src/composer/ChatEditor.js";
import { RewriteMenu } from "../src/composer/RewriteMenu.js";
import { composerText, editorOf, selectText, typeInto } from "./composerHelpers.js";

/** A deferred promise, so a test can control exactly when the "daemon" answers. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderComposerWithRewrite(onRewrite: (text: string, instruction: string) => Promise<string>) {
  const handle = createRef<ChatEditorHandle>();
  render(
    <>
      <RewriteMenu editorRef={handle} onRewrite={onRewrite} />
      <ChatEditor ariaLabel="Message test" editorRef={handle} mode="markdown" placeholder="Message test" onSubmit={() => undefined} />
    </>,
  );
  return { field: screen.getByLabelText("Message test"), handle };
}

describe("#263 — RewriteMenu", () => {
  it("nothing in the composer changes until Replace is clicked", async () => {
    const { promise, resolve } = deferred<string>();
    const onRewrite = vi.fn().mockReturnValue(promise);
    const { field } = renderComposerWithRewrite(onRewrite);
    typeInto(field, "hey can u send me the doc");

    fireEvent.click(screen.getByTestId("rewrite-trigger"));
    fireEvent.click(screen.getByTestId("rewrite-option-proofread"));
    expect(onRewrite).toHaveBeenCalledWith("hey can u send me the doc", "proofread");
    // Still unchanged while the daemon "thinks".
    expect(composerText(field)).toBe("hey can u send me the doc");

    await act(async () => {
      resolve("Could you send me the document?");
      await promise;
    });

    const preview = await screen.findByTestId("rewrite-preview");
    expect(preview).toHaveTextContent("hey can u send me the doc");
    expect(preview).toHaveTextContent("Could you send me the document?");
    // Shown beside the original — the composer itself is still untouched.
    expect(composerText(field)).toBe("hey can u send me the doc");

    fireEvent.click(screen.getByTestId("rewrite-replace"));
    expect(composerText(field)).toBe("Could you send me the document?");
  });

  it("Discard (\"Keep mine\") leaves the composer exactly as it was", async () => {
    const onRewrite = vi.fn().mockResolvedValue("Shorter version.");
    const { field } = renderComposerWithRewrite(onRewrite);
    typeInto(field, "a long rambling message that goes on");

    fireEvent.click(screen.getByTestId("rewrite-trigger"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("rewrite-option-shorter"));
    });
    await screen.findByTestId("rewrite-preview");
    fireEvent.click(screen.getByTestId("rewrite-discard"));

    expect(screen.queryByTestId("rewrite-preview")).toBeNull();
    expect(composerText(field)).toBe("a long rambling message that goes on");
  });

  it("Replace is undoable — ⌘Z after Replace restores the original text", async () => {
    const onRewrite = vi.fn().mockResolvedValue("Polished.");
    const { field } = renderComposerWithRewrite(onRewrite);
    typeInto(field, "unpolished draft");

    fireEvent.click(screen.getByTestId("rewrite-trigger"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("rewrite-option-rewrite"));
    });
    await screen.findByTestId("rewrite-preview");
    fireEvent.click(screen.getByTestId("rewrite-replace"));
    expect(composerText(field)).toBe("Polished.");

    act(() => {
      editorOf(field).dispatchCommand(UNDO_COMMAND, undefined);
    });
    expect(composerText(field)).toBe("unpolished draft");
  });

  it("rewrites the current selection, not the whole message, when one exists", async () => {
    const onRewrite = vi.fn().mockResolvedValue("WORLD");
    const { field } = renderComposerWithRewrite(onRewrite);
    typeInto(field, "hello world");
    selectText(field, "world");

    fireEvent.click(screen.getByTestId("rewrite-trigger"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("rewrite-option-warmer"));
    });
    expect(onRewrite).toHaveBeenCalledWith("world", "warmer");
    fireEvent.click(await screen.findByTestId("rewrite-replace"));
    expect(composerText(field)).toBe("hello WORLD");
  });

  it("shows an error and re-enables the composer when the rewrite fails, without touching the text", async () => {
    const onRewrite = vi.fn().mockRejectedValue(new Error("daemon unreachable"));
    const { field, handle } = renderComposerWithRewrite(onRewrite);
    typeInto(field, "hi");

    fireEvent.click(screen.getByTestId("rewrite-trigger"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("rewrite-option-rewrite"));
    });

    expect(await screen.findByTestId("rewrite-error")).toHaveTextContent("daemon unreachable");
    expect(composerText(field)).toBe("hi");
    // The lock from the pending request is released on failure.
    act(() => handle.current!.setEditable(true));
    expect(field).toHaveAttribute("contenteditable", "true");
  });

  it("the trigger is disabled, not hidden, when there's no duo to rewrite with", () => {
    render(
      <RewriteMenu disabled editorRef={createRef<ChatEditorHandle>()} onRewrite={vi.fn()} />,
    );
    expect(screen.getByTestId("rewrite-trigger")).toBeDisabled();
  });
});
