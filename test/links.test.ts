import { describe, expect, it } from "vitest";
import { messagePermalink, roomHref, threadHref } from "../src/workspace/links.js";

/*
 * #225: a message's shareable address — the spec's own matrix.to grammar,
 * built from a room id and an event id. `workspace/drafts.ts`'s
 * `conversationOf` reads this exact shape back (a draft's own provenance
 * permalink); `shell/routes.ts`'s `routeFromHash` reads it back too, for a
 * copied link opened against this app (#225 AC2).
 */
describe("#225 — a message's matrix.to permalink", () => {
  it("names the room and the event in the spec's fragment, with a via hint from the room's own server", () => {
    expect(messagePermalink("!abc:workspace.example", "$ev1")).toBe(
      "https://matrix.to/#/!abc:workspace.example/$ev1?via=workspace.example",
    );
  });

  it("leaves the matrix ids unencoded, matching this app's other matrix.to anchors", () => {
    const link = messagePermalink("!abc:workspace.example", "$ev1");
    expect(link).not.toContain("%21"); // an encoded "!"
    expect(link).not.toContain("%24"); // an encoded "$"
  });

  it("carries no via hint for a room id with no server part — never crashes on one", () => {
    expect(messagePermalink("!opaque-only", "$ev1")).toBe("https://matrix.to/#/!opaque-only/$ev1");
  });

  it("stays a different address family from this app's own #chat route", () => {
    expect(roomHref("!r:w.example", "$ev1")).toBe("#chat/!r%3Aw.example/%24ev1");
    expect(threadHref("!r:w.example", "$root")).toBe("#chat/!r%3Aw.example/thread/%24root");
    expect(messagePermalink("!r:w.example", "$ev1")).not.toMatch(/^#/);
  });
});
