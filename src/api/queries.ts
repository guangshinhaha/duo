import { useCallback, useRef } from "react";
import {
  defaultShouldDehydrateQuery,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type Query,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { apiRequest, type DuoApiConfig } from "./client.js";
import { pushSubscriptionStatus, subscribeToPush, unsubscribeFromPush } from "../push.js";
import {
  createInvite,
  createOrg,
  createOwnOrgInvite,
  fetchOrgOverview,
  grantOrgAdmin,
  grantOwnOrgAdmin,
  listInvites,
  listOrgMembers,
  listOrgs,
  listOwnOrgInvites,
  listOwnOrgMembers,
  renameOrg,
  renameOwnOrg,
  revokeOrgAdmin,
  revokeOwnOrgAdmin,
  type CreateInviteInput,
} from "./hosted.js";
import type {
  AskLinkRow,
  AuditEntry,
  ClaudeImportSummary,
  DeriveJobStatus,
  GrantOutcome,
  MintedAskLink,
  ConnectorStatus,
  MintedConnector,
  MintedDevice,
  PromotionOffer,
  TrustTier,
  ChannelPolicy,
  ChannelSummary,
  CorrectionCandidate,
  DismissReason,
  DraftOutcome,
  DraftPipelineResult,
  DraftRecord,
  DuoKnowledge,
  DuoRequest,
  ExcludedEvidence,
  FactCheckResult,
  RoomOffTheRecord,
  RewriteInstruction,
  RewriteResult,
  EscalationUrgencyRate,
  EmbedJobStatus,
  GridRow,
  InterruptionPortrait,
  VoiceTrend,
  PendingT4Request,
  PendingT4RequestForJudgement,
  RecipientRef,
  RefusalsListing,
  AwayScope,
  AwayState,
  NeverAnswerInput,
  NeverAnswerSuggestion,
  TopicOption,
  PairedDevice,
  PasteImportSummary,
  PinnedAnswer,
  Rule,
  RuleReviewListing,
  RuleWithEvidence,
  SearchOutcome,
  SentEscalationDigest,
  SettableDraftOutcome,
  ShapeInstruction,
  ScheduledSend,
  AutonomyOffer,
  AutonomyGrant,
  AutonomySettings,
  SendLater,
  VoiceAdaptationStatus,
  WorkingHours,
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
  drafts: (opts?: { outcome?: DraftOutcome | "pending" }) => ["drafts", opts ?? {}] as const,
  // The paged shape of GET /drafts (#29). Keyed by an object like the
  // outcome filter so it can never collide with `draft(id)`'s string
  // element, and still a child of the ["drafts"] root — every existing
  // invalidation (outcome mutations, composer submits, draft-ready pushes)
  // reaches the feed without a new call site.
  draftsFeed: ["drafts", { limit: DRAFTS_PAGE_SIZE }] as const,
  draft: (id: string) => ["drafts", id] as const,
  // #261: the sends the daemon is holding. Under the ["drafts"] root so every outcome mutation refreshes it too.
  scheduledSends: ["drafts", { scheduled: true }] as const,
  workingHours: ["settings", "working-hours"] as const,
  // #268: what your duo is about to send by itself. Under ["drafts"] so a
  // draft-ready push and every outcome mutation refresh the live strip too.
  autonomousSends: ["drafts", { autonomous: true }] as const,
  autonomySettings: ["settings", "autonomy"] as const,
  // #266: under the ["trust"] root, so deciding an offer refreshes grants with it.
  autonomyOffers: ["trust", "autonomy", "offers"] as const,
  autonomyGrants: ["trust", "autonomy", "grants"] as const,
  review: ["review"] as const,
  mirrorPortrait: ["mirror", "portrait"] as const,
  // duo#276: bucketing is part of the key — switching week/month is a
  // different query, not a refetch of the same one with different params.
  mirrorVoiceTrend: (bucket: "week" | "month") => ["mirror", "voice-trend", bucket] as const,
  mirrorRules: ["mirror", "rules"] as const,
  // Under the ["mirror", "rules"] root on purpose: a disposition invalidates
  // the listing by prefix and so refreshes any open evidence with it.
  mirrorRule: (id: string) => ["mirror", "rules", id] as const,
  mirrorRefusals: ["mirror", "refusals"] as const,
  // duo#275: the owner's pinned exact-wording answers.
  mirrorPinnedAnswers: ["mirror", "pinned-answers"] as const,
  // #270: the away period and the topics it can add. (#269's ceiling has no
  // query key: it is policy-set, read nowhere by this client — see
  // profile/Ceiling.tsx.)
  away: ["away"] as const,
  topics: ["topics"] as const,
  trustGrid: ["trust", "grid"] as const,
  audit: ["audit"] as const,
  // #52: the staged irreversible steps awaiting the owner's confirmation.
  t4Pending: ["actions", "t4", "pending"] as const,
  knowledge: ["knowledge"] as const,
  // #47: what this duo is reachable through — the mute routes invalidate it, since `muted` on each row is the daemon's re-read of the policy.
  channels: ["channels"] as const,
  // #54: the two read-only escalation routes — nothing this client writes
  // touches either (the digest POST is deliberately never called).
  escalationHistory: ["escalations", "history"] as const,
  escalationRate: ["escalations", "rate"] as const,
  // #48: the paired devices — GET /devices; a revoke writes into and refreshes it.
  devices: ["devices"] as const,
  // #49: the daemon's one embed job — runtime state (one job, process-bound), so its own key rather than a corpus read.
  embedJob: ["corpus", "embed"] as const,
  // Hosted mode: the daemon's one derive job (pairs → topics → rules → voice), runtime state like the embed job.
  deriveJob: ["corpus", "derive"] as const,
  // The ask links this duo has minted — never their tokens.
  askLinks: ["ask-links"] as const,
  connector: ["connector"] as const,
  hostedInvites: ["hosted-invites"] as const,
  hostedOrgs: ["hosted-orgs"] as const,
  hostedOrgMembers: (orgId: string) => ["hosted-orgs", orgId, "members"] as const,
  // #254: an org admin's own org, through the duo's own routes (`<basePath>/org*`). One root, so the persisted cache
  // can leave all of it out and a role change can refresh all of it.
  orgOverview: ["org", "overview"] as const,
  // Keyed by the org, so a duo that moves to another org never shows the first org's cached people or invites while the new ones load.
  orgMembers: (orgId: string) => ["org", orgId, "members"] as const,
  orgInvites: (orgId: string) => ["org", orgId, "invites"] as const,
  // Under the ["trust"] root: accepting a promotion or granting autonomy moves the grid too.
  trustPromotions: ["trust", "promotions"] as const,
  // #46: keyed by the submitted query — each distinct search is its own
  // cache entry, so revisiting a recent query is instant and a stale
  // search never blocks a new one.
  search: (q: string) => ["search", q] as const,
  // #308: this browser's own `PushManager` state — never persisted (the
  // real answer lives in the browser, not the daemon) and re-read after
  // every subscribe/unsubscribe.
  pushSubscription: ["push-subscription"] as const,
  // digital-duo #279 (issue #262): keyed by recipient id, so resetting one
  // person's learned tone never invalidates another's.
  voiceAdaptation: (personId: string) => ["people", personId, "voice-adaptation"] as const,
  // #315: colleagues' held requests to talk to the duo.
  duoRequests: ["workspace-requests"] as const,
  // duo#272 (digital-duo#288): the evidence the owner has removed from
  // citation — read back by the Knows tab. Its own key, not nested under
  // ["knowledge"]: the knowledge summary route never changes when an
  // exclusion is made or undone, so invalidating one must never imply the
  // other reads stale.
  excludedEvidence: ["knowledge", "evidence", "excluded"] as const,
  // duo#274: keyed by room, so marking one conversation off the record
  // never invalidates another's read.
  roomOffTheRecord: (roomId: string) => ["workspace", "rooms", roomId, "off-the-record"] as const,
};

/** `null` (a member with no duo paired) reads nothing: the query stays idle, and its data is `undefined`. */
export function usePendingDrafts(api: DuoApiConfig | null) {
  return useQuery({
    queryKey: queryKeys.drafts({ outcome: "pending" }),
    queryFn: () => apiRequest<DraftRecord[]>(api!, "/drafts?outcome=pending"),
    enabled: api !== null,
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
export function useDraftsFeed(api: DuoApiConfig | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.draftsFeed,
    enabled: api !== null,
    queryFn: ({ pageParam }) =>
      apiRequest<DraftRecord[]>(
        api!,
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
  return useQuery({
    queryKey: queryKeys.review,
    // The queue screen is the pending list, so it asks for the daemon's
    // own filter (#44) rather than every status ever reviewed — the bare
    // route returns them all, which is history, not a queue.
    queryFn: () => apiRequest<CorrectionCandidate[]>(api, "/review?status=pending"),
  });
}

/**
 * #44: disposing of a correction candidate — the training signal's moment
 * of confirmation. `approve`/`reject` are digital-duo #173's routes; the
 * daemon owns every consequence (voice.md writes, rule writes, finality),
 * and a 409 (`CandidateAlreadyReviewedError` — another device won the
 * race — or `CandidateConflictError`) travels as the mutation's error for
 * the screen to render verbatim.
 */
export function useDecideCandidate(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ candidateId, action }: { candidateId: string; action: "approve" | "reject" }) =>
      apiRequest<{ candidate: CorrectionCandidate }>(api, `/review/${encodeURIComponent(candidateId)}/${action}`, {
        method: "POST",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.review });
      // An approved candidate is a write the Mirror counts — style lands
      // in voice corrections, substance as a confirmed rule — so the rules
      // listing is stale the moment a decision lands (§3.2's discipline:
      // one action writes two surfaces; miss the second and the Mirror
      // shows a rule count the daemon no longer has).
      queryClient.invalidateQueries({ queryKey: queryKeys.mirrorRules });
    },
  });
}

