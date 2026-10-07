import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Ref } from "react";
import { createPortal } from "react-dom";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { LexicalTypeaheadMenuPlugin, MenuOption, type MenuTextMatch } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { ListItemNode, ListNode } from "@lexical/list";
import {
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  ORDERED_LIST,
  STRIKETHROUGH,
  UNORDERED_LIST,
  type Transformer,
} from "@lexical/markdown";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  COMMAND_PRIORITY_NORMAL,
  DROP_COMMAND,
  FORMAT_TEXT_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  KEY_ENTER_COMMAND,
  PASTE_COMMAND,
  type EditorThemeClasses,
  type LexicalEditor,
  type TextNode,
} from "lexical";
import { mergeRegister } from "@lexical/utils";
import { $applyFactCheckMark, $clearFactCheckMarks, FactCheckNode } from "./FactCheckNode.js";
import { $createMentionNode, MentionNode } from "./MentionNode.js";
import { mentionOffer, mentionTokenBeforeCaret, type MentionCandidate } from "./mentionOffer.js";
import { slashCommandOffer, slashCommandTokenBeforeCaret, type SlashCommand } from "./slashCommandOffer.js";
import { $composedMessage, type ComposedMessage } from "./serialize.js";
import { enterSends } from "./enterSends.js";

/**
 * #248: the one editor every composer in the app is built on — Lexical (MIT,
 * Meta) in place of the three hand-rolled `<textarea>`s Room, Thread and the
 * duo's ask box each carried. What each composer kept re-implementing now
 * lives here once:
 *
 * - **Enter sends** (#244): Enter submits, Shift+Enter starts a new line,
 *   ⌘/Ctrl+Enter also submits; on a touch-first device Enter is a new line
 *   and the Send button sends. Never while an IME is composing — Lexical
 *   doesn't dispatch keys mid-composition at all, and the Safari tail (the
 *   confirming Enter arriving as keyCode 229) is swallowed below.
 * - **Mentions** (#65/#216): an "@" opens the typeahead over the room's
 *   members — #65's own candidates and matching, now with ↑/↓/Enter/Tab as
 *   well as a click — and a pick lands as a `MentionNode` token.
 * - **Slash commands** (duo#301): a "/" at the very start of an otherwise
 *   empty message opens a second typeahead, over `SLASH_COMMANDS`
 *   (`slashCommandOffer.ts`). A pick calls `onSlashCommandPick` and empties
 *   the editor — a command is dispatched, never left behind as text, the
 *   same way a mention pick lands a token rather than nothing. Typing a
 *   full command and pressing Enter without ever opening the menu reaches
 *   the same dispatch, from the host's own submit handler (`Room.tsx`),
 *   which also owns the one case this plugin never sees: a "/"-shaped word
 *   nobody recognises, sent as plain text only after the member confirms.
 * - **Markdown** (#216): in `markdown` mode the live shortcuts style
 *   `**bold**`, `*italic*`, `~~struck~~`, `` `code` `` and `- `/`1. ` lists
 *   as they're typed; `serialize.ts` writes the same markdown back out for
 *   the send path, which still turns it into `formatted_body` exactly as
 *   before (`markdown.ts`). `plain` mode is the bare text, for composers
 *   whose send path carries no formatting.
 * - **Paste/drop** (#217): a pasted file goes to `onFiles` — the composer's
 *   own `stage()` — never into the editor as inline content; pasted words
 *   always arrive as plain text (foreign rich text would otherwise import
 *   headings and tables this composer can't send). A dropped file is left
 *   to the composer's own drop zone, which already stages it.
 * - **Rewrite** (#263): `rewriteTarget`/`applyRewrite` are the two
 *   primitives a host's own toolbar (`RewriteMenu.tsx`) needs to read the
 *   selection-or-whole-document and, later, replace exactly that range —
 *   every other concern (the daemon call, the before/after panel, the
 *   Replace button) lives outside this component entirely.
 * - **Fact-check** (#264): `applyFactCheck` lands or clears the daemon's
 *   at-most-one flag as an underline (`FactCheckNode.ts`); the debounce
 *   and the daemon call live in `FactCheckAssist.tsx`, outside this file.
 */

