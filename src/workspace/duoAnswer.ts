import { duoOwnerUserIdOf } from "./identity.js";

/**
 * #67: reading a duo's answer as the asker's surface shows it — trust,
 * provenance, and escalation — from the only thing that travels.
 *
 * What crosses the wire is narrower than what the core knows (digital-duo
 * `workspace/org-read.md` §5, #191): an answer is its words and nothing
 * else. The grounding chunks, the source list and the confidence result
 * stay on the owner's machine with the corpus they index — a citation list
 * is a fingerprint of the corpus. So "why did it say that" reaches an asker
 * exactly one way: the daemon COMPOSES it into the words it sends
 * (`withPublicAttribution`, #44): the answer, a "Sources:" block naming
 * each source as the owner's own standing order or a retrieved past
 * exchange, and an attribution line carrying the duo's confidence and the
 * evidence's age. This module reads that composition back into structure
 * so the surface can show it properly. It invents nothing: no field here
 * exists on the wire, no second channel for evidence is assumed, and
 * anything that isn't the daemon's composition whole reads as null — the
 * caller renders the plain words rather than a half-parsed claim.
 *
 * Two of the daemon's strings are contract (they render verbatim, the
 * vocabulary's daemon-owned list) and are mirrored here so the outcomes can
 * be told from an ordinary message: `PUBLIC_PASSED_ON_MESSAGE` and
 * `PUBLIC_REFUSAL_MESSAGE` (digital-duo `permissions/public-answer.ts`) —
 * the same mirroring-with-degradation identity.ts does for the user-id
 * grammar: if the core's wording ever moves, a message stops being read as
 * an outcome and renders as plain words, still verbatim, never wrong.
 *
 * The confidence is a weighted composite against a configurable threshold,
 * not a calibrated probability (ConfidenceHairline says the same for the
 * owner), so the reading never carries the number — only which side of the
 * owner's own hedging rule it fell on. Nothing here can hand a number to a
 * render, which is what "in plain words, never a percentage" means.
 *
 * Pure on purpose, like mentions.ts: it imports nothing from the SDK, and
 * the seam, the routes and the tests can use it without one another.
 */

/** The daemon's fixed passed-on message (#43 AC3) — mirrored, contract. */
export const PUBLIC_PASSED_ON_MESSAGE = "I can't answer that one for you directly — I've passed it on to the owner, and they'll follow up.";
/** The daemon's fixed refusal message (#43 AC3) — mirrored, contract. */
export const PUBLIC_REFUSAL_MESSAGE =
  "That's not something I speak for the owner on. I've passed it on to them, without saying anything more about it here.";

/**
 * The core's default escalation threshold (`DEFAULT_CONFIDENCE_ESCALATION_THRESHOLD`,
 * digital-duo config.ts): an answer is only ever posted at or above it.
 * The threshold is configuration on the owner's machine and does not travel
 * with an answer, so the default stands in — the one place the asker's
 * reading of "hedging" leans on an assumption, stated here rather than
 * hidden.
 */
export const DEFAULT_ESCALATION_THRESHOLD = 0.55;

/**
 * How far above the threshold an answer must clear to read as confident
 * rather than hedged — the same margin the owner's hairline uses
 * (ConfidenceHairline.hairlineState), so one answer reads the same way to
 * its owner and to the colleague who asked.
 */
export const HEDGE_MARGIN = 0.15;

/** What kind of thing a cited source was — the daemon's own two-way split (#44 AC3). */
export type DuoSourceKind = "standing-order" | "past-exchange";

/** One thing the answer drew on, as the daemon named it in the words. */
export interface DuoAnswerSource {
  readonly kind: DuoSourceKind;
  readonly label: string;
}

/** Which side of the owner's hedging rule an answer fell on — never a number. */
export type DuoTrust = "confident" | "hedging";

/**
 * #270: the line a duo's message opens with while its owner is away —
 * "{owner} is away until {when} — {owner}'s duo is answering." (digital-duo
 * `trust/away.ts`'s `awayStatusLine`, mirrored, contract). The backreference
 * makes the two names one name, as the attribution line's does.
 */
