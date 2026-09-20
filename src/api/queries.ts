import { useCallback, useRef } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { apiRequest, type DuoApiConfig } from "./client.js";
import type {
  AuditEntry,
  CorrectionCandidate,
  DraftOutcome,
  DraftPipelineResult,
  DraftRecord,
  DuoSummary,
  GridRow,
  InterruptionPortrait,
  Rule,
  RuleReviewListing,
  SettableDraftOutcome,
} from "./types.js";

/**
 * The Duo feed's page size (#29) — how much history one `GET /drafts?limit=`
 * window carries. Small enough that opening the thread is one fast fetch,
 * large enough that a conversation reads without paging every few turns.
 */
export const DRAFTS_PAGE_SIZE = 50;

/**
 * Query keys mirror the routes (`client-tech-design.md` §3.2), so
 * invalidation reads as "which route changed" rather than a hand-maintained
 * list. `["drafts", …]` and `["review"]` are invalidated together by any
 * outcome mutation — an "edited" outcome writes the draft row *and* queues
 * a correction candidate in one call, and missing the second invalidation
 * is the easiest bug to ship here (§3.2's own warning).
 */
export const queryKeys = {
  duos: ["duos"] as const,
  drafts: (opts?: { outcome?: DraftOutcome | "pending" }) => ["drafts", opts ?? {}] as const,
  // The paged shape of GET /drafts (#29). Keyed by an object like the
  // outcome filter so it can never collide with `draft(id)`'s string
  // element, and still a child of the ["drafts"] root — every existing
  // invalidation (outcome mutations, composer submits, draft-ready pushes)
  // reaches the feed without a new call site.
  draftsFeed: ["drafts", { limit: DRAFTS_PAGE_SIZE }] as const,
  draft: (id: string) => ["drafts", id] as const,
  review: ["review"] as const,
  mirrorPortrait: ["mirror", "portrait"] as const,
  mirrorRules: ["mirror", "rules"] as const,
  trustGrid: ["trust", "grid"] as const,
  audit: ["audit"] as const,
};

export function useDuos(api: DuoApiConfig, options?: Partial<UseQueryOptions<DuoSummary[]>>) {
  return useQuery({ queryKey: queryKeys.duos, queryFn: () => apiRequest<DuoSummary[]>(api, "/duos"), ...options });
}

export function usePendingDrafts(api: DuoApiConfig) {
  return useQuery({
    queryKey: queryKeys.drafts({ outcome: "pending" }),
    queryFn: () => apiRequest<DraftRecord[]>(api, "/drafts?outcome=pending"),
  });
}

/**
 * One draft by id — `GET /drafts/:id`, the §1.4 route the single-draft
 * address (#25) is built on. The key sits under the `["drafts"]` root, so
 * outcome writes and draft-ready pushes invalidate it with everything
 * else; the ws layer's root-key comment already promised this child key.
 */
export function useDraft(api: DuoApiConfig, id: string) {
  return useQuery({ queryKey: queryKeys.draft(id), queryFn: () => apiRequest<DraftRecord>(api, `/drafts/${encodeURIComponent(id)}`) });
}

/**
 * The Duo thread view's data (#29): the draft log as pages, newest window
 * first, instead of the whole history in one fetch. The daemon's contract
 * (digital-duo #203): `GET /drafts?limit=N` is the NEWEST N drafts,
 * newest-first; `before` (exclusive) fed the current page's oldest
 * createdAt yields the adjacent older window. A short page — fewer rows
 * than the page size below the cursor — means history is exhausted; an
 * exact multiple of the page size costs one empty page to learn that, the
 * daemon's documented end-of-history signal.
 *
 * Replaces #8's un-paged `useDrafts` (the whole log on every visit, the
 * `client-tech-design.md` G-b violation). Invalidation needs no new call
 * sites: the key sits under the `["drafts"]` root, and TanStack's refetch
 * recomputes each page's cursor from the freshly fetched window above it —
 * so new drafts arriving above a loaded walk shift the windows without
 * leaving a gap at the seam.
 */
