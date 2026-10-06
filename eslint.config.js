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

/*
 * #43: this client must never know what Slack is. Channels are the core's
 * concern (digital-duo #168): the daemon sends a channel kind and an
 * adapter-supplied label, and this repository renders both without
 * recognising either — adding a channel to the core must require no
 * change here. Same class of rule as AR-13 above, and for the same
 * reason: a principle with a failing lint is a principle.
 *
 * The selectors match external product names wherever code can carry
 * them — string literals, template quasis, JSX text, identifiers, JSX
 * element and attribute names — so a `slackIcon` import, a
 * `<SlackBadge/>`, a `data-slack` attribute, or copy that names a
 * product all fail, with the message saying why. Icons need no selector
 * of their own: a channel-specific icon reaches this client only through
 * one of these shapes (the #34 law already bars hand-rolled `<svg>`).
 *
 * Two boundaries are deliberate:
 *
 * - Comments are invisible to the AST, so documentation that names a
 *   product to explain this very rule stays legal — "no matches outside
 *   documentation" is structural, not a filter.
 * - The list is a BLOCKLIST of external product names, never an allowlist
 *   of kinds: the native kind is ours (first-class, not a bridge — the
 *   issue's clarification after #57) and every kind this client has
 *   never seen must pass through untouched, so both are permitted by
 *   construction, not by enumeration. The names are curated for
 *   unambiguity (no "signal", which collides with Mirror's weak
 *   signals, no "line", which is a common word) — the list is the
 *   products a reader would recognise, not an exhaustive registry.
 *
 * Scoped to `src/` only: tests speak the DAEMON'S side of the wire, and
 * a fixture may legitimately carry `channelKind: "slack"` — that is the
 * core's data crossing the seam, not this client's knowledge.
 */
const externalChannelProduct =
  "slack|discord|telegram|whatsapp|imessage|skype|teams|msteams|email|gmail|outlook|wechat";
const channelsBelongToTheCore =
  "names a messaging product — channels belong to the core, not this client (#43): the daemon sends the kind and the adapter's label; render them verbatim, add nothing keyed on either.";
/**
 * The same rule for hosted mode's account layer, minus "email": there the
 * word is a Google account's address (sign-in identity, invite locking),
 * which the daemon's own contract names `email` — not a messaging channel.
 * Every other product name stays forbidden, and only these files get
 * the carve-out.
 */
const accountLayerFiles = ["src/api/hosted.ts", "src/components/InvitePeople.tsx", "src/routes/Admin.tsx"];
const channelProductExceptAccountAddress = externalChannelProduct.replace("|email|", "|");
const noExternalChannelNamesInAccountLayer = [
  { selector: `Literal[value=/\\b(${channelProductExceptAccountAddress})\\b/i]`, message: `This string ${channelsBelongToTheCore}` },
  { selector: `JSXText[value=/\\b(${channelProductExceptAccountAddress})\\b/i]`, message: `This text ${channelsBelongToTheCore}` },
  { selector: `TemplateElement[value.cooked=/\\b(${channelProductExceptAccountAddress})\\b/i]`, message: `This template ${channelsBelongToTheCore}` },
  { selector: `Identifier[name=/${channelProductExceptAccountAddress}/i]`, message: `This name ${channelsBelongToTheCore}` },
  { selector: `JSXOpeningElement[name.name=/${channelProductExceptAccountAddress}/i]`, message: `This element ${channelsBelongToTheCore}` },
  { selector: `JSXAttribute[name.name=/${channelProductExceptAccountAddress}/i]`, message: `This attribute ${channelsBelongToTheCore}` },
];
const noExternalChannelNames = [
  { selector: `Literal[value=/\\b(${externalChannelProduct})\\b/i]`, message: `This string ${channelsBelongToTheCore}` },
  { selector: `JSXText[value=/\\b(${externalChannelProduct})\\b/i]`, message: `This text ${channelsBelongToTheCore}` },
  { selector: `TemplateElement[value.cooked=/\\b(${externalChannelProduct})\\b/i]`, message: `This template ${channelsBelongToTheCore}` },
  { selector: `Identifier[name=/${externalChannelProduct}/i]`, message: `This name ${channelsBelongToTheCore}` },
  { selector: `JSXOpeningElement[name.name=/${externalChannelProduct}/i]`, message: `This element ${channelsBelongToTheCore}` },
  { selector: `JSXAttribute[name.name=/${externalChannelProduct}/i]`, message: `This attribute ${channelsBelongToTheCore}` },
];

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
  // Flat configs override, not merge, the same rule for the same file —
  // so this block carries BOTH selector sets: inside `src/` the AR-13
  // composition rule and the channel-vocabulary rule apply together,
  // while tests keep only AR-13 (their fixtures speak the daemon's wire).
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...duoNeverPosesAsAPerson, ...noExternalChannelNames],
    },
  },
  {
    files: accountLayerFiles,
    rules: {
      "no-restricted-syntax": ["error", ...duoNeverPosesAsAPerson, ...noExternalChannelNamesInAccountLayer],
    },
  },
  /*
   * #320: features reach the host only through `getPlatform()`
   * (src/platform/), so each is written once and works in the browser, the
   * Mac app and the phone app alike. The two exceptions are the Mac shell's
   * own window plumbing — tray, menu, cross-window events — which has no
   * meaning on any other platform.
   */
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: ["src/platform/**", "src/shell/native.ts", "src/tray.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tauri-apps/*"],
              message: "Use getPlatform() from src/platform/ — a feature never talks to Tauri directly (#320).",
            },
          ],
        },
      ],
    },
  },
);
