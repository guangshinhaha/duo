# Motion plan: making Duo feel sleeker

> Status: **superseded**. What shipped is recorded in `design-language.md` §3.1 and §3.4; this file is the audit and the reasoning that led to it, kept for history. Deviations from it are listed below.
>
> Originally: proposed, 2026-09-30. It extends `design-language.md` §3.4 and does not override it.
> It was drafted with the `motion-design` skill (`.agents/skills/motion-design`). Where the skill
> and Hairline disagree, Hairline wins, and each case is called out below.

## 0. Where we are

This is an audit of every animation, transition and keyframe in `src/` and `public/welcome.html`.

| Surface | Motion today |
|---|---|
| App: skeletons (`RouteLoading`, `WaitingHome`) | Tailwind `animate-pulse` loop |
| App: `SwipeRow` | A snap-back `transition-transform` |
| App: dialogs, the Why? sheet, menus, tooltips, toasts | **None.** Radix mounts and unmounts them instantly |
| App: route changes, phone push and pop, the Info column | **None.** They hard-cut |
| App: draft arrival, draft resolution, the Waiting count | **None**, although §3.4 specs *Draft arrives* and *Waiting on you clears* |
| App: the loading hairline (§3.1, "the only looping motion") | **Not built.** The pulse skeletons loop instead, which contradicts §3.1 |
| Landing (`welcome.html`) | Hover colour fades, and one fade-up with a hairline draw when a demo chip is clicked |

The one timing token is `--t: 150ms cubic-bezier(0.2, 0, 0, 1)`. The reduced-motion kill switch is
global and tested (`test/Accessibility.test.tsx`).

**Diagnosis.** The app doesn't feel sleek because of what's missing, not because anything is
wrong. Things appear and disappear with no spatial story: a dialog is simply there, a sent draft
simply vanishes, and a phone push is a cut. In the skill's terms, the primary layer is missing.
The fix is a small motion system applied consistently, not decoration.

## 1. The motion identity

**Emotional target.** The product should feel *calm and certain*, like a considered colleague
rather than a toy. The skill's closest archetype is **Corporate, leaning Premium**: no bounce, no
overshoot on operational UI, and short durations with confident deceleration.

**Hairline overrides the skill here.**

- The skill says "always three motion layers (primary, secondary, ambient)." Hairline's P3 is
  "Quiet until it matters," so **operational UI gets no ambient layer.** The one sanctioned loop
  stays the loading hairline. Ambient motion lives on the landing page only, as an editorial
  surface.
- The skill recommends playful overshoot for success states. Here, a sent reply goes to a real
  person, so success is *settled*, not celebrated. There is no confetti, and §3.4 already says so.

### 1.1 Tokens to add to `tokens.css`

These are the skill's three brand constants: one signature curve, a three-step duration palette,
and one entrance pattern.

```css
:root {
  /* Curves: standard for on-screen changes, decelerate for arrivals, accelerate for exits. */
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);      /* the signature curve; ~80% of motion */
  --ease-enter:    cubic-bezier(0.05, 0.7, 0.1, 1); /* MD3 emphasized decelerate */
  --ease-exit:     cubic-bezier(0.3, 0, 1, 1);      /* MD3 accelerate */

  /* Durations: quick, standard, slow. Exits run about 30% shorter than entrances. */
  --dur-quick: 120ms;  /* press, hover, tooltips, menus */
  --dur-std:   200ms;  /* entries arriving, dialogs, toasts, pane changes */
  --dur-slow:  320ms;  /* sheets, the hairline draw, the demotion cross-fade */

  --t: var(--dur-quick) var(--ease-standard);  /* kept as an alias: the one shipped token */

  /* The entrance pattern: rise 8px and fade in. Nothing enters from the side except a phone push. */
  --rise: 8px;
}
```

Add matching `@keyframes` in the same file: `duo-rise-in`, `duo-fade-out`, `duo-sheet-in`,
`duo-sheet-out`, `duo-pop-in` (scale 0.96 to 1 with a fade) and `duo-line-draw` (scaleY 0 to 1,
origin top). Radix sets `data-state="open|closed"` on every part and waits for `animationend`
before it unmounts, so exit animations work with CSS alone.

