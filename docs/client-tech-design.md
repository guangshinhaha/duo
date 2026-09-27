# Digital Duo — Client Technical Design

> Route contracts, the daemon's seam with the existing code, the pairing protocol, and the
> design system. Last updated: 2026-09-19.
> Architecture, gating unknowns and adversarial review live in `client-design.md`; this document
> is what you build from once those are resolved.

---

# Part 0 — The rule this document exists to enforce

`client-design.md` 1.3 states it in one line: **adding a surface must not add a behaviour.** Every
route wraps a function that already exists and is already tested. Where the client needs something
the core cannot do, the core grows a function and a CLI command in the same change — never a route
with logic behind it that `duo` cannot reach.

Reading the code to write this surfaced three places where that rule bites immediately. They are
in 1.6, and they are the actual first commits.

---

# Part 1 — The daemon

## 1.1 Layout

```
src/
  serve/
    index.ts          createServer(deps) → Fastify instance. No side effects.
    boot.ts           duo serve: unlock, resolve deps, bind, listen
    auth.ts           device-token middleware
    routes/
      duos.ts  drafts.ts  mirror.ts  trust.ts  review.ts  audit.ts
    ws.ts             one channel: draft-ready
  commands/serve.ts   CLI entry, thin
```

`createServer` takes its dependencies as an argument and never reads `process.env`, so tests
construct it with a temp store and a fake provider — the same shape the command tests already use.

## 1.2 The seam: why the daemon does not call `commands/`

Every `run*` function in `src/commands/` resolves the passphrase itself:

```ts
// src/commands/draft.ts
export async function runDraft(question, threadContext, config, env = process.env) {
  requireStoreExists(config.storePath);
  const passphrase = resolveOrCreatePassphrase(config.storePath, env);  // ← reads data/.passphrase
  …
}
```

`resolveOrCreatePassphrase` falls back to reading `data/.passphrase` from disk, which is exactly
what `client-design.md` 1.4 forbids in serving mode. The `env` parameter offers a loophole —
`DUO_PASSPHRASE` wins, so the daemon *could* pass a synthetic env object — but that is a trick, not
a boundary, and it leaves the disk fallback one refactor away from reappearing.

**So the daemon depends on the module layer, not the command layer.** It holds one passphrase in
memory from boot and passes it explicitly:

| Daemon calls | Not |
|---|---|
| `draftReply(storePath, passphrase, duoDir, …)` | `runDraft(…)` |
| `listDrafts(storePath, passphrase)` | — |
| `listGrid(storePath, passphrase, duoDir)` | `runTrustGrid(…)` |
| `buildInterruptionPortrait(storePath, passphrase, duoDir)` | `runMirrorPortrait(…)` |
| `listCorrectionCandidates(storePath, passphrase, status)` | — |

Most `run*` functions are pure passphrase plumbing — `runMirrorRuleApprove` is three lines and a
call to `approveRule` — so the daemon simply calls the module function they wrap and loses nothing.

**One is not.** `runRecordDraftOutcome` orchestrates: record the outcome unconditionally, then
classify the edit, then queue candidates, swallowing `NoDraftTextError` because an escalated draft
has no text to diff. That sequence is load-bearing and duplicating it in a route handler would be
the second code path this document exists to prevent. **Extract its body into a module function
taking an explicit passphrase, and let both the CLI command and the route call it.** It is C1's
first commit and it should not change a single test.

## 1.3 Boot

```
duo serve [--host <tailnet-ip>] [--port 7717]
  1. requireStoreExists(config.storePath)
  2. passphrase ← DUO_PASSPHRASE, else interactive prompt (TTY only)
       never resolveOrCreatePassphrase — no disk fallback, ever
  3. refuse to start if host is absent, 0.0.0.0, or a non-loopback
     non-tailnet address  (client-design.md AR-12)
  4. embedding + inference providers resolved once
  5. listen; log the bound address and nothing else
```

Step 3 is a hard failure with an explanatory error, not a warning. A daemon holding a decrypted
government corpus must not be one absent flag away from listening on every interface.

## 1.4 Route contracts