export function useMirrorPortrait(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.mirrorPortrait, queryFn: () => apiRequest<InterruptionPortrait>(api, "/mirror/portrait") });
}

/** `GET /mirror/voice-trend` (digital-duo duo#276): how closely recent drafts match the owner's own recent approved sends, bucketed over time. */
export function useMirrorVoiceTrend(api: DuoApiConfig, bucket: "week" | "month" = "week") {
  return useQuery({
    queryKey: queryKeys.mirrorVoiceTrend(bucket),
    queryFn: () => apiRequest<VoiceTrend>(api, `/mirror/voice-trend?bucket=${bucket}`),
  });
}

export function useMirrorRules(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.mirrorRules, queryFn: () => apiRequest<RuleReviewListing>(api, "/mirror/rules") });
}

/** `GET /mirror/refusals` — what the owner's duo must never speak for them on, and why (#53). */
export function useMirrorRefusals(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.mirrorRefusals, queryFn: () => apiRequest<RefusalsListing>(api, "/mirror/refusals") });
}

/** `GET /mirror/pinned-answers` (digital-duo duo#275) — every pinned answer, newest first, as the Rules tab lists them. */
export function useMirrorPinnedAnswers(api: DuoApiConfig) {
  return useQuery({
    queryKey: queryKeys.mirrorPinnedAnswers,
    queryFn: () => apiRequest<{ pinnedAnswers: PinnedAnswer[] }>(api, "/mirror/pinned-answers"),
  });
}

/**
 * duo#275: pins the owner's own message as the exact, canonical answer to a
 * question/topic — `POST /mirror/pinned-answers`. `sourceLabel` is the
 * message action's own context (e.g. "pinned from #general"), purely
 * descriptive. Invalidates the listing (same shape as `useRuleAction`),
 * rather than splicing the cache by hand, so the Rules tab and the message
 * action that just created it always read the daemon's own listing back.
 */
export function useCreatePinnedAnswer(api: DuoApiConfig | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pattern, answerText, sourceLabel }: { pattern: string; answerText: string; sourceLabel?: string | null }) =>
      api
        ? apiRequest<PinnedAnswer>(api, "/mirror/pinned-answers", { method: "POST", body: JSON.stringify({ pattern, answerText, sourceLabel }) })
        : Promise.reject(new Error("No duo is paired to pin an answer with.")),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mirrorPinnedAnswers });
    },
  });
}

/** `POST /mirror/pinned-answers/:id/edit` (duo#275) — edits the pattern and/or wording of an existing pin in place. */
export function useEditPinnedAnswer(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pattern, answerText }: { id: string; pattern?: string; answerText?: string }) =>
      apiRequest<PinnedAnswer>(api, `/mirror/pinned-answers/${encodeURIComponent(id)}/edit`, {
        method: "POST",
        body: JSON.stringify({ pattern, answerText }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mirrorPinnedAnswers });
    },
  });
}

/**
 * `DELETE /mirror/pinned-answers/:id` (duo#275) — unpins an answer; the
 * daemon-side route is idempotent, so removing one already gone is
 * harmless. Invalidates rather than filtering the cache directly so the
 * card's own "Unpinned." state (`PinnedAnswerCard`) has a listing to fold
 * away from, the same `useLeaving` motion every other rule disposition
 * here already uses.
 */
