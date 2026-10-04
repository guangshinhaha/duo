// @vitest-environment jsdom
//
// Same reason as SanitizeMatrixHtml.test.ts: this component calls the real
// sanitizer (DOMPurify), which happy-dom's non-spec `Node.prototype.nodeName`
// layout breaks (every tag strips regardless of the allowlist). jsdom
// matches the spec here, so this is the one other file that opts into it.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBodyHtml } from "../src/components/MessageBodyHtml.js";

afterEach(() => {
  cleanup();
});

/**
 * #213: the one place `formatted_body` actually reaches
 * `dangerouslySetInnerHTML` — pinning that it's always the sanitizer's own
 * output (never a raw string this component built itself), that a mention
 * pill renders inside the formatted markup, and that an `mxc://` image
 * resolves through the authenticated `loadMedia` the same way every other
 * piece of media in this app already does — never fetched directly or left
 * as a bare `mxc:` src the browser can't load anyway.
 */
describe("#213 — MessageBodyHtml", () => {
  it("renders sanitized formatting — a script tag never reaches the DOM", () => {
    render(
      <MessageBodyHtml
        formattedBody="<b>bold</b> and <script>window.pwned = true</script>a link"
        mentionLabels={{}}
        loadMedia={vi.fn(async () => null)}
      />,
    );
    const container = screen.getByTestId("room-message-html");
    expect(container.querySelector("b")?.textContent).toBe("bold");
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("<script");
  });

  it("a mention anchor renders as the pill, inside the formatted markup", () => {
    render(
      <MessageBodyHtml
        formattedBody='<b>Hey</b> <a href="https://matrix.to/#/@carol:workspace.example">@Carol</a>, ship it'
        mentionLabels={{ "@carol:workspace.example": "Carol" }}
        loadMedia={vi.fn(async () => null)}
      />,
    );
    const pill = screen.getByTestId("room-mention");
    expect(pill.textContent).toBe("@Carol");
    expect(pill.dataset.mentionedUser).toBe("@carol:workspace.example");
    expect(screen.getByTestId("room-message-html").querySelector("b")?.textContent).toBe("Hey");
  });

  it("an mxc:// image resolves through loadMedia (never fetched directly) and its object URL is revoked on unmount", async () => {
    const blob = new Blob(["bytes"], { type: "image/png" });
    const loadMedia = vi.fn(async (url: string) => {
      expect(url).toBe("mxc://workspace.example/abc123");
      return blob;
    });
    const createObjectURL = vi.fn(() => "blob:fake-object-url");
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as typeof URL.revokeObjectURL;
    try {
      const { unmount } = render(
        <MessageBodyHtml
          formattedBody='<img src="mxc://workspace.example/abc123" alt="a cat">'
          mentionLabels={{}}
          loadMedia={loadMedia}
        />,
      );
      // The sanitizer never leaves a literal `mxc:` src for the browser to
      // (fail to) fetch — only `loadMedia`'s authenticated path reaches it.
      const img = screen.getByTestId("room-message-html").querySelector("img")!;
      expect(img.getAttribute("src")).toBeNull();
      await act(async () => {
        await Promise.resolve();
      });
      expect(loadMedia).toHaveBeenCalledWith("mxc://workspace.example/abc123");
      expect(img.src).toBe("blob:fake-object-url");

      unmount();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-object-url");
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it("falls back to no image src when loadMedia resolves null — never shows a broken, unauthenticated fetch", async () => {
    const loadMedia = vi.fn(async () => null);
    render(<MessageBodyHtml formattedBody='<img src="mxc://workspace.example/gone" alt="x">' mentionLabels={{}} loadMedia={loadMedia} />);
    await act(async () => {
      await Promise.resolve();
    });
    const img = screen.getByTestId("room-message-html").querySelector("img")!;
    expect(img.getAttribute("src")).toBeNull();
  });
});
