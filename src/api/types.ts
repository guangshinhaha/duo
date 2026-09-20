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