export function useDeletePinnedAnswer(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => apiRequest<{ deleted: true }>(api, `/mirror/pinned-answers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.mirrorPinnedAnswers });
    },
  });
}

/**
 * #269: add, edit or remove a never-answer rule. Every write answers with the
 * whole listing, which replaces the cached one, so the list never shows a
 * rule the daemon didn't keep. The trust grid is refreshed too: a grant that
 * conflicts with a new rule stops being honoured.
 */
export function useSaveNeverAnswer(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input, editing }: { input: NeverAnswerInput; editing?: string }) =>
      editing === undefined
        ? apiRequest<RefusalsListing>(api, "/mirror/refusals", { method: "POST", body: JSON.stringify(input) })
        : apiRequest<RefusalsListing>(api, `/mirror/refusals/${encodeURIComponent(editing)}`, { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: (listing) => {
      queryClient.setQueryData(queryKeys.mirrorRefusals, listing);
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
  });
}

export function useRemoveNeverAnswer(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (heading: string) => apiRequest<RefusalsListing>(api, `/mirror/refusals/${encodeURIComponent(heading)}`, { method: "DELETE" }),
    onSuccess: (listing) => {
      queryClient.setQueryData(queryKeys.mirrorRefusals, listing);
    },
  });
}

/**
 * #270: where away mode stands. Re-read every minute: a period ends on its
 * own at its end time, and the status line and return summary should follow
 * without the owner having to do anything.
 */
export function useAway(api: DuoApiConfig | null) {
  return useQuery({
    queryKey: queryKeys.away,
    queryFn: () => apiRequest<AwayState>(api!, "/away"),
    enabled: api !== null,
    refetchInterval: 60_000,
  });
}

/** #270: the topics an away period can add. */
export function useTopics(api: DuoApiConfig, enabled: boolean) {
  return useQuery({ queryKey: queryKeys.topics, queryFn: () => apiRequest<TopicOption[]>(api, "/topics"), enabled });
}

function useAwayWrite<TVars>(request: (vars: TVars) => Promise<AwayState>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (state) => {
      queryClient.setQueryData(queryKeys.away, state);
    },
  });
}

/** #270: starts (or changes) an away period. */
export function useSetAway(api: DuoApiConfig) {
  return useAwayWrite((body: { until: string; scope: AwayScope; extraTopicIds?: string[] }) =>
    apiRequest<AwayState>(api, "/away", { method: "PUT", body: JSON.stringify(body) }),
  );
}

/** #270: back early — ends the period now. */
export function useEndAway(api: DuoApiConfig) {
  return useAwayWrite(() => apiRequest<AwayState>(api, "/away", { method: "DELETE" }));
}

/** #270: the owner has read the return summary. */
export function useDismissAwaySummary(api: DuoApiConfig) {
  return useAwayWrite(() => apiRequest<AwayState>(api, "/away/summary/dismiss", { method: "POST" }));
}

/**
 * `GET /mirror/rules/:id` — one rule with the exchanges its evidence cites
 * (#53). `enabled` lets the card ask only when the owner opens the evidence:
 * a listing of rules must not fan out into one read per rule.
 */
export function useMirrorRule(api: DuoApiConfig, id: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.mirrorRule(id),
    queryFn: () => apiRequest<RuleWithEvidence>(api, `/mirror/rules/${encodeURIComponent(id)}`),
    enabled,
  });
}

/** #45: what this duo knows, in one read (digital-duo #175's composition). Read-only — no client route writes it, so nothing invalidates it but a refetch. */
export function useKnowledge(api: DuoApiConfig, options?: Partial<UseQueryOptions<DuoKnowledge>>) {
  return useQuery({ queryKey: queryKeys.knowledge, queryFn: () => apiRequest<DuoKnowledge>(api, "/knowledge"), ...options });
}

/** #47: what this duo is reachable through (digital-duo #171) — one row per bridged channel, every display string the adapter's own. An empty list is a supported configuration, not an error. */
export function useChannels(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.channels, queryFn: () => apiRequest<ChannelSummary[]>(api, "/channels") });
}

/**
 * #47: mute or unmute one channel through the policy route (digital-duo
 * #172). The body carries the channel's `kind` — the key the daemon's one
 * mute store uses — and nothing this client computed. The answer is the
 * updated policy, which this screen has no use for: the list is refetched,
 * because the row's `muted` is the daemon's word, not a local flag.
 */
export function useSetChannelMute(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channel, muted }: { channel: string; muted: boolean }) =>
      apiRequest<ChannelPolicy>(api, muted ? "/channels/policy/mute" : "/channels/policy/unmute", {
        method: "POST",
        body: JSON.stringify({ channel }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.channels });
    },
  });
}

/**
 * #46: the page size the daemon's own default gives (digital-duo #174's
 * `limit` defaults to 10). The client sends no `limit`, so a full page —
 * exactly this many results — is the only honest "maybe more" signal.
 */
export const SEARCH_PAGE_SIZE = 10;

/** #46: corpus search, paged by the daemon's rank cursor ("last rank + 1" pages forward; a result's rank is its stable position in the full fused list). */
export function useCorpusSearch(api: DuoApiConfig, q: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.search(q),
    // No search until there is one: an empty q would only ever earn the
    // daemon's 400, and the overlay mounts this hook before its first
    // submit.
    enabled: q.length > 0,
    queryFn: ({ pageParam }) =>
      apiRequest<SearchOutcome>(
        api,
        pageParam === 0 ? `/search?q=${encodeURIComponent(q)}` : `/search?q=${encodeURIComponent(q)}&cursor=${pageParam}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage) =>
      lastPage.results.length >= SEARCH_PAGE_SIZE ? lastPage.results[lastPage.results.length - 1]!.rank + 1 : undefined,
  });
}

/**
 * #54: the most digests one `GET /escalations/history` page carries — the
 * daemon's own bound (digital-duo #178 validates 1..100, /search's
 * vocabulary). Sent at its maximum so the whole history is few requests.
 */
export const ESCALATION_HISTORY_PAGE_SIZE = 100;

/**
 * #54: every digest the daemon has sent, as pages. The route is oldest
 * first and its `cursor` is an offset into that order, so the next page's
 * cursor is the number of digests already held; a short page is the end.
 * The pattern counts across all of them, so the screen walks every page
 * before it draws a count.
 */
