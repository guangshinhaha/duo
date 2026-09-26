import { render, screen } from "@testing-library/react";
import { Linter } from "eslint";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error the lint config is deliberately @ts-check JS with no declaration — its shape is exercised at runtime by the Linter tests below
import eslintConfig from "../eslint.config.js";
import { OwnerMessage } from "../src/components/OwnerMessage.js";
import { RoomPersonMessage } from "../src/components/RoomPersonMessage.js";
import { RoomDuoMessage } from "../src/components/RoomDuoMessage.js";
import { DuoMessageReference } from "../src/components/DuoMessageReference.js";

/*
 * #60: AR-13 extended to a shared room, where the stakes are highest — a
 * colleague reading a channel has no context, no Mirror, and no reason to
 * be suspicious. A duo's message must be structurally distinct (a different
 * container, not a badge), whose-duo-it-is must be unmissable, the rule
 * must be enforced (lint + runtime guard, both extended to the multi-party
 * components), and the attribution must travel into quotes, replies,
 * notifications and search hits.
 */

/** A shared room fixture: two people, each with their duo talking. */
function Room() {
  return (
    <div data-testid="room">
      <RoomPersonMessage authorName="Ana">What&apos;s our refund policy?</RoomPersonMessage>
      <RoomDuoMessage ownerName="Ana">Refunds within 30 days.</RoomDuoMessage>
      <RoomPersonMessage authorName="Bose">And leave accrual?</RoomPersonMessage>
      <RoomDuoMessage ownerName="Bose">Leave accrues at 1.25 days per month.</RoomDuoMessage>
    </div>
  );
}

describe("#60 — a duo in a shared room is never mistaken for its owner", () => {
  it("a duo's message is a different container from a person's, not the same one with a badge", () => {
    render(<Room />);
    const duo = screen.getAllByTestId("room-duo-message")[0];
    const person = screen.getAllByTestId("room-person-message")[0];
    // Structurally distinct (Hairline, #140): a duo's message is a
    // `DuoLine` — a square-edged block behind a line — and a person's never
    // is. The line is the label, so it survives greyscale.
    expect(duo).toHaveAttribute("data-duo-line");
    expect(duo.querySelector(".shape-duo-line")).not.toBeNull();
    expect(person).not.toHaveAttribute("data-duo-line");
    expect(person.querySelector(".shape-duo-line")).toBeNull();
    expect(duo.className).not.toBe(person.className);
  });

  it("whose duo it is, is unmissable — the owner appears only as the possessive, never as the author", () => {
    render(<Room />);
    const attributions = screen
      .getAllByTestId("room-duo-message-attribution")
      .map((node) => node.textContent);
    expect(attributions).toEqual(["Ana's duo", "Bose's duo"]);
    // The owner's name never stands alone as an author line inside the
    // duo's message — "Ana" the author and "Ana's duo" the attribution are
    // different claims, and only the second is ever rendered.
    for (const message of screen.getAllByTestId("room-duo-message")) {
      expect(message.textContent).not.toMatch(/^Ana$/);
      expect(message.textContent).not.toMatch(/^Bose$/);
    }
  });

  it("has no prop through which an owner identity or avatar could be passed", () => {
    // Structural, not behavioral — same property DuoMessage.test.tsx pins
    // for the single-owner case. `satisfies` makes the key set
    // compile-time exact, so widening a duo-authored component's props is a
    // conscious, visible diff.
    expect(Object.keys({ ownerName: "", children: null } satisfies ComponentProps<typeof RoomDuoMessage>)).toEqual([
      "ownerName",
      "children",
    ]);
    expect(Object.keys({ ownerName: "", children: null } satisfies ComponentProps<typeof DuoMessageReference>)).toEqual([
      "ownerName",
      "children",
    ]);
  });

  it("the attribution travels: quoting, replying, a notification, a search hit all carry the label", () => {
    render(
      <div>
        {/* A person quoting a duo's message */}
        <RoomPersonMessage authorName="Bose">
          <DuoMessageReference ownerName="Ana">Refunds within 30 days.</DuoMessageReference>
          Forwarding this on — seconded.
        </RoomPersonMessage>
        {/* A person replying to a duo's message */}
        <RoomPersonMessage authorName="Ana">
          <DuoMessageReference ownerName="Bose">Leave accrues at 1.25 days per month.</DuoMessageReference>
          Replying to this — thanks, checking with HR.
        </RoomPersonMessage>
        {/* A notification row */}
        <div data-testid="notification">
          <DuoMessageReference ownerName="Ana">Refunds within 30 days.</DuoMessageReference>
        </div>
        {/* A search-result row */}
        <div data-testid="search-hit">
          <DuoMessageReference ownerName="Bose">Leave accrues at 1.25 days per month.</DuoMessageReference>
        </div>
      </div>,
    );
    // Every embedding carries the attribution — a label that survives only
    // in the main timeline is not a label.
    expect(screen.getByTestId("notification").textContent).toContain("Ana's duo");
    expect(screen.getByTestId("search-hit").textContent).toContain("Bose's duo");
    const quotes = screen.getAllByTestId("duo-message-reference-attribution").map((node) => node.textContent);
    expect(quotes).toContain("Ana's duo");
    expect(quotes).toContain("Bose's duo");
    // And the reference is still the distinct container, even embedded in a
    // person's message — not the person's own chrome.
    for (const reference of screen.getAllByTestId("duo-message-reference")) {
      expect(reference).toHaveAttribute("data-duo-line");
      expect(reference.querySelector(".shape-duo-line")).not.toBeNull();
    }
  });
});

