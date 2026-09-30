import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paneKey } from "../src/shell/routes.js";
import { usePresence } from "../src/shell/usePresence.js";

/*
 * Motion between places (docs/motion-plan.md B4 to B8, #192): what counts as
 * a different pane, and how the parts that ease in and out mount and unmount.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("what is a different pane (B5)", () => {
  it("a chat opening another chat is a new pane", () => {
    expect(paneKey({ chat: "!a" })).not.toBe(paneKey({ chat: "!b" }));
    expect(paneKey("waiting")).not.toBe(paneKey("duo"));
    expect(paneKey({ thread: { roomId: "!a", rootEventId: "$1" } })).not.toBe(paneKey({ thread: { roomId: "!a", rootEventId: "$2" } }));
  });

  it("moving inside one surface is not: a message in the same chat, a profile tab, a settings section", () => {
    expect(paneKey({ chat: "!a" })).toBe(paneKey({ chat: "!a", at: "$m" }));
    expect(paneKey({ profile: "rules" })).toBe(paneKey({ profile: "portrait" }));
    expect(paneKey({ settings: "devices" })).toBe(paneKey({ settings: "links" }));
  });
});

describe("a part that eases in and out (B6, B8)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 8) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("what is open at first render is simply there, with nothing to ease from", () => {
    const { result } = renderHook(() => usePresence(true));
    expect(result.current).toEqual({ mounted: true, shown: true });
  });

  it("opening mounts closed first, then shows, so the transition has a state to run from", () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open), { initialProps: { open: false } });
    expect(result.current).toEqual({ mounted: false, shown: false });

    rerender({ open: true });
    expect(result.current).toEqual({ mounted: true, shown: false });
    act(() => {
      vi.advanceTimersByTime(30);
    });
    expect(result.current).toEqual({ mounted: true, shown: true });
  });

  it("closing hides at once but stays mounted through the exit, then goes", () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open), { initialProps: { open: true } });
    rerender({ open: false });
    expect(result.current).toEqual({ mounted: true, shown: false });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toEqual({ mounted: false, shown: false });
  });

  it("closing before the entrance finished never shows", () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open), { initialProps: { open: false } });
    rerender({ open: true });
    rerender({ open: false });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toEqual({ mounted: false, shown: false });
  });
});