export function useEscalationHistory(api: DuoApiConfig) {
  return useInfiniteQuery({
    queryKey: queryKeys.escalationHistory,
    queryFn: ({ pageParam }) =>
      apiRequest<SentEscalationDigest[]>(
        api,
        pageParam === 0
          ? `/escalations/history?limit=${ESCALATION_HISTORY_PAGE_SIZE}`
          : `/escalations/history?limit=${ESCALATION_HISTORY_PAGE_SIZE}&cursor=${pageParam}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      Array.isArray(lastPage) && lastPage.length >= ESCALATION_HISTORY_PAGE_SIZE
        ? allPages.reduce((held, page) => held + (Array.isArray(page) ? page.length : 0), 0)
        : undefined,
  });
}

/** #54: the urgency rate — the daemon's counts and its own quotient, read-only. */
export function useEscalationRate(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.escalationRate, queryFn: () => apiRequest<EscalationUrgencyRate>(api, "/escalations/rate") });
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
    // `recipient` (digital-duo #279, issue #262) rides along only when this
    // caller actually knows who the draft is addressed to — omitted
    // entirely (never sent as `null`) when it doesn't, which is the common
    // case: the owner's own "ask your duo" chat has nobody to name.
    mutationFn: (input: { question: string; threadContext?: string | null; recipient?: RecipientRef }) => {
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
 * #263: `POST /compose/rewrite` — polishes text the owner typed
 * themselves (a selection or the whole composer), never a duo-generated
 * draft. No query to invalidate: nothing is written anywhere until the
 * composer's own Replace applies the result locally.
 */
export function useRewriteText(api: DuoApiConfig | null) {
  return useMutation({
    mutationFn: (input: { text: string; instruction: RewriteInstruction }) =>
      api
        ? apiRequest<RewriteResult>(api, "/compose/rewrite", { method: "POST", body: JSON.stringify(input) })
        : Promise.reject(new Error("No duo is paired to rewrite with.")),
  });
}

/**
 * #264: `POST /compose/fact-check` — a debounced, opt-in check of the
 * owner's own typed composer text. Also writes nothing: the daemon reads
 * the corpus, never the composer's words.
 */
export function useFactCheck(api: DuoApiConfig | null) {
  return useMutation({
    mutationFn: (input: { text: string; threadContext?: string | null }) =>
      api
        ? apiRequest<FactCheckResult>(api, "/compose/fact-check", { method: "POST", body: JSON.stringify(input) })
        : Promise.reject(new Error("No duo is paired to fact-check against.")),
  });
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
    // #257: `alternative` names which of a hedged draft's candidates was
    // sent or kept; the daemon records the rest as not chosen. Absent for a
    // single draft — and then absent from the body too (JSON drops it).
    mutationFn: ({
      draftId,
      outcome,
      sentText,
      dismissReason,
      alternative,
      ownerDelivered,
    }: {
      draftId: string;
      outcome: SettableDraftOutcome;
      sentText?: string;
      /** #259: an optional, one-tap reason for a "discarded" outcome — the daemon refuses it alongside any other outcome. */
      dismissReason?: DismissReason;
      alternative?: number;
      /** #314: the owner already posted the text themselves, in the conversation — the daemon records it delivered. */
      ownerDelivered?: boolean;
    }) =>
      apiRequest(api, `/drafts/${draftId}/outcome`, {
        method: "POST",
        body: JSON.stringify({ outcome, sentText, dismissReason, alternative, ...(ownerDelivered ? { ownerDelivered: true } : {}) }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.review });
    },
  });
}

/**
 * #259's one-tap follow-up to a "shouldn't answer this" dismissal, made real
 * by #269: the daemon's starting words for a never-answer rule, read off the
 * dismissed draft's question. Nothing is recorded by this call — the owner
 * edits or approves the words, and only then does `useSaveNeverAnswer` write
 * the rule (#269: "rules are stated in plain words the owner wrote or
 * approved").
 */
export function requestNeverAnswerSuggestion(api: DuoApiConfig, draftId: string): Promise<NeverAnswerSuggestion> {
  return apiRequest<NeverAnswerSuggestion>(api, `/drafts/${encodeURIComponent(draftId)}/never-answer-suggestion`);
}

/**
 * Puts a draft the daemon just returned into every cached place it is
 * shown — the pending list, the paged feed, its own address — so a shaped
 * draft swaps in at once instead of after a refetch. Anything that isn't a
 * draft list or this draft is left alone.
 */
function replaceCachedDraft(queryClient: ReturnType<typeof useQueryClient>, updated: DraftRecord): void {
  const swap = (draft: DraftRecord): DraftRecord => (draft.id === updated.id ? updated : draft);
  queryClient.setQueriesData({ queryKey: ["drafts"] }, (data: unknown) => {
    if (Array.isArray(data)) {
      return (data as DraftRecord[]).map(swap);
    }
    if (data && typeof data === "object" && "pages" in data && Array.isArray((data as { pages: unknown }).pages)) {
      const paged = data as { pages: DraftRecord[][] };
      return { ...paged, pages: paged.pages.map((page) => page.map(swap)) };
    }
    if (data && typeof data === "object" && (data as DraftRecord).id === updated.id) {
      return updated;
    }
    return data;
  });
}

/**
 * #258: one tap on a shape chip — the daemon regenerates that candidate
 * with the instruction, over the sources it already cites, and logs the
 * tap as training signal (the request IS the record; nothing is logged
 * client-side). The returned draft swaps into the caches straight away.
 */
export function useShapeDraft(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draftId, instruction, alternative }: { draftId: string; instruction: ShapeInstruction; alternative: number }) =>
      apiRequest<DraftRecord>(api, `/drafts/${draftId}/shape`, { method: "POST", body: JSON.stringify({ instruction, alternative }), timeoutMs: ASK_TIMEOUT_MS }),
    onSuccess: (updated) => {
      replaceCachedDraft(queryClient, updated);
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}

/** #258: the one-tap undo — the daemon puts back the text the latest shape on that candidate replaced (and keeps the shape on record, marked undone). */
export function useUndoShape(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draftId, alternative }: { draftId: string; alternative: number }) =>
      apiRequest<DraftRecord>(api, `/drafts/${draftId}/shape/undo`, { method: "POST", body: JSON.stringify({ alternative }) }),
    onSuccess: (updated) => {
      replaceCachedDraft(queryClient, updated);
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}

/** #261: every send the daemon is holding for later, soonest first. */
export function useScheduledSends(api: DuoApiConfig | null) {
  return useQuery({
    queryKey: queryKeys.scheduledSends,
    queryFn: () => apiRequest<ScheduledSend[]>(api!, "/scheduled-sends"),
    enabled: api !== null,
    // A held send leaves this list on its own when it fires — re-read now and then so it does here too.
    refetchInterval: 60_000,
  });
}

/**
 * #261: hands an approved draft to the daemon to send later. The daemon holds
 * it — not this device — so it goes out even if this app is closed by then.
 */
export function useScheduleSend(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draftId, outcome, sentText, when }: { draftId: string; outcome: "sent" | "edited"; sentText?: string; when: SendLater }) =>
      apiRequest<ScheduledSend>(api, `/drafts/${draftId}/schedule`, { method: "POST", body: JSON.stringify({ outcome, sentText, ...when }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}

/** #261: takes a held send back before it fires; the draft returns to Waiting on you. */
export function useCancelScheduledSend(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) => apiRequest<void>(api, `/drafts/${draftId}/schedule`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}

/** #261: the working hours "start of their working hours" resolves against, with when they next start. */
export function useWorkingHours(api: DuoApiConfig | null) {
  return useQuery({
    queryKey: queryKeys.workingHours,
    queryFn: () => apiRequest<WorkingHours>(api!, "/settings/working-hours"),
    enabled: api !== null,
  });
}

export function useSaveWorkingHours(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (hours: Omit<WorkingHours, "nextStart">) =>
      apiRequest<WorkingHours>(api, "/settings/working-hours", { method: "PUT", body: JSON.stringify(hours) }),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.workingHours, saved);
    },
  });
}

/**
 * #268: every reply your duo is about to send by itself, still inside its
 * undo window. Re-read every couple of seconds while any is held — a held
 * reply leaves on its own when the window ends, and the strip must not show
 * a Stop for something already sent — and quietly otherwise.
 */
export function useAutonomousSends(api: DuoApiConfig | null) {
  return useQuery({
    queryKey: queryKeys.autonomousSends,
    queryFn: () => apiRequest<ScheduledSend[]>(api!, "/autonomous-sends"),
    enabled: api !== null,
    refetchInterval: (query) => (Array.isArray(query.state.data) && query.state.data.length > 0 ? 2_000 : 30_000),
  });
}

/**
 * #268: Stop or Edit an autonomous reply inside its window. Both stop it —
 * nothing is posted — and the draft returns to Waiting on you; Edit answers
 * with the draft so the caller can open it in the editor.
 */
export function useStopAutonomousSend(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draftId, action }: { draftId: string; action: "stop" | "edit" }) =>
      apiRequest<{ draft: DraftRecord | undefined }>(api, `/autonomous-sends/${encodeURIComponent(draftId)}/${action}`, { method: "POST" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}

/** #266: what your duo is asking to answer by itself, computed fresh by the daemon. */
export function useAutonomyOffers(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.autonomyOffers, queryFn: () => apiRequest<AutonomyOffer[]>(api, "/autonomy/offers") });
}

/** #266: Accept grants autonomy for that one person; Decline keeps the offer quiet for the daemon's cooldown. Nothing changes without this call. */
export function useDecideAutonomyOffer(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ recipientKey, decision }: { recipientKey: string; decision: "accept" | "decline" }) =>
      apiRequest<unknown>(api, `/autonomy/offers/${encodeURIComponent(recipientKey)}/${decision}`, { method: "POST" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
  });
}

/** #266: the people your duo answers by itself. */
export function useAutonomyGrants(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.autonomyGrants, queryFn: () => apiRequest<AutonomyGrant[]>(api, "/autonomy/grants") });
}

/** #266: takes autonomy back — the daemon also stops any reply to that person still inside its window. */
export function useRevokeAutonomyGrant(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (recipientKey: string) => apiRequest<unknown>(api, `/autonomy/grants/${encodeURIComponent(recipientKey)}/revoke`, { method: "POST" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["trust"] });
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
    },
  });
}

/** #268: the undo window on autonomous replies, kept by the daemon (it is the daemon that holds them). */
export function useAutonomySettings(api: DuoApiConfig | null) {
  return useQuery({
    queryKey: queryKeys.autonomySettings,
    queryFn: () => apiRequest<AutonomySettings>(api!, "/settings/autonomy"),
    enabled: api !== null,
  });
}

export function useSaveAutonomySettings(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { holdSeconds: number; confirmNoHold?: boolean }) =>
      apiRequest<AutonomySettings>(api, "/settings/autonomy", { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.autonomySettings, saved);
      // An offer states the window in its words.
      queryClient.invalidateQueries({ queryKey: queryKeys.autonomyOffers });
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

/** #315: how often the held requests are re-read — polled, like confirmations, because the notification this feeds is for an owner not looking. */
export const DUO_REQUESTS_POLL_MS = 30_000;

/**
 * #315: colleagues' requests to talk to your duo — the invitations the
 * daemon holds until you decide (digital-duo #192, `GET /workspace/invites`).
 */
export function useDuoRequests(api: DuoApiConfig | null) {
  return useQuery({
    queryKey: queryKeys.duoRequests,
    // A daemon with no workspace answers an empty list; anything without one reads as none, never as an error.
    queryFn: async () => {
      const answer = await apiRequest<{ invites?: unknown } | undefined>(api!, "/workspace/invites");
      return Array.isArray(answer?.invites) ? (answer.invites as DuoRequest[]) : [];
    },
    enabled: api !== null,
    refetchInterval: DUO_REQUESTS_POLL_MS,
    refetchIntervalInBackground: true,
  });
}

/** #315: Allow / Allow and always allow / Decline — the owner's decision on one request. */
export function useDecideDuoRequest(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ roomId, decision }: { roomId: string; decision: "allow" | "always" | "decline" }) =>
      decision === "decline"
        ? apiRequest<void>(api, `/workspace/invites/${encodeURIComponent(roomId)}/refuse`, { method: "POST" })
        : apiRequest(api, `/workspace/invites/${encodeURIComponent(roomId)}/allow`, {
            method: "POST",
            body: JSON.stringify({ always: decision === "always" }),
          }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.duoRequests });
    },
  });
}

/**
 * #314: brings the owner into a conversation their duo is in, so they can
 * answer a question it passed to them there, as themselves — the daemon's
 * duo invites its own owner, and nobody else.
 */
export function inviteOwnerInto(api: DuoApiConfig, roomId: string): Promise<{ roomId: string; userId: string }> {
  return apiRequest(api, `/workspace/rooms/${encodeURIComponent(roomId)}/invite-owner`, { method: "POST" });
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

/**
 * duo#272 (digital-duo#288): what the Knows tab shows under "Removed from
 * citation" — every past exchange the owner has excluded, newest first,
 * with enough of its own text to recognise it (or an honest `null` once
 * the record itself is gone).
 */
export function useExcludedEvidence(api: DuoApiConfig) {
  return useQuery({
    queryKey: queryKeys.excludedEvidence,
    queryFn: () => apiRequest<{ excluded: ExcludedEvidence[] }>(api, "/knowledge/evidence/excluded"),
  });
}

/**
 * `POST /knowledge/evidence/:recordId/exclude` (digital-duo#288): the owner
 * removing one bad "past exchange" source inline, from a draft's Used list
 * or the Review surface's own provenance rail. Idempotent on the daemon's
 * side (excluding twice is a no-op), and this stops the record being cited
 * in any future draft without touching the one already on screen —
 * reversible from the Knows tab (`useRestoreEvidence`), never undone here.
 */
export function useExcludeEvidence(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ recordId }: { recordId: string }) =>
      apiRequest<{ excluded: true }>(api, `/knowledge/evidence/${encodeURIComponent(recordId)}/exclude`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.excludedEvidence });
    },
  });
}

/** `POST /knowledge/evidence/:recordId/restore` (digital-duo#288) — the Knows tab's undo for `useExcludeEvidence`, the same idempotent shape as a rule's approve/reject. */
export function useRestoreEvidence(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ recordId }: { recordId: string }) =>
      apiRequest<{ excluded: false }>(api, `/knowledge/evidence/${encodeURIComponent(recordId)}/restore`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.excludedEvidence });
    },
  });
}

/**
 * duo#274: whether this room is currently off the record — `GET
 * /workspace/rooms/:roomId/off-the-record`. Read on demand (the room
 * header toggle and the Info panel's own switch both mount this), never
 * pre-fetched for every room in the list: a mark is rare, so there is no
 * reason to carry the daemon round trip for rooms nobody has opened.
 */
export function useRoomOffTheRecord(api: DuoApiConfig | null, roomId: string) {
  return useQuery({
    queryKey: queryKeys.roomOffTheRecord(roomId),
    queryFn: () => apiRequest<RoomOffTheRecord>(api!, `/workspace/rooms/${encodeURIComponent(roomId)}/off-the-record`),
    enabled: api !== null,
  });
}

/**
 * duo#274: marks a room off the record — `POST
 * /workspace/rooms/:roomId/off-the-record`. The daemon purges what it
 * already learned from the room in the same call (standing-order and
 * correction candidates still pending, and any rule already written from
 * one of its drafts); the client has nothing further to do but show the
 * confirmation and let the read below settle to `offTheRecord: true`.
 */
export function useMarkRoomOffTheRecord(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ roomId }: { roomId: string }) =>
      apiRequest<RoomOffTheRecord>(api, `/workspace/rooms/${encodeURIComponent(roomId)}/off-the-record`, { method: "POST" }),
    onSuccess: (_result, { roomId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.roomOffTheRecord(roomId) });
    },
  });
}

/**
 * duo#274: lifts the off-the-record marker — `DELETE
 * /workspace/rooms/:roomId/off-the-record`. This only stops the room being
 * excluded going forward; it never un-purges what marking it already
 * removed, the same one-way shape a rule's or a correction's rejection
 * already has.
 */
export function useClearRoomOffTheRecord(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ roomId }: { roomId: string }) =>
      apiRequest<RoomOffTheRecord & { wasOn: boolean }>(api, `/workspace/rooms/${encodeURIComponent(roomId)}/off-the-record`, { method: "DELETE" }),
    onSuccess: (_result, { roomId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.roomOffTheRecord(roomId) });
    },
  });
}

/**
 * #48: which devices can read this corpus — `GET /devices` (digital-duo
 * #177), the same read `duo pair list` makes. The list includes revoked
 * rows (`revokedAt` set); whether a device can authenticate is exactly
 * `revokedAt === null`.
 */
export function useDevices(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.devices, queryFn: () => apiRequest<PairedDevice[]>(api, "/devices") });
}

/**
 * #48: `POST /devices/:id/revoke` — the daemon revokes, evicts the cached
 * verification and closes that device's socket in the same tick, and answers
 * the revoked row. The row is written into the list as it arrives (the
 * daemon's own answer, so the list updates without waiting on a refetch),
 * and the list is re-read either way: a refusal may mean the list is stale.
 *
 * Revoking THIS device (`id === api.deviceId`) skips the re-read on success:
 * the token that would make it is the one just revoked, so it could only
 * 401 — and a 401 means "revoked from elsewhere" to the app (#41), which is
 * not what happened here. The caller returns to Setup instead.
 */
export function useRevokeDevice(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => apiRequest<PairedDevice>(api, `/devices/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
    onSuccess: (revoked) => {
      queryClient.setQueryData<PairedDevice[]>(queryKeys.devices, (list) => list?.map((device) => (device.id === revoked.id ? revoked : device)));
    },
    onSettled: (_revoked, error, { id }) => {
      if (error || id !== api.deviceId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.devices });
      }
    },
  });
}

