# Hairline — the Digital Duo design language

> Status: proposed, 2026-09-26. Extends, never overrides, `client-design.md` §1.5–1.6,
> `client-tech-design.md` Part 4 (the tokens) and `vocabulary.md` (the words). Where this doc and
> those disagree, those win until this one is ratified.

The product has two voices on every screen: a person, and that person's duo. Everything in this
language exists to do two jobs. It keeps those voices **impossible to confuse**, and it keeps what
connects them, the evidence, **one glance away**.

The name comes from the one element the product already ships that nobody else has: the
**confidence hairline**, the 2px line on a draft's leading edge. This language promotes that
line from a component detail to the product's signature. **The duo always writes behind a line.**

---

## 1. Principles

Each principle is testable. If a design can't be checked against it, the principle isn't doing
its job.

| # | Principle | What it means on screen | How to check |
|---|---|---|---|
| P1 | **Attributed, always** | Generated text sits behind the hairline and under an attribution line ("Your duo", "{owner}'s duo"). Nothing else in the product uses a leading line. | Cover the words. You should still be able to tell which blocks the duo wrote. |
| P2 | **Why costs zero clicks** | Provenance ("Drew on 3 sources", rules hit, confidence reading) is on screen by default: a rail on desktop, a drawer on phone. It is never behind a disclosure triangle. | Screenshot any draft. Can someone answer "why did it say that?" from the screenshot? |
| P3 | **Quiet until it matters** | The UI is greyscale with one accent (Signal), which means *action available*. Attention is batched: one count (Waiting on you) and digests rather than a stream. | Squint at a screen. The only colour you see should be the thing waiting on you. |
| P4 | **Decisions, not settings** | Trust changes when the owner answers a concrete example (approve this rule, accept this offer). It never happens through a toggle on an abstract grid. | Search the UI for a switch that changes what the duo may do. There should be none. |
| P5 | **Cautious by design** | Promotions arrive as *offers*. Demotions arrive as *announcements*. Irreversible acts take two steps with Cancel focused, and they are disabled rather than queued when offline. | Every T4 path has two screens, and neither has the primary action focused. |
| P6 | **Keyboard-first, touch-complete** | Every draft, rule and offer action has a single key. Every one of them also has a visible control of at least 44px on phone. | Clear Review with the trackpad unplugged. Then clear it one-handed on a phone. |

Two rules sit above the principles, inherited from `vocabulary.md`. **A duo is never called an
employee, assistant or teammate**, and **it never speaks as the owner.** The visual language
enforces the second rule structurally: duo output never carries the owner's avatar or any
person's photo, and it never shares a container with the owner's words. A desk duo may carry the avatar its owner
picked — a glyph or image drawn inside the duo mark's frame — on the roster and its profile. Its messages still lead
with the mark and attribution line.

---

## 2. What we borrow, and from whom

Good products have already solved pieces of this problem. We borrow the mechanism, never the look.

| Reference | What they got right | What we take | Where it lands | What we leave |
|---|---|---|---|---|
| **Granola** | Your notes render in black; AI-enhanced text renders in grey. Authorship is legible at a glance. | Authorship as a *visual register*, not a badge. | P1, the hairline, the duo's text treatment | Colour alone as the signal. Ours is structural, so it survives greyscale and colour-blindness. |
| **Superhuman** | Inbox triage as a game you can win. One key per verb. "Inbox Zero" as a reward. | Single-key triage, J/K movement, a calm "Nothing waiting on you" end state. | Review, Corrections, Mirror | Undo-send. A send here posts to a real person, so we don't pretend a timer makes it reversible. |
| **Linear** | Restraint: one accent, dense but airy lists, ⌘K for everything, Triage as its own inbox. | A single count for what waits on you, ⌘K, and the single accent. | IA (Review above Conversations), search | Linear's density. Our list holds a handful of considered drafts, not hundreds of issues. |
| **GitHub** (suggested changes) | A reviewer's edit renders as a diff that can be accepted in one click. | Edits shown as diffs, and "what your edit taught" as a reviewable object. | Edit-to-teach, Corrections | Code-review chrome: no line numbers, no file trees. |
| **Stripe** (dashboard, test mode) | A persistent, unmissable banner tells you which mode you're in. Every object has an id and a log. | A persistent *mode ribbon* for whose voice you're reading, and an event log behind every object. | Attribution line, Audit | Stripe's teal-on-white. |
| **Perplexity** | Numbered citations inline, with sources always visible beside the answer. | Sources beside the answer at zero clicks. | Provenance rail, trust reading on the asker page | Inline footnote numerals in drafts. Drafts are messages, and a colleague shouldn't read "[2]". |
| **Spotify Wrapped / Apple Screen Time** | Your own data, reflected back as a portrait worth screenshotting. | The duo's Portrait as a *portrait*: big editorial sentences built from your own numbers. | Mirror, onboarding | Gamified superlatives ("You're a top 1% answerer!"). |
| **Things 3** | Calm typography, generous whitespace, and a *Today* count that doesn't nag. | Warmth through type and spacing rather than colour. | Global type scale | — |
| **Apple** (permission prompts) | Permission is asked in context, at the moment it matters, in plain words. | Trust offers arrive as a card in your duo's chat. | Promotion offers | Blanket "Allow always". |
| **Raycast** | A command bar that does things, not only finds them. | ⌘K "Search what your duo knows" with actions on results. | Search | — |