const AWAY_LINE = /^(.+) is away until (.+) — \1's duo is answering\.$/;

/** What an away line said: the owner's away, until when. */
export interface DuoAwayNotice {
  /** The line as the daemon wrote it — what renders. */
  readonly line: string;
  /** The end time as the daemon worded it, e.g. "Mon 12 Oct, 09:00". */
  readonly until: string;
}

/** A duo message the daemon composed, read back into what it said. */
export type DuoAnswerReading = (
  | {
      readonly kind: "answered";
      /** The answer's own words, without the composed scaffolding around them. */
      readonly answer: string;
      /** What it drew on, in the order named — empty when the answer named nothing. */
      readonly sources: readonly DuoAnswerSource[];
      readonly trust: DuoTrust;
      /** The evidence's age as one plain sentence fragment, e.g. "Evidence up to 3 days old". */
      readonly evidence: string;
      /** The daemon's identity line, as written — whose voice this is, and that it is not theirs. */
      readonly attribution: string;
    }
  /** The question went to the owner (the daemon's fixed passed-on message, whole body kept verbatim). */
  | { readonly kind: "passed-on"; readonly body: string }
  /** The subject is one the owner set a boundary on (the fixed refusal message, whole body kept verbatim). */
  | { readonly kind: "refused"; readonly body: string }
) & {
  /** #270: set when the message opened with its owner's away line; the line is not part of `body` or `answer`. */
  readonly away: DuoAwayNotice | null;
};

/**
 * The identity line, whole: "— {owner}'s duo speaking here, not {owner}
 * directly." with, on an actual answer only, " Confidence: {n}. Based on
 * {evidence}." (`publicAttributionLine`). The backreference makes the two
 * names one name — a line that names one owner and then another is not the
 * daemon's composition.
 */
const ATTRIBUTION_LINE = /^— (.+)'s duo speaking here, not \1 directly\.(?: Confidence: (\d+(?:\.\d+)?)\. Based on (.+)\.)?$/;