/**
 * #49: the first run, from the app — the routes digital-duo #176 opened.
 * Each hook is a thin call: the daemon owns the parse, the work-relevance
 * gate, the dedupe and the embed loop, and this client adds none of them.
 *
 * Importing sends the transcript text itself (file upload is out of #176's
 * scope). A success moves what the Knowledge screen counts, so the
 * knowledge read is stale the moment it lands.
 */
export function useImportPaste(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (transcript: string) =>
      apiRequest<PasteImportSummary>(api, "/corpus/import-paste", { method: "POST", body: JSON.stringify({ transcript }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge });
    },
  });
}

/**
 * The embed job's status, polled while it runs. Embedding a real corpus is
 * minutes of provider round-trips, so the answer is a job to watch, not a
 * response to wait for: `pollMs` re-asks only while the daemon says
 * "running", and stops by itself when the job does.
 */
export function useEmbedJob(api: DuoApiConfig, pollMs: number) {
  return useQuery({
    queryKey: queryKeys.embedJob,
    queryFn: () => apiRequest<EmbedJobStatus>(api, "/corpus/embed"),
    refetchInterval: (query) => (query.state.data?.state === "running" ? pollMs : false),
  });
}

/**
 * #52: how often the pending confirmations are re-read. The daemon's one
 * push channel carries `draft-ready` and nothing else (§1.7), and a
 * confirmation that only shows when the owner happens to open its screen is
 * a safeguard nobody sees — so the client asks, on an interval, the one
 * question the daemon already answers. The interval is the ceiling on how
 * long a raised confirmation can wait unnoticed while the app is open.
 */