export interface ChatEditorHandle {
  /** The message as it stands — markdown source plus mentions, in document order. */
  read(): ComposedMessage;
  /** Empties the editor (after a send). */
  clear(): void;
  focus(): void;
  /** #263: toggles whether the editor accepts input — used to lock it while a rewrite is pending or its before/after panel is open, so the range `applyRewrite` replaces can never go stale underneath it. */
  setEditable(editable: boolean): void;
  /** #263: the editor's own root DOM element, for a host that needs to attach listeners to it directly (`FactCheckAssist.tsx`'s hover/focus detection) without reaching into Lexical internals. */
  getRootElement(): HTMLElement | null;
  /** #263: the text a rewrite acts on — the current selection if one is non-empty, else the whole document — and records which of the two `applyRewrite` will replace. */
  rewriteTarget(): { text: string; hasSelection: boolean };
  /** #263: replaces exactly the range `rewriteTarget` last captured with plain text — one undoable editor step, so ⌘Z after Replace restores the original. */
  applyRewrite(text: string): void;
  /** #264: clears any existing fact-check mark, then — when `flag` is given and its claim can be isolated within one existing text run — places a new one. Pass `null` to only clear (e.g. the owner edited, or the feature was turned off). */
  applyFactCheck(flag: { claim: string; concern: string; sourceLabel: string } | null): void;
}

/** The live shortcuts a member gets in `markdown` mode — #216's scope: bold, italic, inline code, lists, plus GFM strikethrough (`markdown.ts` renders it, `sanitizeMatrixHtml.ts` allows `del`). */
const MARKDOWN_SHORTCUTS: Transformer[] = [
  UNORDERED_LIST,
  ORDERED_LIST,
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  STRIKETHROUGH,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
];

/** The formats `serialize.ts` can write back as markdown — the keyboard's ⌘B/⌘I land; ⌘U (no markdown for it) doesn't, rather than show a style the message won't carry. */
const SENDABLE_FORMATS = new Set(["bold", "italic", "strikethrough", "code"]);

const THEME: EditorThemeClasses = {
  paragraph: "m-0",
  text: {
    italic: "italic",
    strikethrough: "line-through",
    code: "rounded-[var(--r-sm)] bg-[var(--surface-2)] px-1 font-mono",
  },
  list: {
    ul: "m-0 list-disc pl-5",
    ol: "m-0 list-decimal pl-5",
    listitem: "",
    nested: { listitem: "list-none" },
  },
};

/** The text a fresh editor starts with — lines become line breaks inside one paragraph (the duo ask box's buffered question, #27). */
function initialStateOf(text: string): ((editor: LexicalEditor) => void) | undefined {
  if (text.length === 0) {
    return undefined;
  }
  return () => {
    const paragraph = $createParagraphNode();
    text.split("\n").forEach((line, index) => {
      if (index > 0) {
        paragraph.append($createLineBreakNode());
      }
      if (line.length > 0) {
        paragraph.append($createTextNode(line));
      }
    });
    $getRoot().append(paragraph);
  };
}