describe("#60 — enforcement, not documentation", () => {
  const consoleError = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("the runtime guard fires for a person component inside RoomDuoMessage, even through a wrapper the lint rule cannot see", () => {
    // Same cross-file gap DuoMessage.test.tsx's Bubble closes for the
    // single-owner case: neither half of this composition contains a
    // literal nesting for the static selector to match.
    function Bubble({ children }: { children: ReactNode }) {
      return <RoomDuoMessage ownerName="Ana">{children}</RoomDuoMessage>;
    }
    const spy = consoleError();
    expect(() =>
      render(
        <Bubble>
          <OwnerMessage>should never render</OwnerMessage>
        </Bubble>,
      ),
    ).toThrow(/must never render inside a duo-authored message/);
    spy.mockRestore();
  });

  it("the runtime guard fires for a person component inside a quote/reference of a duo's message", () => {
    function QuoteBubble({ children }: { children: ReactNode }) {
      return <DuoMessageReference ownerName="Ana">{children}</DuoMessageReference>;
    }
    const spy = consoleError();
    expect(() =>
      render(
        <QuoteBubble>
          <RoomPersonMessage authorName="Ana">should never render</RoomPersonMessage>
        </QuoteBubble>,
      ),
    ).toThrow(/must never render inside a duo-authored message/);
    spy.mockRestore();
  });

  it("a person quoting a duo is fine — the forbidden direction is person-inside-duo, not duo-inside-person", () => {
    // No throw, no console error: a person's message embedding a labelled
    // reference to a duo's message is exactly the designed composition.
    const spy = consoleError();
    render(
      <RoomPersonMessage authorName="Ana">
        <DuoMessageReference ownerName="Ana">Refunds within 30 days.</DuoMessageReference>
      </RoomPersonMessage>,
    );
    expect(screen.getByTestId("duo-message-reference")).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe("#60 — the lint rule reaches the multi-party components", () => {
  // Lint the REAL exported config — not a restatement of it — so this test
  // pins what `npm run lint` actually enforces.
  const linter = new Linter({ configType: "flat" });
  const ar13Errors = (code: string) =>
    linter.verify(code, eslintConfig as never, { filename: "fixture.tsx" }).filter((message) => /AR-13/.test(message.message));

  const cases: [string, string][] = [
    ["OwnerMessage inside RoomDuoMessage", `<RoomDuoMessage ownerName="a"><OwnerMessage>x</OwnerMessage></RoomDuoMessage>`],
    ["RoomPersonMessage inside RoomDuoMessage", `<RoomDuoMessage ownerName="a"><RoomPersonMessage authorName="a">x</RoomPersonMessage></RoomDuoMessage>`],
    ["OwnerMessage inside DuoMessageReference", `<DuoMessageReference ownerName="a"><OwnerMessage>x</OwnerMessage></DuoMessageReference>`],
    ["RoomPersonMessage inside DuoMessageReference", `<DuoMessageReference ownerName="a"><RoomPersonMessage authorName="a">x</RoomPersonMessage></DuoMessageReference>`],
    ["RoomPersonMessage inside DuoMessage", `<DuoMessage><RoomPersonMessage authorName="a">x</RoomPersonMessage></DuoMessage>`],
  ];

  it.each(cases)("%s fails lint with the AR-13 message", (_name, jsx) => {
    const code = `export function Fixture() { return ${jsx}; }`;
    const errors = ar13Errors(code);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("a duo never poses as a person");
  });

  it("the original single-owner case still fails, and the designed compositions do not", () => {
    expect(
      ar13Errors(`export function Fixture() { return <DuoMessage><OwnerMessage>x</OwnerMessage></DuoMessage>; }`),
    ).toHaveLength(1);
    // A duo's message in the timeline, and a person embedding a labelled
    // reference to a duo's message, are the designed compositions — no
    // AR-13 error for either.
    expect(ar13Errors(`export function Fixture() { return <RoomDuoMessage ownerName="a">x</RoomDuoMessage>; }`)).toHaveLength(0);
    expect(
      ar13Errors(
        `export function Fixture() { return <RoomPersonMessage authorName="a"><DuoMessageReference ownerName="a">x</DuoMessageReference></RoomPersonMessage>; }`,
      ),
    ).toHaveLength(0);
  });
});
