/**
 * Client-side mirrors of the daemon's domain types. `client-tech-design.md`
 * §1.4: "Responses return the domain types verbatim. No DTO layer" — that
 * rule is about the *server* never inventing a second shape, not about the
 * two npm packages sharing a TypeScript project reference (this client is
 * a separate package from the CLI/daemon, so there's no way to `import
 * type` across that boundary without a workspace-wide build step this
 * pass doesn't add). These are kept intentionally minimal and are the one
 * place a server-side type change must be mirrored by hand — see
 * `src/drafting/pipeline.ts`, `src/drafting/draft-log.ts`, etc. for the
 * authoritative shapes this file must never drift from silently.
 */

export interface DraftSource {
  // "attachment" (digital-duo #190/#183): a file shared in the conversation
  // the question rode with; `id` is the workspace's own file reference and
  // `label` the daemon's filename/type/preview line — rendered as told.
  // "pinned" (digital-duo duo#275): the owner's own exact wording, pinned to
  // a question/topic pattern and quoted back verbatim — `id` is a
  // `trust/pinned-answers.ts` row, removed from the Rules tab's Pinned
  // answers section, never inline per-draft (`SourceRemoveButton` renders
  // nothing for it, same as it already does for "attachment").
  kind: "rule" | "evidence" | "attachment" | "pinned";
  id: string;
  label: string;
}

// `POST /compose/rewrite` (digital-duo#263): polishes the OWNER'S OWN typed
// composer text — never a duo-generated draft, which already has
// `POST /drafts` for that. Mirrors digital-duo's `src/drafting/rewrite.ts`
// REWRITE_INSTRUCTIONS verbatim — the composer's own menu.
export const REWRITE_INSTRUCTIONS = ["rewrite", "shorter", "warmer", "proofread"] as const;
export type RewriteInstruction = (typeof REWRITE_INSTRUCTIONS)[number];

export interface RewriteResult {
  readonly text: string;
}

// `POST /compose/fact-check` (digital-duo#264): a quiet, conservative check
// of the owner's own typed composer text against the corpus. `source`
// reuses `DraftSource` above — the daemon never invents a source, only
// cites one of the facts retrieval actually turned up. `flag` is `null`
// far more often than not by design (see the daemon's own fact-check.ts
// doc comment): no configured inference provider, no topical corpus
// match, or a self-reported confidence under the daemon's threshold all
// read the same way here — nothing to show.
export interface FactCheckFlag {
  readonly claim: string;
  readonly concern: string;
  readonly source: DraftSource;
}

export interface FactCheckResult {
  readonly flag: FactCheckFlag | null;
}

/**
 * `GET /knowledge/evidence/excluded` (duo#272, digital-duo#288): one past
 * exchange the owner removed from a draft's "Used" list — reversible from
 * the Knows tab. `label` is the record's own text, truncated, exactly as a
 * draft source's own `label` is; `null` once the record itself is gone
 * (deleted, or never imported), in which case the exclusion still holds.
 */
export interface ExcludedEvidence {
  readonly recordId: string;
  readonly excludedAt: string;
  readonly label: string | null;
}

/**
 * `GET /knowledge/sources` (duo#278): every source the corpus has records
 * under, or had before the owner excluded it — the Privacy settings
 * page's per-source switch, one level up from `ExcludedEvidence`'s
 * per-record undo. `source` is the daemon's own string ("claude-export",
 * "paste", "connector"), rendered verbatim, same discipline as
 * `DuoKnowledge["records"]["bySource"]`'s keys — this client keeps no
 * registry to translate them through. `excludedAt` is `null` exactly when
 * `excluded` is `false`.
 */
export interface SourceControl {
  readonly source: string;
  readonly recordCount: number;
  readonly excluded: boolean;
  readonly excludedAt: string | null;
}

/**
 * `GET /workspace/rooms/:roomId/off-the-record` (duo#274): the owner's
 * "don't learn from this conversation" marker for one room. `decidedAt` is
 * `null` exactly when `offTheRecord` is `false`. `POST` to mark it also
 * returns a `purged` summary of what the daemon removed because it was
 * already learned from the room — the client never needs that count for
 * anything but an honest confirmation line, so it isn't modeled further
 * here.
 */
export interface RoomOffTheRecord {
  readonly roomId: string;
  readonly offTheRecord: boolean;
  readonly decidedAt: string | null;
}

// Mirrors the daemon's own split (src/drafting/draft-log.ts):
// SETTABLE_DRAFT_OUTCOMES is what this client may POST to
// /drafts/:id/outcome; DRAFT_OUTCOMES adds "escalation_answered", which
// the daemon writes itself the moment an escalation is answered and this
// client only ever reads back, never sets.
export const SETTABLE_DRAFT_OUTCOMES = ["sent", "edited", "discarded"] as const;
export type SettableDraftOutcome = (typeof SETTABLE_DRAFT_OUTCOMES)[number];

export const DRAFT_OUTCOMES = [...SETTABLE_DRAFT_OUTCOMES, "escalation_answered"] as const;
export type DraftOutcome = (typeof DRAFT_OUTCOMES)[number];