/** Enter/Shift+Enter/⌘-Enter, paste, formats — the key and clipboard half of the composer. */
function ComposerKeysPlugin({
  onSubmit,
  onFiles,
}: {
  onSubmit: () => void;
  onFiles?: (files: File[]) => void;
}) {
  const [editor] = useLexicalComposerContext();
  // Held in refs so a parent's fresh closure each render never re-registers
  // the commands mid-keystroke.
  const submit = useRef(onSubmit);
  const files = useRef(onFiles);
  useEffect(() => {
    submit.current = onSubmit;
    files.current = onFiles;
  });

  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          KEY_ENTER_COMMAND,
          (event) => {
            // A null event is Lexical's own synthesized Enter (an IME
            // committing a trailing newline): leave it to the editor.
            if (event === null) {
              return false;
            }
            // Safari delivers the Enter that confirms an IME candidate as
            // keyCode 229 once composition has already ended — that Enter
            // chose a word, it neither sends nor starts a line.
            if (event.isComposing || event.keyCode === 229) {
              event.preventDefault();
              return true;
            }
            const modified = event.metaKey || event.ctrlKey;
            if (modified || (!event.shiftKey && enterSends())) {
              event.preventDefault();
              submit.current();
              return true;
            }
            // Shift+Enter (or Enter on a touch keyboard): a new line — a new
            // paragraph, so inside a list it's the next item, and on an empty
            // item it leaves the list, the way every editor does.
            event.preventDefault();
            editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
            return true;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          PASTE_COMMAND,
          (event) => {
            const clipboard = "clipboardData" in event ? event.clipboardData : null;
            if (!clipboard) {
              return false;
            }
            const pasted = [...(clipboard.files ?? [])];
            if (pasted.length > 0) {
              files.current?.(pasted);
            }
            const text = typeof clipboard.getData === "function" ? clipboard.getData("text/plain") : "";
            if (text.length > 0) {
              editor.update(() => {
                if (!$isRangeSelection($getSelection())) {
                  $getRoot().selectEnd();
                }
                const selection = $getSelection();
                if ($isRangeSelection(selection)) {
                  selection.insertRawText(text);
                }
              });
            }
            if (pasted.length > 0 || text.length > 0) {
              event.preventDefault();
              return true;
            }
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          DROP_COMMAND,
          (event) => {
            // A dropped file belongs to the composer's own drop zone (the
            // form around this editor stages it — one path for every drop);
            // the editor only has to keep the browser from opening it and
            // keep itself from inserting it.
            if ((event.dataTransfer?.files.length ?? 0) > 0) {
              event.preventDefault();
              return true;
            }
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(FORMAT_TEXT_COMMAND, (format) => !SENDABLE_FORMATS.has(format), COMMAND_PRIORITY_LOW),
      ),
    [editor],
  );
  return null;
}

/** Reports the composed body upward on every change — the composer's "is there anything to send?" */
function ChangePlugin({ onChange }: { onChange?: (body: string) => void }) {
  const [editor] = useLexicalComposerContext();
  const last = useRef<string | null>(null);
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  });
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        const body = editorState.read(() => $composedMessage().body);
        if (body !== last.current) {
          last.current = body;
          change.current?.(body);
        }
      }),
    [editor],
  );
  return null;
}

/** What the editor replaces when a rewrite is applied — captured by `rewriteTarget()`, consumed once by `applyRewrite()`. `null` means nothing has been captured (or the editor regained focus on a fresh target since) — `applyRewrite` then does nothing rather than guess. */
type RewriteRange =
  | { readonly kind: "selection"; readonly anchorKey: string; readonly anchorOffset: number; readonly focusKey: string; readonly focusOffset: number }
  | { readonly kind: "all" };