export const T4_POLL_MS = 30_000;

/**
 * #52: the staged T4 requests, each joined with the registry facts the
 * owner judges it by (digital-duo #180). Polled — and polled in the
 * background, because the notification this feeds is for the owner who is
 * not looking at the window.
 */
export function usePendingT4(api: DuoApiConfig | null) {
  return useQuery({
    queryKey: queryKeys.t4Pending,
    queryFn: () => apiRequest<PendingT4RequestForJudgement[]>(api!, "/actions/t4/pending"),
    refetchInterval: T4_POLL_MS,
    refetchIntervalInBackground: true,
    enabled: api !== null,
  });
}

/**
 * Starts the daemon's one embed job. A 202 carries the starting status,
 * which becomes the watched state at once. A 409 (`embed_already_running`)
 * means a job is already running — from another device or a terminal — so
 * the status is re-read and the same watch carries on; the daemon's own
 * sentence still surfaces as the mutation's error.
 */
export function useStartEmbed(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<EmbedJobStatus>(api, "/corpus/embed", { method: "POST" }),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.embedJob, status);
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.embedJob });
    },
  });
}

/**
 * #52: giving the confirmation — `POST /actions/t4/:id/confirm`, the one
 * route that confirms a T4 request, and this the one hook that calls it
 * (a test holds both to that). The daemon runs the action exactly once and
 * records this device against it; a 404 or 409 travels as the mutation's
 * error for the card to show in the daemon's own words.
 *
 * `networkMode: "always"` is the AR-15 half: by default a mutation issued
 * while the browser believes it is offline is *paused* and fired when the
 * connection returns — a queued confirmation, hours later, against context
 * that has moved, which is exactly the failure the T4 guard exists to
 * prevent. Always means attempt now; an unreachable daemon fails it now.
 */