/** One line of the "Sources:" block (`renderSourceAttribution`), the two kinds as the daemon words them. */
const SOURCE_LINE = /^ {2}- \[(the owner's own standing order|a retrieved past exchange, not the owner speaking now)\] (.+)$/;

/** The evidence's age as `formatEvidenceAge` words it, turned into a fragment a reader can take in. */
function evidenceSentence(phrase: string): string {
  if (phrase === "evidence from today") {
    return "Evidence from today";
  }
  if (phrase === "no dated evidence behind it") {
    return "No dated evidence behind it";
  }
  const aged = /^evidence up to (\d+) day\(s\) old$/.exec(phrase);
  if (aged) {
    const days = Number(aged[1]);
    return `Evidence up to ${days} ${days === 1 ? "day" : "days"} old`;
  }
  // The daemon's wording moved: say what it said rather than guess.
  return `Based on ${phrase}`;
}

/** The "Sources:" block a paragraph is, when every one of its lines is the daemon's line. */
function sourcesOf(paragraph: string): readonly DuoAnswerSource[] | null {
  const lines = paragraph.split("\n");
  if (lines[0] !== "Sources:" || lines.length < 2) {
    return null;
  }
  const sources: DuoAnswerSource[] = [];
  for (const line of lines.slice(1)) {
    const match = SOURCE_LINE.exec(line);
    if (!match) {
      return null;
    }
    sources.push({ kind: match[1] === "the owner's own standing order" ? "standing-order" : "past-exchange", label: match[2]! });
  }
  return sources;
}

/**
 * Reads a duo's message body as the daemon composed it, or null when it
 * isn't (or isn't wholly): a plain message, a failure notice, a paraphrase
 * of a fixed message. Callers apply it to duo-shaped senders only — the
 * attribution is by user id (identity.ts), and a person typing the same
 * words is a person's words.
 */
export function readDuoAnswer(fullBody: string): DuoAnswerReading | null {
  // #270: an away line opens the message when the owner is away. It is read
  // off first, and only when the rest is itself the daemon's composition —
  // an away line alone, or before plain words, is not an outcome.
  const allParagraphs = fullBody.split("\n\n");
  const awayMatch = allParagraphs.length > 2 ? AWAY_LINE.exec(allParagraphs[0]!) : null;
  const away: DuoAwayNotice | null = awayMatch ? { line: allParagraphs[0]!, until: awayMatch[2]! } : null;
  const body = away ? allParagraphs.slice(1).join("\n\n") : fullBody;
  const reading = readComposed(body);
  return reading ? ({ ...reading, away } as DuoAnswerReading) : null;
}

type ComposedReading = DuoAnswerReading extends infer R ? (R extends unknown ? Omit<R, "away"> : never) : never;

function readComposed(body: string): ComposedReading | null {
  const paragraphs = body.split("\n\n");
  if (paragraphs.length < 2) {
    return null;
  }
  const attribution = ATTRIBUTION_LINE.exec(paragraphs[paragraphs.length - 1]!);
  if (!attribution) {
    return null;
  }
  const rest = paragraphs.slice(0, -1);
  if (attribution[2] === undefined) {
    // No detail: the composed outcomes that drew on nothing — only the two
    // fixed messages are outcomes; anything else attributed is just words.
    const text = rest.join("\n\n");
    if (text === PUBLIC_PASSED_ON_MESSAGE) {
      return { kind: "passed-on", body };
    }
    return text === PUBLIC_REFUSAL_MESSAGE ? { kind: "refused", body } : null;
  }
  const sources = sourcesOf(rest[rest.length - 1]!);
  const answer = (sources === null ? rest : rest.slice(0, -1)).join("\n\n");
  if (answer.length === 0) {
    return null;
  }
  return {
    kind: "answered",
    answer,
    sources: sources ?? [],
    // The wire's number has two decimals; the epsilon keeps 0.70 on the
    // confident side of 0.55 + 0.15, which floats would put a hair above it.
    trust: Number(attribution[2]) + 1e-9 < DEFAULT_ESCALATION_THRESHOLD + HEDGE_MARGIN ? "hedging" : "confident",
    evidence: evidenceSentence(attribution[3]!),
    // The identity half only, as written: the numeric half is what the
    // reading exists to keep out of a render.
    attribution: `— ${attribution[1]}'s duo speaking here, not ${attribution[1]} directly.`,
  };
}

/**
 * What a preview of a message says: an answer's own words, without the
 * composed scaffolding (and the number in it) — anything else as it was
 * said. Previews have no sender at hand, and need none: a body that isn't
 * the daemon's composition reads as itself.
 */
export function plainPreview(body: string): string {
  const reading = readDuoAnswer(body);
  return reading?.kind === "answered" ? reading.answer : body;
}

/**
 * Where a question the duo passed to its owner stands: `waiting` until the
 * owner speaks in the conversation after the pass-on, `followed-up` once
 * they have. Null for anything that isn't a duo's passed-on message.
 *
 * "The owner" is structural, the way every attribution is — the person
 * whose id the duo's id derives from (`@duo-carol` → `@carol`), never a
 * display name that claims to be. Their reply is the ordinary message of a
 * person, and it arrives through the room like any other; this reads the
 * conversation for it and adds no message of its own. Struck replies are
 * no answer, and neither is anything the owner said before the pass-on.
 * `conversation` is the room's timeline in order, thread replies included:
 * an answer in the pass-on's own thread and one in the main flow both count.
 */
export function escalationOf(message: RoomMessageLike, conversation: readonly RoomMessageLike[]): "waiting" | "followed-up" | null {
  const owner = duoOwnerUserIdOf(message.senderId);
  if (owner === null || message.redacted || readDuoAnswer(message.body)?.kind !== "passed-on") {
    return null;
  }
  const at = conversation.findIndex((candidate) => candidate.eventId === message.eventId);
  if (at < 0) {
    return "waiting";
  }
  const answered = conversation.slice(at + 1).some((later) => later.senderId === owner && !later.redacted && later.pending !== true);
  return answered ? "followed-up" : "waiting";
}

/** The slice of a room message the escalation reading needs — the seam's `RoomMessage` satisfies it. */
export interface RoomMessageLike {
  readonly eventId: string;
  readonly senderId: string;
  readonly body: string;
  readonly redacted: boolean;
  readonly pending?: boolean;
}
