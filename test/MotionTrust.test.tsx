import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Collapse, useLeaving } from "../src/components/Collapse.js";
import { EditDiff } from "../src/components/EditDiff.js";
import { Swap } from "../src/components/Swap.js";
import { SwipeRow } from "../src/shell/SwipeRow.js";
import { setThemePreference } from "../src/theme.js";

/*
 * Trust and editorial moments (docs/motion-plan.md B9, C1 to C6, #194): the
 * parts that are logic rather than CSS. happy-dom runs no animation, so these
 * pin what the styles key on.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe("a value that changes in place (C1)", () => {
  beforeEach(() => vi.useFakeTimers());

  it("cross-fades: the old value leaves where it stood as the new one arrives", () => {
    const { container, rerender } = render(<Swap value="answer">Answers on its own</Swap>);
    expect(container.querySelector(".swap-out")).toBeNull();

    rerender(<Swap value="ask">Asks you first</Swap>);
    expect(container.querySelector(".swap-out")).toHaveTextContent("Answers on its own");
    expect(container.querySelector(".swap-out")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".swap-in")).toHaveTextContent("Asks you first");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector(".swap-out")).toBeNull();
    expect(container).toHaveTextContent("Asks you first");
  });

  it("an unchanged value never animates, even when its words are re-rendered", () => {
    const { container, rerender } = render(<Swap value="ask">Asks you first</Swap>);
    rerender(<Swap value="ask">Asks you first</Swap>);
    expect(container.querySelector(".swap-out")).toBeNull();
    expect(container.querySelector(".swap-in")).toBeNull();
  });
});

describe("a decided card is seen to be decided, then folds away (C2)", () => {
  function List({ ids }: { ids: string[] }) {
    const rows = useLeaving(ids, (id) => id, 400);
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

  it("stays exactly as it is for the hold, then folds, then goes", () => {
    const { rerender } = render(<List ids={["a", "b"]} />);
    rerender(<List ids={["b"]} />);
    const leaving = () => screen.getByTestId("row-a").firstElementChild as HTMLElement;

    // Held: still there, not yet leaving.
    expect(leaving()).not.toHaveAttribute("data-leaving");
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(leaving()).not.toHaveAttribute("data-leaving");

    // Folding.
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(leaving()).toHaveAttribute("data-leaving");

    // Gone.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByTestId("row-a")).toBeNull();
    expect(screen.getByTestId("row-b")).toBeInTheDocument();
  });
});

describe("what an edit taught (C3)", () => {
  it("strikes what was removed and marks what was added, so the styles can draw them", () => {
    render(<EditDiff original="within the hour" edited="in about ten minutes" />);
    for (const removed of screen.getAllByTestId("edit-diff-removed")) {
      expect(removed.className).toContain("diff-del");
    }
    for (const added of screen.getAllByTestId("edit-diff-added")) {
      expect(added.className).toContain("diff-ins");
    }
  });
});

describe("the theme switch (C6)", () => {
  it("applies at once where the browser cannot cross-fade", () => {
    setThemePreference("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("cross-fades through a view transition where it can, and the stamp lands inside it", () => {
    const seen: string[] = [];
    (document as unknown as { startViewTransition: (update: () => void) => void }).startViewTransition = (update) => {
      seen.push(document.documentElement.dataset.theme ?? "unset");
      update();
      seen.push(document.documentElement.dataset.theme ?? "unset");
    };
    setThemePreference("dark");
    expect(seen).toEqual(["unset", "dark"]);
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  });

  it("for someone who asked for less motion, it is instant even where the browser could fade", () => {
    const start = vi.fn();
    (document as unknown as { startViewTransition: unknown }).startViewTransition = start;
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    setThemePreference("light");
    expect(start).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe("light");
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  });
});

describe("the swipe feels like something (B9)", () => {
  const touch = { pointerId: 1, pointerType: "touch", button: 0 };
  const offsetOf = (el: HTMLElement): number => Number(/translateX\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1] ?? 0);

  function row() {
    render(
      <SwipeRow dismiss={async () => {}} send={async () => {}}>
        <span>row</span>
      </SwipeRow>,
    );
    return screen.getByTestId("swipe-surface");
  }
  const drag = (surface: HTMLElement, dx: number): void => {
    fireEvent.pointerDown(surface, { ...touch, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(surface, { ...touch, clientX: 300 + dx / 2, clientY: 100 });
    fireEvent.pointerMove(surface, { ...touch, clientX: 300 + dx, clientY: 100 });
  };

  it("follows the finger until the commit point, then resists", () => {
    const surface = row();
    drag(surface, -60);
    expect(offsetOf(surface)).toBe(-60);
    fireEvent.pointerUp(surface, { ...touch, clientX: 240, clientY: 100 });

    drag(surface, -200);
    // Past the 96px commit point the row moves at about a third of the finger's pace.
    expect(offsetOf(surface)).toBeLessThan(-96);
    expect(offsetOf(surface)).toBeGreaterThan(-200 + 60);
  });

  it("the label being committed to settles to full size only once the commit point is crossed", () => {
    const surface = row();
    const send = screen.getByTestId("swipe-reveal-send").querySelector(".swipe-label")!;
    drag(surface, -60);
    expect(send).not.toHaveAttribute("data-armed");
    drag(surface, -200);
    expect(send).toHaveAttribute("data-armed");
    expect(screen.getByTestId("swipe-reveal-dismiss").querySelector(".swipe-label")).not.toHaveAttribute("data-armed");
  });

  it("letting go short of the commit point settles back with a transition and no overshoot", () => {
    const surface = row();
    drag(surface, -60);
    fireEvent.pointerUp(surface, { ...touch, clientX: 240, clientY: 100 });
    expect(surface.style.transform).toBe("");
    expect(surface.className).toContain("swipe-settle");
    expect(screen.getByTestId("swipe-reveal-send").querySelector(".swipe-label")).not.toHaveAttribute("data-armed");
  });

  it("the decision is the finger's travel, not the resisted row's: a full swipe still sends", async () => {
    const send = vi.fn(async () => {});
    render(
      <SwipeRow dismiss={null} send={send}>
        <span>row</span>
      </SwipeRow>,
    );
    const surface = screen.getByTestId("swipe-surface");
    drag(surface, -110);
    fireEvent.pointerUp(surface, { ...touch, clientX: 190, clientY: 100 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