export function useConfirmT4(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: "always",
    mutationFn: (requestId: string) =>
      apiRequest<PendingT4Request>(api, `/actions/t4/${encodeURIComponent(requestId)}/confirm`, { method: "POST" }),
    // Success or refusal, what is still waiting is the daemon's to say.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.t4Pending }),
  });
}

/**
 * `POST /corpus/import-claude`: a Claude data export's conversations.json,
 * sent as its raw text — the daemon parses it exactly as `duo import claude`
 * does. Like the paste import, a success moves what Knowledge counts.
 */
export function useImportClaude(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (exportText: string) =>
      apiRequest<ClaudeImportSummary>(api, "/corpus/import-claude", { method: "POST", body: JSON.stringify({ export: exportText }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge });
    },
  });
}

/**
 * `POST /corpus/import-claude-zip` (#239): the zip claude.ai hands an owner
 * straight from its export, uploaded whole — the daemon unzips it, finds
 * `conversations.json`, and imports exactly as `/corpus/import-claude` does
 * (`ClaudeImportSummary`, the same shape either way). The body is the raw
 * zip bytes, not JSON — `apiRequest`'s default `Content-Type:
 * application/json` is overridden by the caller's own header, matching the
 * daemon's route-local content-type parsers (digital-duo's owner-routes.ts).
 */
export function useImportClaudeZip(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, contentType }: { file: Blob; contentType: string }) =>
      apiRequest<ClaudeImportSummary>(api, "/corpus/import-claude-zip", {
        method: "POST",
        body: file,
        headers: { "Content-Type": contentType },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge });
    },
  });
}

/** The derive job's status, polled only while the daemon says "running" — the embed job's shape. */
export function useDeriveJob(api: DuoApiConfig, pollMs: number) {
  return useQuery({
    queryKey: queryKeys.deriveJob,
    queryFn: () => apiRequest<DeriveJobStatus>(api, "/corpus/derive"),
    refetchInterval: (query) => (query.state.data?.state === "running" ? pollMs : false),
  });
}

/** `POST /corpus/derive` — starts the one derive job; a 409 (already running) re-reads the status rather than pretending to start a second. */
export function useStartDerive(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<DeriveJobStatus>(api, "/corpus/derive", { method: "POST" }),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.deriveJob, status);
    },
    onError: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.deriveJob });
    },
  });
}

export function useAskLinks(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.askLinks, queryFn: () => apiRequest<AskLinkRow[]>(api, "/ask-links") });
}

/** `POST /ask-links` — the answer carries the token, once; the caller shows it and the list is re-read (the list never carries it). */
export function useCreateAskLink(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; expiresInHours?: number }) =>
      apiRequest<MintedAskLink>(api, "/ask-links", { method: "POST", body: JSON.stringify(input) }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.askLinks });
    },
  });
}

export function useRevokeAskLink(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => apiRequest<void>(api, `/ask-links/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.askLinks });
    },
  });
}

/** `POST /devices` — pair another device from this one; the token comes back once. */
export function usePairDevice(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name }: { name: string }) => apiRequest<MintedDevice>(api, "/devices", { method: "POST", body: JSON.stringify({ name }) }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.devices });
    },
  });
}

export function useConnector(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.connector, queryFn: () => apiRequest<ConnectorStatus>(api, "/connector") });
}

/** `POST /connector` — mints the claude.ai connector URL, revoking any earlier one; the path comes back once and the status is re-read. */
export function useMintConnector(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<MintedConnector>(api, "/connector", { method: "POST" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connector });
    },
  });
}

/** `POST /connector/connections/:id/revoke` — disconnects one Claude at once; it has to sign in again to come back. */
export function useRevokeConnection(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest<{ ok: true }>(api, `/connector/connections/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connector });
    },
  });
}

export function useTrustPromotions(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.trustPromotions, queryFn: () => apiRequest<PromotionOffer[]>(api, "/trust/promotions") });
}

/** Accept or decline one promotion offer — nothing promotes without this explicit call. Invalidates the whole ["trust"] root: offers and grid both move. */
export function useDecidePromotion(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ topicId, tier, decision }: { topicId: string; tier: TrustTier; decision: "accept" | "decline" }) =>
      apiRequest<unknown>(api, `/trust/promotions/${encodeURIComponent(topicId)}/${encodeURIComponent(tier)}`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
  });
}

/** `POST /trust/grant` — answers the core's `GrantOutcome`; only "applied" moved anything, but the grid is re-read either way. */
export function useGrantAutonomy(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { scopeText: string; tier: TrustTier; topicId?: string }) =>
      apiRequest<GrantOutcome>(api, "/trust/grant", { method: "POST", body: JSON.stringify(input) }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
  });
}

/**
 * Hosted mode's admin surface (`GET/POST {origin}/hosted/invites`) — at the
 * daemon's origin, not under this duo's base path, and authorised by this
 * device's own token (the daemon checks it belongs to an admin's duo).
 */
export function useHostedInvites(origin: string, api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.hostedInvites, queryFn: () => listInvites(origin, api.token) });
}

/** The answer carries the invite code and link, once; the list is re-read and never carries either. */
export function useCreateHostedInvite(origin: string, api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInviteInput) => createInvite(origin, api.token, input),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hostedInvites });
    },
  });
}

/**
 * What the persisted `duo-cache` may hold (#70, #128, #254). A message search is asked, answered and
 * forgotten. The super admin's view of the server (the orgs, each org's people with their Google
 * addresses, the invites) is fetched afresh per visit: it never rests in the browser after the
 * screen closes, and a withdrawn admin never reloads to a cached roster. The same goes for an org
 * admin's view of their own org and for the role itself (`org`): the role is asked of the daemon
 * on every load, so one that changed while the app was closed is never read back from storage.
 */
export function shouldPersistQuery(query: Query): boolean {
  const [root, second] = query.queryKey;
  return (
    defaultShouldDehydrateQuery(query) &&
    !(root === "workspace" && second === "search") &&
    // #268: an autonomous reply's undo window lasts seconds — one read back
    // from storage would offer Stop on a reply that has long since gone.
    !(root === "drafts" && typeof second === "object" && second !== null && "autonomous" in second) &&
    root !== "hosted-orgs" &&
    root !== "hosted-invites" &&
    root !== "org"
  );
}

/**
 * The super admin's org screens (the `hosted/orgs` routes, same origin and same
 * device token as the invites above). A 401 or 403 here is how the daemon
 * says this account is not (or is no longer) a super admin, so it is not
 * retried — the screen reads it and says so.
 */
