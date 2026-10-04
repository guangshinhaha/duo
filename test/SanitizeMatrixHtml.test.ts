// @vitest-environment jsdom
//
// DOMPurify's anti-clobbering node-name lookup (`lookupGetter(Node.prototype,
// "nodeName")`) assumes a real browser's layout, where `Node.prototype`
// itself resolves the right name for every node kind. happy-dom (this
// project's default test environment) instead gives `Node.prototype` its
// own always-"" `nodeName` getter and shadows it per subclass — so
// DOMPurify's lookup finds the generic stub first and never reaches the
// override, and EVERY element's tag name reads as "", which strips
// everything regardless of the allowlist. Real browsers (and jsdom, which
// matches the spec's layout here) don't have this gap — this file is the
// one place in the suite that calls the real sanitizer, so it opts into
// jsdom rather than carrying this incompatibility into the rest of the
// suite's happy-dom environment.
import { describe, expect, it } from "vitest";
import { sanitizeFormattedBody } from "../src/workspace/sanitizeMatrixHtml.js";

/**
 * #213: another client's `formatted_body` rendered as formatting, never as
 * raw markup or an attack surface. These pin the sanitizer in isolation —
 * the Matrix spec's allowed tag/attribute list (client-server API
 * §m.room.message msgtypes), never a denylist that could miss the next
 * browser-parsed element — and the two things it does beyond stripping:
 * resolving a mention anchor into this app's own pill, and moving a valid
 * `mxc://` image reference to a `data-mxc-src` the renderer resolves
 * authenticated (`MessageBodyHtml.tsx`).
 */
function parse(html: string): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("#213 — formatting the spec allows renders as formatting", () => {
  it("bold, italic, and strong/em all survive", () => {
    const out = parse(sanitizeFormattedBody("<b>bold</b> <strong>also bold</strong> <i>italic</i> <em>also italic</em>"));
    expect(out.querySelector("b")?.textContent).toBe("bold");
    expect(out.querySelector("strong")?.textContent).toBe("also bold");
    expect(out.querySelector("i")?.textContent).toBe("italic");
    expect(out.querySelector("em")?.textContent).toBe("also italic");
  });

  it("an unordered and an ordered list keep their items and the ordered list's start", () => {
    const out = parse(sanitizeFormattedBody('<ul><li>one</li><li>two</li></ul><ol start="3"><li>three</li></ol>'));
    expect(Array.from(out.querySelectorAll("ul li")).map((li) => li.textContent)).toEqual(["one", "two"]);
    const ol = out.querySelector("ol");
    expect(ol?.getAttribute("start")).toBe("3");
    expect(ol?.querySelector("li")?.textContent).toBe("three");
  });

  it("a code block keeps its language- class, a non-language- class is stripped", () => {
    const withLanguage = parse(sanitizeFormattedBody('<pre><code class="language-js">const x = 1;</code></pre>'));
    expect(withLanguage.querySelector("code")?.getAttribute("class")).toBe("language-js");
    expect(withLanguage.querySelector("pre code")?.textContent).toBe("const x = 1;");

    const withOther = parse(sanitizeFormattedBody('<code class="not-a-language">x</code>'));
    expect(withOther.querySelector("code")?.hasAttribute("class")).toBe(false);
  });

  it("a blockquote survives", () => {
    const out = parse(sanitizeFormattedBody("<blockquote>quoted words</blockquote>"));
    expect(out.querySelector("blockquote")?.textContent).toBe("quoted words");
  });

  it("a link with an allowed scheme keeps its href and gets rel=noopener/target=_blank", () => {
    const out = parse(sanitizeFormattedBody('<a href="https://example.com/page">a link</a>'));
    const a = out.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com/page");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("a table's structure, headings, and cells survive", () => {
    const out = parse(
      sanitizeFormattedBody(
        "<table><caption>t</caption><thead><tr><th>H</th></tr></thead><tbody><tr><td>cell</td></tr></tbody></table>",
      ),
    );
    expect(out.querySelector("caption")?.textContent).toBe("t");
    expect(out.querySelector("th")?.textContent).toBe("H");
    expect(out.querySelector("td")?.textContent).toBe("cell");
  });

  it("details/summary and del/strike/s/u/sup/sub/hr/br all pass through", () => {
    const out = parse(
      sanitizeFormattedBody(
        "<details><summary>spoiler</summary>answer</details><del>gone</del><strike>also gone</strike><s>also</s><u>under</u><sup>up</sup><sub>down</sub><hr/><br/>",
      ),
    );
    expect(out.querySelector("summary")?.textContent).toBe("spoiler");
    expect(out.querySelector("details")?.textContent).toContain("answer");
    expect(out.querySelector("del")).not.toBeNull();
    expect(out.querySelector("strike")).not.toBeNull();
    expect(out.querySelector("s")).not.toBeNull();
    expect(out.querySelector("u")).not.toBeNull();
    expect(out.querySelector("sup")).not.toBeNull();
    expect(out.querySelector("sub")).not.toBeNull();
    expect(out.querySelector("hr")).not.toBeNull();
    expect(out.querySelector("br")).not.toBeNull();
  });
});

