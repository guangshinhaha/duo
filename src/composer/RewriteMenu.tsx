import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Sparkles } from "lucide-react";
import type { RewriteInstruction } from "../api/types.js";
import type { ChatEditorHandle } from "./ChatEditor.js";
import { REWRITE_INSTRUCTIONS, REWRITE_INSTRUCTION_LABEL } from "./rewrite.js";

/**
 * #263: "polish what you wrote yourself" — a toolbar button beside the
 * composer offering Rewrite / Shorter / Warmer / Proofread on the current
 * selection, or the whole message when nothing is selected. Mirrors Teams
 * Copilot's own Rewrite/Adjust and WhatsApp's Writing Help in the one way
 * that matters for trust: NOTHING in the composer changes until Replace
 * is clicked. The result sits beside the original the whole time, and
 * Discard leaves the composer exactly as it was.
 *
 * The editor is locked (`ChatEditorHandle.setEditable`) from the moment a
 * rewrite is requested until Replace or Discard — the range `rewriteTarget`
 * captured would otherwise go stale under a keystroke the owner made while
 * waiting on the daemon, and "the words moved while you weren't looking"
 * is a worse failure than a composer that's briefly read-only.
 *
 * ⌘J (Ctrl+J on other platforms) opens the menu when focus is anywhere
 * inside this component's own subtree — a plain DOM listener rather than
 * a Lexical command, so ChatEditor itself stays free of any rewrite-
 * specific wiring (the toolbar is a HOST of the editor, not a part of it).
 */
export function RewriteMenu({
  editorRef,
  disabled = false,
  onRewrite,
}: {
  editorRef: RefObject<ChatEditorHandle | null>;
  /** True when there's no daemon to rewrite against (no paired duo) — the button still renders, visibly disabled, rather than disappearing. */
  disabled?: boolean;
  onRewrite: (text: string, instruction: RewriteInstruction) => Promise<string>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pendingInstruction, setPendingInstruction] = useState<RewriteInstruction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ instruction: RewriteInstruction; original: string; rewritten: string } | null>(null);

  useEffect(() => {
    if (disabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j") {
        return;
      }
      const editorRoot = editorRef.current?.getRootElement();
      const focusInEditor = editorRoot?.contains(document.activeElement) ?? false;
      const focusInMenu = containerRef.current?.contains(document.activeElement) ?? false;
      if (!focusInEditor && !focusInMenu) {
        return;
      }
      event.preventDefault();
      setOpen((current) => !current);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [disabled, editorRef]);

  const request = (instruction: RewriteInstruction) => {
    const handle = editorRef.current;
    if (!handle) {
      return;
    }
    const { text } = handle.rewriteTarget();
    const trimmed = text.trim();
    setOpen(false);
    if (trimmed.length === 0) {
      return;
    }
    setError(null);
    setPendingInstruction(instruction);
    handle.setEditable(false);
    onRewrite(trimmed, instruction).then(
      (rewritten) => {
        setPendingInstruction(null);
        setResult({ instruction, original: trimmed, rewritten });
      },
      (requestError: unknown) => {
        setPendingInstruction(null);
        setError(requestError instanceof Error ? requestError.message : "Couldn't rewrite that. Try again.");
        handle.setEditable(true);
      },
    );
  };

  const replace = () => {
    if (!result) {
      return;
    }
    const handle = editorRef.current;
    handle?.applyRewrite(result.rewritten);
    handle?.setEditable(true);
    handle?.focus();
    setResult(null);
  };

  const discard = () => {
    editorRef.current?.setEditable(true);
    editorRef.current?.focus();
    setResult(null);
    setError(null);
  };

  return (
    <div className="relative" data-testid="rewrite-menu" ref={containerRef}>
      <button
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)] disabled:opacity-40"
        data-testid="rewrite-trigger"
        disabled={disabled || pendingInstruction !== null}
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <Sparkles aria-label="Polish your words" className="size-4" />
      </button>
      {open && (
        <div className="absolute bottom-full z-10 mb-1 flex flex-col gap-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] p-1" data-testid="rewrite-options" role="menu">
          {REWRITE_INSTRUCTIONS.map((instruction) => (
            <button
              className="min-h-9 rounded-[var(--r-sm)] px-2 text-left type-body text-[var(--text)] hover:bg-[var(--surface-2)]"
              data-testid={`rewrite-option-${instruction}`}
              key={instruction}
              role="menuitem"
              type="button"
              onClick={() => request(instruction)}
            >
              {REWRITE_INSTRUCTION_LABEL[instruction]}
            </button>
          ))}
        </div>
      )}
      {pendingInstruction !== null && (
        <p aria-live="polite" className="absolute bottom-full mb-1 whitespace-nowrap type-provenance text-[var(--muted)]" data-testid="rewrite-pending">
          {REWRITE_INSTRUCTION_LABEL[pendingInstruction]}…
        </p>
      )}
      {error !== null && (
        <p className="absolute bottom-full mb-1 whitespace-nowrap type-provenance text-[var(--refused)]" data-testid="rewrite-error">
          {error}
        </p>
      )}
      {result !== null && (
        <div
          aria-label={`${REWRITE_INSTRUCTION_LABEL[result.instruction]} preview`}
          className="absolute bottom-full z-10 mb-1 flex w-80 flex-col gap-2 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] p-3"
          data-testid="rewrite-preview"
          role="dialog"
        >
          <div data-testid="rewrite-before">
            <p className="type-provenance text-[var(--muted)]">Yours</p>
            <p className="type-body text-[var(--text)]">{result.original}</p>
          </div>
          <div data-testid="rewrite-after">
            <p className="type-provenance text-[var(--muted)]">{REWRITE_INSTRUCTION_LABEL[result.instruction]}</p>
            <p className="type-body text-[var(--text)]">{result.rewritten}</p>
          </div>
          <div className="flex gap-2">
            <button
              className="inline-flex min-h-9 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)]"
              data-testid="rewrite-replace"
              type="button"
              onClick={replace}
            >
              Replace
            </button>
            <button
              className="inline-flex min-h-9 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
              data-testid="rewrite-discard"
              type="button"
              onClick={discard}
            >
              Keep mine
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
