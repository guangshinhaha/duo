// @ts-expect-error no node types by design
import { readFileSync, readdirSync, statSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { DuoLine } from "../src/components/DuoLine.js";
import { DuoMessage } from "../src/components/DuoMessage.js";
import { Mark } from "../src/components/Mark.js";
import { OwnerMessage } from "../src/components/OwnerMessage.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe("Hairline — the duo always writes behind a line (#140)", () => {
  it("carries an attribution line with the mark, and a leading line in the state colour", () => {
    render(
      <DuoLine label="Your duo" meta="draft · 2m" state="hedged" testId="dl" attributionTestId="dl-attr">
        Thursday probably works.
      </DuoLine>,
    );
    expect(screen.getByTestId("dl-attr")).toHaveTextContent("Your duo");
    expect(screen.getByTestId("dl-attr")).toHaveTextContent("draft · 2m");
    expect(screen.getByTestId("dl-attr").querySelector('[data-testid="duo-mark"]')).not.toBeNull();
    const line = screen.getByTestId("dl");
    expect(line).toHaveAttribute("data-duo-line", "hedged");
    const block = line.querySelector(".shape-duo-line") as HTMLElement;
    expect(block.style.getPropertyValue("--duo-line")).toBe("var(--escalate)");
    expect(block.style.getPropertyValue("--duo-line-opacity")).toBe("0.4");
  });

  it("has no prop through which an avatar, initials or a person's name could be passed", () => {
    type Keys = keyof ComponentProps<typeof DuoLine>;
    const allowed: Keys[] = ["label", "meta", "aside", "state", "testId", "attributionTestId", "compact", "children"];
    expect(allowed).toHaveLength(8);
    // A compile-time guarantee: widening DuoLine's props to accept an
    // avatar would make this exhaustiveness check a visible diff.
    const exhaustive: Record<Keys, true> = { label: true, meta: true, aside: true, state: true, testId: true, attributionTestId: true, compact: true, children: true };
    expect(Object.keys(exhaustive).sort()).toEqual([...allowed].sort());
  });

  it("a duo's mark is not a person's avatar: it renders no initials", () => {
    render(<Mark />);
    expect(screen.getByTestId("duo-mark")).toHaveTextContent("");
    expect(screen.getByTestId("duo-mark")).toHaveAttribute("aria-hidden", "true");
  });

  it("DuoMessage renders through DuoLine, and an owner message still cannot render inside it", () => {
    render(<DuoMessage>Five days per quarter.</DuoMessage>);
    expect(screen.getByTestId("duo-message")).toHaveAttribute("data-duo-line", "neutral");
    expect(() =>
      render(
        <DuoLine label="Your duo" testId="x" attributionTestId="x-attr">
          <OwnerMessage>never</OwnerMessage>
        </DuoLine>,
      ),
    ).toThrow(/AR-13/);
  });

  it("nothing but DuoLine sets the duo-authored boundary — 'renders duo text' and 'renders through DuoLine' are one fact", () => {
    const users = walk(join(root, "src"))
      .filter((path: string) => /<DuoAuthoredBoundary[\s>]/.test(readFileSync(path, "utf8")))
      .map((path: string) => path.slice(join(root, "src").length + 1));
    expect(users).toEqual(["components/DuoLine.tsx"]);
  });

  it("no source file uses a raw hex colour: colour comes from the tokens", () => {
    const offenders = walk(join(root, "src"))
      .filter((path: string) => /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/.test(readFileSync(path, "utf8").replace(/&#\d+;|&#39;|\/\/.*|\/\*[\s\S]*?\*\//g, "")))
      .map((path: string) => path.slice(join(root, "src").length + 1));
    expect(offenders).toEqual([]);
  });
});
