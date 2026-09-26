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
enforces the second rule structurally: duo output never carries an avatar, and it never shares
a container with the owner's words.

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
- **Loading state**: the hairline draws top to bottom (400ms) while the duo is working. It is
  the only looping motion in the product.
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
- **Motion**: `--t` (150ms, ease-out) on state change only. Three named moments are allowed more:
  - *Draft arrives*: fade-up 8px over 200ms, and the hairline draws in over 300ms.
  - *Waiting on you clears*: *Waiting on you clears*: the count ticks down, then settles to "Nothing waiting on you." (no confetti).
  - *Demotion*: the trust cell steps down one level with a 300ms cross-fade, and the sentence
    announcing it arrives at the same time.
  - Everything respects `prefers-reduced-motion` by collapsing to instant.

### 3.5 Iconography

Lucide at 1.5px stroke and 16/20px size, as shipped. Every icon that stands alone carries an
`aria-label` (#34). The duo has no avatar. Where a person would get an avatar, the duo gets the
mark.

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

Primary action: Send (Signal fill). Secondary: Edit, Dismiss (ghost). In the chat-first shell this card is the **draft tray**, docked above the composer and never in the transcript (§6.2). When offline the primary
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
| Global | ⌘I | Toggle the inspector |
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
2. **Your duo is a chat.** Pinned first, always present, works with no workspace. Ask it anything;
   answers arrive behind the hairline with their sources. Training arrives here as occasional
   cards: rules to confirm, trust offers, "I got that wrong" notices, a weekly digest.
3. **The draft tray** docks above the composer of the chat a draft answers: attribution line,
   hairline state, the draft, a one-line why, and **Send ⏎ · Edit E · Dismiss X**. It is never in the
   transcript. A passed-on question shows **Answer it**; a refusal shows the reason only.
4. **The inspector** (desktop, ⌘I) shows why a draft says what it says — trust reading, standing
   orders hit, sources, who asked. With no draft it shows the contact; in Your duo it shows the
   profile. On phone the tray's **Why?** opens the same content as a bottom sheet.
5. **The duo's profile** (tap its name): **Portrait**, **Knows**, **May do**, **Rules**,
   **Activity**. It is where you go to understand the duo, never where you must go to use it.
6. **Settings** (list header): Notifications · Appearance · Devices · Ask links · Connect to
   Claude · Advanced (connection) · End this duo.

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
