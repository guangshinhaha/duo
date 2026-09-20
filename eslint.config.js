// @ts-check
import tseslint from "typescript-eslint";

/**
 * The one rule that matters here: a duo-authored message's doc comment
 * promises that its subtree can never render a person-identity component.
 * AR-13 (`client-design.md`) is "a principle with a failing test is a
 * principle; one in a style guide is a hope," and a lint rule is the same
 * idea applied to what gets *written*.
 *
 * `no-restricted-syntax` with JSX-descendant selectors, not
 * `no-restricted-imports`: the real invariant is about *composition* — a
 * person-identity component (`OwnerMessage`, and since #60 the
 * multi-party `RoomPersonMessage`) must never render inside a
 * duo-authored one (`DuoMessage`, `RoomDuoMessage`, or a
 * `DuoMessageReference` quote/notification/search hit) — not about which
 * files are allowed to import which module. The selectors match
 * ancestor/descendant JSX nodes *within one syntax tree*, at any depth,
 * so the violation is caught the moment it's typed, in any file, even
 * through an inline wrapper written in the same expression.
 *
 * They cannot catch composition *across* a component boundary, though: a
 * `Bubble` whose own source is `<RoomDuoMessage>{children}
 * </RoomDuoMessage>` (no literal person component in sight) used
 * elsewhere as `<Bubble><RoomPersonMessage/></Bubble>` gives this rule
 * nothing to match at either call site, though React still mounts one
 * inside the other at runtime. `DuoMessage.tsx`'s `InsideDuoMessage`
 * context — set by every duo-authored component via
 * `DuoAuthoredBoundary` — is the runtime half that closes that gap
 * regardless of indirection: this rule is the fast, dev-time layer; that
 * one is the complete guarantee.
 */
const duoNeverPosesAsAPerson = ["OwnerMessage", "RoomPersonMessage"].flatMap((personComponent) =>
  ["DuoMessage", "RoomDuoMessage", "DuoMessageReference"].map((duoComponent) => ({
    selector: `JSXElement[openingElement.name.name='${duoComponent}'] JSXElement[openingElement.name.name='${personComponent}']`,
    message: `${personComponent} must never render inside ${duoComponent}'s subtree — a duo never poses as a person (AR-13; see DuoMessage's doc comment).`,
  })),
);

export default tseslint.config(
  // `src-tauri/target/**` is cargo build output (vendored/bundled JS among
  // the artifacts); linting generated files can only ever produce noise.
  { ignores: ["dist/**", "src-tauri/target/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...duoNeverPosesAsAPerson],
    },
  },
);