export function useHostedOrgs(origin: string, api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.hostedOrgs, queryFn: () => listOrgs(origin, api.token), retry: false });
}

export function useHostedOrgMembers(origin: string, api: DuoApiConfig, orgId: string) {
  return useQuery({
    queryKey: queryKeys.hostedOrgMembers(orgId),
    queryFn: () => listOrgMembers(origin, api.token, orgId),
    retry: false,
  });
}

export function useCreateHostedOrg(origin: string, api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createOrg(origin, api.token, name),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hostedOrgs });
    },
  });
}

/**
 * #254: what this duo is in its org, asked of the daemon (`GET {basePath}/org`) whenever the app opens and
 * again on focus, on reconnect, once a minute while it is open and after any appoint or revoke — so a role
 * change reaches a person who is already signed in, with no sign-out. Never persisted (`shouldPersistQuery`).
 * `enabled` is `pairedHostedAccount(api) !== null`: only a signed-in hosted device asks, and only the paired
 * daemon is asked. A "no org" (404) or "not yours" (403) is an answer
 * (`{ none: true }`), not an error, so it holds across refreshes. Any other failure is not retried here (the next
 * refresh is the retry) and never says "member": `data` stays what it was, or empty. A 401 is the revocation guard's (the app unpairs).
 */
export function useOrgOverview(api: DuoApiConfig | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.orgOverview,
    queryFn: () => fetchOrgOverview(api!),
    enabled: enabled && api !== null,
    retry: false,
    refetchInterval: 60_000,
  });
}

export function useOwnOrgMembers(api: DuoApiConfig, orgId: string) {
  return useQuery({ queryKey: queryKeys.orgMembers(orgId), queryFn: () => listOwnOrgMembers(api), retry: false });
}

export function useOwnOrgInvites(api: DuoApiConfig, orgId: string) {
  return useQuery({ queryKey: queryKeys.orgInvites(orgId), queryFn: () => listOwnOrgInvites(api), retry: false });
}

/**
 * Which org a screen manages: the super admin's (`{ origin, orgId }`, the `hosted/orgs` routes) or, as null, an
 * org admin's own (`<basePath>/org*`). The hooks below also take that org's id (`orgId`), which an org admin's
 * scope doesn't carry: it keys their cached people and invites, and is never sent.
 */
export type OrgScope = { origin: string; orgId: string } | null;

/**
 * An invite into the org, shown once: the answer carries the code and link, and the pending list is re-read
 * and never carries either. The super admin names the org; an org admin's own route takes none (it is always theirs).
 */
export function useInviteIntoOrg(api: DuoApiConfig, scope: OrgScope, orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateInviteInput, "orgId">) =>
      scope ? createInvite(scope.origin, api.token, { ...input, orgId: scope.orgId }) : createOwnOrgInvite(api, input),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: scope ? queryKeys.hostedInvites : queryKeys.orgInvites(orgId) });
    },
  });
}

/** Renames the org. The role query is re-read too: an org admin's own page draws the org's name from it. */
export function useRenameOrg(api: DuoApiConfig, scope: OrgScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => (scope ? renameOrg(scope.origin, api.token, scope.orgId, name) : renameOwnOrg(api, name)),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.hostedOrgs });
      queryClient.invalidateQueries({ queryKey: queryKeys.orgOverview });
    },
  });
}

/**
 * Appoints or revokes an org admin. `scope` is the super admin's way (`{ origin, orgId }`, the `hosted/orgs`
 * routes) or null for an org admin's own org (`<basePath>/org/admins/…`). Either way the people are re-read, and
 * so is this duo's own role — stepping down, or being revoked by someone else meanwhile, ends the admin entry
 * on the next answer instead of the next minute.
 */
export function useSetOrgAdmin(api: DuoApiConfig, scope: { origin: string; orgId: string } | null, orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ duoId, appoint }: { duoId: string; appoint: boolean }) =>
      scope
        ? (appoint ? grantOrgAdmin : revokeOrgAdmin)(scope.origin, api.token, scope.orgId, duoId)
        : (appoint ? grantOwnOrgAdmin : revokeOwnOrgAdmin)(api, duoId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: scope ? queryKeys.hostedOrgMembers(scope.orgId) : queryKeys.orgMembers(orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orgOverview });
    },
  });
}

/**
 * #308: whether THIS browser could ever subscribe to web push, and whether
 * it already has — `push.ts`'s own read of `navigator`/`PushManager`, never
 * the daemon (the daemon only ever sees subscriptions that were registered
 * with it, not this browser's live `PushManager` state). `enabled` lets
 * Settings skip the check entirely while no duo is paired — there is
 * nothing to register a subscription with yet.
 */
export function usePushSubscriptionStatus(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.pushSubscription, queryFn: pushSubscriptionStatus, enabled, staleTime: 0 });
}

/** Subscribes this device to web push and registers it with the daemon (`subscribeToPush`, `src/push.ts`) — Settings' "Notify me when the app is closed" control. */
export function useSubscribeToPush(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => subscribeToPush(api),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pushSubscription });
    },
  });
}

/** Unsubscribes this device from web push, locally and at the daemon (`unsubscribeFromPush`, `src/push.ts`) — Settings' own off switch, independent of the sign-out choke point in `App.tsx` that calls the same function. */
export function useUnsubscribeFromPush(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unsubscribeFromPush(api),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pushSubscription });
    },
  });
}

/**
 * `GET /people/:id/voice-adaptation` (digital-duo #279, issue #262): what
 * your duo has learned about how you write to this one person. Always
 * returns a status object — `active: false` (with `features: null`) below
 * the daemon's own sample threshold, never a bare `null`. `personId` is the
 * same id a draft's `recipient.id` and `recipientAdaptation.recipientId`
 * carry — this client never mints or guesses one.
 */
export function useVoiceAdaptation(api: DuoApiConfig | null, personId: string) {
  return useQuery({
    queryKey: queryKeys.voiceAdaptation(personId),
    queryFn: () => apiRequest<VoiceAdaptationStatus>(api!, `/people/${encodeURIComponent(personId)}/voice-adaptation`),
    enabled: api !== null,
  });
}

/**
 * `DELETE /people/:id/voice-adaptation` (digital-duo #279, issue #262): the
 * profile's "Reset learned tone" — clears what the daemon has derived from
 * past approved sends/edits to this person, never the sends/edits
 * themselves. Only this one person's cached status is invalidated; nothing
 * else about them (or any other relationship) changes.
 */
export function useResetVoiceAdaptation(api: DuoApiConfig) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (personId: string) => apiRequest<void>(api, `/people/${encodeURIComponent(personId)}/voice-adaptation`, { method: "DELETE" }),
    onSuccess: (_result, personId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.voiceAdaptation(personId) });
    },
  });
}
