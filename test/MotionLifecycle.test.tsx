import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markDraftArrived, useArrival } from "../src/arrivals.js";
import { Collapse, useLeaving } from "../src/components/Collapse.js";
import { DuoLine } from "../src/components/DuoLine.js";
import { Mark } from "../src/components/Mark.js";
import { RouteLoading } from "../src/components/RouteLoading.js";
import { TickingCount } from "../src/components/TickingCount.js";

/*
 * The draft lifecycle's motion (docs/motion-plan.md A5 to A7, B1, B3, #191).
 * happy-dom runs no animation, so these pin the wiring the CSS keys on: what
 * carries the arrive class, when a leaving item stays mounted, what the count
 * shows mid-tick.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a draft arrives (A5)", () => {
  function Probe({ id }: { id: string }) {
    return (
      <DuoLine arrived={useArrival(id)} attributionTestId="a" label="Your duo" testId="line">
        words
      </DuoLine>
    );
  }

  it("only a draft the daemon pushed rises in, and only the first time it is shown", () => {
    markDraftArrived("pushed");
    const first = render(<Probe id="pushed" />);
    expect(screen.getByTestId("line").className).toContain("duo-arrive");
    first.unmount();

    // Navigating away and back: it is in place, not news.
    render(<Probe id="pushed" />);
    expect(screen.getByTestId("line").className).not.toContain("duo-arrive");
    cleanup();

    // A draft that was simply there when the chat opened never animates.
    render(<Probe id="loaded-with-the-page" />);
    expect(screen.getByTestId("line").className).not.toContain("duo-arrive");
  });

  it("a push the owner did not see is not news minutes later", () => {
    vi.useFakeTimers();
    markDraftArrived("stale");
    vi.advanceTimersByTime(60_000);
    render(<Probe id="stale" />);
    expect(screen.getByTestId("line").className).not.toContain("duo-arrive");
  });
});

describe("the duo is working (A6)", () => {
  it("the mark loops only while the duo works", () => {
    const { rerender } = render(<Mark working />);
    expect(screen.getByTestId("duo-mark")).toHaveAttribute("data-working");
    rerender(<Mark />);
    expect(screen.getByTestId("duo-mark")).not.toHaveAttribute("data-working");
  });

  it("skeletons hold still: nothing pulses", () => {
    render(<RouteLoading />);
    for (const block of screen.getAllByTestId("route-loading-block")) {
      expect(block.className).not.toContain("animate-pulse");
      expect(block.className).toContain("motion-skeleton");
    }
  });
});

describe("a decided draft folds away (B1)", () => {
  function List({ ids }: { ids: string[] }) {
    const rows = useLeaving(ids, (id) => id);
    return (
      <ul>
        {rows.map(({ item, leaving }) => (
          <li data-testid={`row-${item}`} key={item}>
            <Collapse leaving={leaving}>{item}</Collapse>
          </li>
        ))}
      </ul>
    );
  }

  beforeEach(() => vi.useFakeTimers());

  it("a removed item stays mounted, leaving and inert, then goes", () => {
    const { rerender } = render(<List ids={["a", "b"]} />);
    rerender(<List ids={["b"]} />);

    const leaving = screen.getByTestId("row-a").firstElementChild as HTMLElement;
    expect(leaving).toHaveAttribute("data-leaving");
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("row-b").firstElementChild).not.toHaveAttribute("data-leaving");

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByTestId("row-a")).toBeNull();
    expect(screen.getByTestId("row-b")).toBeInTheDocument();
  });

  it("the leaving item keeps its place in the list", () => {
    const { rerender } = render(<List ids={["a", "b", "c"]} />);
    rerender(<List ids={["a", "c"]} />);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["a", "b", "c"]);
  });

  it("an item that comes back stops leaving", () => {
    const { rerender } = render(<List ids={["a"]} />);
    rerender(<List ids={[]} />);
    rerender(<List ids={["a"]} />);
    expect(screen.getByTestId("row-a").firstElementChild).not.toHaveAttribute("data-leaving");
  });

  it("an unchanged list re-rendered with fresh arrays does not loop", () => {
    function Fresh() {
      const [n, setN] = useState(0);
      useLeaving([...["a"]], (id) => id);
      return <button onClick={() => setN(n + 1)}>{n}</button>;
    }
    render(<Fresh />);
    expect(screen.getByRole("button")).toHaveTextContent("0");
  });
});

describe("the waiting count ticks (B3)", () => {
  beforeEach(() => vi.useFakeTimers());

  it("shows the new figure entering while the old one leaves, then only the new one", () => {
    const { container, rerender } = render(<TickingCount value={3} />);
    rerender(<TickingCount value={2} />);
    expect(container.querySelector(".tick-out")).toHaveTextContent("3");
    expect(container.querySelector(".tick-out")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".tick-in")).toHaveTextContent("2");

    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(container.querySelector(".tick-out")).toBeNull();
    expect(container).toHaveTextContent("2");
  });

  it("going to zero lets the old figure leave and shows nothing in its place", () => {
    const { container, rerender } = render(<TickingCount value={1} />);
    rerender(<TickingCount value={0} />);
    expect(container.querySelector(".tick-in")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(container).toHaveTextContent("");
  });
});

describe("review fixes (#198)", () => {
  beforeEach(() => vi.useFakeTimers());

  it("the figure's entrance is not cut short: the old one lingers as long as the new one rises", () => {
    const { container, rerender } = render(<TickingCount value={3} />);
    rerender(<TickingCount value={2} />);
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(container.querySelector(".tick-in")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(container.querySelector(".tick-in")).toBeNull();
  });

  it("a badge stays for one tick after reaching zero, so the last figure is seen leaving", async () => {
    const { useLingering } = await import("../src/components/TickingCount.js");
    const { renderHook } = await import("@testing-library/react");
    const { result, rerender } = renderHook(({ n }) => useLingering(n), { initialProps: { n: 1 } });
    expect(result.current).toBe(true);
    rerender({ n: 0 });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toBe(false);
  });
});
