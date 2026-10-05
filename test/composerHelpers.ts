import { act, fireEvent } from "@testing-library/react";
import {
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
} from "lexical";
import { $composedMessage, type ComposedMessage } from "../src/composer/serialize.js";

/*
 * #248: the composers are Lexical editors now — a contenteditable, not a
 * <textarea> — so `fireEvent.change` and `toHaveValue` no longer reach
 * them. These helpers drive the editor the way a keyboard does: one
 * character per update (which is what lets Lexical's markdown shortcuts
 * and the mention typeahead see each keystroke), Shift+Enter for a new
 * line, and the real keydown path for Enter.
 */

/** The Lexical editor mounted on a composer's contenteditable. */
export function editorOf(element: HTMLElement): LexicalEditor {
  const editor = (element as HTMLElement & { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (!editor) {
    throw new Error("not a Lexical editor root");
  }
  return editor;
}

function ensureSelection(): void {
  if (!$isRangeSelection($getSelection())) {
    $getRoot().selectEnd();
  }
}

/**
 * Commits whatever the editor has queued — a markdown shortcut's transform
 * and a typeahead pick both land in a follow-up update Lexical commits on
 * the next microtask, which a keyboard never outruns but a test's very next
 * line would.
 */
export function flushEditor(element: HTMLElement): void {
  const editor = editorOf(element);
  act(() => {
    editor.update(() => undefined, { discrete: true });
  });
}

/** Types `text` at the caret, one keystroke at a time — "\n" is a Shift+Enter new line. */
export function typeInto(element: HTMLElement, text: string): void {
  typeChars(element, text);
  flushEditor(element);
}

function typeChars(element: HTMLElement, text: string): void {
  const editor = editorOf(element);
  for (const char of text) {
    act(() => {
      if (char === "\n") {
        editor.update(ensureSelection, { discrete: true });
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
        return;
      }
      editor.update(
        () => {
          ensureSelection();
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.insertText(char);
          }
        },
        { discrete: true },
      );
    });
  }
}

/** Empties the composer — the editor's own "select all, delete". */
export function clearComposer(element: HTMLElement): void {
  const editor = editorOf(element);
  act(() => {
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        root.append($createParagraphNode());
        root.selectEnd();
      },
      { discrete: true },
    );
  });
}

/** Replaces whatever the composer holds with `text` — the editor's stand-in for `fireEvent.change`. */
export function setComposer(element: HTMLElement, text: string): void {
  clearComposer(element);
  typeInto(element, text);
}

/** What the composer would send right now — its markdown source and mentions. */
export function composed(element: HTMLElement): ComposedMessage {
  flushEditor(element);
  return editorOf(element).getEditorState().read($composedMessage);
}

/** The composer's text, the editor's stand-in for a textarea's `value`. */
export function composerText(element: HTMLElement): string {
  return composed(element).body;
}

/** A real Enter keydown on the editor — modifiers as given. */
export function pressEnter(element: HTMLElement, init: KeyboardEventInit = {}): void {
  act(() => {
    fireEvent.keyDown(element, { key: "Enter", code: "Enter", keyCode: 13, ...init });
  });
  flushEditor(element);
}