**Guardrail.** Extend `test/DesignSystem.test.tsx` to ban raw `duration-*`, `ease-*` and inline
`transition: …ms` in components. Motion comes from these tokens or it doesn't ship, which is the
same law the type scale already follows.

**Only `transform` and `opacity` animate.** Never animate `width`, `height` or `top`. A collapse
uses `grid-template-rows: 1fr → 0fr`.

## 2. The app, by priority

### P0: the foundation and the missing named moments

| # | Moment | Motion | Where |
|---|---|---|---|
| A1 | **Dialogs** (search ⌘K, new conversation, sign-in, pairing) | The scrim fades in over `--dur-std` and out over 150ms. The panel does `duo-pop-in` with a rise, 200ms `--ease-enter` on the way in and 150ms `--ease-exit` on the way out. | `primitives/Dialog.tsx`, `AlertDialog.tsx`: once in the primitive, every consumer gets it |
| A2 | **Why? sheet on phone** | It slides up from 100% over `--dur-slow` with `--ease-enter`, and slides down over 200ms with `--ease-exit`. The scrim fades. | `WhyButton.tsx`, through a `sheet` variant on `DialogContent` |
| A3 | **Menus and tooltips** | `duo-pop-in` from `var(--radix-dropdown-menu-content-transform-origin)` over `--dur-quick`, with a 100ms fade out. Tooltips don't scale; they fade and shift 2px toward their side (`data-side`). | `DropdownMenu.tsx`, `Tooltip.tsx` |
| A4 | **Toasts** | Slide in 16px from the right with a fade over `--dur-std`. The swipe follows Radix's `--radix-toast-swipe-move-x`, and on release it either snaps back or exits right. | `Toast.tsx` |
| A5 | **Draft arrives** (spec'd in §3.4, not built) | The block rises 8px over 200ms with `--ease-enter`. Its hairline, `.shape-duo-line::before`, draws top to bottom over `--dur-slow`, starting 60ms after the block, so the line lands last. **It runs only for a draft that arrives live**, never on a remount or history load. A `data-arrived` flag is set when a draft id is first seen after the initial render. | `DuoLine.tsx`, `tokens.css`, a small `useArrival(id)` hook |
| A6 | **The duo is working** (the loading hairline in §3.1, not built) | The `Mark`'s hairline draws top to bottom over 400ms and loops, with a `scaleY` of 0→1→0 so it never jumps. This is the one sanctioned loop. | `Mark.tsx` gains a `working` prop, used wherever the duo is drafting or answering |
| A7 | **Skeletons** | Drop `animate-pulse`, because §3.1 says the hairline is the only loop. Skeleton blocks fade in after a 150ms delay, so a fast load never flashes a skeleton, and hold still. Real content replaces them with the entrance pattern. | `RouteLoading.tsx`, `WaitingHome.tsx` |
| A8 | **Press feedback** | Every button and row does `active:scale-[0.98]` over `--dur-quick` and settles over 200ms. Hover colour uses `--t`. The skill says this is the single cheapest thing that makes UI feel responsive. | One `.press` utility in `tokens.css`, applied to the control forms |

### P1: resolving things, and moving between places

| # | Moment | Motion | Where |
|---|---|---|---|
| B1 | **Draft sent** | The action row fades out over 120ms. The tray collapses (`grid-template-rows` 1fr → 0fr) over 200ms with `--ease-standard`. The `DeliveryStateLine` cross-fades in at the same moment, so the reply lands as the draft leaves. That is the *setup → action → resolution* arc. | `DraftTray.tsx`, `DeliveryStateLine.tsx` |
| B2 | **Draft dismissed, with undo** | It collapses the same way, and the undo bar rises in. Undo reverses the collapse at the same duration, so dismissing is visibly reversible. | `DraftTray.tsx`, `SwipeRow.tsx` |
| B3 | **Waiting on you clears** (spec'd in §3.4) | The count ticks: the old digit exits up 6px while the new one enters from below, over 200ms with tabular numerals. At zero, "Nothing waiting on you." rises in after 120ms. No confetti. | `ChatList.tsx` (the Waiting row), `WaitingHome.tsx`, a `<TickingCount>` component |
| B4 | **Phone push and pop** | Push: the new screen enters from +24px x (not the full width, per the skill's ⅓ rule) with a fade over 250ms, `--ease-enter`. Pop reverses that at 200ms. The easiest path is the View Transitions API, since `document.startViewTransition` works in Chromium and in WKWebView (Safari 18+), which Tauri uses. Where it's missing, fall back to no animation. | `ChatShell.tsx`, and the router in `shell/routes.ts` |
| B5 | **Desktop pane change** | Opening a different chat cross-fades the pane content with a 4px rise over 200ms, keyed on the route. The list and the chrome stay still. The **hero** is the content, not the frame. | `ChatShell.tsx`, on `<main data-testid="pane">` |
| B6 | **Info column (⌘I)** | Today it mounts and unmounts. Keep it mounted, and animate a translateX of 16px plus opacity over 200ms, with the column width moving through `grid-template-columns`. The pane resizes once, with no jump. | `ChatShell.tsx` |
| B7 | **Live messages in a room** | A message that arrives while the room is open rises in over 200ms. History never animates. Scroll-to-end on your own send is smooth, not a jump. The room already tracks stickiness in `stickToEnd.ts`. | `Room.tsx`, `stickToEnd.ts` |
| B8 | **Offline bar** | It slides down over 200ms and collapses over 150ms, so the layout below moves once, smoothly. | `OfflineBar.tsx` |
| B9 | **Swipe feel** | Past the threshold, add rubber-band resistance (a factor of about 0.35). When the row crosses the commit threshold, the reveal label scales from 0.92 to 1, standing in for a haptic tick. On release, it settles over 250ms with `--ease-standard` and no overshoot. | `SwipeRow.tsx` |

### P2: the named trust moments and the editorial surfaces

| # | Moment | Motion | Where |
|---|---|---|---|
| C1 | **Demotion** (spec'd in §3.4) | The trust cell cross-fades down one level over 300ms, and the announcing sentence rises in at the same moment. It's firm, with no shake, because a demotion is an announcement, not an error. | `profile/MayDo.tsx`, `profile/Activity.tsx` |
| C2 | **Rule and candidate decided** | On Approve or Reject, the card's buttons fade out, the card dims to 0.55 over 200ms, and the decided line rises in. If the card leaves the list, it collapses after 400ms. | `RuleCard.tsx`, `CandidateCard.tsx` |
| C3 | **Edit diff** | The `del` strike draws left to right, and the `ins` highlight wipes in over 200ms. What your edit taught is shown *happening*. | `EditDiff.tsx` |
| C4 | **Portrait (the Mirror)** | This is a Reflection surface, so it's allowed more. Sentences stagger in at 90ms apart, each rising 12px over 450ms with `--ease-enter`, and the whole cascade stays under 500ms. Numbers count up over 600ms. It runs once per visit. | `profile/Portrait.tsx`, onboarding moments in `Onboarding.tsx` |
| C5 | **⌘K results** | Results cascade in at 20ms apart, capped at 8 rows so the total stays under 200ms. The highlighted row's background moves with `--t` instead of snapping. | `SearchOverlay.tsx` |
| C6 | **Theme switch** | Cross-fade the whole document with a view transition over 200ms, instead of a hard flip. | `theme.ts` |

## 3. The landing page (`public/welcome.html`)

This is a marketing surface, so **ambient motion is allowed** and the budget is larger. It stays a
single dependency-free HTML file: CSS, about 60 lines of vanilla JS, and IntersectionObserver.
There's no GSAP and no Framer. Only `transform` and `opacity` animate, and the existing
reduced-motion block keeps working.

| # | Moment | Motion |
|---|---|---|
| L1 | **Hero entrance** (dramatic stagger) | Eyebrow, then each line of the h1, then the lede, then the CTAs, 100ms apart. Each rises 16px and fades in over 600ms with `--ease-enter`. The demo card starts at 300ms, rising 24px. The whole cascade finishes in under 1s. In the nav, the mark draws first: the bar grows, then the hairline draws. |
| L2 | **The demo plays itself** | This is the biggest change, and the product's story in 8 seconds. When the demo scrolls into view: the question arrives → the Mark's hairline loops ("drafting…") for 900ms → the draft rises in as its hairline draws → the Send button gets a press state → "Sent to Aisha" appears and the count ticks from 1 to 0. Then it moves to the next chip's example. It **stops for good** the moment a visitor clicks anything, and it pauses offscreen. Under reduced motion, the static first state shows. |
| L3 | **Switching chips** | Stop restarting the whole draft. The hairline colour cross-fades over 320ms, and the draft text cross-fades (out 120ms, in 200ms) with the block's height transitioning. The rail's three facts stagger in 40ms apart. |
| L4 | **Edit in the demo** | Same as C3: the strike draws and the insert highlight wipes in. |
| L5 | **Section reveals** | Each section's `.head` and its first block rise 12px and fade in once, when 20% of it is in view. Children stagger 60ms apart. They don't reverse on scroll-up. |
| L6 | **The loop** | As it enters view, the four `.bar` rules fill left to right as one continuous line over 900ms. Each dot lights as the line reaches it, and the last dot turns Signal. A horizontal path reads as progress. |
| L7 | **The Mirror** | Portrait sentences reveal in sequence, 120ms apart. `23` and `61%` count up. The Signal underline under each number draws left to right. |
| L8 | **Approving a rule card** | Press → the card compresses to 0.99 → the buttons fade → the card dims to 0.55 → "Approved…" rises in. This is C2's motion, so the site demonstrates the real app's motion. |
| L9 | **Trust: "Demote fast"** | When the grid scrolls into view, one cell, *Deploy access · Reversible act*, steps down from "On its own" to "Asks you" with the 300ms demotion cross-fade, and its ledger line (`Lost`) highlights briefly. The section's claim acts itself out. |
| L10 | **Ambient** | The hero's Signal-glow radial drifts slowly (a 24s sine loop, ±40px, with opacity from 0.8 to 1). It's the only ambient loop on the page. The CTA box's glow is static. |
| L11 | **Nav and buttons** | The nav's border and blur fade in only after 8px of scroll, so the page opens borderless. Buttons get `active:scale(0.98)`. The primary hover lifts brightness rather than dropping opacity to 0.9, which reads as disabled. |

## 4. How to build it

The plan is ordered so each step ships on its own and is visible in the app.

1. **Tokens and primitives** (§1.1, A1–A4, A8). This is one PR, and the whole app immediately
   feels different. Add the DesignSystem test rule in the same PR.
2. **Draft lifecycle** (A5–A7, B1–B3). This is the product's core loop: arrive, work, resolve,
   clear.
3. **Navigation** (B4–B8). Spike View Transitions in the Tauri WKWebView first. If it misbehaves,
   fall back to keyed CSS entrances only.
4. **Landing** (L1–L11). This is independent of 1–3 and can run in parallel.
5. **Trust and editorial** (B9, C1–C6).
6. Update `design-language.md` §3.4 with the tokens and the final list of named moments, so the
   rule and the code stay one fact.

**No new dependencies.** Radix already handles presence for exit animations, CSS covers
everything in P0 and P1, and View Transitions are native. Framer Motion would add about 40kB to
the bundle for springs we've decided not to use.

**Verification for each step:**

- Existing tests stay green. These are CSS-only changes, and happy-dom doesn't run animations.
- `test/Accessibility.test.tsx`'s reduced-motion block still covers everything.
- `test/DesignSystem.test.tsx` gains the token-only rule.
- Check each step by eye in a real browser and in the Tauri shell, at 1× and at 0.25× speed
  (Chrome DevTools → Animations). The skill's quality checks are: no linear spatial motion, exits
  shorter than entrances, total staggers under 500ms in the app, and no more than ⅓ of the
  elements on screen moving at once.

## What shipped differently from this plan

- **Phone push and pop** use keyed CSS entrances, not the View Transitions API: the Tauri WKWebView path
  could not be tested, so it was not adopted. Only entrances animate; the departing screen cannot.
- **Undo (B2)**: a dismissal is held in the tray for its undo window and recorded only when that ends, so the
  collapse happens after the window and there is nothing to reverse on Undo.
- **Count to zero (B3)**: the figure leaves and nothing replaces it, instead of showing a literal 0.
- **Portrait rise (C4)** uses the shared 8px entrance instead of 12px.
- **The duo route's tray-to-answer swap** inside a turn did not gain a collapse.
- **Landing page (L1 to L11)**: autoplay runs at every width; layout shift is lower than before but not zero
  (the web-font swap remains); one trust cell (Deploy access, Answer) stays demoted after the demo.
