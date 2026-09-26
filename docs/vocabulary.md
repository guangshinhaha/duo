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

An answer the duo composed, waiting on the owner. Drafts live in Review
("Waiting on you in Review."); their verbs are send, edit, and keep. A draft
is never "a response", "a reply", or "a message from your duo" — it is a
draft until the owner sends it.

### escalation

A question the pipeline raised for the owner's judgement (`escalated`
without `refused`). Escalations appear in Review with their reason; the
owner answers one like a question, not like an error.

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

Per topic, what the duo may do without asking — shown beside its tier, never
as a control in this cut: the surface stays read-only until the core exposes
the shared module path (that writes are exposeable in principle is the
ratified decision, recorded in the core repo's `trust-surface.md`, #179).

### workspace

The org's messaging layer — a Matrix homeserver members sign in to and the
duo's daemon dials out to. Two credentials with separate lifetimes: the
workspace session (who you are, in the org) and the duo pairing (which only
you reach). A member signed in with no duo paired is a normal state, and the
surfaces say so rather than demanding pairing.

### conversation

A room in the workspace — people, groups, and colleagues' duos, all entries
in one list. Conversations are the default space once you're signed in; your
own duo's loop keeps its home in Review.

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

### forget this device

The unpair action, under exactly this name everywhere it appears: the
sidebar, the folded navigation, and Settings (whose confirmation spells out
what it does — the address and token are removed here, on this device only;
the daemon keeps its own record). Never "Disconnect" (nothing is
disconnected server-side), "log out", or "unpair" in visible strings.

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

## The daemon-owned strings — contract, not suggestions

These arrive fixed from the owner's daemon and render **verbatim**,
never paraphrased, never "improved":

- **The passed-on message and the refusal message** the asker page shows
  (`PUBLIC_PASSED_ON_MESSAGE` / `PUBLIC_REFUSAL_MESSAGE`, #43 AC3) —
  deliberately indistinct by underlying reason; a friendlier paraphrase here
  would reintroduce exactly the signal those fixed strings remove.
- **The duo attribution** — whose voice a block of text is. The client's
  three phrasings are pinned above and by test; the labelling is structural
  (`DuoMessage`, no avatar, AR-13), not a coat of paint.
- **Delivery failure reasons** — rendered verbatim after the client's own
  "Couldn't deliver — " prefix.
- **The daemon's error and owner-notice messages** — when the daemon speaks
  in `{error:{code,message}}`, its wording is the truth of what happened;
  the client has nothing truer to say over it.

## Canonical phrasings already in the product

These earned their place — reuse them rather than minting synonyms: "Ask
your duo…", "Waiting on you in Review.", "Queued as a standing-order
candidate.", "Drew on N sources", "Nothing earned yet.", "Your duo refused
this one.", "the owner's duo", "Your duo escalated a question to you.",
"Your duo answered on your behalf in …".