/** The imperative half the composer's form (and #263/#264's assist components) drive: read on submit, clear after, focus after a pick, plus the rewrite and fact-check primitives. */
function HandlePlugin({ handleRef }: { handleRef?: Ref<ChatEditorHandle> }) {
  const [editor] = useLexicalComposerContext();
  const rewriteRange = useRef<RewriteRange | null>(null);
  useImperativeHandle(
    handleRef,
    () => ({
      read: () => editor.getEditorState().read($composedMessage),
      clear: () => {
        editor.update(
          () => {
            const root = $getRoot();
            root.clear();
            root.append($createParagraphNode());
            root.selectStart();
          },
          { discrete: true },
        );
      },
      focus: () => editor.focus(),
      setEditable: (editable) => editor.setEditable(editable),
      getRootElement: () => editor.getRootElement(),
      rewriteTarget: () => {
        let result = { text: "", hasSelection: false };
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection) && !selection.isCollapsed()) {
            rewriteRange.current = {
              kind: "selection",
              anchorKey: selection.anchor.key,
              anchorOffset: selection.anchor.offset,
              focusKey: selection.focus.key,
              focusOffset: selection.focus.offset,
            };
            result = { text: selection.getTextContent(), hasSelection: true };
          } else {
            rewriteRange.current = { kind: "all" };
            result = { text: $composedMessage().body.trim(), hasSelection: false };
          }
        });
        return result;
      },
      applyRewrite: (text) => {
        editor.update(() => {
          const target = rewriteRange.current;
          if (target?.kind === "selection") {
            const anchorNode = $getNodeByKey(target.anchorKey);
            const focusNode = $getNodeByKey(target.focusKey);
            if (anchorNode && focusNode) {
              const range = $createRangeSelection();
              range.anchor.set(target.anchorKey, target.anchorOffset, "text");
              range.focus.set(target.focusKey, target.focusOffset, "text");
              $setSelection(range);
              range.insertText(text);
              return;
            }
            // The captured nodes are gone (shouldn't happen — the editor
            // is locked via setEditable while a rewrite is in flight —
            // but falling through to a whole-document replace is still
            // correct, never a thrown error over a stale key.
          }
          const root = $getRoot();
          root.clear();
          const paragraph = $createParagraphNode();
          text.split("\n").forEach((line, index) => {
            if (index > 0) {
              paragraph.append($createLineBreakNode());
            }
            if (line.length > 0) {
              paragraph.append($createTextNode(line));
            }
          });
          root.append(paragraph);
          root.selectEnd();
        });
        rewriteRange.current = null;
      },
      applyFactCheck: (flag) => {
        $clearFactCheckMarks(editor);
        if (flag) {
          $applyFactCheckMark(editor, flag.claim, flag.concern, flag.sourceLabel);
        }
      },
    }),
    [editor],
  );
  return null;
}

class MentionOption extends MenuOption {
  readonly candidate: MentionCandidate;
  constructor(candidate: MentionCandidate) {
    super(candidate.userId);
    this.candidate = candidate;
  }
}

/** #65 on Lexical's typeahead: the offer, its matching, and the pick landing as a `MentionNode`. */
function MentionsPlugin({ candidates, menuParent }: { candidates: readonly MentionCandidate[]; menuParent: HTMLElement }) {
  const [editor] = useLexicalComposerContext();
  const [fragment, setFragment] = useState<string | null>(null);
  const options = useMemo(
    () => (fragment === null ? [] : mentionOffer(candidates, fragment).map((candidate) => new MentionOption(candidate))),
    [candidates, fragment],
  );
  const triggerFn = useCallback((text: string): MenuTextMatch | null => {
    const token = mentionTokenBeforeCaret(text);
    return token === null ? null : { leadOffset: token.leadOffset, matchingString: token.fragment, replaceableString: token.token };
  }, []);
  const onSelectOption = useCallback(
    (option: MentionOption, nodeToReplace: TextNode | null, closeMenu: () => void) => {
      editor.update(() => {
        const mention = $createMentionNode(option.candidate.userId, option.candidate.label);
        if (nodeToReplace) {
          nodeToReplace.replace(mention);
        } else {
          $getSelection()?.insertNodes([mention]);
        }
        // The pick lands with its trailing space, the caret after it — the
        // same "@carol's duo " the textarea's pick used to leave.
        const space = $createTextNode(" ");
        mention.insertAfter(space);
        space.select(1, 1);
        closeMenu();
      });
      editor.focus();
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin<MentionOption>
      // Above the Enter-sends handler (LOW), so Enter with the offer open
      // picks rather than sends.
      commandPriority={COMMAND_PRIORITY_NORMAL}
      // The menu's anchor lives inside the composer (not at the caret, not
      // in document.body) and stays in its flow, where the offer has always
      // sat — under the input row.
      anchorClassName="static! h-auto! w-auto!"
      parent={menuParent}
      options={options}
      triggerFn={triggerFn}
      onQueryChange={setFragment}
      onSelectOption={onSelectOption}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorElementRef.current && options.length > 0
          ? createPortal(
              <div className="mt-2 flex flex-col gap-1" data-testid="mention-offer">
                {options.map((option, index) => (
                  <button
                    aria-selected={selectedIndex === index}
                    className={`inline-flex min-h-11 items-center gap-2 self-start rounded-[var(--r-sm)] border bg-[var(--surface-2)] px-2 type-body ${
                      selectedIndex === index ? "border-[var(--accent)]" : "border-[var(--edge)]"
                    }`}
                    data-testid="mention-option"
                    id={`typeahead-item-${index}`}
                    key={option.key}
                    ref={option.setRefElement}
                    role="option"
                    tabIndex={-1}
                    type="button"
                    // Keep the caret in the editor: the pick happens there.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => {
                      setHighlightedIndex(index);
                      selectOptionAndCleanUp(option);
                    }}
                  >
                    <span
                      aria-hidden="true"
                      className="rounded-full border border-[var(--edge)] px-2 type-provenance text-[var(--muted)]"
                      data-testid="mention-kind"
                    >
                      {option.candidate.kind}
                    </span>
                    {option.candidate.label}
                  </button>
                ))}
              </div>,
              anchorElementRef.current,
            )
          : null
      }
    />
  );
}

