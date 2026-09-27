import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether the current render is inside a `DuoMessage`'s subtree. This is
 * the runtime half of the AR-13 labelling contract — the ESLint
 * `no-restricted-syntax` rule (`eslint.config.js`) is a static, JSX-AST
 * check: it matches `<DuoMessage>` and `<OwnerMessage>` appearing as
 * ancestor/descendant JSX nodes *in the same syntax tree*, however deep
 * — so it catches `<DuoMessage><OwnerMessage/></DuoMessage>` even through
 * an inline wrapper written in the same expression. What it cannot catch
 * is composition *across* a component boundary: a `Bubble` component
 * whose own source is `<DuoMessage>{children}</DuoMessage>` (no literal
 * `<OwnerMessage>` node in sight), used elsewhere as
 * `<Bubble><OwnerMessage/></Bubble>` (no literal `<DuoMessage>` node in
 * sight either) — neither call site gives the static rule anything to
 * match, though React still mounts `OwnerMessage` inside `DuoMessage`'s
 * tree at runtime. Context propagates through the actual component tree
 * regardless of which file wrote which half, so `OwnerMessage` checking
 * this at render time closes exactly that gap.
 */
const InsideDuoMessage = createContext(false);

/**
 * Marks everything rendered below as duo-authored — the runtime AR-13
 * boundary. Every component that renders duo-generated text (`DuoMessage`,
 * and since #60 the multi-party `RoomDuoMessage` and `DuoMessageReference`)
 * wraps its content in this, so a person-identity component mounted
 * anywhere beneath it — directly, or through wrappers the lint rule can't
 * see through — fails at render time instead of silently posing.
 */
export function DuoAuthoredBoundary({ children }: { children: ReactNode }) {
  return <InsideDuoMessage.Provider value={true}>{children}</InsideDuoMessage.Provider>;
}

/** A person-identity component's own runtime half of the guard — see `InsideDuoMessage`'s doc comment above. */
export function useAssertNotInsideDuoMessage(componentName: string): void {
  if (useContext(InsideDuoMessage)) {
    throw new Error(
      `${componentName} must never render inside a duo-authored message's subtree (AR-13: a duo never poses as a person)`,
    );
  }
}
