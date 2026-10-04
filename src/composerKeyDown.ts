import type { KeyboardEvent } from "react";

/**
 * The one Enter-to-send rule every composer textarea shares (#244): Enter
 * submits the form the field sits in — the same `requestSubmit()` call
 * ⌘/Ctrl+Enter already used, so an empty or whitespace-only question still
 * can't go out (that guard lives in each form's own `onSubmit`, re-run by
 * `requestSubmit()`, never duplicated here). Shift+Enter is left alone —
 * the browser's own newline. And an Enter that's really an IME candidate
 * pick (`isComposing`, or `keyCode === 229` for a browser that doesn't set
 * `isComposing` reliably) does nothing here either: it's confirming a
 * character, not sending a message.
 *
 * A plain function, not a hook: it only reacts to the event handed to it,
 * so every composer wires the exact same `onKeyDown={handleComposerKeyDown}`
 * and the three textareas (`Composer.tsx`, `Room.tsx`, `Thread.tsx`) can't
 * drift apart on what Enter does.
 */
export function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
  if (e.key !== "Enter" || e.shiftKey) {
    return;
  }
  if (e.nativeEvent.isComposing || e.keyCode === 229) {
    return;
  }
  e.preventDefault();
  e.currentTarget.form?.requestSubmit();
}