class SlashCommandOption extends MenuOption {
  readonly command: SlashCommand;
  constructor(command: SlashCommand) {
    super(command.id);
    this.command = command;
  }
}

/** duo#301 on the same typeahead plugin #65 uses: the offer, its matching, and a pick calling straight out to the host rather than landing a node (a command is dispatched, not written). */
function SlashCommandsPlugin({ menuParent, onPick }: { menuParent: HTMLElement; onPick: (command: SlashCommand) => void }) {
  const [fragment, setFragment] = useState<string | null>(null);
  const options = useMemo(() => (fragment === null ? [] : slashCommandOffer(fragment).map((command) => new SlashCommandOption(command))), [fragment]);
  const triggerFn = useCallback((text: string): MenuTextMatch | null => {
    const token = slashCommandTokenBeforeCaret(text);
    return token === null ? null : { leadOffset: token.leadOffset, matchingString: token.fragment, replaceableString: token.token };
  }, []);
  const onSelectOption = useCallback(
    (option: SlashCommandOption, _nodeToReplace: TextNode | null, closeMenu: () => void) => {
      // The pick dispatches — it is the host's job to empty the editor
      // (`editorRef.current.clear()`, the same call a send makes), never
      // this plugin's: a command is dispatched whole, the opposite of a
      // mention's pick, which keeps its token as part of the text.
      closeMenu();
      onPick(option.command);
    },
    [onPick],
  );

  return (
    <LexicalTypeaheadMenuPlugin<SlashCommandOption>
      commandPriority={COMMAND_PRIORITY_NORMAL}
      anchorClassName="static! h-auto! w-auto!"
      parent={menuParent}
      options={options}
      triggerFn={triggerFn}
      onQueryChange={setFragment}
      onSelectOption={onSelectOption}
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) =>
        anchorElementRef.current && options.length > 0
          ? createPortal(
              <div className="mt-2 flex flex-col gap-1" data-testid="slash-command-offer">
                {options.map((option, index) => (
                  <button
                    aria-selected={selectedIndex === index}
                    className={`inline-flex min-h-11 items-center gap-2 self-start rounded-[var(--r-sm)] border bg-[var(--surface-2)] px-2 type-body ${
                      selectedIndex === index ? "border-[var(--accent)]" : "border-[var(--edge)]"
                    }`}
                    data-testid="slash-command-option"
                    id={`typeahead-item-${index}`}
                    key={option.key}
                    ref={option.setRefElement}
                    role="option"
                    tabIndex={-1}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => {
                      setHighlightedIndex(index);
                      selectOptionAndCleanUp(option);
                    }}
                  >
                    <span className="type-identifier text-[var(--text)]">{option.command.command}</span>
                    <span className="type-provenance text-[var(--muted)]">{option.command.description}</span>
                  </button>
                ))}
              </div>,
              anchorElementRef.current,
            )
          : null
      }
    />
  );
}