---

## 3. Identity

### 3.1 The mark

Two vertical strokes side by side: a solid 3-unit bar (**you**) and a 1-unit hairline (**your
duo**), with a 2-unit gap. The two strokes are the same height and the hairline never leads. It
reads as a pause mark and as a pair, and it draws on the product's own signature element.

```
█ │     you, then your duo
```

- **Wordmark**: `duo`, lowercase, Inter 600, tracking −0.02em, set after the mark.
- **Loading state**: while the duo is working (asking it something), the mark's hairline draws
  top to bottom (400ms), fades and draws again, an 800ms loop. It is the only looping motion in the
  operational product. Skeletons do not loop: they hold still and appear only if a wait lasts
  longer than 150ms.
- **Favicon/app icon**: the mark in Paper on Ink, with the hairline in Signal.

### 3.2 Colour

The product tokens stay exactly as `client-tech-design.md` Part 4 sets them. This section gives
them names, so design and copy can refer to them, and adds a small brand layer for editorial
surfaces (the Mirror and marketing).

| Name | Token | Dark | Light | Role |
|---|---|---|---|---|
| Ink | `--bg` | `#0B0C0E` | `#F7F7F8` | Ground |
| Graphite | `--surface` | `#141619` | `#FFFFFF` | Cards, drafts |
| Slate | `--surface-2` | `#1C1F24` | `#F0F0F2` | Rails, inputs |
| Edge | `--edge` | `#24282E` | `#E2E3E6` | Borders |
| Paper | `--text` | `#E8EAED` | `#17181A` | Primary text |
| Fog | `--muted` | `#A6ACB2` | `#4D5055` | Provenance (AAA, load-bearing) |
| Dust | `--faint` | `#5F6469` | `#8A8D93` | Timestamps, disabled |
| **Signal** | `--accent` | `#7C8CFF` | `#4D5FE0` | **Action available. Nothing else.** |
| Moss | `--confident` | `#4B9E6A` | `#23703F` | Hairline: confident |
| Amber | `--escalate` | `#D9A441` | `#9A6B12` | Hairline: escalated / hedged (40%) |
| Ash | `--refused` | `#6B7280` | `#6B7280` | Hairline: refused |

The three hairline colours are **semantic, not decorative.** They appear only on hairlines and on
the trust reading, never on buttons or headings. Signal never appears on a hairline.

**Brand layer** (editorial surfaces only, never in operational UI):

| Name | Token | Value | Role |
|---|---|---|---|
| Signal glow | `--signal-glow` | `rgba(124,140,255,0.14)` | Soft wash behind a hero mark or a Mirror headline |
| Paper-warm | `--paper-warm` | `#EDEAE4` | Serif display text on Ink in the Mirror and on marketing pages |

### 3.3 Type

Three roles, each with one job.

