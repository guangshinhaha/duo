import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatEditor, type ChatEditorHandle } from "../src/composer/ChatEditor.js";
import type { MentionCandidate } from "../src/composer/mentionOffer.js";
import { composed, composerText, pressEnter, typeInto } from "./composerHelpers.js";

const CANDIDATES: readonly MentionCandidate[] = [
  { userId: "@carol:workspace.example", label: "Carol", kind: "person" },
  { userId: "@duo-carol:workspace.example", label: "carol's duo", kind: "duo" },
  { userId: "@dan:workspace.example", label: "Dan", kind: "person" },
];

function renderEditor(props: Partial<Parameters<typeof ChatEditor>[0]> = {}) {
  const onSubmit = vi.fn();
  const onFiles = vi.fn();
  const onTextChange = vi.fn();
  const handle = createRef<ChatEditorHandle>();
  render(
    <ChatEditor
      ariaLabel="Message test"
      editorRef={handle}
      mode="markdown"
      placeholder="Message test"
      onFiles={onFiles}
      onSubmit={onSubmit}
      onTextChange={onTextChange}
      {...props}
    />,
  );
  const field = screen.getByLabelText("Message test");
  return { field, onSubmit, onFiles, onTextChange, handle };
}

describe("#248/#244 — Enter sends, Shift+Enter is a new line", () => {
  it("Enter submits; Shift+Enter adds a line and doesn't", () => {
    const { field, onSubmit } = renderEditor();
    typeInto(field, "first line");
    pressEnter(field, { shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    typeInto(field, "second line");
    expect(composerText(field)).toBe("first line\nsecond line");
    pressEnter(field);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Sending never adds a line of its own.
    expect(composerText(field)).toBe("first line\nsecond line");
  });

  it("⌘-Enter and Ctrl-Enter also submit", () => {
    const { field, onSubmit } = renderEditor();
    typeInto(field, "hi");
    pressEnter(field, { metaKey: true });
    pressEnter(field, { ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("an Enter that confirms an IME candidate neither sends nor adds a line", () => {
    const { field, onSubmit } = renderEditor();
    typeInto(field, "ni");
    // Mid-composition: Lexical doesn't dispatch the key at all.
    act(() => {
      fireEvent.compositionStart(field, { data: "" });
    });
    pressEnter(field, { isComposing: true });
    act(() => {
      fireEvent.compositionEnd(field, { data: "" });
    });
    // Safari's tail: the confirming Enter arrives after compositionend as keyCode 229.
    pressEnter(field, { keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(composerText(field)).toBe("ni");
  });

  it("on a touch-first device Enter is a new line, not a send", () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) => ({ matches: query.includes("pointer: coarse"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    );
    try {
      const { field, onSubmit } = renderEditor();
      typeInto(field, "one");
      pressEnter(field);
      typeInto(field, "two");
      expect(onSubmit).not.toHaveBeenCalled();
      expect(composerText(field)).toBe("one\ntwo");
    } finally {
      matchMedia.mockRestore();
    }
  });
});

describe("#248/#216 — markdown shortcuts style as you type, and serialize back", () => {
  it("**bold** turns bold in the editor and comes back out as **bold**", () => {
    const { field } = renderEditor();
    typeInto(field, "make it **bold** now");
    expect(field.querySelector("strong")).toHaveTextContent("bold");
    expect(field).not.toHaveTextContent("**");
    expect(composerText(field)).toBe("make it **bold** now");
  });

  it("_italic_, ~~struck~~ and `code` round-trip", () => {
    const { field } = renderEditor();
    typeInto(field, "an _aside_ and ~~gone~~ and `npm test`");
    expect(field.querySelector(".italic")).toHaveTextContent("aside");
    expect(field.querySelector(".line-through")).toHaveTextContent("gone");
    expect(field.querySelector(".font-mono")).toHaveTextContent("npm test");
    expect(composerText(field)).toBe("an *aside* and ~~gone~~ and `npm test`");
  });

  it("'- ' starts a list; Shift+Enter is the next item; an empty item leaves the list", () => {
    const { field } = renderEditor();
    typeInto(field, "- one\ntwo\n\nafter");
    expect(field.querySelectorAll("li")).toHaveLength(2);
    expect(composerText(field)).toBe("- one\n- two\nafter");
  });

  it("'1. ' starts a numbered list", () => {
    const { field } = renderEditor();
    typeInto(field, "1. first\nsecond");
    expect(field.querySelector("ol")).not.toBeNull();
    expect(composerText(field)).toBe("1. first\n2. second");
  });

  it("literal markdown characters stay exactly as typed — no escaping in body", () => {
    const { field } = renderEditor();
    typeInto(field, "snake_case and 2 * 3");
    expect(composerText(field)).toBe("snake_case and 2 * 3");
  });

  it("a fenced code block typed line by line comes back as the fence", () => {
    const { field } = renderEditor();
    typeInto(field, "```\nconst x = 1;\n```");
    expect(composerText(field)).toBe("```\nconst x = 1;\n```");
  });

  it("plain mode never formats", () => {
    const { field } = renderEditor({ mode: "plain" });
    typeInto(field, "**not bold**");
    expect(field.querySelector("strong")).toBeNull();
    expect(composerText(field)).toBe("**not bold**");
  });
});

describe("#248/#65 — the mention typeahead", () => {
  it("'@' offers every candidate, kinds marked; typing narrows by label or localpart", async () => {
    const { field } = renderEditor({ mentionCandidates: CANDIDATES });
    typeInto(field, "hi @");
    const offer = await screen.findByTestId("mention-offer");
    expect(offer.querySelectorAll('[data-testid="mention-option"]')).toHaveLength(3);
    expect(screen.getAllByTestId("mention-kind").map((kind) => kind.textContent)).toEqual(["person", "duo", "person"]);
    typeInto(field, "ca");
    await vi.waitFor(() => expect(screen.getAllByTestId("mention-option")).toHaveLength(2));
    typeInto(field, "rol'");
    await vi.waitFor(() => expect(screen.getAllByTestId("mention-option").map((o) => o.textContent)).toEqual(["duocarol's duo"]));
  });

  it("a click lands the pick as a pill with its trailing space, and it rides as a mention", async () => {
    const { field } = renderEditor({ mentionCandidates: CANDIDATES });
    typeInto(field, "ask @duo");
    fireEvent.click(await screen.findByText("carol's duo"));
    expect(screen.queryByTestId("mention-offer")).toBeNull();
    typeInto(field, "about it");
    expect(composed(field)).toEqual({
      body: "ask @carol's duo about it",
      mentions: [{ userId: "@duo-carol:workspace.example", label: "carol's duo" }],
    });
    expect(field.querySelector('[data-testid="composer-mention"]')).toHaveAttribute("data-mentioned-user", "@duo-carol:workspace.example");
  });

  it("Enter with the offer open picks instead of sending; arrows move the pick", async () => {
    const { field, onSubmit } = renderEditor({ mentionCandidates: CANDIDATES });
    typeInto(field, "@");
    await screen.findByTestId("mention-offer");
    act(() => {
      fireEvent.keyDown(field, { key: "ArrowDown", code: "ArrowDown", keyCode: 40 });
    });
    pressEnter(field);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(composed(field).mentions).toEqual([{ userId: "@duo-carol:workspace.example", label: "carol's duo" }]);
    // The offer's gone: the next Enter sends.
    pressEnter(field);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("no match, no offer — and Enter sends", async () => {
    const { field, onSubmit } = renderEditor({ mentionCandidates: CANDIDATES });
    typeInto(field, "@zz");
    expect(screen.queryByTestId("mention-offer")).toBeNull();
    pressEnter(field);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("an email address is not a mention", () => {
    renderEditor({ mentionCandidates: CANDIDATES });
    typeInto(screen.getByLabelText("Message test"), "carol@ca");
    expect(screen.queryByTestId("mention-offer")).toBeNull();
  });

  it("a mention inside bold still serializes as its plain words for the seam to anchor", async () => {
    const { field } = renderEditor({ mentionCandidates: CANDIDATES });
    typeInto(field, "**hey @Car");
    fireEvent.click(await screen.findByText("Carol"));
    typeInto(field, "**");
    // Whatever the shortcut did, the addressed words are intact and the mention rides.
    expect(composed(field).body).toContain("@Carol");
    expect(composed(field).mentions).toEqual([{ userId: "@carol:workspace.example", label: "Carol" }]);
  });

  it("two mentions ride in document order", async () => {
    const { field } = renderEditor({ mentionCandidates: CANDIDATES });
    typeInto(field, "@Da");
    fireEvent.click(await screen.findByText("Dan"));
    typeInto(field, "and @Car");
    fireEvent.click(await screen.findByText("Carol"));
    expect(composed(field).mentions.map((mention) => mention.label)).toEqual(["Dan", "Carol"]);
    expect(composed(field).body).toBe("@Dan and @Carol ");
  });
});

describe("#248/#217 — paste", () => {
  it("a pasted file goes to onFiles, never into the editor", () => {
    const { field, onFiles } = renderEditor();
    const file = new File(["x"], "shot.png", { type: "image/png" });
    act(() => {
      fireEvent.paste(field, { clipboardData: { files: [file], types: ["Files"], getData: () => "" } });
    });
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(composerText(field)).toBe("");
  });

  it("pasted words arrive as plain text", () => {
    const { field, onFiles } = renderEditor();
    act(() => {
      fireEvent.paste(field, {
        clipboardData: { files: [], types: ["text/plain", "text/html"], getData: (type: string) => (type === "text/plain" ? "line one\nline two" : "<h1>x</h1>") },
      });
    });
    expect(onFiles).not.toHaveBeenCalled();
    expect(composerText(field)).toBe("line one\nline two");
    expect(field.querySelector("h1")).toBeNull();
  });
});

describe("#248 — the handle", () => {
  it("clear empties the editor and reports the empty body", () => {
    const { field, handle, onTextChange } = renderEditor();
    typeInto(field, "words");
    expect(onTextChange).toHaveBeenLastCalledWith("words");
    act(() => handle.current!.clear());
    expect(composerText(field)).toBe("");
    expect(onTextChange).toHaveBeenLastCalledWith("");
  });

  it("starts from initialText, lines kept", () => {
    const { field } = renderEditor({ initialText: "kept\nacross a route switch", mode: "plain" });
    expect(composerText(field)).toBe("kept\nacross a route switch");
  });
});
