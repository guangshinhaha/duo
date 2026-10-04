import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../src/workspace/markdown.js";

/*
 * #216: `markdown.ts` is the one seam around `marked` (MIT) — these pin
 * what it actually produces, independent of mentions or the wire shape
 * `matrix.ts`'s `send` builds around it (WorkspaceMatrixSeam.test.ts pins
 * that half).
 */
describe("markdown → HTML for a sent message's formatted_body (#216)", () => {
  it("bold and italic", () => {
    expect(markdownToHtml("**bold** and _italic_")).toBe("<p><strong>bold</strong> and <em>italic</em></p>\n");
  });

  it("an unordered list", () => {
    expect(markdownToHtml("- one\n- two")).toBe("<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n");
  });

  it("an ordered list", () => {
    expect(markdownToHtml("1. one\n2. two")).toBe("<ol>\n<li>one</li>\n<li>two</li>\n</ol>\n");
  });

  it("inline code", () => {
    expect(markdownToHtml("run `npm test`")).toBe("<p>run <code>npm test</code></p>\n");
  });

  it("a fenced code block", () => {
    expect(markdownToHtml("```\nconst x = 1;\n```")).toBe("<pre><code>const x = 1;\n</code></pre>\n");
  });

  it("a lone newline renders as a line break, not a swallowed space — the composer's Enter is already a newline (#27)", () => {
    expect(markdownToHtml("line one\nline two")).toBe("<p>line one<br>line two</p>\n");
  });

  it("plain words with no markdown syntax still come back as their own (trivial) formatting", () => {
    expect(markdownToHtml("just a sentence")).toBe("<p>just a sentence</p>\n");
  });

  it("an already-complete anchor tag passes through untouched in shape — markdown doesn't re-parse its own output", () => {
    const html = markdownToHtml('before <a href="https://matrix.to/#/@carol:workspace.example">@Carol</a> after');
    expect(html).toContain('<a href="https://matrix.to/#/@carol:workspace.example">@Carol</a>');
  });
});
