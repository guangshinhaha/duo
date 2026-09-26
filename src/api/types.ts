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

export type DuoSummary = { kind: "personal" } | { kind: "shared"; ownerId: string; ownerName: string };

export interface DraftSource {
  kind: "rule" | "evidence";
  id: string;
  label: string;
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
