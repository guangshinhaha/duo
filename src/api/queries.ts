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
  FactCheckResult,
  RewriteInstruction,
  RewriteResult,
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
  ShapeInstruction,
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
    }: {
      draftId: string;
      outcome: SettableDraftOutcome;
      sentText?: string;
      /** #259: an optional, one-tap reason for a "discarded" outcome — the daemon refuses it alongside any other outcome. */
      dismissReason?: DismissReason;
      alternative?: number;
    }) => apiRequest(api, `/drafts/${draftId}/outcome`, { method: "POST", body: JSON.stringify({ outcome, sentText, dismissReason, alternative }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["drafts"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.review });
    },
  });
}

/**
 * #259's one-tap follow-up to a "shouldn't answer this" dismissal: offering
 * to turn that signal into a standing never-answer rule — the trust epic's
 * #269 (guangshinhaha/duo). #269's rule store does not exist in the daemon
 * yet (checked against digital-duo's src/drafting and src/profile as of
 * #259 — no rule-creation route to call), so this stays a local no-op that
 * resolves without ever reaching the network. It is a stub for #269 to
 * replace with a real `POST` once that route exists — the call site in
 * `useDraftDecision.ts` does not change, only this function's body does.
 * Deliberately not a fetch to a route that would only ever 404: inventing
 * a request the daemon can't serve would teach nothing and risks reading,
 * to anyone watching the network tab, as a bug rather than a known gap.
 */
export function requestNeverAnswerRule(api: DuoApiConfig, draftId: string): Promise<{ created: false }> {
  // Both parameters are kept, unused, in the real call shape #269 will
  // need (which draft, against which duo) — so the signature this stub
  // commits to already matches the real call it stands in for.
  void api;
  void draftId;
  return Promise.resolve({ created: false });
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