export function ChatEditor({
  ariaLabel,
  placeholder,
  mode,
  initialText = "",
  onTextChange,
  onSubmit,
  onFiles,
  mentionCandidates,
  onSlashCommandPick,
  editorRef,
  className = "",
  testId,
}: {
  ariaLabel: string;
  placeholder: string;
  /** `markdown`: live formatting shortcuts, written back as markdown. `plain`: the bare text. */
  mode: "markdown" | "plain";
  initialText?: string;
  /** The composed body after every change (untrimmed). */
  onTextChange?: (body: string) => void;
  /** Enter (or ⌘/Ctrl+Enter) — the composer's own submit. */
  onSubmit: () => void;
  /** Files pasted into the editor (#217). */
  onFiles?: (files: File[]) => void;
  /** Who an "@" can offer (#65) — omitted, no typeahead at all. */
  mentionCandidates?: readonly MentionCandidate[];
  /** duo#301: a "/" at the start of the message offers the slash commands — omitted, no typeahead at all (same shape as `mentionCandidates`). */
  onSlashCommandPick?: (command: SlashCommand) => void;
  editorRef?: Ref<ChatEditorHandle>;
  className?: string;
  testId?: string;
}) {
  // Read once, like every LexicalComposer config: the editor owns its own
  // state from the first render on.
  const [initialConfig] = useState(() => ({
    namespace: "duo-composer",
    nodes: mode === "markdown" ? [ListNode, ListItemNode, MentionNode, FactCheckNode] : [MentionNode, FactCheckNode],
    theme: THEME,
    editorState: initialStateOf(initialText),
    onError: (error: Error) => {
      throw error;
    },
  }));
  // The offer renders into an element of the composer's own, so it needs
  // that element in hand before the typeahead mounts.
  const [menuParent, setMenuParent] = useState<HTMLDivElement | null>(null);

  const contentEditable = (
    <ContentEditable
      aria-label={ariaLabel}
      aria-placeholder={placeholder}
      aria-multiline
      className={`max-h-48 min-h-11 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-1 text-[var(--text)] ${className}`}
      data-testid={testId}
      placeholder={
        <div aria-hidden="true" className="pointer-events-none absolute top-1 left-2 select-none text-[var(--faint)]">
          {placeholder}
        </div>
      }
    />
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative min-w-0 flex-1" data-testid="chat-editor">
        {mode === "markdown" ? (
          <RichTextPlugin contentEditable={contentEditable} ErrorBoundary={LexicalErrorBoundary} />
        ) : (
          <PlainTextPlugin contentEditable={contentEditable} ErrorBoundary={LexicalErrorBoundary} />
        )}
        <div ref={setMenuParent} />
      </div>
      <HistoryPlugin />
      {mode === "markdown" && (
        <>
          <ListPlugin />
          <MarkdownShortcutPlugin transformers={MARKDOWN_SHORTCUTS} />
        </>
      )}
      <ComposerKeysPlugin onSubmit={onSubmit} onFiles={onFiles} />
      <ChangePlugin onChange={onTextChange} />
      <HandlePlugin handleRef={editorRef} />
      {mentionCandidates !== undefined && menuParent !== null && <MentionsPlugin candidates={mentionCandidates} menuParent={menuParent} />}
      {onSlashCommandPick !== undefined && menuParent !== null && <SlashCommandsPlugin menuParent={menuParent} onPick={onSlashCommandPick} />}
    </LexicalComposer>
  );
}
