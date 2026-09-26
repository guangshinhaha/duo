import { useCallback, useRef } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { apiRequest, type DuoApiConfig } from "./client.js";
import type {
  AuditEntry,
  ChannelPolicy,
  ChannelSummary,
  CorrectionCandidate,
  DraftOutcome,
  DraftPipelineResult,
  DraftRecord,
  DuoKnowledge,
  DuoSummary,
  EscalationUrgencyRate,
  EmbedJobStatus,
  GridRow,
  InterruptionPortrait,
  PendingT4Request,
  PendingT4RequestForJudgement,
  RefusalsListing,
  PairedDevice,
  PasteImportSummary,
  Rule,
  RuleReviewListing,
  RuleWithEvidence,
  SearchOutcome,
  SentEscalationDigest,
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
  // Under the ["mirror", "rules"] root on purpose: a disposition invalidates
  // the listing by prefix and so refreshes any open evidence with it.
  mirrorRule: (id: string) => ["mirror", "rules", id] as const,
  mirrorRefusals: ["mirror", "refusals"] as const,
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
  // #46: keyed by the submitted query — each distinct search is its own
  // cache entry, so revisiting a recent query is instant and a stale
  // search never blocks a new one.
  search: (q: string) => ["search", q] as const,
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

export function useMirrorRules(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.mirrorRules, queryFn: () => apiRequest<RuleReviewListing>(api, "/mirror/rules") });
}

/** `GET /mirror/refusals` — what the owner's duo must never speak for them on, and why (#53). */
export function useMirrorRefusals(api: DuoApiConfig) {
  return useQuery({ queryKey: queryKeys.mirrorRefusals, queryFn: () => apiRequest<RefusalsListing>(api, "/mirror/refusals") });
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
export function usePendingT4(api: DuoApiConfig) {
  return useQuery({
    queryKey: queryKeys.t4Pending,
    queryFn: () => apiRequest<PendingT4RequestForJudgement[]>(api, "/actions/t4/pending"),
    refetchInterval: T4_POLL_MS,
    refetchIntervalInBackground: true,
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
