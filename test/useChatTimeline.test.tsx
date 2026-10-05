import { StrictMode, useCallback, useEffect, useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTimelineList, useChatTimeline } from "../src/shell/useChatTimeline.js";
import { rowTopOnScreen, scrollTranscriptTo, stubTimelineLayout } from "./timelineLayout.js";

/*
 * #248: the virtualized transcript's own contract, below any route — here
 * under StrictMode, the way `main.tsx` mounts the app in development, where
 * React runs every effect's cleanup and then the effect again on mount.
 */

let prepend: (ids: readonly string[]) => void = () => undefined;

function Transcript({ initial }: { initial: readonly string[] }) {
  const [rows, setRows] = useState<readonly string[]>(initial);
  const [landed, setLanded] = useState(false);
  prepend = (ids) => setRows((current) => [...ids, ...current]);
  const timeline = useChatTimeline({
    count: rows.length,
    getKey: useCallback((index: number) => rows[index]!, [rows]),
    estimateSize: useCallback(() => 100, []),
    follow: landed,
  });
  // The route's first landing: the very end.
  useEffect(() => {
    if (timeline.ready && !landed) {
      setLanded(true);
      timeline.scrollToEnd();
    }
  });
  return (
    <div data-testid="room-scroller" ref={timeline.scrollerRef}>
      <ChatTimelineList
        count={rows.length}
        testId="room-timeline"
        timeline={timeline}
        renderRow={(index) => <div data-testid="room-message">{rows[index]}</div>}
      />
      <div ref={timeline.footerRef} />
    </div>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("#248 — useChatTimeline under StrictMode", () => {
  it("a member who scrolled up keeps their place when older rows land above — never thrown back to the end", async () => {
    const layout = stubTimelineLayout();
    render(
      <StrictMode>
        <Transcript initial={["row 1", "row 2", "row 3", "row 4", "row 5"]} />
      </StrictMode>,
    );
    const scroller = screen.getByTestId("room-scroller");
    await waitFor(() => expect(scroller.scrollTop).toBe(scroller.scrollHeight - layout.viewport));

    // The member scrolls up themselves: the opening "the end" aim is theirs to override.
    scrollTranscriptTo(scroller, 40);
    await waitFor(() => expect(rowTopOnScreen(screen.getByText("row 1"), layout)).toBe(36));

    act(() => prepend(["older 1", "older 2", "older 3"]));
    await screen.findByText("older 3");
    // Three 100px rows and their gaps landed above; the row being read hasn't moved on screen.
    await waitFor(() => expect(scroller.scrollTop).toBe(40 + 3 * 120));
    expect(rowTopOnScreen(screen.getByText("row 1"), layout)).toBe(36);
  });
});
