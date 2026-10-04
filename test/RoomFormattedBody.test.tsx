// @vitest-environment jsdom
//
// Same reason as SanitizeMatrixHtml.test.ts/MessageBodyHtml.test.tsx: the
// formatted path calls the real sanitizer (DOMPurify), which happy-dom's
// non-spec `Node.prototype.nodeName` layout breaks.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBody } from "../src/routes/Room.js";
import type { RoomMessage } from "../src/workspace/matrix.js";

afterEach(() => {
  cleanup();
});

const loadMedia = vi.fn(async () => null);
const getUrlPreview = vi.fn(async () => null);

function messageFor(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId" | "senderId" | "body">): RoomMessage {
  return {
    roomId: "!project-x:workspace.example",
    senderName: "Bose",
    originServerTs: 1_700_000_000_000,
    edited: false,
    redacted: false,
    reactions: [],
    thread: null,
    threadRootEventId: null,
    replyToEventId: null,
    parts: null,
    ...over,
  };
}

/**
 * #213: `Room.tsx`'s `MessageBody` — shared by the main flow and
 * `Thread.tsx` — is where a message's render actually branches between the
 * old plain path and the new formatted one. These exercise that branch
 * directly (no full app/connection scaffolding needed; `MessageBody` is
 * already a pure render over one `RoomMessage`), pinning the three things
 * the issue asked for: another client's rich text renders as formatting,
 * a message with no `formatted_body` is completely unchanged, and a
 * mention still renders as this app's own pill when both are present.
 */
describe("#213 — Room's MessageBody renders a formatted_body as formatting", () => {
  it("bold, a list, a code block, a blockquote, and a link all render as that formatting", () => {
    render(
      <MessageBody
        message={messageFor({
          eventId: "$1",
          senderId: "@bose:workspace.example",
          body: "ship it: **done**\n- a\n- b\n`code`\n> quoted\nhttps://example.com",
          formattedBody:
            "ship it: <b>done</b><ul><li>a</li><li>b</li></ul><pre><code>code</code></pre>" +
            '<blockquote>quoted</blockquote><a href="https://example.com">a link</a>',
        })}
        loadMedia={loadMedia}
        getUrlPreview={getUrlPreview}
      />,
    );
    const html = screen.getByTestId("room-message-html");
    expect(html.querySelector("b")?.textContent).toBe("done");
    expect(Array.from(html.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["a", "b"]);
    expect(html.querySelector("code")?.textContent).toBe("code");
    expect(html.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(html.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    // The old raw markup/plain-words fallback this issue replaces is gone —
    // the asterisks and the leading "-" never show as literal characters.
    expect(screen.queryByText(/\*\*done\*\*/)).toBeNull();
  });

  it("a message with no formatted_body renders exactly the old plain way — unchanged", () => {
    render(
      <MessageBody
        message={messageFor({ eventId: "$2", senderId: "@bose:workspace.example", body: "plain words, nothing fancy" })}
        loadMedia={loadMedia}
        getUrlPreview={getUrlPreview}
      />,
    );
    expect(screen.getByText("plain words, nothing fancy")).toBeInTheDocument();
    expect(screen.queryByTestId("room-message-html")).toBeNull();
  });

  it("a mention pill still renders correctly alongside other formatting in the formatted path", () => {
    render(
      <MessageBody
        message={messageFor({
          eventId: "$3",
          senderId: "@bose:workspace.example",
          body: "@Carol, @carol's duo — see the <b>plan</b>",
          formattedBody:
            '<a href="https://matrix.to/#/@carol:workspace.example">@Carol</a>, ' +
            '<a href="https://matrix.to/#/@duo-carol:workspace.example">@carol</a> — see the <b>plan</b>',
          mentionLabels: { "@carol:workspace.example": "Carol", "@duo-carol:workspace.example": "carol's duo" },
        })}
        loadMedia={loadMedia}
        getUrlPreview={getUrlPreview}
      />,
    );
    const pills = screen.getAllByTestId("room-mention");
    expect(pills).toHaveLength(2);
    expect(pills[0]).toHaveTextContent("@Carol");
    expect(pills[0].className).toContain("border-[var(--accent)]");
    expect(pills[1]).toHaveTextContent("@carol's duo");
    expect(pills[1].className).toContain("border-dashed");
    expect(screen.getByTestId("room-message-html").querySelector("b")?.textContent).toBe("plan");
  });

  it("a redacted message never renders the formatted path, even if the struck event once carried one", () => {
    render(
      <MessageBody
        message={messageFor({
          eventId: "$4",
          senderId: "@bose:workspace.example",
          body: "",
          redacted: true,
          formattedBody: "<b>should never show</b>",
        })}
        loadMedia={loadMedia}
        getUrlPreview={getUrlPreview}
      />,
    );
    expect(screen.getByTestId("room-message-deleted")).toBeInTheDocument();
    expect(screen.queryByTestId("room-message-html")).toBeNull();
  });
});