describe("#213 — anything outside the spec's allowlist is stripped, never executed", () => {
  it("a script tag never appears in the sanitized output", () => {
    const out = sanitizeFormattedBody('before<script>window.pwned = true;</script>after');
    expect(out).not.toContain("<script");
    expect(parse(out).querySelector("script")).toBeNull();
    expect(parse(out).textContent).toBe("beforeafter");
  });

  it("an onerror (or any on*) attribute is stripped off a surviving tag", () => {
    const out = parse(sanitizeFormattedBody('<img src="mxc://workspace.example/abc" onerror="window.pwned = true" alt="x">'));
    const img = out.querySelector("img");
    expect(img?.hasAttribute("onerror")).toBe(false);
    expect(img?.getAttribute("alt")).toBe("x");
  });

  it("an iframe is removed entirely", () => {
    const out = sanitizeFormattedBody('<iframe src="https://evil.example"></iframe>safe words');
    expect(out).not.toContain("<iframe");
    expect(parse(out).querySelector("iframe")).toBeNull();
    expect(parse(out).textContent).toBe("safe words");
  });

  it("a style tag, an object/embed tag, and a form are all removed", () => {
    const out = parse(
      sanitizeFormattedBody(
        "<style>body{display:none}</style><object data=\"evil\"></object><embed src=\"evil\"><form action=\"https://evil.example\"><input></form>",
      ),
    );
    expect(out.querySelector("style")).toBeNull();
    expect(out.querySelector("object")).toBeNull();
    expect(out.querySelector("embed")).toBeNull();
    expect(out.querySelector("form")).toBeNull();
    expect(out.querySelector("input")).toBeNull();
  });

  it("a javascript: href is dropped — the anchor survives with no href", () => {
    const out = parse(sanitizeFormattedBody('<a href="javascript:alert(1)">click me</a>'));
    const a = out.querySelector("a");
    expect(a?.hasAttribute("href")).toBe(false);
    expect(a?.textContent).toBe("click me");
  });

  it("a relative href is dropped — the spec requires an absolute, schemed href", () => {
    const out = parse(sanitizeFormattedBody('<a href="/some/path">relative</a>'));
    expect(out.querySelector("a")?.hasAttribute("href")).toBe(false);
  });

  it("an href scheme the spec doesn't list (tel:) is dropped even though DOMPurify's own default allowlist permits it", () => {
    const out = parse(sanitizeFormattedBody('<a href="tel:+10000000000">call</a>'));
    expect(out.querySelector("a")?.hasAttribute("href")).toBe(false);
  });

  it("a bare class on a tag other than code is stripped — no Tailwind-class smuggling", () => {
    const out = parse(sanitizeFormattedBody('<p class="fixed inset-0 z-50 bg-black">overlay attempt</p>'));
    expect(out.querySelector("p")?.hasAttribute("class")).toBe(false);
  });

  it("a style attribute is stripped from every tag", () => {
    const out = parse(sanitizeFormattedBody('<p style="position:fixed;inset:0;background:black">x</p>'));
    expect(out.querySelector("p")?.hasAttribute("style")).toBe(false);
  });

  it("an id attribute is stripped", () => {
    const out = parse(sanitizeFormattedBody('<p id="smuggled">x</p>'));
    expect(out.querySelector("p")?.hasAttribute("id")).toBe(false);
  });

  it("an unrecognised data- attribute is stripped even though DOMPurify allows data- attributes by default", () => {
    const out = parse(sanitizeFormattedBody('<p data-evil="1">x</p>'));
    expect(out.querySelector("p")?.hasAttribute("data-evil")).toBe(false);
  });

  it("a malformed color value is dropped rather than passed through as CSS", () => {
    const out = parse(sanitizeFormattedBody('<font color="red; background: url(javascript:alert(1))">x</font>'));
    expect(out.querySelector("font")?.hasAttribute("color")).toBe(false);
  });

  it("a valid hex color on font/span survives", () => {
    const out = parse(sanitizeFormattedBody('<font color="#ff0000">x</font><span data-mx-color="#00ff00">y</span>'));
    expect(out.querySelector("font")?.getAttribute("color")).toBe("#ff0000");
    expect(out.querySelector("span")?.getAttribute("data-mx-color")).toBe("#00ff00");
  });

  it("mx-reply (the rich-reply fallback quote) is stripped along with its content", () => {
    const out = parse(sanitizeFormattedBody("<mx-reply>quoted original message</mx-reply>the actual reply"));
    expect(out.querySelector("mx-reply")).toBeNull();
    expect(out.textContent).toBe("the actual reply");
  });

  it("tags are not nested unboundedly deep by this function itself (DOMPurify's own 100-level guard applies, not re-implemented here)", () => {
    // Not a depth assertion — just confirms a deeply nested, otherwise-legal
    // document still sanitizes without throwing.
    const deep = "<b>".repeat(50) + "x" + "</b>".repeat(50);
    expect(() => sanitizeFormattedBody(deep)).not.toThrow();
  });
});