export function useDraftsFeed(api: DuoApiConfig) {
  return useInfiniteQuery({
    queryKey: queryKeys.draftsFeed,
    queryFn: ({ pageParam }) =>
      apiRequest<DraftRecord[]>(
        api,
        pageParam === undefined
          ? `/drafts?limit=${DRAFTS_PAGE_SIZE}`
          : `/drafts?limit=${DRAFTS_PAGE_SIZE}&before=${encodeURIComponent(pageParam)}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length < DRAFTS_PAGE_SIZE ? undefined : lastPage[lastPage.length - 1].createdAt,
  });
}

export function useReview(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.review, queryFn: () => apiRequest<CorrectionCandidate[]>(api, "/review") });
}

export function useMirrorPortrait(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.mirrorPortrait, queryFn: () => apiRequest<InterruptionPortrait>(api, "/mirror/portrait") });
}

export function useMirrorRules(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.mirrorRules, queryFn: () => apiRequest<RuleReviewListing>(api, "/mirror/rules") });
}

export function useTrustGrid(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.trustGrid, queryFn: () => apiRequest<GridRow[]>(api, "/trust/grid") });
}

export function useAudit(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.audit, queryFn: () => apiRequest<AuditEntry[]>(api, "/audit") });
}

/**
 * How long the composer's POST /drafts may run before the client gives up on
 * it (#27). §1.4 budgeted "ask → draft in seconds, ideally <5s"; a real
 * provider can blow past that by an order of magnitude, so the window is
 * generous — but finite, because a wedged ask must end by itself instead of
 * pinning the composer's submit button forever.
 */
export const ASK_TIMEOUT_MS = 60_000;

/**
 * Creates a draft (the composer's submit action). Invalidates the
 * pending-drafts list — the new draft (or escalation) should appear in
 * Review immediately. Returns the mutation plus a `cancel` for the
 * composer's Cancel button (#27): one in-flight ask at a time, aborted at
 * the fetch layer so a slow daemon can be abandoned without waiting out
 * the timeout.
 */
export function useCreateDraft(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  const controllerRef = useRef<AbortController | null>(null);
  const mutation = useMutation({
    mutationFn: (input: { question: string; threadContext?: string | null }) => {
      controllerRef.current = new AbortController();
      return apiRequest<DraftPipelineResult>(api, "/drafts", {
        method: "POST",
        body: JSON.stringify(input),
        signal: controllerRef.current.signal,
        timeoutMs: ASK_TIMEOUT_MS,
      });
    },
    onSettled: () => {
      controllerRef.current = null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);
  return { mutation, cancel };
}

/**
 * Send / Edit / Ignore. Invalidates both `["drafts"]` and `["review"]` —
 * see this module's doc comment on why both, always, regardless of which
 * outcome was recorded (an "edited" outcome is the one that actually
 * queues a candidate, but invalidating unconditionally is simpler and
 * cheaper than branching on outcome to decide).
 */
export function useRecordOutcome(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draftId, outcome, sentText }: { draftId: string; outcome: SettableDraftOutcome; sentText?: string }) =>
      apiRequest(api, `/drafts/${draftId}/outcome`, { method: "POST", body: JSON.stringify({ outcome, sentText }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.review });
    },
  });
}

export function useAnswerEscalation(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draftId, answer }: { draftId: string; answer: string }) =>
      apiRequest<{ candidateId: string }>(api, `/drafts/${draftId}/answer`, { method: "POST", body: JSON.stringify({ answer }) }),
    // Only ["drafts"] — this writes to standing_order_candidates, not the
    // correction_candidates table queryKeys.review actually serves
    // (GET /review), so invalidating it here would only ever fire a
    // network request whose result can never change from this mutation.
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}

export function useRuleAction(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, action }: { ruleId: string; action: "approve" | "reject" | "promote" }) =>
      apiRequest<Rule>(api, `/mirror/rules/${ruleId}/${action}`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mirrorRules });
    },
  });
}