Responses return the **domain types verbatim**. No DTO layer: a second set of shapes is a second
thing to drift. These routes' only bearers are the owner's devices; the one asker-reachable
route, `POST /ask`, already returns its own asker-facing projection (#159) rather than the
domain types.

| Method | Path | Returns | Module |
|---|---|---|---|
| `GET` | `/health` | `{ ok: true }` | inline |
| `GET` | `/duos` | `DuoSummary[]` *(new, 1.6)* | `duo/registry` |
| `GET` | `/channels` | `ChannelSummary[]` — one row per registered adapter, display strings supplied by the adapter (#171); the channel list on the profile's Knows tab (`#duo/profile/knows`, #47) renders it without recognising a kind or a label | `drafting/delivery` |
| `GET` | `/channels/policy` | `ChannelPolicy` — which channels, and which threads in them, produce no proactive offers (#172) | `drafting/channel-mutes` |
| `POST` | `/channels/policy/mute` | `ChannelPolicy` — the updated policy (channel or thread scope); the Channels screen mutes at channel scope by `kind` and re-reads `GET /channels` (#47) | `drafting/channel-mutes` |
| `POST` | `/channels/policy/unmute` | `ChannelPolicy` — the updated policy | `drafting/channel-mutes` |
| `GET` | `/devices` | `DeviceToken[]` — no token or hash field, so the list structurally cannot leak a credential (#177) | `serve/tokens` |
| `POST` | `/devices/:id/revoke` | `DeviceToken` — same-tick teardown: cached auth and live socket drop with it | `serve/tokens` |
| `GET` | `/drafts?outcome=&before=&limit=` | `DraftRecord[]` (G-b's filter/pagination) | `drafting/draft-log` |
| `GET` | `/drafts/:id` | `DraftRecord` | `drafting/draft-log` |
| `POST` | `/drafts` | `DraftPipelineResult` — 201, with a same-tick `draft-ready` push (#162) | `drafting/pipeline` |
| `POST` | `/ask` | the public-answer envelope — `kind` + asker-visible `text`; a device principal also gets `draftId`/`confidence`/`ownerNotice` (R8's projection, #159). `duo: "shared"` routes to `answerSharedDuo` (KTD4) | `permissions/public-answer` |
| `POST` | `/drafts/:id/outcome` | `ClassifyAndQueueResult \| {}` — delivery through the draft's origin channel rides the same seam (#170) | `drafting/delivery` |
| `POST` | `/drafts/:id/answer` | `{ candidateId: string }` | `drafting/standing-order-candidates` |
| `GET` | `/review?status=` | the merged queue's rows — draft edits *and* standing-order candidates, each tagged `source` (#166) | `corrections/review` |
| `POST` | `/review/:id/approve` | `{ candidate, result }` (#173) | `corrections/review` |
| `POST` | `/review/:id/reject` | `{ candidate }` (#173) | `corrections/review` |
| `GET` | `/mirror/portrait` | `InterruptionPortrait` | `derivation/portrait` |
| `GET` | `/knowledge` | `DuoKnowledge` — what this duo knows and which providers it was wired with (#175) | `duo/knowledge-summary` |
| `GET` | `/mirror/rules` | `RuleReviewListing` | `derivation/rule-review` |
| `GET` | `/mirror/rules/:id` | `RuleWithEvidence` — the rule with the supporting evidence exchanges behind it | `derivation/rule-review` |
| `POST` | `/mirror/rules/:id/:action` | `Rule` | `derivation/rule-review` |
| `GET` | `/mirror/refusals` | `{ decided: boolean, refusals: Refusal[] }` — pure `duo/refusals.md` file state; `decided: false` is a 200 (#182). add/confirm-none stay terminal-only (AR-18) | `trust/refusals` |
| `GET` | `/trust/grid` | `GridRow[]` | `trust/grid` |
| `GET` | `/actions/t4/pending` | `PendingT4RequestForJudgement[]` — the staged irreversible steps (#180) | `actions/t4-guard` |
| `POST` | `/actions/t4/:id/confirm` | `PendingT4Request` — confirming is this route and only this route; the confirming device's id rides the attempt (#180) | `actions/t4-guard` |
| `GET` | `/actions/attempts` | `ActionAttemptEntry[]` — every attempt, refused or resolved (#180) | `actions/attempt-log` |
| `GET` | `/lifecycle` | `{ lifecycle, transfers }` — the lifecycle record plus every transfer's state (#181) | `continuity/lifecycle`, `continuity/transfer` |
| `POST` | `/lifecycle/end` | `EndDuoResult` — describes what would go until `confirmed: true`; a confirmed end drops every token, so each device's next request is a 401 (#181; the client's kill switch is Settings' "End this duo", #55 — see *Ending the duo* below) | `continuity/lifecycle` |
| `POST` | `/corpus/import-paste` | `PasteImportSummary` — the transcript text in the body, down `duo import paste`'s own path (#176) | `ingest/paste-import` |
| `POST` | `/corpus/embed` | `EmbedJobStatus` — 202 (starts the one job); 409 `embed_already_running` (#176) | `serve/embed-job` |
| `GET` | `/corpus/embed` | `EmbedJobStatus` — the running job's progress (#176) | `serve/embed-job` |
| `POST` | `/corpus/import-claude` | `ClaudeImportSummary` — a Claude export's `conversations.json` text in the body (`{ export }`), down `duo import claude`'s own path (hosted mode) | `ingest/claude` |
| `POST` | `/corpus/derive` | `DeriveJobStatus` — 202 (starts the one derive job: pairs → topics → rules → voice); 409 `derive_already_running` (hosted mode) | `serve/derive-job` |
| `GET` | `/corpus/derive` | `DeriveJobStatus` — the running job's stage, or its error verbatim (hosted mode) | `serve/derive-job` |
| `GET` | `/ask-links` | `AskLinkRow[]` — never a token (hosted mode) | `serve/tokens` |
| `POST` | `/ask-links` | `MintedAskLink` — 201, the token shown once (`{ name, expiresInHours? }`) | `serve/tokens` |
| `POST` | `/ask-links/:id/revoke` | 204 — the link stops on its next use | `serve/tokens` |
| `POST` | `/devices` | `MintedDevice` — 201, pairs another device from a paired one; the token shown once | `serve/tokens` |
| `GET` | `/connector` | `ConnectorStatus` — `mode` "secret": whether a claude.ai connector exists (its URL is never recoverable); `mode` "signin" (hosted sign-in, digital-duo #240): the plain `url` to paste and the `connections`, no secret. Either way the prompt the owner pastes into claude.ai to feed past chats (digital-duo #227, #240) | `serve/mcp`, `serve/tokens` |
| `POST` | `/connector` | `MintedConnector` — 201, mints the connector URL path shown once and revokes any earlier one (digital-duo #227) | `serve/tokens` |
| `POST` | `/connector/connections/:id/revoke` | `{ ok }` — disconnects one connected Claude at once (sign-in mode only, else 404; digital-duo #240) | `serve/mcp` |
| `GET` | `/trust/promotions` | `PromotionOffer[]` — the batched digest (#54) | `trust/promotion` |
| `POST` | `/trust/promotions/:topicId/:tier` | the moved `TrustCell` — `{ decision: "accept" \| "decline" }`; nothing promotes without it | `trust/promotion` |
| `POST` | `/trust/grant` | `GrantOutcome` — `{ scopeText, tier, topicId? }`; "ambiguous" returns candidates for a picker, never a guess; T4 absent (trust-surface.md) | `trust/grants` |
| `POST` | `/hosted/signup` | `HostedSignupResult` — at the daemon ORIGIN, not a duo's base URL; no bearer, the invite is the credential (`{ invite, credential }` with Google sign-in configured, `{ invite, name }` without); 403 `invite_invalid` / `invite_wrong_account`, 409 `already_has_duo` | `hosted` |
| `GET` | `/hosted/config` | `HostedConfig` — at the daemon ORIGIN, public: `{ googleClientId }`, null when sign-in isn't configured | `hosted` |
| `POST` | `/hosted/login` | `HostedSignupResult` — at the daemon ORIGIN: `{ credential }` (a Google ID token) in, this account's duo (`basePath` "" for the root duo) and a fresh device token out; 404 `no_duo` | `hosted` |
| `GET` | `/oauth/requests/:id` | `{ clientName, scopes? }` — at the daemon ORIGIN: who is asking to connect and what they asked for (`scopes`: id, label, description, defaultOn; absent from a daemon that predates permissions), for the `#connect` sign-in page; 404 `request_expired` (digital-duo #240, #256) | `hosted` |
| `POST` | `/oauth/requests/:id/approve` | `{ redirectTo, ownerName }` — at the daemon ORIGIN: `{ credential, scopes? }` (a Google ID token, and the permissions the owner ticked, never more than Claude asked for) in, where to send the browser back to Claude out; 404 `no_duo` when the account owns no duo, 400 `no_scopes` when nothing is ticked, and the request stays open (digital-duo #240, #256) | `hosted` |
| `POST` | `/oauth/requests/:id/deny` | `{ redirectTo }` — at the daemon ORIGIN: the owner declined; back to Claude with `access_denied` (digital-duo #240) | `hosted` |
| `GET` | `/hosted/invites` | `HostedInviteRow[]` — at the daemon ORIGIN, admin only (Bearer: the admin's own device token); never a code | `hosted` |
| `POST` | `/hosted/invites` | `MintedHostedInvite` — 201, admin only (`{ name, orgId?, email?, expiresInHours? }`; no `orgId` means the default org); the code and link shown once | `hosted` |
| `GET` | `/hosted/orgs` | `HostedOrg[]` (`{ id, name, createdAt, memberCount }`) — at the daemon ORIGIN, super admin only (401 no credential, 403 anyone else); the Admin screen (#128) | `hosted` |
| `POST` | `/hosted/orgs` | `HostedOrg` — 201, super admin only (`{ name }`); 400 bad name, 409 name taken | `hosted` |
| `POST` | `/hosted/orgs/:orgId/rename` | `HostedOrg` — super admin only (`{ name }`; POST because the daemon's CORS allows only GET and POST); 404 unknown org, 409 name taken | `hosted` |
| `GET` | `/hosted/orgs/:orgId/members` | `HostedOrgMember[]` (`{ duoId, name, email, isRoot, joinedAt, isAdmin, superAdmin, orgRole, appointedBy, appointedByName, appointedAt, orgAdminLog }`) — super admin only; 404 unknown org; the client fills what an older daemon leaves out | `hosted` |
| `POST` | `/hosted/orgs/:orgId/admins/:duoId/grant` | `{ member, changed }` — super admin only, no body; 409 `super_admin_protected` / `root_not_appointable` (#254) | `hosted` |
| `POST` | `/hosted/orgs/:orgId/admins/:duoId/revoke` | `{ member, changed }` — super admin only, no body; may revoke an org's last org admin (#254) | `hosted` |
| `GET` | `/org` | `{ org: { id, name }, role, superAdmin }` — inside the paired duo, so under its `basePath` (`api.baseUrl`), any member; how the app learns its role, asked on load, on focus and once a minute, never persisted; 404 `not_found` in no org (#254) | `hosted` |
| `GET` | `/org/members` | the org's people (shape as the super admin's list) — org admins only, their own org only; 403 for anyone else (#254) | `hosted` |
| `GET` | `/org/invites` | `[{ id, name, email, orgId, createdAt, expiresAt }]` — org admins only, this org's pending invites, never a code (#254) | `hosted` |
| `POST` | `/org/invites` | 201 `MintedHostedInvite` — org admins only (`{ name, email?, expiresInHours? }`; no org id is sent, it is always this org's); 409 `too_many_invites` (#254) | `hosted` |
| `POST` | `/org/rename` | `{ org: { id, name } }` — org admins only (`{ name }`); 409 `name_unavailable` (#254) | `hosted` |
| `POST` | `/org/admins/:duoId/grant` | `{ member, changed }` — org admins, in their own org, no body; 409 `super_admin_protected` / `root_not_appointable` (#254) | `hosted` |
| `POST` | `/org/admins/:duoId/revoke` | `{ member, changed }` — org admins, no body; 403 once the role is gone, 409 `last_org_admin` / `super_admin_protected`; revoking one's own id steps down (#254) | `hosted` |
| `GET` | `/search?q=&limit=&cursor=` | `HybridSearchOutcome` — `duo search`'s own hybrid read (#174) | `ingest/embeddings` |
| `POST` | `/escalations/digest` | `AssembleDigestResult` — assembling *is* the send: the append-only row plus its marked items (#178); the Activity tab's "Where it runs out" (#54) never calls it — opening a screen must not send | `escalation/digest` |
| `GET` | `/escalations/history?limit=&cursor=` | `SentEscalationDigest[]` (#178) — oldest first, `limit` 1–100 (default 10), `cursor` an offset; that section walks every page at `limit=100` before it counts | `escalation/digest` |
| `GET` | `/escalations/rate` | `EscalationUrgencyRate` (#178) — `{ total, urgent, rate }` over every classified escalation, urgent ones included; drawn as counts plus a bar, never a percentage | `escalation/digest` |
| `GET` | `/audit` | `AuditEntry[]` | `permissions/audit` |
| `GET` | `/ws` | the one push channel — `draft-ready`; auth by first message (#162) | `serve/ws` |

**Ending the duo (#55).** "Instantly killable" is only true if it is not tied to one laptop, so
Settings carries the kill switch: `POST /lifecycle/end` twice, and only the second deletes. The
first call, `{ decidedBy, confirmed: false }`, is when the confirmation opens — the daemon's own
`EndDuoResult` lists what would go, and the dialog states *what ends, what is kept, what cannot be
undone* from that list (counts, and the files verbatim). Nothing proceeds without a typed
confirmation; the second call, `{ decidedBy, confirmed: true }`, is sent only then. `decidedBy`
is the signed-in member's user id, or "the owner, from a paired device" when no workspace is
signed in — the route requires a non-empty name and a device has none of its own. The client
says only what the route establishes:

- **What it says is kept** is the daemon's record of the ending (the audit log lives outside what
  the route deletes) and — only when one exists — the workspace sign-in, which is the client's
  own, separate credential.
- **A failure is not always "not ended".** The route deletes and *then* audits, so a 5xx can be
  an ending that finished; a lost response can be one too. Only a 4xx is worded "was not
  ended"; the rest say the device *can't tell*, and it finds out on its next request.
- **Success is `confirmed: true` in the answer, nothing else.** A 200 without it is not an end.
- **After the end every token is dead**, so this device's next request is a 401 — on the wire
  exactly a revoked token (#41). The client therefore remembers, per device (`duo.ended`), that
  *it* ended the duo, and says so on Setup and in the member shell; that notice outranks "no
  longer paired". A *different* paired device meeting the same 401 cannot know why and says the
  generic thing — the daemon has no way to say more. A fresh pairing is a different duo and
  clears the marker.
- **Offline is disabled, never queued** (AR-15): the control is disabled with the reason, and an
  irreversible act is never held to fire later. While the request is in flight the dialog cannot
  be dismissed.

Transfer and handover flows (`GET /lifecycle`'s `transfers`) are out of scope for the client.

There is deliberately no `/duos/:id/ask` route. Asking the **personal** duo something *is*
drafting — there is no separate "ask" action for it, the same way `duo ask`/`duo draft` never
took a duo id — so that's `POST /drafts`. The **asker's** one-question surface is `POST /ask`
(#159): an ask token authorizes exactly that route, and the same route serves the shared duo
when the body says `duo: "shared"` (#159/KTD4) — the `askerRef` resolution against
`duo/directory.json` happens inside the route, never in a client. `runAsk` (`commands/ask.ts`)
is a raw, ungrounded provider passthrough used only to verify provider configuration (R4/R5) —
it is never a route backing anything a client shows the owner.

`POST /drafts` returns the full `DraftPipelineResult` **synchronously** in v1 — 201, not 202. Self-
consistency sampling without a configured inference provider falls back to the fast, deterministic
extractive draft; with a real provider this can run tens of seconds, and a 202-plus-WebSocket-push
shape (the client gets a draft id back immediately, the real result arrives over the socket) is the
obvious next step once that becomes the common case. Deferred rather than built speculatively: a
synchronous, fully-tested route now beats a half-tested job queue.

`DraftPipelineResult` is a discriminated union on `kind` (see `drafting/pipeline.ts` for the
authoritative shape — not reproduced here, so this document can't drift from it), so the client
renders a draft and an escalation from one switch with no shape-guessing. Its `refused` field
exists so the client can tell **"won't"** from **"can't"** without parsing prose: a refusal is a
boundary the owner set and should read as the system working, while a low-confidence escalation is
the duo being honest and invites `POST /drafts/:id/answer`.

## 1.5 Errors

One shape, always:

```ts
{ error: { code: string; message: string } }
```

`code` is stable and switchable; `message` is the existing error's own text, which is already
written for a human — `UnsafeStorePathError` and `CorrectionCandidateNotFoundError` both explain
themselves better than a route handler would. Domain errors map to status directly:
`CorrectionCandidateNotFoundError` → `404`, `CandidateAlreadyReviewedError` → `409`,
`NoDraftTextError` → swallowed as it already is, never a `500`.

## 1.6 Three gaps in the core, found by reading it

**G-a · `listDrafts` has no CLI command.** `src/drafting/draft-log.ts` exports it, the CLI exposes
`draft`, `draft-outcome` and `draft-answer` — and nothing that lists. The Review surface is built
entirely on a function no user can currently reach. → Add `duo drafts list` in the same commit as
the route.

**G-b · `listDrafts` cannot filter or paginate.** It is `SELECT * FROM drafts ORDER BY created_at`.
Review wants `outcome IS NULL`; filtering client-side means shipping the entire draft log on every
poll, forever. → `listDrafts(storePath, passphrase, { outcome?: DraftOutcome | "pending", limit?, before? })`,
defaulting to today's behaviour so no caller changes.

**G-c · There is no "list my duos".** The sidebar is the first thing the client renders and nothing
returns it. → `listAvailableDuos` (`duo/registry.ts`) plus `duo list`.

This is deliberately **not** a general multi-duo registry, and role duos (`src/role-duo/`,
already landed) are the reason why: each is addressed by an explicit definition file path passed
to `duo role-duo`, and nothing anywhere enumerates which definition files exist. Inventing a
registry entry format for them here would mean the daemon listing a kind of duo the CLI itself
cannot list — exactly the "a surface must never add a behaviour" rule this document opened with.
So `/duos` returns at most two entries: the personal duo (always — this process *is* its personal
duo) and the shared duo (best-effort, if `shared-duo/persona.json` resolves to a human owner).
A role duo you hold or seeded is real and useful, but it's reached today the way the CLI reaches
it — `duo role-duo seed <path>` with the path you already have — not through the sidebar. Giving
role duos a real registry is v1.5-shaped follow-up work, not a gap this pass silently papers over.

Each is small. Each is a real gap the client would otherwise paper over with logic in a route
handler, which is the failure mode this document is written to prevent.

---

# Part 2 — Pairing and device tokens

Tailscale authenticates the *device onto the network*. It does not authenticate a client to the
daemon, and "anything on my tailnet is me" stops being true the moment a tailnet has a second
member or a shared node.

```
duo pair --name "iPhone"
  → token = base64url(randomBytes(32))
  → store sha256(token) in device_tokens(id, name, hash, created_at, last_seen_at, revoked_at)
  → print the token once, and a QR of it
```

- The daemon stores **only the hash**, so a stolen store yields no working token.
- Clients send `Authorization: Bearer <token>`; comparison is constant-time.
- `duo pair list` / `duo pair revoke <id>`. Revocation is immediate and closes that device's
  WebSocket.
- Losing the phone means revoking one token. It must never mean re-keying the store — which is
  the whole reason this is a separate secret rather than the passphrase.
- `last_seen_at` is recorded, because "which devices can read my corpus right now" is a question
  the owner should be able to answer.
- Both are also answerable from a paired device (digital-duo #177, client #48): `GET /devices`
  lists every device — id, name, created, `last_seen_at`, never a token or hash — and
  `POST /devices/:id/revoke` does what `duo pair revoke` does, plus the same-tick teardown of that
  device's cached auth and live socket. Revoking the last device, or the caller itself, is
  deliberate and allowed: `duo pair new` at the Mac always mints a working token, so there is no
  lockout to refuse. The daemon does **not** say which row is the caller, so Settings keeps a
  client-local mark (`deviceId`, set once by the owner, kept beside the pairing) and the client
  never guesses. Pairing a new device stays a physical act at the Mac — the client offers no route
  for it. "Forget this device" is a different act: it removes the token from this device only and
  does not revoke it.

Rate-limit auth failures and log them. On a private network the realistic attacker is a process on
a machine that is already on the tailnet, and that attacker gets to retry.

---

# Part 3 — The client

## 3.1 Routes

```
/review          ← default. badge = drafts where outcome is null
/duo/:id         thread view + composer
/mirror          portrait · rules · weak signals · refusals — a rule opens onto its evidence
/trust           grid, read-only on mobile (AR-17)
/audit
/confirmations   irreversible steps awaiting the owner's explicit yes (#52). badge = requests awaiting
/settings        daemon address · paired devices (list, revoke) · forget this device · end this duo (#55)
/onboarding      the first run: import · embed · derive → ends at /mirror (#49)
```

Mobile drops `/trust` and `/audit` to a single "More" section and hides rule authoring entirely
(AR-18). It is the same codebase and the same routes; the difference is which are reachable.

## 3.2 State

TanStack Query for everything server-shaped. Keys mirror the routes so invalidation is obvious:

```ts
["drafts", { outcome: "pending" }]   // invalidated by any outcome POST and by draft-ready
["review"]                           // invalidated by an outcome POST — an edit queues a candidate
["mirror", "rules"]  ["mirror", "rules", id]  ["mirror", "refusals"]  ["mirror", "portrait"]  ["trust", "grid"]  ["audit"]
["devices"]                          // GET /devices; a revoke writes the answered row in, then refetches (#48)
["corpus", "embed"]                  // the daemon's one embed job (#49) — polled only while it says "running"
["actions", "t4", "pending"]         // polled (30s, background too); invalidated by a confirm POST (#52)
```

The only client-owned state is the composer buffer, UI preferences, and the one label the daemon cannot supply (`deviceId`, which paired device this is, #48). No Zustand, no Redux: there
is one writer (the daemon) and the cache is the model.

`POST /drafts/:id/outcome` with `edited` invalidates **both** `["drafts"]` and `["review"]`, because
one action writes the draft row and queues a correction candidate. Missing the second is the
easiest bug to ship here and the hardest to notice.

#62 adds the workspace's own keys, labelled with the `#58` target so a workspace fetch failing at
the network level reads as the workspace going quiet, never as the daemon's:

```ts
["workspace", "rooms"]                // the conversations list
["workspace", "timeline", roomId]     // one conversation, invalidated by the live subscription
```

The workspace half keeps the same discipline with its own seam: `src/workspace/matrix.ts` is the
one module that imports matrix-js-sdk (dynamically, so an owner who never signs in never loads
it), the way `tray.ts` and `dockBadge.ts` are the one modules that speak Tauri. Its clients are
built with **nothing persistent** — no store, no session store, no web storage — so a workspace
session exists in exactly one place, the app's own credential store (`duo.workspace-session`,
beside and independent of `duo.api-config`), and signing out has no warm SDK state to leave
behind. Attribution is structural end to end: a duo-shaped sender (`@duo-<owner>:<server>`, the
grammar mirrored from the core's identity work, digital-duo #187) renders as the multi-party
`RoomDuoMessage` with the possessive attribution derived from the id; a display name can claim
anything, the id grammar cannot.

#63 widens the seam's read side and adds the member's verbs, all against the member's own
account — which is what makes them durable across devices: the list's projection (name or
members, the latest word, unread and its mention half, kind from the `m.direct` account data and
the join rule, mute from the account's push rules) is composed homeserver-side; the verbs map to
`createRoom` (a direct conversation), `leave`, a push-rule write (mute), and the user directory
(search). Opening a conversation receipts the room's latest event (`m.read`, unthreaded) — the
read position is account state, so the unread badge clears on every device, and no read or mute
fact is ever stored locally.

#64 adds the message verbs on the same footing: edit, delete, react, unreact, and reply-in-thread
are homeserver operations (a replacement, a redaction, an annotation, a thread relation), and the
timeline projection folds their outcomes the way every reader's homeserver would — a same-sender
replacement amends the base at the base's place and marks it edited (a foreign replacement is a
claim, not a change, and changes nothing), a redaction keeps the row and strikes the words,
reactions aggregate under their key with the member's own marked, and a thread reply carries its
root's id out of the main flow, leaving the root a summary. Threads are addressable
(`#thread/<room>/<root>`) and read like the room — the receipt is the room's. The one deliberate
local half is the optimistic send: the sender's words render immediately, marked as on their way,
in the query cache alone — the subscription's refetch lands the homeserver's record in place of
the copy, and nothing else ever renders it.

#65 adds mentioning, on the same principle: the surface adds no behaviour, it addresses. The
composer offers the room's own members (the member themself excepted) — a person by their name,
a duo as "{owner}'s duo" from the user-id grammar — and a surviving pick rides the wire in the
spec's full shape (v1.15 §32): `m.mentions.user_ids` on `m.room.message`, the structured half
the homeserver's push rules read, sent on every message — empty included, as the spec
recommends, so the legacy display-name rules stay quiet — and beside it the pill half,
matrix.to anchors in `formatted_body` around exactly the words the pick left in the body (the
body carries "@label" for humans; a pick deleted from the text rides nothing). The duo's
answer — a question asked while its owner's Mac slept is answered on wake (core #186,
held-not-lost) — arrives through the room like any duo message and renders attributed from the
id grammar; nothing is synthesized before it arrives, and the daemon's permissions outcomes
(passed on, declined) render in the daemon's own words, verbatim.

The receiving half completes the gesture: the seam reads a message's anchors back and projects
the body into parts — plain-text runs and mention parts, all-or-nothing, so a body that no
longer matches its anchors renders as the plain words rather than half a pill — with a person's
part-label preferring the room's own record of their name, else the anchor's text. Each mention
part renders as a pill, a duo's label re-derived from the id grammar at the render site (the
same structural rule holding at the last inch, so no display name a sender claimed can misname
somebody's duo), and the list's unread counts arrive homeserver-composed with their mention
half already in them — the "@ 2" badge is that count, not something the client tallies.

#69 adds the interruption decision — the client's only speaking role beyond rendering. What may
interrupt is two standings with two homes, on purpose: per-conversation (`all`, `mentions`,
`nothing` — the #63 mute renamed as the far end of one tri-state, not a separate button) is
account state and syncs across devices (a push rule for `nothing`, room account data
`duo.notifications` for the others); do-not-disturb with quiet hours is the member standing at
this machine and stays on it (`duo.dnd`). The dispatcher hears the seam's live arrivals and the
daemon's draft-ready push, and decides once, in App: the member's own words never interrupt
(from any device), the conversation on screen never interrupts about itself, the member's own
duo acting on their behalf is its own category — fixed words, governed by no conversation's
standing, because it belongs to no conversation, and no setting offers to turn the category off (the one
notification the owner can never fully silence; do-not-disturb defers it, never drops it) — and everything else follows its room's
standing, the sender labelled by the id grammar (`{owner}'s duo`), never a display name.
Do-not-disturb holds instead of silencing: what it held waits in Settings (`duo.missed`, capped,
each entry a link back), and it holds the duo's acts the same way. An escalation or refusal
announces in its own words ("Your duo escalated a question to you."), classified by reading the
draft the push names; a record that won't answer announces as the waiting draft it most
conservatively is. The surface adds no behaviour throughout — every standing is read or written
through the seam, and the classifications read only what the daemon already serves.

#66 adds the share on the same seam: `uploadFile` (bytes to the homeserver's media store, with
progress), `sendFile` (the `m.file`/`m.image` message carrying name, declared type, declared
size, and the `mxc://` reference — the wire shape core #190's association convention reads), and
`loadMedia` (the bytes of a reference, fetched as the member: MSC3916 authenticated media wants
the token in a header, which an `<img>` or link cannot send, so the seam fetches and the card
holds a blob — an image previews from it, a download is a click that fetches on demand, and a
reference the homeserver won't serve leaves the card's facts standing with the failure said).
A refused upload or send states its reason — the workspace's own upload limit named as its,
the workspace's words for any other refusal, a dropped connection as one — with the file kept
attached and the words kept typed. The timeline
projection carries shares as conversation turns with their facts declared, folding a same-kind
replacement's label while the reference stands. Sharing is not importing, structurally: no
module in the share path imports the daemon's api, pinned by test the way the seam scan is.
The daemon's `attachment` draft-source kind is mirrored in `DraftSource`, so an attachment the
duo grounded on appears in the provenance rail as the daemon labelled it (core #190/#183). The
client's share limits (8 MiB images, 16 MiB files, 3 per message) are its own door, named
in their refusals — the duo's 32 KiB grounding cap is a different, smaller door the composer's
hint describes, never a limit this app enforces. Attach-then-ask rides by construction: each
attachment sends as its own message, in order, before the question — contiguous, same sender,
same room, exactly what the backend associates.

#68 closes the loop the product is built on inside one app: a message someone sends the owner
in a conversation here is drafted for by the owner's duo, and the owner sends, edits, or
ignores the draft — the edit is the correction loop's input, as it always was. **Everything
that acts is the daemon's**, over its own workspace connection: it drafts (a channel-origin
draft whose provenance, digital-duo #169, names the conversation and the message by the
message's own `matrix.to` permalink) and it delivers (`POST /drafts/:id/outcome` hands a sent
or edited draft's text back through the origin channel's seam, #170, and records
pending/delivered/failed). The client's part is the surface, and it adds no behaviour the
daemon lacks: it never posts a draft's text itself (that would be a second sender racing the
daemon's delivery — the words reach the timeline as the homeserver's record, the owner's own
message, attributed as a person). The channel kind is the daemon's string and is never
consulted (#43); a draft belongs to a conversation exactly when its permalink parses as a
`matrix.to` room address (`conversationOf` in `src/workspace/drafts.ts` — a room *id* only, an
alias names nothing unambiguous, and anything else reads as no conversation), so drafts of
other origins, legacy rows, and permalinks the client cannot read stay in Review alone.

Three surfaces read the same records, under keys that already exist — nothing new is cached:
Review (`["drafts", { outcome: "pending" }]`) and a draft's own page each link the draft back
into its conversation, but only when the member holds that room (the shared
`["workspace", "rooms"]` read — never a link the workspace would refuse); and the conversation
itself renders `RoomDrafts` — the pending list and the newest window of the draft log
(`["drafts", { limit: 50 }]`), both filtered by the conversation the provenance names — in a
region beside the composer, **outside the transcript** (AR-14: the transcript is what the
room's members read, and a draft is the owner's alone until sent). It renders through the very
same `DraftCard` — Send, Edit, Ignore with the undo window, the daemon-unreachable rule (AR-15)
— so there is one draft, one decision, and one invalidation (`["drafts"]` and `["review"]`):
deciding it in the conversation clears it from Review and the badge, and leaving it alone
leaves it in Review, its durable home. After a send, the region keeps one line per recent
sent draft — "You sent your duo’s draft." and the daemon's delivery state (#21) verbatim — so
a failed delivery is visible where the conversation is, and no retry is invented (the daemon
exposes none). A member with no duo paired has no drafts and the region is not mounted: no
duo, no daemon read.

#49 puts the first run in the app, on the routes core #176 opened (`POST /corpus/import-paste`,
`POST`/`GET /corpus/embed`) and adds no behaviour to them. The flow keeps no "first run" flag: every
step's state is read off the daemon — records mean the import happened, the embed job's own status
is the embed's, rules mean derivation has produced something — so a refresh, a second device, or a
terminal run alongside all agree. "Empty" is the daemon's own fact (`GET /knowledge`: no records,
no import ever run, no rules), and only a definite empty sends the default surface to `#onboarding`;
a duo built in a terminal is never empty by that reading, so it opens on Review as before, and
Setup is untouched. Embedding is a job the app starts and watches (polled only while the daemon
says "running", the daemon's own counts rendered, its error rendered verbatim). **Derivation has no
route** — `duo derive` is a terminal stage — so the app cannot start it and does not pretend to: the
derive step says where it runs and watches `GET /knowledge` for its effect, and the flow ends when
the first rules appear *while the owner is watching* (navigating to `#duo/profile/rules`, approve and reject in
reach; opened on a duo that already has rules it points at the Rules tab instead of whisking there).
Whether core should expose a derive job, as it did for embedding, is core's question; until it
does, that step stays a terminal step the app observes.

#67 is the part of the product that exists nowhere else — an asker judging a colleague's duo
rather than taking it on faith — and it is built on what the wire actually carries, which is
narrower than what the core knows. An answer travels as its words and nothing else (digital-duo
`workspace/org-read.md` §5, #191): the confidence result, the source list and the grounding
chunks stay on the owner's machine beside the corpus, because a citation list is a fingerprint of
it. So the daemon composes the asker-facing basis INTO the words (`withPublicAttribution`, #44):
the answer, a "Sources:" block naming each source as the owner's standing order or a retrieved
past exchange, and an identity line carrying the confidence and the evidence's age. The client
adds no channel for evidence and asks for none; `workspace/duoAnswer.ts` reads that composition
back, whole or not at all — anything that is not the daemon's composition (a plain message, a
failure notice, a paraphrase of a fixed message) reads as plain words, and only a duo-shaped
sender, by the id grammar, is read at all, so a person typing the same words borrows nothing.
`RoomDuoAnswer` renders the reading inside the duo's message, in `MessageBody`, so the
conversation and the thread read identically:

- **Provenance at zero clicks.** The sources the words named, told apart by kind ("{owner}'s own
  standing order" / "a past exchange, not {owner} speaking now"), and the evidence's age, sit on
  the answer — no disclosure, no control. An answer that named nothing says so. Nothing offers
  more, because there is no more to fetch.
- **Trust in words, never a number.** The reading never carries the confidence: only which side
  of the owner's own hedging rule it fell on (the hairline's threshold-plus-margin, one constant
  for owner and asker; the threshold is owner-side configuration that does not travel, so the
  core's default stands in, and the source says so). Four sentences, each its own state —
  confident, hedging, outside what the duo answers on its own (passed on), a boundary its owner
  set (refused) — so nothing rests on colour, and the number is stripped from every surface that
  shows the words, previews included.
- **Escalation as a state.** A passed-on message reads "Waiting on {owner}" until the owner —
  the id the duo's id derives from, never a display name — speaks in the conversation after it,
  in the main flow or in the message's own thread; then it reads as replied. The owner's answer
  is an ordinary message of a person and arrives through the room like any other, rendered as
  the person: AR-13 holds at the moment it matters most. Nothing is shown before the duo has
  said it passed the question on.
- **A refusal is the system working.** The fixed message renders byte for byte in an element of
  its own; the client's framing sits beside it, never in place of it, in the vocabulary of a
  boundary — no alert semantics, no retry, no error words, no waiting state.

#70 adds searching what was said, and holds it apart from the other search this product has.
There are two, and they are different questions on different machines: **messages** (what people
and duos said in conversations — shared, the workspace's, served by the homeserver's own
`POST /search`) and **the corpus** (what a duo knows — private, on the owner's Mac, `GET /search`
on the daemon, #46). The seam's `searchMessages(query, next?)` asks the homeserver over message
bodies with the member's words, a page size, and a small context window (`event_context`), and
chooses no rooms: scoping to the conversations the member is in is the homeserver's rule, and the
projection additionally refuses a result from a room this account is not joined to, so a slip of
the server's can never put another conversation's words on screen. A hit is a text message — words
said (an edit's replacement event amends a row that exists elsewhere, and a shared file or a notice is not
words said, so the name of a file is not searched here) — with its room, its
sender's id, the lines said around it in the order they were said, and its thread's root when it
answered inside one. Nothing in the message search imports the daemon's `src/api`, and nothing
in the corpus search imports `src/workspace` — a scan in `test/WorkspaceSearch.test.tsx` holds
both directions, so corpus results can reach no one but the owner and message search can never
fall back to them. The surfaces name their scope: the conversations list's box reads "Search what
was said" (messages in your conversations, searched on the workspace); the ⌘K overlay reads
"Search what your duo knows" (your duo's private records, searched on your Mac).

Landing at a hit is the homeserver's `/context` through the SDK (`timelineAt`): the room's address
grows an event (`#room/<room>/<event>`; a thread's, `#thread/<room>/<root>/<event>`), the route
reads the window around it — history the live timeline may never have carried — marks and scrolls
to the hit, sends no read receipt (an old moment is not the latest), and offers the way back to the
live conversation in place of the composer. A hit renders through the same `RoomDuoMessage` /
`RoomPersonMessage` split as any message, and each context line's label comes from the same id
grammar — a duo's answer, found by search, is still visibly that duo's (#60). A search's answer is
asked, shown and forgotten: its query key (`["workspace", "search", query]`) has `gcTime: 0` and is
excluded from the persisted cache, so what a member looked for never rests in storage and a
restored answer can never outlive a membership that ended.

## 3.3 Offline

The query cache persists to storage and rehydrates at launch. Two connections fail for
unrelated reasons (#58): the workspace (messaging, up independently of any one person's
hardware) and the owner's duo daemon (asleep whenever the Mac is). Health is tracked
separately for each, and the two rules below are each about one of them — written down so
nobody applies the wrong rule to the wrong object.

- Cached views render, with one bar line per down connection, each naming which and showing
  that one's last sync (#58). The workspace line keeps the error voice: **"Last synced 14:32.
  The workspace is unreachable."** The daemon line is an expected state, not an error:
  **"Last seen 14:32. Your duo is asleep — it answers when your Mac is back."**
- **Ordinary messages queue and deliver on reconnect** (#61) — simply what a messaging app
  does. A message sent offline is held on the device, shown as pending, and delivered in
  order when the workspace answers again. A delivery that fails tells the owner, keeps the
  text, and retries only by their choice; a failed message holds its place at the head of
  the line so nothing behind it jumps ahead.
- **Drafts and duo actions are disabled, not queued** — Send, Edit, Ignore, an escalation
  answer, a rule disposition, anything irreversible. A Send that fires two hours later
  against context that has moved is worse than no Send. This is `client-design.md` AR-15,
  and it is a product decision, not a technical limitation to be engineered around later.
  Two different rules for two different objects: applying the draft rule to messages ships
  an app that refuses to let you type offline; applying the message rule to drafts ships
  exactly the failure AR-15 was written to prevent.
- **A confirmation is the sharpest case (#52).** `POST /actions/t4/:id/confirm` runs an irreversible
  action, so it is never enabled from a cache: a request is confirmable only once *this* visit has
  read the pending list from the daemon and the daemon is still answering, and the mutation runs
  with `networkMode: "always"` so a browser that believes it is offline fails the call now instead
  of parking it until the connection returns. The daemon has no push for it, so the client polls
  `GET /actions/t4/pending` (in the background too) and notifies on a request id it has not yet
  told the owner about; the notification only navigates — the confirm hook is used in exactly one
  component, and a test holds the route to one module.
- Reconnect refetches the daemon's views rather than replaying actions against them.

## 3.4 The labelling contract

`concept.md`: *"always labelled … it never poses as you."* `client-design.md` AR-13 promotes this
from a guideline to a structural rule, which means it needs a mechanism, not a convention.

- One component, `<DuoMessage>`, renders every piece of duo-generated text. It has no `avatar`
  prop. There is nothing to pass.
- `<OwnerMessage>` renders the owner's own words — sent replies, typed questions — and is the only
  component that accepts the owner's identity.
- An ESLint rule forbids the owner's avatar component inside `DuoMessage`'s subtree, and a unit
  test asserts a rendered draft contains the duo attribution string. A principle with a failing
  test is a principle; one in a style guide is a hope.

---

# Part 4 — Design system

`client-design.md` 1.6 sets the intent. These are the values.

```css
:root {
  --bg:        #0B0C0E;   --surface:  #141619;   --surface-2: #1C1F24;
  --text:      #E8EAED;   --muted:    #A6ACB2;   --faint:     #5F6469;
  --accent:    #7C8CFF;                  /* action available. nothing else. */
  --edge:      #24282E;
  --escalate:  #D9A441;   --confident: #4B9E6A;  --refused:   #6B7280;

  --r-sm: 6px;  --r-md: 10px;  --r-lg: 14px;
  --sp: 4px;                             /* every spacing value is a multiple */
  --t: 150ms cubic-bezier(0.2, 0, 0, 1);
}
```

- **Type.** Inter, or SF on Apple platforms. Body 14/22. Headings tighten to `-0.011em`; body does
  not. One weight jump only — 400 and 560.
- **Density.** 12px vertical padding per message, 20px between speakers. Measurably airier than
  Slack's 8/8, because this surface shows a handful of considered drafts, not hundreds of lines.
- **The confidence hairline.** 2px on the draft's leading edge. Three states, derived from real
  fields — never a percentage, which is precision `confidenceScore` does not have:

  | State | Condition | Colour |
  |---|---|---|
  | Refused | `kind === "escalation" && refused` | `--refused` |
  | Escalated | `kind === "escalation"` | `--escalate` |
  | Hedged | `score < threshold + 0.15` | `--escalate` at 40% |
  | Confident | otherwise | `--confident` |

  `threshold` ships in `ConfidenceResult` rather than being hardcoded, so a config sweep moves the
  UI with it.
- **Motion.** `--t` on state change only. A draft arriving may animate. Scrolling, hover and tab
  switches may not.
- **Light mode** exists and is not the default. Same tokens, inverted ramp, identical contrast
  targets: AA for body, AAA for the muted ramp, because `--muted` carries provenance text that is
  load-bearing.

---

# Part 5 — Testing

Matching the repo's existing vitest setup:

| Layer | Approach |
|---|---|
| Routes | `fastify.inject()` against a temp store seeded by the existing test helpers. No network. |
| The seam | The extracted module functions from 1.2 keep their current command tests, unchanged. That they do not change is the evidence the refactor was safe. |
| Auth | Token hashing, constant-time compare, revocation closes the socket, and a test asserting boot **refuses** `0.0.0.0`. |
| Client | Testing Library on the reducers and the draft/escalation switch. |
| Labelling | The AR-13 test in 3.4. It gates the build. |

No end-to-end browser suite for the pilot. The owner surfaces' audience is one person, the
workspace surfaces are held by the seam and component tests above (3.2, 3.4), and the cost is
not repaid.

---

# Part 6 — Work breakdown

One new epic. Steps match `client-design.md` Part 4's C-numbering.

| Step | Work | Blocked by |
|---|---|---|
| C1.0 | Extract `runRecordDraftOutcome`'s body into a passphrase-explicit module function. No behaviour change, no test changes. | — |
| C1.1 | G-a, G-b, G-c: `listDrafts` filter + pagination, `duo drafts list`, `DuoSummary` + `duo list` | — |
| C1.2 | `src/serve/`, `createServer`, read-only routes, `fastify.inject` tests | C1.0, C1.1 |
| C2.0 | Serving-mode unlock; boot refuses a non-tailnet bind | G3 |
| C2.1 | `device_tokens`, `duo pair` / `list` / `revoke`, bearer middleware | C2.0 |
| C3 | Client shell: Vite + React + Tailwind + shadcn, tokens from Part 4, route tree | C1.2 |
| C4 | Review surface, `<DuoMessage>`, the confidence hairline, the labelling test | C3 |
| C5 | Tauri v2 macOS shell, native notifications | C4 |
| C6 | Mirror browser: portrait, rules, weak signals, approve / reject / promote | C4 |
| C7 | WebSocket draft-ready, cache persistence, offline bar | C5 |
| C8 | Tauri v2 iOS / Android targets | G4, C7 |

C1.0 and C1.1 touch only existing code and are unblocked by G3 and G4 both — they are worth doing
whatever the MDM conversations return, because `duo drafts list` is a gap in the CLI today.