describe("#213 — an <img> of an mxc:// reference is handed to the authenticated media path, never fetched directly", () => {
  it("a valid mxc:// src becomes data-mxc-src, with no literal src left for the browser to fetch unauthenticated", () => {
    const out = parse(sanitizeFormattedBody('<img src="mxc://workspace.example/abc123" width="200" height="100" alt="a cat" title="cat.png">'));
    const img = out.querySelector("img");
    expect(img?.getAttribute("data-mxc-src")).toBe("mxc://workspace.example/abc123");
    expect(img?.hasAttribute("src")).toBe(false);
    expect(img?.getAttribute("width")).toBe("200");
    expect(img?.getAttribute("height")).toBe("100");
    expect(img?.getAttribute("alt")).toBe("a cat");
    expect(img?.getAttribute("title")).toBe("cat.png");
  });

  it("a non-mxc src (http, https, data:) is dropped outright — never left as a direct unauthenticated fetch", () => {
    for (const src of ["https://evil.example/track.png", "http://evil.example/track.png", "data:image/png;base64,AAAA"]) {
      const out = parse(sanitizeFormattedBody(`<img src="${src}" alt="x">`));
      const img = out.querySelector("img");
      expect(img?.hasAttribute("src")).toBe(false);
      expect(img?.hasAttribute("data-mxc-src")).toBe(false);
    }
  });

  it("a malformed mxc:// value (no media id) is dropped", () => {
    const out = parse(sanitizeFormattedBody('<img src="mxc://workspace.example" alt="x">'));
    const img = out.querySelector("img");
    expect(img?.hasAttribute("data-mxc-src")).toBe(false);
    expect(img?.hasAttribute("src")).toBe(false);
  });
});

describe("#213 — a mention anchor renders as this app's own pill", () => {
  it("a person's matrix.to anchor becomes a solid pill carrying the resolved label", () => {
    const out = parse(
      sanitizeFormattedBody('before <a href="https://matrix.to/#/@carol:workspace.example">@Carol</a> after', {
        "@carol:workspace.example": "Carol",
      }),
    );
    expect(out.querySelector("a")).toBeNull();
    const pill = out.querySelector('[data-testid="room-mention"]');
    expect(pill?.tagName).toBe("SPAN");
    expect(pill?.getAttribute("data-mentioned-user")).toBe("@carol:workspace.example");
    expect(pill?.textContent).toBe("@Carol");
    expect(pill?.className).toContain("border-[var(--accent)]");
    expect(out.textContent).toBe("before @Carol after");
  });

  it("a duo's matrix.to anchor becomes the dashed pill, from mentionLabels — never the anchor's own claimed text", () => {
    const out = parse(
      sanitizeFormattedBody('<a href="https://matrix.to/#/@duo-carol:workspace.example">@carol</a> refund policy?', {
        "@duo-carol:workspace.example": "carol's duo",
      }),
    );
    const pill = out.querySelector('[data-testid="room-mention"]');
    expect(pill?.textContent).toBe("@carol's duo");
    expect(pill?.className).toContain("border-dashed");
  });

  it("a mention anchor alongside other formatting still renders both", () => {
    const out = parse(
      sanitizeFormattedBody('<b>Hey</b> <a href="https://matrix.to/#/@carol:workspace.example">@Carol</a>, see <code>this</code>', {
        "@carol:workspace.example": "Carol",
      }),
    );
    expect(out.querySelector("b")?.textContent).toBe("Hey");
    expect(out.querySelector('[data-testid="room-mention"]')?.textContent).toBe("@Carol");
    expect(out.querySelector("code")?.textContent).toBe("this");
  });

  it("an id missing from mentionLabels falls back to the localpart rather than throwing", () => {
    const out = parse(sanitizeFormattedBody('<a href="https://matrix.to/#/@nobody:workspace.example">@whoever</a>', {}));
    expect(out.querySelector('[data-testid="room-mention"]')?.textContent).toBe("@nobody");
  });

  it("a room/event matrix.to permalink is left as an ordinary link, not a pill", () => {
    const out = parse(sanitizeFormattedBody('<a href="https://matrix.to/#/!room:workspace.example">the room</a>'));
    expect(out.querySelector('[data-testid="room-mention"]')).toBeNull();
    expect(out.querySelector("a")?.getAttribute("href")).toBe("https://matrix.to/#/!room:workspace.example");
  });
});