| Role | Face | Where | Why |
|---|---|---|---|
| **Interface** | Inter (SF Pro on Apple) | Everything operational | Already shipped. Use `font-feature-settings: "cv11", "ss03"` and tabular numerals on counts. |
| **Reflection** | Newsreader (variable, opsz) | The Mirror portrait, the landing page headline, onboarding moments | The Mirror is the one place the product speaks *about you*. It should read like a portrait, not a table. The serif is never used for the duo's own words. |
| **Record** | JetBrains Mono | Identifiers: thread ids, asker refs, channel kinds, audit rows, keyboard hints | Raw values off the wire, read by machine grammar. This proposal replaces the current 560-weight sans for the identifier role. |

The operational scale is unchanged from `tokens.css`: body 14/22, heading 16/22 at −0.011em,
provenance 12, identifier 12, and one weight jump (400 → 560).

The **Reflection scale**, for editorial surfaces only, runs 20 / 28 / 40 / 64. It is set in
Newsreader at weight 400, with italic for emphasis, `text-wrap: balance`, and −0.02em at 40 and
above.

### 3.4 Space, shape, motion

- **Space**: 4px base (`--sp`), as shipped. There are 12px of vertical padding per message and
  20px between speakers.
- **Radius**: 6 / 10 / 14, as shipped. Drafts use 10. **A draft's leading edge is square.** The
  hairline runs flush and the radius applies only to the trailing corners. This is the one
  asymmetric shape in the product, and it belongs to the duo.
- **Elevation**: none in operational UI. Surfaces separate by value (Ink → Graphite → Slate) and
  by Edge borders. The only shadow is on dialogs.