// Mirrors the daemon's own DISMISS_REASONS (digital-duo's
// src/drafting/draft-log.ts, #259): the one-tap, always-optional reason a
// "discarded" outcome may carry. Only ever meaningful alongside
// `outcome: "discarded"` — the daemon refuses any other pairing.
export const DISMISS_REASONS = ["wrong_facts", "wrong_tone", "shouldnt_answer", "will_handle_myself"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

export interface ConfidenceResult {
  score: number;
  passesThreshold: boolean;
  threshold: number;
}

/**
 * Where a draft came from (digital-duo #169) — mirrored from the daemon's
 * `DraftProvenance` (`src/drafting/draft-log.ts`). Always present on the
 * wire: a row that predates provenance or whose stored JSON is unreadable
 * reads `{ origin: "unknown" }`, never throws.
 */
export type DraftProvenance =
  | { readonly origin: "owner" }
  | {
      readonly origin: "channel";
      readonly channelKind: string;
      readonly askerRef: string;
      readonly threadId: string | null;
      readonly permalink: string | null;
    }
  | { readonly origin: "unknown" };

/**
 * What happened when a sent/edited draft was handed back to its origin
 * channel (digital-duo #170's delivery seam). `null` means no delivery was
 * ever attempted — the draft wasn't sent, or it was self-asked and had
 * nowhere to go, which is not an error. The reason on a failure is the
 * daemon's own string and renders verbatim; retrying is the daemon's call,
 * never this client's.
 */
export type DraftDelivery =
  | { readonly state: "pending" }
  | { readonly state: "delivered" }
  | { readonly state: "failed"; readonly reason: string };

export interface DraftRecord {
  id: string;
  question: string;
  threadContext: string | null;
  draftText: string | null;
  escalated: boolean;
  escalationReason: string | null;
  confidenceScore: number;
  sources: DraftSource[];
  createdAt: string;
  outcome: DraftOutcome | null;
  outcomeRecordedAt: string | null;
  sentText: string | null;
  /** True only for a refused-subject escalation — a real stored field, not derived from escalationReason's text (src/drafting/draft-log.ts's own reasoning for why). */
  refused: boolean;
  /** The composite-confidence escalation threshold that was actually in effect when this draft was generated — what ConfidenceHairline compares confidenceScore against, instead of a hardcoded guess. */
  escalationThreshold: number;
  provenance: DraftProvenance;
  /** The daemon's record of the delivery attempt (#170) — always present on the wire, `null` when nothing was ever sent anywhere. */
  delivery: DraftDelivery | null;
  /**
   * Why the owner dismissed this draft (#259) — null for a silent dismissal
   * (the common case), for every other outcome, and for any draft recorded
   * before this field existed. The daemon always sends it (same as every
   * other field here), but it's typed optional, unlike its siblings above,
   * so the many existing `DraftRecord` test fixtures across this package
   * don't all need a mechanical `dismissReason: null` added just to keep
   * compiling — a missing field reads exactly like an explicit `null`
   * everywhere this is read (`=== "shouldnt_answer"`, never a bare
   * dereference).
   */
  dismissReason?: DismissReason | null;
  /*
   * #257/#258 (digital-duo drafting): optional here, though the daemon
   * always sends them, for the same reason `provenance` is read with `?.`
   * (useDraftDecision): a record rehydrated from the persisted cache can
   * predate the fields, and renders before the refetch that heals it.
   */
  /** The candidates a hedged draft offered (#257) — empty for a single draft. Index 0 is the draft itself while pending. */
  alternatives?: DraftAlternative[];
  /** Which candidate was sent or kept — null while pending, for a dismissal, and for a single draft. */
  chosenAlternative?: number | null;
  /** Every shape applied to this draft, oldest first (#258). */
  shapes?: DraftShape[];
  /**
   * digital-duo #279 (issue #262): true only when this draft's wording was
   * actually tuned for its recipient's own register — optional for the same
   * cache-rehydration reason as `alternatives` above (a row persisted before
   * this field existed reads as `undefined`, which Why treats exactly like
   * `false`: nothing to say).
   */
  adaptedForRecipient?: boolean;
  /** The adaptation itself when `adaptedForRecipient` is true; `null` otherwise (never both missing and `true`). */
  recipientAdaptation?: RecipientAdaptation | null;
  /** Who the draft is addressed to (digital-duo#262) — null when nobody was named. Optional for the same cache reason as the fields above. */
  recipient?: { id: string; name: string | null } | null;
  /**
   * #313/#314 (digital-duo): what the colleague who asked was told — null
   * when no colleague asked. Optional for the cache-rehydration reason above.
   */
  publicOutcome?: "answered" | "passed_on" | "declined_refused" | null;
  /** #314: why the question went to the owner, in the daemon's own words — set for a pass-on or a decline. */
  passOnReason?: string | null;
}

// digital-duo #279 (issue #262): who a draft is addressed to, sent on
// `POST /drafts` only when this client actually knows one — a question the
// owner asks their own duo for themselves has nobody to name. `name` is
// optional even when `id` is known: the client sends whatever the
// directory/room already gave it, never a second lookup just to fill this in.
export interface RecipientRef {
  readonly id: string;
  readonly name?: string;
}

/**
 * Whether, and how, a draft's wording was tuned for the one person it's
 * addressed to (digital-duo #279, issue #262) — derived from at least
 * `sampleSize` of the owner's own approved sends/edits to that person
 * (the daemon's threshold; below it nothing is flagged, so a `DraftRecord`
 * reads `adaptedForRecipient: false` and this is `null`). `register` is the
 * daemon's own word for the tone it found (e.g. "formal", "casual") —
 * rendered verbatim, never translated. Mirrors the daemon's own
 * `RecipientAdaptation` (`src/drafting/pipeline.ts`) — `recipientName` is
 * nullable there (a recipient can be known by id alone), so it is here too.
 */
export interface RecipientAdaptation {
  readonly recipientId: string;
  readonly recipientName: string | null;
  readonly sampleSize: number;
  readonly register: string;
}

/**
 * The learned, per-relationship features the daemon conditions a draft's
 * wording on, once `active` below. Mirrors the daemon's
 * `RecipientVoiceFeatures` (`src/drafting/recipient-voice.ts`), kept
 * intentionally minimal per this file's own convention — `register` is the
 * only field any UI renders today; add more (formalityScore,
 * habitualGreeting, …) here if a future surface needs them.
 */
export interface RecipientVoiceFeatures {
  readonly register: string;
}

/**
 * `GET`/`DELETE /people/:id/voice-adaptation` (digital-duo #279): mirrors
 * the daemon's own `RecipientVoiceStatus` in full — unlike `RecipientAdaptation`
 * above, this route is the *only* source for `active`/`threshold`/`resetAt`,
 * so there is no narrower shape to keep instead. `features` is `null` until
 * `active` (below the daemon's sample threshold, or never reset-and-relearned)
 * — there is nothing worth rendering until then.
 */
export interface VoiceAdaptationStatus {
  readonly recipientId: string;
  readonly recipientName: string | null;
  /** Approved sends to this person counted since the last reset. */
  readonly sampleSize: number;
  /** The sample-size threshold adaptation activates at. */
  readonly threshold: number;
  /** True once drafts to this person are actually conditioned on `features`. */
  readonly active: boolean;
  readonly features: RecipientVoiceFeatures | null;
  /** When the owner last reset this relationship's learned tone, or null if never. */
  readonly resetAt: string | null;
}

/**
 * #315 (digital-duo #192): a colleague's request to talk to your duo — an
 * invitation the daemon is holding until you decide. `reason` is the
 * colleague's first message when their client carried it (the preview).
 */
export interface DuoRequest {
  roomId: string;
  inviterId: string | null;
  name: string | null;
  joinedMemberCount: number;
  reason?: string | null;
  direct?: boolean;
  receivedAt: string;
}

/** One candidate among a hedged draft's alternatives (#257): its own text and confidence, citing the draft's one evidence pool. */
export interface DraftAlternative {
  text: string;
  /** null for the duo's default draft; otherwise what it was asked for — "shorter", "cautious". */
  instruction: string | null;
  confidenceScore: number;
  sources: DraftSource[];
  /** "chosen" for the one sent or kept, "not_chosen" for the rest once decided, null while pending. */
  outcome: "chosen" | "not_chosen" | null;
}

/** The shapes a draft can be given with one tap (#258) — the daemon's closed set. */
export const SHAPE_INSTRUCTIONS = ["shorter", "warmer", "more_formal", "more_direct"] as const;
export type ShapeInstruction = (typeof SHAPE_INSTRUCTIONS)[number];

/** One shape applied to a pending draft (#258): which candidate, how, and whether it was taken back. */
export interface DraftShape {
  id: string;
  alternative: number;
  instruction: ShapeInstruction;
  createdAt: string;
  undoneAt: string | null;
}

/**
 * #261: one send the daemon is holding for later (digital-duo
 * `src/drafting/scheduled-sends.ts`, `GET /scheduled-sends`). The draft
 * rides along so a Scheduled list can show what goes out without a second
 * read; the draft itself stays undecided (`outcome: null`) until it fires.
 */
export interface ScheduledSend {
  draftId: string;
  outcome: "sent" | "edited";
  sentText: string | null;
  sendAt: string;
  scheduledAt: string;
  state: "scheduled" | "sent" | "cancelled" | "superseded" | "failed";
  settledAt: string | null;
  failureReason: string | null;
  /** #268: true for a send your duo is making by itself, inside its undo window — listed by `GET /autonomous-sends`, never by `GET /scheduled-sends`. Absent on a daemon that predates #268. */
  autonomous?: boolean;
  draft: DraftRecord;
}

/**
 * #266: what your duo has to show for itself with one person (digital-duo
 * `src/trust/recipient-autonomy.ts`'s `TrackRecord`, verbatim): its most
 * recent decided replies to them, and how many you sent exactly as drafted.
 */
export interface AutonomyTrackRecord {
  readonly recipientKey: string;
  readonly recipientName: string | null;
  readonly considered: number;
  readonly sentUnedited: number;
  readonly edited: number;
  readonly dismissed: number;
  readonly uneditedShare: number;
  readonly since: string | null;
  readonly latest: string | null;
  readonly recentClean: boolean;
  readonly disqualified: boolean;
}

/** #266: `GET /autonomy/offers` — your duo asking to answer one person itself, with the evidence in its own words. */
export interface AutonomyOffer {
  readonly recipientKey: string;
  readonly recipientName: string | null;
  readonly trackRecord: AutonomyTrackRecord;
  readonly holdSeconds: number;
  readonly evidence: string;
}

/** #266: `GET /autonomy/grants` — a person your duo answers by itself, and the record that earned it. */
export interface AutonomyGrant {
  readonly recipientKey: string;
  readonly recipientName: string | null;
  readonly grantedAt: string;
  readonly evidence: AutonomyTrackRecord;
  readonly revokedAt: string | null;
}

/** #268: `GET/PUT /settings/autonomy` — how long an autonomous reply waits for Stop/Edit. 0 (no wait) only with explicit confirmation. */
export interface AutonomySettings {
  readonly holdSeconds: number;
}

/** #261: when to send it — an exact time, or the start of working hours, which the daemon resolves from its own setting. */
export type SendLater = { sendAt: string } | { at: "working-hours" };

/** #261: the duo's working-hours setting (`GET/PUT /settings/working-hours`) and when it next starts. */
export interface WorkingHours {
  start: string;
  end: string;
  timezone: string;
  days: number[];
  nextStart?: string;
}

/**
 * What `POST /drafts` actually returns — a discriminated union on `kind`,
 * mirroring `DraftPipelineResult` (`src/drafting/pipeline.ts`). `refused`
 * is what lets the UI tell "won't" from "can't" without parsing `reason`.
 */
export type DraftPipelineResult =
  | { kind: "draft"; draftId: string; text: string; sources: DraftSource[]; confidence: ConfidenceResult }
  | { kind: "escalation"; draftId: string; reason: string; refused: boolean; confidence: ConfidenceResult | undefined };

export const CORRECTION_CANDIDATE_KINDS = ["style", "substance"] as const;
export type CorrectionCandidateKind = (typeof CORRECTION_CANDIDATE_KINDS)[number];

export interface CorrectionCandidate {
  id: string;
  kind: CorrectionCandidateKind;
  draftId: string;
  question: string;
  draftText: string;
  sentText: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt: string | null;
}

export interface TopicShare {
  topicId: string;
  label: string;
  count: number;
  share: number;
}

export interface ThreadShare {
  threadId: string;
  count: number;
  share: number;
}

export interface InterruptionPortrait {
  totalQuestions: number;
  periodStart: string | null;
  periodEnd: string | null;
  topicBreakdown: TopicShare[];
  topFiveShare: number;
  busiestThreads: ThreadShare[];
  /** Field names verified live against the daemon (`src/derivation/portrait.ts`) during the 2026-09-20 smoke test — an earlier mirror guessed `insufficientHistory`, which never matched the wire and silently rendered zeros instead of the thin state. */
  tooThin: boolean;
  minimumQuestionsToCharacterize: number;
}

/** One of a voice-trend bucket's worst-scoring drafts (duo#276) — enough to link to the draft itself and show what the duo actually wrote. */
export interface VoiceTrendExample {
  draftId: string;
  score: number;
  snippet: string;
}

/** One period of `VoiceTrend` — field names match the daemon's own `VoiceTrendBucket` (`digital-duo src/derivation/voice-trend.ts`) byte for byte. */
export interface VoiceTrendBucket {
  periodStart: string;
  periodEnd: string;
  sampleSize: number;
  /** Null when nothing in this bucket could be scored yet (no anchor established before it) — never a fabricated zero. */
  score: number | null;
  reanchored: boolean;
  worstExamples: VoiceTrendExample[];
}

/** `GET /mirror/voice-trend` (digital-duo duo#276): how closely the duo's own drafts matched the owner's recent approved sends, over time. */
export interface VoiceTrend {
  bucketing: "week" | "month";
  buckets: VoiceTrendBucket[];
  /** True when there has never been enough approved history to establish even one anchor — show "not enough data yet", not an empty chart. */
  tooThin: boolean;
  minimumSendsToCharacterize: number;
  totalApprovedSends: number;
}

/** One completed ingest run, as `GET /knowledge` reports it (digital-duo #175's `ImportRun`) — every count is a fact the run already kept. */
export interface ImportRunSummary {
  runAt: string;
  staged: number;
  written: number;
  alreadyPresent: number;
  skippedDmConversations: number;
  discardedOtherText: number;
  discardedAboveCeiling: number;
}

/** The shared duo's usage report, exactly as `duo shared usage` computes it (#175 reuses #71's builder verbatim — the summary string is the daemon's own sentence, rendered as-is). */
export interface SharedUsageReport {
  totalQuestions: number;
  distinctAskers: number;
  repeatAskers: number;
  answeredCount: number;
  declinedCount: number;
  /** answeredCount / totalQuestions, off the wire — formatted, never recomputed. */
  answerRate: number;
  /** declinedCount / totalQuestions — every decline routes to the owner. */
  escalationRate: number;
  weeklyTrend: { weekStart: string; questionCount: number }[];
  gaps: { question: string; count: number }[];
  lastAskedAt: string | null;
  daysSinceLastAsk: number | null;
  abandoned: boolean;
  summary: string;
}

/**
 * `GET /knowledge` (digital-duo #175): what this duo knows, in one read.
 * Every field is a fact the daemon already computed — the corpus verdict
 * is the portrait's own `tooThin` (same threshold, same breakdown), the
 * rates are the usage report's own arithmetic. This client composes and
 * renders; it never derives, never re-judges.
 */
export interface DuoKnowledge {
  records: { total: number; bySource: Record<string, number> };
  /** Null when this store has never seen an import. */
  lastImport: ImportRunSummary | null;
  corpus: {
    tooThin: boolean;
    minimumQuestionsToCharacterize: number;
    totalQuestions: number;
    periodStart: string | null;
    periodEnd: string | null;
    topicBreakdown: TopicShare[];
  };
  /** Every review-status key present, zero included. */
  rules: { byReviewStatus: Record<RuleReviewStatus, number> };
  /** Echoed from the daemon's configuration; null means unconfigured. */
  providers: { inference: string | null; embedding: { name: string; model: string } | null };
  sharedUsage: SharedUsageReport;
}

/**
 * One corpus record, as `GET /search` returns it (digital-duo #174 wraps
 * the ingest normalisation layer's `IngestRecord`). `kind`/`author`/
 * `audience`/`classification` are the daemon's own strings — typed `string`
 * on purpose: this client renders them verbatim or not at all and keeps no
 * registry of their values to translate through (#43's discipline).
 */
export interface CorpusRecord {
  id: string;
  source: string;
  sourceRef: string | null;
  kind: string;
  author: string;
  text: string;
  timestamp: string;
  threadId: string | null;
  audience: string;
  classification: string;
  topics: string[];
}

/**
 * `GET /search?q=` — `duo search`'s hybrid retrieval, verbatim. `rank` is
 * the result's position in the full fused list, stable across pages (the
 * cursor pages by "last rank + 1"); `warning` is the daemon's own
 * embeddings-down sentence, rendered verbatim when present.
 */
export interface SearchOutcome {
  results: { record: CorpusRecord; rank: number }[];
  usedEmbeddings: boolean;
  warning?: string;
}

/**
 * `POST /corpus/import-paste` (digital-duo #176): what `duo import paste`
 * prints, verbatim. `workRelevant: false` is the zero summary of a
 * transcript the daemon judged not work-relevant (AR-11) — a 200, not an
 * error, and nothing was written.
 */
export interface PasteImportSummary {
  workRelevant: boolean;
  written: number;
  skipped: number;
  discardedAboveCeiling: number;
}

/**
 * `GET`/`POST /corpus/embed` (digital-duo #176): the daemon's one embed
 * job. `embedded` climbs by batch while `state` is "running"; `total` is
 * every record in the store (the denominator `duo embed` prints); `error`
 * is the failing error's own message, non-null only in state "error".
 */
export interface EmbedJobStatus {
  state: "idle" | "running" | "done" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  embedded: number;
  total: number;
  error: string | null;
}

export type RuleReviewStatus = "pending" | "approved" | "rejected" | "superseded";
export type RuleOrigin = "derived" | "owner_asserted";

export interface Rule {
  id: string;
  topicId: string;
  text: string;
  status: "confirmed" | "inconsistent" | "weak_signal";
  supportCount: number;
  consistency: number;
  createdAt: string;
  lastConfirmedAt: string | null;
  reviewStatus: RuleReviewStatus;
  origin: RuleOrigin;
}

export interface RuleReviewListing {
  awaitingApproval: Rule[];
  weakSignals: Rule[];
  inconsistent: Rule[];
  approved: Rule[];
  rejected: Rule[];
}

/**
 * One cited exchange behind a rule, as `GET /mirror/rules/:id` resolves it
 * (digital-duo #182's `RuleEvidenceExchange`). Text is `null` when the record
 * the citation points at has since been removed — the daemon degrades rather
 * than refusing the whole rule, and the client says so rather than hiding it.
 */
export interface RuleEvidenceExchange {
  qaPairId: string;
  questionText: string | null;
  answerText: string | null;
}

/** `GET /mirror/rules/:id` — a rule together with the exchanges its evidence cites. */
export interface RuleWithEvidence {
  rule: Rule;
  evidence: RuleEvidenceExchange[];
}

/** One entry of `duo/refusals.md`: `heading` is what is refused, `reason` the owner's own hand-written basis (may be empty). */
export interface Refusal {
  heading: string;
  reason: string;
}

/**
 * `GET /mirror/refusals` (digital-duo #182) — pure `duo/refusals.md` file
 * state. `decided` is whether that file exists at all: `false` is "never
 * asked", which an empty `refusals` alone cannot tell from "asked, and the
 * owner recorded none".
 */
export interface RefusalsListing {
  decided: boolean;
  refusals: Refusal[];
}

/**
 * `GET/POST/DELETE /mirror/pinned-answers` (digital-duo duo#275): the
 * owner's own exact wording, pinned to a question/topic `pattern` — quoted
 * back verbatim whenever a question matches, outranking every standing
 * order and every retrieved piece of evidence. `sourceLabel` is a short,
 * purely descriptive note of where this came from (e.g. the chat the owner
 * pinned it from) — null for one written with no particular source.
 */
export interface PinnedAnswer {
  id: string;
  pattern: string;
  answerText: string;
  createdAt: string;
  updatedAt: string;
  sourceLabel: string | null;
}

/**
 * #269: a never-answer rule as the profile sends it — the owner's own
 * sentence (`rule`, whose subject the daemon reads off it), or a `subject`
 * with an optional `reason`.
 */
export type NeverAnswerInput = { rule: string } | { subject: string; reason?: string };

/** #259 → #269: the daemon's starting words for a rule off a dismissed draft. Only a suggestion; nothing is recorded. */
export interface NeverAnswerSuggestion {
  draftId: string;
  question: string;
  subject: string;
}

/**
 * The Singapore GSCS tiers the daemon reads off a record's marking, lowest
 * first (digital-duo `ingest/record.ts`). #269's ceiling is this same
 * taxonomy — see `profile/Ceiling.tsx` for why it has no corresponding
 * write type here: digital-duo#48 makes it policy-set, not owner-set.
 */
export const CLASSIFICATION_LEVELS = ["official_open", "official_closed", "restricted", "confidential", "secret"] as const;
export type ClassificationLevel = (typeof CLASSIFICATION_LEVELS)[number];

/** One of the duo's topics, as an away period can add it (`GET /topics`). */
export interface TopicOption {
  id: string;
  label: string;
}

/** #270: `may_do` answers what May do already allows; `may_do_and_topics` adds topics for this period only. */
export type AwayScope = "may_do" | "may_do_and_topics";

export interface AwayPeriod {
  id: number;
  startedAt: string;
  until: string;
  scope: AwayScope;
  extraTopics: TopicOption[];
  endedAt: string | null;
  endedEarly: boolean;
  summaryDismissedAt: string | null;
}

export interface AwaySummaryItem {
  question: string;
  askerRef: string;
  at: string;
  draftId: string;
  topicId: string | null;
}

export interface AwaySummary {
  periodId: number;
  /** False while the period is still running (a summary so far); true once it has ended (the return summary). */
  ended: boolean;
  from: string;
  to: string;
  answered: (AwaySummaryItem & { viaAwayTopic: boolean })[];
  passedOn: (AwaySummaryItem & { waiting: boolean })[];
  declined: AwaySummaryItem[];
}

/** #270: `GET /away` and every away write's reply. */
export interface AwayState {
  active: AwayPeriod | null;
  last: AwayPeriod | null;
  /** Exactly what colleagues see while the owner is away; null when they are in. */
  statusLine: string | null;
  summary: AwaySummary | null;
  scopes: AwayScope[];
  maxDays: number;
}

export type TrustTier = "T0" | "T1" | "T2" | "T3";
export type AutonomyLevel = "ask" | "approve" | "auto";

export interface GridRow {
  topicId: string;
  topicLabel: string | undefined;
  tier: TrustTier;
  level: AutonomyLevel;
  source: "earned" | "granted";
  stale: boolean;
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  question: string;
  askerRef: string;
  askerResolved: boolean;
  declined: boolean;
  answerText: string;
}

/**
 * `GET /mirror/public-answers` (digital-duo#267): every public-answer-log
 * entry — a colleague's question through an ask link, and what became of
 * it. Mirrors digital-duo's `src/permissions/public-answer-log.ts`
 * `PublicAnswerLogEntry` plus `sources`, which the route resolves on read
 * from the T1 draft that produced the answer (`draftId`) rather than the
 * log storing them twice — the Activity tab's own "every answer, with its
 * sources" requirement (#267 AC1).
 */
export const PUBLIC_ANSWER_LOG_OUTCOMES = ["answered", "passed_on", "declined_refused", "corrected"] as const;
export type PublicAnswerLogOutcome = (typeof PUBLIC_ANSWER_LOG_OUTCOMES)[number];

export interface PublicAnswerLogEntry {
  id: string;
  createdAt: string;
  question: string;
  askerRef: string;
  topicId: string | null;
  outcome: PublicAnswerLogOutcome;
  text: string;
  draftId: string;
  correctsEntryId: string | null;
  askLinkId: string | null;
  askerResolved: boolean | null;
  clearanceApplied: ClassificationLevel;
  sources: DraftSource[];
}

/**
 * `POST /mirror/public-answers/:id/correct` (digital-duo#267): "That was
 * wrong" — what correcting a logged public answer actually does, verbatim
 * from digital-duo's `src/permissions/public-correction.ts`
 * `CorrectPublicAnswerResult`. `demotion` is `undefined` only when the
 * original entry never resolved a topic at all; `demoted` is false when
 * the cell was already at the floor ("ask") — the correction is still
 * recorded either way (#267 AC3).
 */
export interface CorrectPublicAnswerResult {
  correctionEntryId: string;
  originalEntryId: string;
  correctedTopicId: string | null;
  text: string;
  postedInThread: boolean;
  threadGoneNotice: string | undefined;
  demotion: { topicId: string; tier: TrustTier; fromLevel: AutonomyLevel; toLevel: AutonomyLevel; demoted: boolean } | undefined;
  notifiedAskerRefs: string[];
}

/**
 * One paired device as `GET /devices` and `POST /devices/:id/revoke` answer
 * it (digital-duo #177) — the daemon's own `DeviceToken` shape, which has no
 * token or hash field, so a credential cannot ride this type. `revokedAt` is
 * null for a device that can still authenticate; `lastSeenAt` is null for one
 * the daemon has never heard from. Timestamps are the daemon's ISO strings.
 */
export interface PairedDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/**
 * #52: the action registry's own row, as digital-duo #180's
 * `GET /actions/t4/pending` joins it to each staged request — the facts a
 * confirmation is judged on. Verbatim domain types (§1.4): the client
 * classifies nothing, so `tier` and `reversible` are read, never derived.
 */
export interface RegisteredAction {
  id: string;
  description: string;
  reversible: boolean;
  obligates: boolean;
  audience: "none" | "owner" | "internal" | "external";
  topicIds: string[];
  tier: "T0" | "T1" | "T2" | "T3" | "T4";
  registeredAt: string;
  updatedAt: string;
}

/** #52: a staged irreversible step, awaiting the owner's confirmation. `executedAt` is null while it waits and set once, by the confirmation. */
export interface PendingT4Request {
  id: string;
  actionId: string;
  topicId: string;
  /** Why the duo staged it — duo-authored text. */
  reasoning: string;
  createdAt: string;
  executedAt: string | null;
}

/** #52: what `GET /actions/t4/pending` returns per request. `action` is null only if the registry row is gone, which the daemon says no code path can do — a request in that state cannot say what it would do, so it cannot be confirmed here. */
export interface PendingT4RequestForJudgement extends PendingT4Request {
  action: RegisteredAction | null;
}

export interface ApiError {
  error: { code: string; message: string };
}

// Mirrors what `POST /ask` puts on the wire *for an ask token* (digital-duo
// #159's route projection in its `src/serve/server.ts` — contract-first
// against #159's implemented branch while it awaits merge; this repo's
// `mock/daemon.mjs` serves the same shape meanwhile), not the CLI's richer
// `PublicAnswerOutcome` from `src/permissions/public-answer.ts`: the daemon
// composes the full public post — answer, sources, attribution, confidence,
// evidence age — into `text` before responding, and the owner-facing extras
// (`draftId`, `logEntryId`, `topicId`, `confidence`, `evidenceAgeDays`,
// `ownerNotice`) ride along only for a *device* principal. This page always
// calls with an ask token, so those fields never arrive and are
// deliberately absent here — a shape that cannot even express the owner's
// view is the surest way not to render it.
// `kind` discriminates; the split matters: the two non-answer variants are
// *distinct* fixed strings by design (#43 AC3), worded so an asker can
// never infer what the answer might have been — a surface must render
// them verbatim, never paraphrase them into something friendlier.
export interface PublicAnswered {
  /** Always "personal" from this page — it never sends the `duo` field, so the daemon's personal branch answers. */
  readonly duo: "personal";
  readonly kind: "answered";
  /** The full public text — answer, sources, attribution, confidence, and evidence age — already composed by the daemon; there is nothing left for this client to append (#44 AC1/AC3). */
  readonly text: string;
  /** Structured copy of the sources already woven into `text` — for callers that want them machine-read, not for re-rendering. */
  readonly sources: readonly DraftSource[];
}

export interface PublicPassedOn {
  readonly duo: "personal";
  readonly kind: "passed_on";
  readonly text: string;
}

export interface PublicDeclinedRefused {
  readonly duo: "personal";
  readonly kind: "declined_refused";
  readonly text: string;
}

export type PublicAnswerOutcome = PublicAnswered | PublicPassedOn | PublicDeclinedRefused;

/**
 * One row of `GET /channels` (digital-duo #171) — a channel in a shape that
 * names no messaging product: `kind` is an opaque identifier and `label` is
 * the adapter's own display string, and this client renders both without
 * recognising either (#43). `state` is the daemon's own connection-health
 * word; a screen may branch on `"failed"` (the daemon's general vocabulary,
 * not any one channel's) and must render any other value as it arrived.
 * `reason` is present iff `state` is `"failed"`, in the adapter's words.
 * `muted` is the daemon's re-read of the one mute store — never a flag the
 * client keeps.
 */
export interface ChannelSummary {
  readonly kind: string;
  readonly label: string;
  readonly state: "connected" | "failed";
  readonly reason?: string;
  readonly lastActivityAt: string | null;
  readonly muted: boolean;
}

/**
 * What the policy routes answer (digital-duo #172): the one mute store read
 * by scope. `muted` holds channel kinds; `mutedThreads` scopes a mute to one
 * thread within a channel, which no client screen sets yet.
 */
export interface ChannelPolicy {
  readonly muted: string[];
  readonly mutedThreads: { readonly channel: string; readonly threadId: string }[];
}

// #54: `GET /escalations/history` and `GET /escalations/rate` (digital-duo
// #178), mirrored by hand from `src/escalation/digest.ts`. A digest is an
// append-only record of a batch actually sent — its items are the ordinary
// (never the urgent, which interrupt live) unresolved escalations gathered
// into it.
export interface EscalationDigestItem {
  readonly draftId: string;
  readonly question: string;
  readonly threadContext: string | null;
  readonly escalationReason: string | null;
  readonly createdAt: string;
}

export interface SentEscalationDigest {
  readonly id: string;
  readonly createdAt: string;
  readonly itemCount: number;
  readonly items: readonly EscalationDigestItem[];
}

/** All-time, over every escalation the daemon has classified: `rate` is `urgent / total`, and 0 (never NaN) when `total` is 0. */
export interface EscalationUrgencyRate {
  readonly total: number;
  readonly urgent: number;
  readonly rate: number;
}

// #55: `POST /lifecycle/end`'s answer (digital-duo #181), verbatim from the
// core's `EndDuoResult`. Without `confirmed: true` in the request it is only
// a description — what WOULD go, with nothing deleted — and `confirmed` in
// the answer says which of the two happened. The path lists are the
// daemon's own relative paths: the client counts them and shows them, and
// claims nothing the daemon did not list.
export interface EndDuoResult {
  /** True only when deletion actually ran. */
  readonly confirmed: boolean;
  readonly storeDataDir: string;
  /** Files under the store's data directory — what the duo knows. */
  readonly storePaths: readonly string[];
  readonly duoDir: string;
  /** Files derived from it — rules, voice, refusals, lifecycle records. */
  readonly duoDirPaths: readonly string[];
}

// Invite-only hosted mode (digital-duo's hosted daemon): `POST
// {origin}/hosted/signup` answers the new duo's address suffix and the first
// device token, shown exactly once. `basePath` is appended to the daemon
// origin to make this device's `baseUrl` (the duo's own path on the daemon).
export interface HostedSignupResult {
  /** null for the server's original (root) duo, which lives at the bare origin. */
  readonly tenantId: string | null;
  /** The duo's path under the daemon origin (/t/ then the tenant id), or "" for the root duo. */
  readonly basePath: string;
  readonly token: string;
  readonly ownerName: string;
  /** May mint invites from Settings. Absent from a daemon that predates sign-in — read as false. */
  readonly isAdmin?: boolean;
  /** #254: this duo's role in its org — `org_admin` manages the org, `member` is anyone else (the super admin is `isAdmin`, apart). Absent from a daemon that predates org admins. */
  readonly orgRole?: "member" | "org_admin";
  /** The org this duo belongs to (null for the root duo of a server with no org for it). Absent from a daemon that predates orgs. */
  readonly orgId?: string | null;
}

/** `GET {origin}/hosted/config` — what the sign-in page needs. A null client id means sign-in isn't configured on that server. */
export interface HostedConfig {
  readonly googleClientId: string | null;
}


// `POST /corpus/import-claude`: a Claude data export's conversations.json,
// imported exactly as `duo import claude` does — the daemon's own counts.
export interface ClaudeImportSummary {
  readonly conversationCount: number;
  readonly workRelevantConversationCount: number;
  readonly written: number;
  readonly skipped: number;
  readonly discardedAboveCeiling: number;
}

export type DeriveStage = "pairs" | "topics" | "rules" | "voice";

// `GET`/`POST /corpus/derive`: the daemon's one derive job — pairs, topics,
// rules, voice, in that order. `stage` names the step running (or the one
// that failed); `error` is the failing step's own message, verbatim.
export interface DeriveJobStatus {
  readonly state: "idle" | "running" | "done" | "error";
  readonly stage: DeriveStage | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

// `GET /ask-links`: every ask link this duo has minted — never its token,
// which is shown once at minting (`MintedAskLink`) and never again.
export interface AskLinkRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly valid: boolean;
}

export interface MintedAskLink {
  readonly id: string;
  readonly name: string;
  readonly expiresAt: string;
  readonly token: string;
}

// `POST /devices`: pairing another device from an already-paired one.
export interface MintedDevice {
  readonly id: string;
  readonly name: string;
  readonly token: string;
}

// `GET /connector` and `POST /connector` (digital-duo#227): the claude.ai connector.
// GET says whether one exists (its URL is never recoverable) and carries the prompt
// the owner pastes into claude.ai to feed their past chats; POST answers the URL
// path exactly once, to be joined to the daemon address.
export interface ConnectorConnection {
  readonly id: string;
  readonly clientName: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  /** What the owner allowed at sign-in, as permission ids (digital-duo#256). Absent from a daemon that predates them. */
  readonly scopes?: readonly string[];
}

// `mode` is "signin" where the daemon connects Claude by Google sign-in (digital-duo#240): there is one
// plain `url` to paste and `connections` to disconnect, and no secret to mint. Absent or "secret": the
// secret-URL connector above. An older daemon sends no `mode`.
export interface ConnectorStatus {
  readonly mode?: "secret" | "signin";
  readonly connector: { readonly id: string; readonly createdAt: string } | null;
  readonly url?: string;
  readonly connections?: readonly ConnectorConnection[];
  readonly historyPrompt: string;
}

export interface MintedConnector {
  readonly id: string;
  readonly createdAt: string;
  readonly path: string;
}

// `GET /trust/promotions` — the core's `PromotionOffer`, verbatim.
export interface PromotionOffer {
  readonly topicId: string;
  readonly topicLabel: string | undefined;
  readonly tier: TrustTier;
  readonly currentLevel: AutonomyLevel;
  readonly offeredLevel: AutonomyLevel;
  readonly cleanStreak: number;
}

export interface GrantCandidate {
  readonly topicId: string;
  readonly label: string;
  readonly score: number;
}

// `POST /trust/grant` — the core's `GrantOutcome`, verbatim. "ambiguous"
// is the owner's turn: pick a candidate and re-post with its topicId.
export type GrantOutcome =
  | { readonly status: "applied"; readonly topicId: string; readonly topicLabel: string; readonly tier: TrustTier }
  | { readonly status: "ambiguous"; readonly candidates: readonly GrantCandidate[] }
  | { readonly status: "no_match" }
  | { readonly status: "topic_not_found"; readonly topicId: string }
  | { readonly status: "refused"; readonly refusal: { readonly heading: string; readonly reason: string } };
