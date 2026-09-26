# The vocabulary (#51)

One place. Before writing a string — a label, an empty state, an error, a
button — check the word here first. The product's premise is that the duo is
labelled and never impersonates its owner (`concept.md`); a premise that lives
in nouns cannot survive each surface inventing its own.

## Three rules that travel with the words

1. **A duo must never be called an employee** — nor a teammate, an assistant,
   staff, a chatbot, an intern, or any other noun that makes it a person or a
   colleague. It is a thing the owner owns, named and labelled.
2. **It never speaks as the owner.** Duo output is attributed ("Your duo",
   "the owner's duo") and never written in the owner's voice; nothing the duo
   produced renders without its attribution. The client enforces this
   structurally (`DuoMessage` has no avatar and cannot contain an owner
   message, AR-13) — the words must not undo what the structure holds.
3. **It is always labelled.** Every piece of generated text, every draft,
   every answer carries whose it is. An unlabelled string is a bug even when
   its content is harmless.

## The nouns

### owner

The one human this daemon serves — the person whose token this device holds.
"you" and "your" in the client's strings always mean the owner, never a
generic user. On the asker's page, where the reader is not the owner, say
"the owner" explicitly.

### asker

A colleague who asks the duo a question through an ask link. Askers are never
named by identity in this client — an asker is a reference, not a person, and
the words must not imply otherwise ("a colleague" for the human, "the asker"
for the wire reference).

### duo

The system of record that answers, drafts, escalates, and refuses — one per
owner, always attributed, never a person. Owner surfaces say "Your duo"; the
asker page says "the owner's duo" (its reader is not the owner); the roster
says "Your duo" and "{owner}'s duo". These three are the whole set.

### draft

An answer the duo composed, waiting on the owner. A draft lives in the **draft
tray**, docked above the composer of the chat it answers ("Only you can see
your duo’s drafts — nothing is posted until you send one."), and it is
counted in **Waiting on you**. Its verbs are send, edit, and dismiss. A draft
is never "a response", "a reply", or "a message from your duo" — it is a
draft until the owner sends it. It is never in the transcript: a draft the
owner sends appears there as *the owner's own message*, footnoted "from your
duo's draft" for the owner alone. Deciding a draft in the tray clears it
everywhere, and left alone it stays in the tray and in Waiting on you.

### draft tray

The region above a chat's composer that holds your duo's draft for that chat:
the attribution line, the hairline state, the draft, a one-line why, and the
actions. It is outside the transcript by construction (AR-14, kept), and it
says who may see it ("only you can see this"). Never "the reply box", "the
suggestion", or "the preview".

### waiting on you

The filter on the chat list, and the count behind it: chats holding a draft
you have not decided, a question your duo passed to you, or a confirmation.
The count is one number, the same in the list, the dock or tray icon, and the
window title. It replaces "Review" as the name of the queue. Empty state:
"Nothing waiting on you." **Review** is retired as a surface name; the word
survives only as an ordinary verb ("Review and confirm…" on a T4 card).

### profile

What you open by tapping your duo's name: five tabs, **Portrait** (who it
thinks you are), **Knows** (what it has read, and what feeds it), **May do**
(what it handles on its own), **Rules** (your standing orders and what they
came from) and **Activity** (what it answered, passed on, or refused, and
where it runs out). It is where you understand the duo, never where you must
go to use it. A colleague's duo has no profile on your side: its trust reading
travels with each answer.

### dismiss

The owner declines a draft: nothing is sent, and the draft is recorded as
dismissed (undoable for a few seconds, because nothing has left the machine).
The verb replaces **ignore**, which read as "did nothing" when it is in fact a
judgement the duo learns from. Never "delete", "discard" or "reject" for a
draft. ("Reject" stays the verb for a rule or a correction candidate.)

### escalation

A question the pipeline raised for the owner's judgement (`escalated`
without `refused`). Escalations appear in Review with their reason; the
owner answers one like a question, not like an error.

