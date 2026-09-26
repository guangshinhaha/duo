import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftRecord } from "../src/api/types.js";
import { isTrayWindow, wireMenu, wireOpenHash } from "../src/shell/native.js";
import { canSendOutside } from "../src/shell/waiting.js";

const events = vi.hoisted(() => ({ handlers: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, handler);
    return () => events.handlers.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/*
 * #151: the seams to the Mac shell, and the one rule about what may be done
 * from outside the app.
 */

const draft = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  id: "d",
  question: "q",
  threadContext: null,
  draftText: "a",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.9,
  sources: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
  provenance: { origin: "unknown" },
  delivery: null,
  ...over,
});

beforeEach(() => {
  events.handlers.clear();
  window.location.hash = "";
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("what may be sent from outside the app", () => {
  it("only a confident draft for somebody else's message", () => {
    expect(canSendOutside(draft())).toBe(true);
    expect(canSendOutside(draft({ confidenceScore: 0.6 }))).toBe(false); // hedged
    expect(canSendOutside(draft({ draftText: null, escalated: true }))).toBe(false); // passed on
    expect(canSendOutside(draft({ draftText: null, escalated: true, refused: true }))).toBe(false); // refused
    expect(canSendOutside(draft({ provenance: { origin: "owner" } }))).toBe(false); // your own question
    expect(canSendOutside(draft({ outcome: "sent" }))).toBe(false); // already decided
    expect(canSendOutside(draft({ draftText: "  " }))).toBe(false); // nothing to send
  });
});

describe("the shell's doors into the page", () => {
  it("knows it is the mini tray by its address", () => {
    expect(isTrayWindow()).toBe(false);
    window.location.hash = "#tray";
    expect(isTrayWindow()).toBe(true);
  });

  it("the menu re-issues the keys the page already handles, so each shortcut has one handler", async () => {
    await wireMenu();
    const keys: Array<[string, boolean]> = [];
    const onKey = (e: KeyboardEvent) => keys.push([e.key, e.metaKey]);
    window.addEventListener("keydown", onKey);
    for (const id of ["search", "inspector", "chat-3"]) {
      events.handlers.get("menu-action")!({ payload: id });
    }
    window.removeEventListener("keydown", onKey);
    expect(keys).toEqual([
      ["k", true],
      ["i", true],
      ["3", true],
    ]);
  });

  it("the menu's navigations are plain navigation", async () => {
    await wireMenu();
    events.handlers.get("menu-action")!({ payload: "settings" });
    expect(window.location.hash).toBe("#settings");
    events.handlers.get("menu-action")!({ payload: "waiting" });
    expect(window.location.hash).toBe("#waiting");
    // An id it does not know does nothing.
    events.handlers.get("menu-action")!({ payload: "nope" });
    expect(window.location.hash).toBe("#waiting");
  });

  it("the tray can send the app only to an address inside it", async () => {
    await wireOpenHash();
    events.handlers.get("open-hash")!({ payload: "#chat/abc" });
    expect(window.location.hash).toBe("#chat/abc");
    events.handlers.get("open-hash")!({ payload: "https://example.com" });
    events.handlers.get("open-hash")!({ payload: 42 });
    expect(window.location.hash).toBe("#chat/abc");
  });
});
