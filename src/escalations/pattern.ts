import type { EscalationDigestItem, SentEscalationDigest } from "../api/types.js";

/** One question the duo kept having to escalate, with every escalation of it in the digests. */
export interface EscalationGroup {
  /** The most recent member's question, verbatim — the group is worded by what was last actually asked. */
  readonly question: string;
  /** The most recent member's reason, as the daemon wrote it. */
  readonly escalationReason: string | null;
  readonly count: number;
  /** Newest first — `draftIds[0]` is the escalation a person would answer. */
  readonly draftIds: readonly string[];
  readonly latestAt: string;
}

export interface EscalationPattern {
  readonly groups: readonly EscalationGroup[];
  readonly totalEscalations: number;
  readonly digestCount: number;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
}

/**
 * Two wordings are the same question when they differ only in case and
 * whitespace. Nothing subtler: matching by resemblance would be a judgement
 * the daemon never made, so a near-miss stays its own group and every count
 * is an exact one — what `duo escalations history` holds, arranged, never
 * inferred.
 */
export function normalizeQuestion(question: string): string {
  return question.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The pattern across the sent digests (#54): each distinct question, how
 * many times it was escalated, most-escalated first (equal counts: the more
 * recently escalated first). Pure arrangement of the daemon's own rows — a
 * draft is counted once even if a payload ever listed it twice, and a digest
 * that is not the documented shape (a cache written by another build)
 * contributes nothing rather than crashing the screen.
 */
export function escalationPattern(digests: readonly SentEscalationDigest[]): EscalationPattern {
  const seen = new Set<string>();
  const byQuestion = new Map<string, EscalationDigestItem[]>();
  let digestCount = 0;
  for (const digest of digests) {
    if (!digest || !Array.isArray(digest.items)) {
      continue;
    }
    digestCount += 1;
    for (const item of digest.items) {
      if (!item || typeof item.question !== "string" || seen.has(item.draftId)) {
        continue;
      }
      seen.add(item.draftId);
      const key = normalizeQuestion(item.question);
      byQuestion.set(key, [...(byQuestion.get(key) ?? []), item]);
    }
  }

  const ranked = [...byQuestion.entries()].map(([key, items]) => {
    // Newest first; the draft id keeps equal timestamps deterministic.
    const newestFirst = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.draftId.localeCompare(a.draftId));
    const latest = newestFirst[0]!;
    const group: EscalationGroup = {
      question: latest.question,
      escalationReason: latest.escalationReason,
      count: items.length,
      draftIds: newestFirst.map((item) => item.draftId),
      latestAt: latest.createdAt,
    };
    return { key, group };
  });
  ranked.sort((a, b) => b.group.count - a.group.count || b.group.latestAt.localeCompare(a.group.latestAt) || a.key.localeCompare(b.key));

  const times = [...byQuestion.values()]
    .flat()
    .map((item) => item.createdAt)
    .sort();
  return {
    groups: ranked.map((entry) => entry.group),
    totalEscalations: seen.size,
    digestCount,
    periodStart: times[0] ?? null,
    periodEnd: times[times.length - 1] ?? null,
  };
}