The profile's Activity tab (`#duo/profile/activity`, "Where it runs out", #54) shows the pattern across them:
each question the duo keeps having to ask, how many times, most first —
"where its knowledge runs out". Two questions are the same only when they
read the same (case and spacing aside); nothing is grouped by resemblance,
because the daemon never judged one. Counts come from the digests the daemon
has sent, and an urgent escalation is in none of them (it interrupts live
instead), so the screen says what it counted. The urgent rate is the daemon's
own counts — "3 of 12 escalations were urgent" — and its own figure as a bar's
width, never a percentage (§1.6's rule for every derived proportion), and with
nothing classified yet there is no bar at all. Answering an escalation from
there is the same answer as in Review, which queues a standing-order candidate.

### refusal

An escalation the pipeline declined outright — "Your duo refused this one.",
with the reason, no action offered. The noun is refusal, the past tense is
refused; never "declined" in owner surfaces ("Declined" is the asker-page
outcome the daemon names, and the two must not blur).

### standing order

A rule the owner approved that lets the duo answer without asking. When the
owner answers a question they asked themselves, the answer is "Queued as a
standing-order candidate." — candidate, because approval is a separate act
in Corrections. Hyphenate the adjective ("standing-order candidate"); the
noun stays two words ("a standing order").

### correction candidate

The record of an edit — what the owner changed, waiting in Corrections for
them to confirm what it taught. Never "feedback", "training data", or "a
learning": it is a candidate until confirmed.

### trust tier

Per topic, how much the owner trusts the duo's answers — earned by corrected
answers or granted by hand. The empty state says what earning looks like:
"Nothing earned yet. As your duo answers and you correct it, topics it
handles well will show up here."

### autonomy level

Per topic, what the duo may do without asking — shown beside its tier. The
grid itself stays a read; the owner changes a level only through the two
deliberate acts the core exposes over its one shared module path (the
ratified decision, recorded in the core repo's `trust-surface.md`, #179):
accepting an offered promotion, and a plain-words grant that refuses an
ambiguous match rather than guessing. T4 is never offered.

### the three levels, in plain words

On daily surfaces an autonomy level is written as a sentence about what the duo
does, never as a code: **Answers on its own** (it may answer without asking),
**Drafts for you** (it writes a draft and waits), and **Always asks you** (it
passes the question on). T0–T4, "earned", "granted" and "stale" stay in detail
views and the audit record; they do not appear in the default views. The
fourth state is not a level: anything external or irreversible reads **"Never
on its own. You confirm each one."** — a hatched row with no control, never a
disabled switch (AR-17).

### workspace

The org's messaging layer — a Matrix homeserver members sign in to and the
duo's daemon dials out to. Two credentials with separate lifetimes: the
workspace session (who you are, in the org) and the duo pairing (which only
you reach). A member signed in with no duo paired is a normal state, and the
surfaces say so rather than demanding pairing.

### conversation

A room in the workspace — people, groups, and colleagues' duos, all entries
in one list. Conversations are the default space once you're signed in; your
own duo's loop keeps its home in Review, and a draft for a message that
arrived in a conversation opens back into it ("Open the conversation") when
you hold that conversation.

### member

A person signed in to the workspace. "Member" never describes a duo: a
colleague's duo appears in a conversation as "{owner}'s duo", attributed
structurally from its user id (`@duo-<owner>`) — never as a colleague, never
by a display name it could set to anything.

### mention

Addressing a person or somebody's duo — the product's central gesture, and
one word for both halves of it. Composing one: an "@" in the composer offers
the room's members, clearly distinguished — a person by their name, a duo as
"{owner}'s duo" from the user-id grammar, never from a name a sender chose;
the pick lands in the text as words people read and rides the wire both ways
the spec carries a mention — as ids (`m.mentions.user_ids`) the homeserver's
notification settings read, and as the pill half (`formatted_body` matrix.to
anchors around exactly those words) the receiving client renders — and a
mention deleted from the text doesn't ride the wire: what the message
doesn't say, the wire doesn't claim. Receiving one: the message's mentions
render as mentions — a pill per mention, a person's by the resolved name, a
duo's reading "{owner}'s duo" re-derived from its user id so a claimed
display name can never misname it — and on the list, a mention reads
differently from mere unread — "@ 2" beside the unread count — because it
is a different demand: unread says you haven't looked, a mention says
someone is waiting on you. A mentioned duo's answer arrives in the
conversation as its own message, attributed structurally like any duo
message — including its permissions outcomes (passed on, declined), which
render in the daemon's own words, verbatim, never paraphrased into
something friendlier.

### channel

An outside system bridged into the duo — the daemon's word, and the core's
concern: an adapter there supplies a kind and a display label, and this
client renders both **without recognising either**, so a channel added to
the core needs no change here. The Channels screen lists what the daemon
reports — the adapter's label, its state, when it last carried something,
whether it is muted — and a channel whose connection has failed is put first
with the adapter's reason under it, because that screen is where the owner
goes to learn why it is quiet. No channels is a complete configuration, not
an unfinished one: the screen says the duo answers only its owner right now
and offers nothing to finish. To *mute* a channel is to ask the daemon to
create no drafts from it; the muted state shown is the daemon's re-read, and
the verb here is the owner's, distinct from a member muting a conversation
(below). Connecting or authorising a channel is not done from this app — it
happens where the credentials are.

### trust reading

What an asker reads under a colleague's duo's answer to judge it — always in
words, never as a number or a percentage, because the confidence is a
composite against a threshold, not a probability. Four readings, each its own
sentence: *confident* ("{owner} has trusted this duo with this topic, and it's
sure of this answer"), *hedging* (the same trust, "less sure of this answer",
treat it as a starting point), *outside what this duo answers on its own* (it
passed the question to {owner}), and *a boundary {owner} set* (a refusal —
the system working as designed, never a fault). Beside an answer it shows
what it drew on at zero clicks, exactly as far as the words carried it: the
evidence itself stays on the owner's machine. A passed-on question is
*waiting on {owner}* until {owner} speaks after it, then *replied* — the
answer itself is {owner}'s own message, a person's, never the duo's.

## The verbs

One action, one name, everywhere it appears. If a control and a sentence
describe the same act, they use the same word.

### ask

The owner puts a question to the duo ("Ask your duo…" in the composer); an
asker does the same from their page ("Ask"). Asking is the only way a
question enters — nothing in this client "messages", "chats with", or "pings"
the duo.

### send

The owner releases a draft as the answer ("Send"; "Send edited" when the text
changed). Sending is disabled offline, never queued — a send firing hours
later against moved context is worse than no send. That is the draft rule
(AR-15 in `client-design.md`); the member's own ordinary messages are the
other object and do queue offline, delivering on reconnect (#61).

### keep

The owner answers a question they asked themselves ("Keep"; "Keep edited") —
nobody asked, so there is no recipient to send to; the answer becomes a
standing-order candidate instead.

### pass on

The duo hands a question to the owner rather than answering. The asker sees
the daemon's passed-on message (below); owner surfaces say the duo passed it
to you. Never "forwarded", "handed off", "escalated to a human".

### refuse

The duo declines outright. Owner surfaces: "Your duo refused this one." The
asker page renders the daemon's refusal message verbatim. Never "couldn't
answer", "was unable to help" — a refusal is a decision, not a failure.

### confirm

The owner's explicit go-ahead for an irreversible step their duo has staged
(a T4 action — `concept.md` §6: "never autonomous, product principle, not a
limitation"). The surface is "Confirmations"; the control that gives it is
"Confirm", and it is never the first control the owner meets: the card states
what will happen, to what, and whether it can be undone — the registered
action's own words, verbatim — and its one control ("Review and confirm…")
opens a question that says it again above Cancel and Confirm. Cancel is the
focused answer. Confirming is disabled offline, never queued (AR-15): a
confirmation firing later against moved context is exactly the failure the
guard exists to prevent. Never "approve" (that is a rule's or a correction's
verb), "authorise", "allow", "OK", or a bare "Yes".

### forget this device

The unpair action, under exactly this name everywhere it appears: the
sidebar, the folded navigation, and Settings (whose confirmation spells out
what it does — the address and token are removed here, on this device only;
the daemon keeps its own record, and the token still works there). Never
"Disconnect" (nothing is disconnected server-side), "log out", or "unpair" in
visible strings.

### revoke

The daemon-side counterpart, on Settings' Devices list: cutting a paired
device off so its token stops working and its open connection closes, at the
daemon, immediately. It is the only word for that act — never "forget" (which
is local and revokes nothing) and never "remove" or "unpair". Revoking the
device you are using states its consequence first (its access ends now, and
the app returns to Setup) and revokes before it forgets. The list names a
device by the name it was paired under, says when it was paired and last seen,
and marks "This device" — a label the owner places once, because the daemon
does not say which row is the caller. Pairing stays at the Mac: `duo pair new`.

### end this duo

The kill switch, under exactly this name: Settings' "End this duo…" and its
confirmation ("End this duo?", "End this duo for good"). It is the only
control in the client that acts on the daemon itself rather than on this
device, which is why it is never confused with "forget this device": that
one removes this device's stored connection and leaves the daemon's record;
this one deletes the duo — what it knows and everything derived from it —
and every paired device loses it. The confirmation states what ends, what is
kept, and what cannot be undone before anything proceeds, and takes a typed
"END"; it never says "revoke" or "wipe", and states no deletion the daemon
did not itself list. Once done, the app says "Your duo was ended" — the
true reason — and never "no longer paired", which is what a revoked token
says.

### sign in / sign out

The workspace connection's begin and end, under exactly these names. Signing
in takes the homeserver's address and the member's username and password;
signing out clears what this device cached — messages and duo data both —
and never unpairs the duo: the two connections end independently ("forget
this device" ends the other).

### pair

Connecting this device to a duo daemon — "Pair your duo" where it's offered
(the front door's second card, the member shell's offer, Settings' empty
state). Pairing is offered, never demanded: a member without one messages
fully and sees the explanation wherever a duo surface would be.

### start / leave / set notifications for

The member's verbs over their own conversations, each an operation on the
member's workspace account — which is why each holds on every device, and
why the list's reflection after any of them is the workspace's next answer,
never a flag this device keeps. Starting searches the workspace's people
("New conversation"); leaving asks first and can be undone by an invite.
Notifications are a standing, not a toggle: "All messages", "Mentions", or
"Nothing" — mute is the far end of the same control, not a separate button,
and the standing holds on every device the way starting and leaving do.
Reading a conversation is the quiet fourth: opening it receipts the latest
event, and the unread badge clears everywhere the member is signed in.

### do not disturb / quiet hours / what was missed

The member's rule for this device alone: what may interrupt HERE, while the
per-conversation standings travel with the account. Do not disturb is the
whole rule; quiet hours are its schedule — a start, an end, and a span that
may cross midnight. What the rule holds back is never dropped: it waits in
Settings as "what was missed", each entry a link back to where it happened,
until the member clears it. The rule holds the duo's own acts too — an
escalation waits like a mention — because holding is not silencing; the
per-conversation standings are what never apply to the duo's acts, since
those belong to no conversation.

### share

Sending a file or an image as a message of its own — "Attach" in the
conversation's composer, the member's own `m.file`/`m.image` message in the
flow, rendered with its facts (name, size, type) and a download, an image
inline where it can be previewed. The verb is never "upload" in visible
strings (the upload is a step, not the act), and above all never "import":
sharing reaches the people in the conversation and nothing else, while
importing a document into a duo's corpus is the owner's separate,
explicitly labelled act elsewhere. A share that immediately precedes the
member's question makes it available to a duo in the room — text up to the
duo's own reading cap (32 KiB, the duo's door, not this app's share
limits), images honestly not readable yet — and the composer says so in
those words at attach time.

### import / embed / derive

The three stages of building a duo, in the order the daemon runs them, under
these names in the app's first run (#49). Import reads a pasted conversation
into the corpus; embed makes it searchable (a job the app starts and watches);
derive finds what the duo learned from it — and derive is a terminal stage
("`duo derive`"), which the app says plainly and watches rather than offers. A
first run ends at the Mirror, where the owner approves or rejects the rules
that were derived: the owner never writes a personality, they approve a draft
of it. Counts in this flow are the daemon's own ("14 questions found", "30 of
40 records embedded") and a job's failure reads as the daemon worded it.

### edit / delete / react / reply in thread

The message verbs, each an operation on the room the homeserver holds — the
surface adds no behaviour, it moves the server's own state and renders the
next answer. An edit replaces the words where they stood and marks them
"(edited)"; a delete asks first, then strikes — "Message deleted" keeps the
row's place, and the words don't come back. A reaction is one emoji from a
fixed set, aggregated under its message as a chip the member takes back by
tapping again. A reply in thread belongs to its thread: the conversation
carries the thread as a preview — whose it was (by the id grammar, like any
sender), the latest word, the count — and the thread itself is its own
address, one link away and back. A sent message renders for its sender at
once, marked as on its way, until the homeserver's record replaces it.

### search

Two searches live in this product, under two names, and they are never the
same verb. **Search what was said** finds messages — what people and duos said
in the conversations you're in — and it is the workspace's: shared,
membership-scoped by the workspace, asked of the workspace. A hit reads with
its conversation and its author (a duo's answer as "{owner}'s duo", from its
user id, like any duo message), the words around it, and opens at that
message in context. **Search what your duo knows** (⌘K) finds what the duo has
learned from the owner's own records — private, on the owner's Mac, and never
searched on the workspace; its results reach the owner and no one else. A
surface never offers one under the other's name, and neither falls back to the
other when it finds nothing.

## The daemon-owned strings — contract, not suggestions

These arrive fixed from the owner's daemon and render **verbatim**,
never paraphrased, never "improved":

- **The passed-on message and the refusal message** the asker page shows
  (`PUBLIC_PASSED_ON_MESSAGE` / `PUBLIC_REFUSAL_MESSAGE`, #43 AC3) —
  deliberately indistinct by underlying reason; a friendlier paraphrase here
  would reintroduce exactly the signal those fixed strings remove. In a
  conversation they render in an element of their own (#67), the client's
  framing ("outside what this duo answers on its own", "a boundary {owner}
  set") beside them, never instead of them.
- **The duo attribution** — whose voice a block of text is. The client's
  three phrasings are pinned above and by test; the labelling is structural
  (`DuoMessage`, no avatar, AR-13), not a coat of paint.
- **A channel's label, its state, and its failure reason** — the adapter's own
  words, on the Channels screen, shown as sent (#47); the client keeps no
  table from a channel kind to a name, an icon, or a colour.
- **Delivery failure reasons** — rendered verbatim after the client's own
  "Couldn't deliver — " prefix.
- **The daemon's error and owner-notice messages** — when the daemon speaks
  in `{error:{code,message}}`, its wording is the truth of what happened;
  the client has nothing truer to say over it.

## Canonical phrasings already in the product

These earned their place — reuse them rather than minting synonyms: "Ask
your duo…", "Waiting on you.", "Queued as a standing-order
candidate.", "Drew on N sources", "Nothing earned yet.", "Your duo refused
this one.", "the owner's duo", "Your duo escalated a question to you.",
"Your duo answered on your behalf in …".

## Changed with the chat-first redesign (epic #138, 2026-09-26)

| Retired | Now | Where |
|---|---|---|
| Review (the surface) | **Waiting on you** (filter and count) and the **draft tray** | chat list, each chat |
| Ignore (a draft) | **Dismiss** | draft tray |
| Conversations, Duo (ask) | **Chats**; **Your duo** (a chat) | home |
| Mirror | **Portrait** (in the profile) | profile |
| Trust, "T1 approve earned" | **May do**, "Answers on its own" | profile |
| Knowledge, Channels | **Knows** | profile |
| Audit, Escalations (patterns) | **Activity** | profile |
| Corrections | **Rules** (waiting ones arrive as a card in Your duo) | profile, chat |

Wording that moves with it: "Waiting on you in Review." becomes "Waiting on you." in a chat, and
"Your duo refused this one." stays as it is. The daemon-owned strings and every rule above that
this section does not name are unchanged.
