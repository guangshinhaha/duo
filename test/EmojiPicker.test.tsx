import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmojiPicker } from "../src/components/EmojiPicker.js";

afterEach(() => {
  cleanup();
});

/*
 * #291: the full picker behind the quick six's "+" — search finds any
 * emoji in the dataset (not just the six quick-react choices), and recent
 * picks lead the grid until a search narrows it.
 */
describe("#291 — EmojiPicker", () => {
  it("renders far more than the fixed six, and picking one calls onPick with the emoji", () => {
    const onPick = vi.fn();
    render(<EmojiPicker recents={[]} onPick={onPick} />);

    const grid = screen.getByTestId("emoji-picker-grid");
    expect(within(grid).getAllByTestId("emoji-picker-option").length).toBeGreaterThan(1000);

    const thumbsUp = within(grid).getByRole("button", { name: "thumbs up" });
    fireEvent.click(thumbsUp);
    expect(onPick).toHaveBeenCalledWith("👍");
  });

  it("search narrows the grid to matching names, by whole word or part of the name", () => {
    render(<EmojiPicker recents={[]} onPick={vi.fn()} />);
    const search = screen.getByTestId("emoji-picker-search");

    fireEvent.change(search, { target: { value: "red heart" } });
    const grid = screen.getByTestId("emoji-picker-grid");
    const names = within(grid)
      .getAllByTestId("emoji-picker-option")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toContain("red heart");
    expect(names.length).toBeLessThan(10);
  });

  it("a search that matches nothing says so, rather than showing an empty grid silently", () => {
    render(<EmojiPicker recents={[]} onPick={vi.fn()} />);
    fireEvent.change(screen.getByTestId("emoji-picker-search"), { target: { value: "zzzznotanemoji" } });
    expect(screen.queryAllByTestId("emoji-picker-option")).toHaveLength(0);
    expect(screen.getByText("Nothing matched.")).toBeInTheDocument();
  });

  it("recent picks lead the picker until a search is typed, then the recents row drops away", () => {
    render(<EmojiPicker recents={["🔥", "👍"]} onPick={vi.fn()} />);
    const recents = screen.getByTestId("emoji-picker-recents");
    expect(within(recents).getAllByTestId("emoji-picker-option").map((b) => b.textContent)).toEqual(["🔥", "👍"]);

    fireEvent.change(screen.getByTestId("emoji-picker-search"), { target: { value: "heart" } });
    expect(screen.queryByTestId("emoji-picker-recents")).not.toBeInTheDocument();
  });
});
