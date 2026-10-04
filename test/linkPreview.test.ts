import { describe, expect, it } from "vitest";
import { firstLinkOf } from "../src/workspace/linkPreview.js";

/*
 * #219: the plain-body half of link detection — pure, so it's testable
 * without a DOM or a connection. One preview per message (Room.tsx takes
 * only the first link this finds), a reasonably careful match that doesn't
 * drag in a sentence's trailing punctuation or a wrapping bracket/paren, and
 * no special handling for code spans because this client renders none yet.
 */
describe("#219 — firstLinkOf finds the one link a preview card renders for", () => {
  it("finds a bare https link", () => {
    expect(firstLinkOf("check this out: https://example.com/page")).toBe("https://example.com/page");
  });

  it("finds a bare http link too", () => {
    expect(firstLinkOf("http://example.com")).toBe("http://example.com");
  });

  it("returns null when the body carries no link", () => {
    expect(firstLinkOf("just words, no link here")).toBeNull();
    expect(firstLinkOf("")).toBeNull();
  });

  it("takes only the first link — one preview per message", () => {
    expect(firstLinkOf("https://first.example and also https://second.example")).toBe("https://first.example");
  });

  it("drops a sentence's trailing punctuation", () => {
    expect(firstLinkOf("see https://example.com/page.")).toBe("https://example.com/page");
    expect(firstLinkOf("is this it? https://example.com/page!")).toBe("https://example.com/page");
  });

  it("does not drag in a wrapping bracket, paren or quote", () => {
    expect(firstLinkOf("(https://example.com/page)")).toBe("https://example.com/page");
    expect(firstLinkOf("[https://example.com/page]")).toBe("https://example.com/page");
    expect(firstLinkOf('"https://example.com/page"')).toBe("https://example.com/page");
  });

  it("stops at whitespace, never swallowing the rest of the message", () => {
    expect(firstLinkOf("https://example.com/page then some more words")).toBe("https://example.com/page");
  });
});