- **Motion**: calm, certain, and now cinematic. The archetype is Premium: layered, smooth, with a
  little life at the edges. Things settle with about 5% overshoot (`--ease-spring`) where they
  arrive, blur into focus, and leave a trace (a glow, a lift) instead of just appearing and
  vanishing. Two rules sit above everything else here.
  **Only `transform`, `opacity` and `filter` (blur into focus) animate** (a fold or a resize may
  ease a size, and the Portrait's count-up animates a number, and those are the only exceptions). **Nothing moves
  without a reason the owner can name**: where it came from, where it went, or that something
  changed. Everything respects `prefers-reduced-motion` by collapsing to instant.

  *The tokens* (`src/styles/tokens.css`; a component takes its motion from these or it does not
  ship, and `test/DesignSystem.test.tsx` enforces that):

  | Token | Value | Use |
  |---|---|---|
  | `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | the signature curve: on-screen change, about 80% of all motion |
  | `--ease-enter` | `cubic-bezier(0.05, 0.7, 0.1, 1)` | arrivals decelerate |
  | `--ease-exit` | `cubic-bezier(0.3, 0, 1, 1)` | departures accelerate |
  | `--dur-quick` | 120ms | press, hover, tooltips, menus |
  | `--dur-std` | 200ms | entries arriving, dialogs, toasts, pane changes |
  | `--dur-slow` | 320ms | sheets, the hairline draw, a value that changes in place |
  | `--dur-exit` | 150ms | every exit, shorter than its entrance |
  | `--ease-spring` | `cubic-bezier(0.34, 1.32, 0.64, 1)` | overlays, arrivals and press release: about 5% overshoot, then settle |
  | `--rise` | 8px | the one entrance: rise and fade in |
  | `--t` | quick + standard | state change; the original token, kept as an alias |

  *The expressive tier* (2026-09-30): dialogs and sheets spring in over a blurred page; a live draft
  arrives with a glow that washes across it in its own state colour; a decided draft lifts away as it
  folds; the Waiting count bumps as it ticks; chat rows draw a hairline on hover and when selected;
  a pane change resolves out of a slight blur. None of it loops (the working hairline is still the
  only loop), and none of it moves without a cause. On the landing page the same idea goes further:
  the headline and section headings resolve word by word out of blur, the draft in the demo streams
  in behind its hairline and lifts away when sent, the page carries its own hairline that fills as
  you read, light follows the pointer across the hero and into cards, the primary buttons lean toward
  the pointer, and a signal travels the loop. Reduced motion turns all of it off.

  *State change* uses `--t`. *Arrivals* rise 8px and fade in. *Exits* are shorter than the
  entrance they undo. *Pressing* any button or chat row shrinks it to 0.98.

  *The named moments*, each with its own timing because it says something:
  - **Dialogs and sheets**: the scrim fades in and the panel rises into place (200ms). A phone's
    bottom sheet slides up from the edge (320ms in, 200ms out). Menus pop from their trigger,
    tooltips shift 2px toward the side they sit on, toasts slide in from the right and follow a
    swipe.
  - **Draft arrives**: only a draft the daemon pushed while the owner was there. The block rises 8px
    (200ms) and its hairline draws top to bottom (320ms, starting 60ms later, so the line lands
    last). A draft that was already there, or that returns after navigating away, is in place.
  - **The duo is working**: the hairline loop above.
  - **A draft is decided**: its tray folds away (height and opacity together, 200ms) as its outcome
    rises in below it. A dismissal is held for its undo window *before* it is recorded, so nothing
    has collapsed yet when Undo is pressed and there is nothing to reverse.
  - **Waiting on you clears**: the count ticks (the old figure leaves upward while the new one rises
    from below, in tabular numerals), then "Nothing waiting on you." rises in. No confetti.
  - **Moving between places**: the pane's content fades and rises 4px when a *different* surface
    opens, while the list and chrome stay still; moving between profile tabs or settings sections is
    not a new surface and does not animate. On a phone the pane slides in 24px from the right and
    the list slides back from the left. Only entrances animate: a screen that unmounts cannot play
    an exit. The Info column eases open as the pane narrows; the offline bar folds open and shut.
  - **A message arrives in a room**: it rises in; history never does. The scroll to the end is
    smooth after the first landing, instant under reduced motion.
  - **The swipe**: the row follows the finger, resists past its commit point, and the label being
    committed to settles to full size. The decision is the finger's travel, not the resisted row's.
  - **Demotion**: the trust level cross-fades (320ms) and the sentence announcing it rises in at the
    same moment. No shake: a demotion is an announcement, not an error.
  - **A rule or correction is decided**: once the daemon has taken it, the card says what it now is
    and dims to 0.55; it holds for 400ms, then folds out of its list.
  - **An edit's diff**: the strike draws left to right and the highlight wipes in.
  - **The Portrait** (a Reflection surface, so it may do more): its sentences rise in 90ms apart
    and its figures count up over 600ms, once per visit. The real digits stay in the text; an
    overlay paints the count, so nothing shifts.
  - **Search** results cascade in 20ms apart, capped at eight, and a theme switch cross-fades the
    document.

  *Editorial surfaces* (the landing page, the Mirror) may add ambient motion. Operational UI may not
  (P3, Quiet until it matters): it has the working hairline and nothing else that loops. The landing
  page plays the loop as a self-running demo with a visible Pause control (it stops for good at the first real use, never at a scroll), reveals its sections
  once, and drifts its hero glow. It is one file with no dependencies, and nothing on it is hidden
  when scripts do not run.

### 3.5 Iconography

Lucide at 1.5px stroke and 16/20px size, as shipped. Every icon that stands alone carries an
`aria-label` (#34). A personal duo has no avatar; where a person would get one, it gets the mark. A desk duo's chosen avatar sits inside
the mark's frame, so it can never be mistaken for a person.

---

## 4. Signature components

These five define the product. Everything else is ordinary UI done carefully.

### 4.1 Attribution line

A 12px provenance-role line above any duo-authored block: **mark · "Your duo" · state · time**.
It is always present, it is never truncated before the name, and it is never the owner's avatar.

```
│ Your duo · draft · 2m
```

### 4.2 Draft card

```
┌ attribution line ─────────────────────────┐
│█  Refunds within 30 days are automatic;    │  ← hairline on the leading edge (Moss/Amber/Ash)
│█  after that, route to Finance via …       │     square leading corners, 10px trailing
│                                             │
│  [Send ⏎]  [Edit E]  [Dismiss X]     ⌘K ↗  │  ← Signal only on the primary verb
└─────────────────────────────────────────────┘
```

Primary action: Send (Signal fill). Secondary: Edit, Dismiss (ghost). In the chat-first shell this card is the **draft**, inline at the end of the owner's own view of the transcript, visibly unsent (§6.2, #181). When offline the primary
action is disabled rather than queued (AR-15), and the reason shows under the button.

### 4.3 Provenance rail

This is a permanent column on desktop (280px) and a drawer on phone. It has three blocks in a
fixed order: **Trust reading** (words, never a number), **Standing orders hit** (each one opens
the rule), and **Drew on N sources** (each one opens the source). An empty block says so ("No
standing order applied"). It never disappears.

### 4.4 Rule card (profile, rules-to-confirm card)

A standing order in plain words, set in Interface 16 with **evidence stacked beneath it**: the
threads it came from, and one line each. Its verbs are Approve (A), Edit (E) and Reject (R). A
rule's evidence can be deleted from the card, which deletes the rule along with it (concept §9).

### 4.5 Trust cell

This is one (topic × tier) cell in the grid. It is read-only. It changes through only two
routes: an **offer** accepted in Your duo's chat, or a **plain-words grant**. T4 renders as a hatched,
empty cell labelled "Never on its own". It is not a disabled switch, because no switch exists
there to disable (AR-17).

---

## 5. Interaction patterns

Each pattern names the problem, the mechanism, the words, and the keys.

### 5.1 Triage (Waiting on you)
*Problem:* drafts in a transcript scroll away, and an ignored draft looks like an unread one (AR-14).
*Pattern:* **Waiting on you** is a filter on the chat list with a count. It opens on the oldest undecided chat. J/K moves
between waiting chats. **⏎ Send**, **E Edit**, **X Dismiss**. Dismiss can be
undone for 5s (⌘Z) because nothing has left the machine. Send cannot be undone, and the UI
doesn't pretend otherwise. The empty state reads "Nothing waiting on you.", with the time of the last
decision and nothing else.
*Borrowed from:* Superhuman, Linear Triage.

### 5.2 Edit to teach
*Problem:* an edit is the richest training signal, but only if the owner can see what it taught.
*Pattern:* Edit opens the draft in place, with the hairline still visible. On **Send edited**
(⌘⏎) a one-line toast confirms the send and adds: "Queued as a correction candidate", which links to
the duo's Rules. There the edit renders as a diff (removed text struck through in Dust,
added text in Paper), with the proposed rule beneath it.
*Borrowed from:* GitHub suggested changes.

### 5.3 Approve a draft of yourself (profile and cards)
*Problem:* nobody will write their own personality.
*Pattern:* Profile › Portrait opens on a **portrait**, three to five Reflection-scale sentences built from
the owner's own counts ("You were asked about deployment access 23 times in six months."). Below
the portrait sit rule cards, one decision at a time, with evidence. Approve (A) and Reject (R)
advance the queue. Progress shows as "4 of 12", never as a percentage.
*Borrowed from:* Spotify Wrapped for the portrait, and Superhuman's one-item-at-a-time focus for the rule queue.

### 5.4 Offer and announce (the trust ledger)
*Problem:* trust should be felt as granted, and losing it should never be a surprise.
*Pattern:* a **promotion** is an offer card in Your duo's chat, naming the drafts that earned it:
"Your duo has answered 12 deploy-access questions without an edit. Let it answer these on its
own?" It has two buttons, **Let it answer** and **Keep asking me**. A **demotion** has no
buttons. It is one sentence in the draft's attribution line and in Audit: "I got that wrong,
so I've gone back to asking you first."
*Borrowed from:* Apple's in-context permission prompts.

### 5.5 Deliberate confirm (T4)
*Problem:* an irreversible action must never look like a toggle.
*Pattern:* a Confirmations card states **what, to what, and whether it can be undone**, in the
action's own words. Its only control is "Review and confirm…", which opens a dialog restating
the action above **Cancel** (focused) and **Confirm**. It is disabled offline and never queued.
There is no keyboard shortcut for Confirm.

### 5.6 Escalation as a question
*Problem:* an escalation rendered like an error reads as a failure.
*Pattern:* an escalation renders as a question with its reason ("I haven't seen you answer this
before") and a composer below it. The owner's answer is **Keep** (it becomes a standing-order
candidate). A refusal renders without actions: "Your duo refused this one.", with the reason.

### 5.7 Two searches, never merged
**Search what was said** (conversation header, `/`) searches the workspace. **Search what your duo
knows** (⌘K, global) searches the owner's own records, privately. The two share no input and
neither falls back to the other.
*Borrowed from:* Raycast for ⌘K's act-on-result rows.

### 5.8 Offline honesty
Messages queue and deliver on reconnect. Decisions (Send, Keep, Confirm) are disabled while
offline, with a reason, and are never queued. The offline bar sits at the top of the window and
says what still works.

### 5.9 Batched attention
The dock or tray badge shows **the Waiting-on-you count only**. Escalations interrupt only when marked
urgent. Everything else waits for the digest. Do not disturb holds the duo's acts too, and "what
was missed" collects them.

### 5.10 Ending things
Forget this device (local), Revoke (daemon-side, per device) and End this duo (everything,
typed "END") are three verbs for three acts. Each confirmation states what ends, what is kept,
and what can't be undone, in that order.

### 5.11 Empty states teach
Every empty state says what will fill it and how, and never offers a fake action. For example:
"Nothing earned yet. As your duo answers and you correct it, topics it handles well will show up
here."

### Keyboard map

| Scope | Key | Action |
|---|---|---|
| Global | ⌘K | Search what your duo knows |
| Global | ⌘1–9 | Open the first nine chats (Your duo is ⌘1) |
| Global | ⌘I | Toggle the Info panel |
| Global | ? | Show the keyboard map |
| Chats | J / K | Next / previous chat (in Waiting on you: next waiting chat) |
| Draft tray | ⏎ | Send |
| Draft tray | E | Edit (⌘⏎ Send edited) · Answer it, on a passed-on question |
| Draft tray | X | Dismiss (⌘Z within 5s to undo) |
| Rule cards | A / R / E | Approve / Reject / Edit |
| Conversation | / | Search what was said |

---

## 6. Information architecture

### 6.1 The object model

```
Owner ─owns─▶ Duo ─drafts─▶ Draft ─(send/edit/ignore)─▶ Outcome
                │              └─edit─▶ Correction candidate ─approve─▶ Standing order
                │                                                          ▲
                ├─raises─▶ Escalation ─(keep)─▶ Standing-order candidate ──┘
                ├─stages─▶ T4 action ─(confirm)─▶ Audit event
                ├─learns from─▶ Channel / Import ─▶ Source ─derive─▶ Rule (Mirror)
                └─holds─▶ Trust cell (topic × tier) ◀─offer / grant / demote─
Member ─in─▶ Conversation ◀─in─ Person | Colleague's duo
```

### 6.2 Navigation: a messenger, three places

> **Revised 2026-09-26** (epic #138): supersedes the grouped-sidebar proposal that was here.

The app is **Chats, Your duo, Settings.** One list is home. Your duo is always its first, pinned
row. The three-group sidebar shipped in #132 is replaced by this.

```
┌──────────────────────┬────────────────────────────┬───────────────┐
│ Chats     ✎  ⚙       │ ▮ Aisha · via Slack        │ Why it drafted │
│ ⌕ Search        ⌘K   │                            │ ─────────────  │
│ [All] [Waiting on you ③]│  Aisha: how do I get…    │ Trust reading  │
│                      │                            │ Standing order │
│ ▮ Your duo    ●      │ ┌█ Your duo · draft ─────┐ │ Drew on 3      │
│ ──────────────       │ │ Request read-only…     │ │ Who's asking   │
│ AR Aisha   Slack  ①  │ │ [Send ⏎][Edit E][✕ X]  │ │                │
│ BA Bala           ①  │ └────────────────────────┘ │                │
│ #  release Slack  ①  │ [ Message Aisha…        ↑ ]│                │
│ WL Wei Ling          │                            │                │
│ ▮ Bose's duo         │                            │                │
└──────────────────────┴────────────────────────────┴───────────────┘
```

1. **Chats is home.** People, groups, bridged Slack threads and colleagues' duos in one list.
   Filters: **All · Waiting on you (n)**. A duo's row carries the mark, never initials or a photo.
   A bridged question (Slack) is a chat with whoever asked — one per thread, or per asker when
   the channel names no thread — and its row, header and every message carry the platform
   ("Slack"), so it never reads as a native chat. The daemon keeps drafts, not conversations, and
   offers no thread history (digital-duo files that gap), so the chat holds the questions your
   duo was asked and your replies, and says so; there is no composer, because the only way to
   post back through the bridge is to decide a draft. When history exists the chat fills in.
2. **Your duo is a chat.** Pinned first, always present, works with no workspace. Ask it anything;
   answers arrive behind the hairline with their sources. Training arrives here as occasional
   cards: rules to confirm, trust offers, "I got that wrong" notices, a weekly digest.
3. **The draft** sits inline at the end of the owner's own view of the chat it answers, on the
   owner's side (#181, #183): attribution line, hairline state, the draft, a one-line why, and
   **Send ⏎ · Edit E · Dismiss X · Why?** under it. In a chat with other people it is dashed and says
   "only you can see this · not sent" — nobody else sees it until Send. In Your duo an answer waiting on
   you is simply the duo's reply, with **Keep · Edit · Dismiss** (#182). A passed-on question says so in
   plain words and shows **Answer it**; a refusal says what it is. The daemon's own reasoning is behind
   **Why?**.
4. **Why?** opens beside the draft, only when asked: a small popover on desktop, a bottom sheet on a
   phone (#185) — trust reading in words, standing orders hit, sources, who asked.
   **Info** (the chat header's ⓘ, or ⌘I) opens a side panel, closed by default: the contact or group,
   who and which duos are in it; in Your duo, its profile (#184).
5. **The duo's profile** (tap its name): **Portrait**, **Knows**, **May do**, **Rules**,
   **Activity**. It is where you go to understand the duo, never where you must go to use it.
6. **Settings** (list header): Notifications · Appearance · Profile (#224, your own name and
   picture) · Devices · Ask links · Connect to Claude · Advanced (connection) · End this duo.

Where each old screen went: Review → tray + Waiting on you · Conversations → Chats · Duo → the
Your duo chat · Confirmations → a card in the chat and in Your duo · Corrections → rule cards +
Profile › Rules · Escalations → a tray in the source chat + Profile › Activity · Mirror →
Profile › Portrait · Trust → Profile › May do · Knowledge, Channels → Profile › Knows · Audit →
Profile › Activity · Settings → Settings in sections.

### 6.3 Addresses

| Surface | Hash |
|---|---|
| Chats (home) | `#chats` (the default, with or without a workspace) |
| A chat / a thread | `#chat/:id`, `#chat/:id/thread/:root` |
| Your duo | `#duo` |
| Your duo's profile | `#duo/profile`, `#duo/profile/:tab` (portrait · knows · may · rules · activity) |
| Settings | `#settings`, `#settings/:section` |
| Asker page | `ask.html?…` (outside the app) |
| Landing / style guide | `/welcome.html`, `/design.html` (outside the app) |

Old hashes redirect: `#review` → `#chats` filtered to Waiting on you, `#draft/:id` → that draft's
chat, `#conversations` → `#chats`, `#room/:id` → `#chat/:id`, `#corrections` → `#duo`,
`#mirror` → `#duo/profile/portrait`, `#knowledge`/`#channels` → `#duo/profile/knows`, `#trust` →
`#duo/profile/may`, `#audit`/`#escalations` → `#duo/profile/activity`.

### 6.4 Phone

A push stack over the same structure: **Chats → Chat → Profile or sheet**, with the system back
gesture. No tab bar, and Settings sits behind the list header. Swipe a row left to send a
**confident** draft and right to dismiss it (undoable); a hedged draft or a passed-on question never
has swipe-send. The tray is thumb-height and **Why?** opens a bottom sheet.

---

## 7. Voice

The words are governed by `vocabulary.md`. The design language adds three tone rules.

- **Plain and exact.** "Your duo refused this one." Never "Oops!", never apologies, never
  exclamation marks.
- **The duo speaks in the first person only about itself.** "I got that wrong, so I've gone back to
  asking you first." It never speaks in the first person as the owner.
- **Counts are the daemon's own.** "23 times in six months", never "a lot". Proportions are bar
  widths, never percentages (§1.6).

---

## 8. Adoption, in order

1. Name the tokens (§3.2) in `tokens.css` comments. This is a zero-risk change.
2. Square the draft's leading corners and add the attribution line wherever a duo block lacks one.
3. Replace the sidebar with the chat-first shell (§6.2, epic #138).
4. Add the keyboard map (§5) with a `?` overlay.
5. Add JetBrains Mono for the identifier role, and Newsreader for the Mirror portrait only.
6. Add the promotion offer card to Your duo's chat (§5.4). This depends on the #179 trust-surface ratification.

The landing page (`public/welcome.html`) is the first surface built fully in this language, and
it doubles as its reference implementation.
