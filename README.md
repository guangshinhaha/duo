# Duo client

The Mac/phone client (`docs/client-tech-design.md` Part 3) — a React app against the `duo serve`
daemon, wrapped by Tauri for desktop and mobile (`docs/client-tech-design.md` C5/C8, not yet added
in this pass).

## What's here

- **`src/api/`** — a typed fetch wrapper (`client.ts`) plus TanStack Query hooks (`queries.ts`)
  against the daemon's real routes. `types.ts` mirrors the daemon's domain types by hand — see its
  own doc comment for why (two separate npm packages, no shared workspace build step yet).
- **`src/components/DuoMessage.tsx` / `OwnerMessage.tsx`** — the labelling contract
  (`docs/client-design.md` AR-13) made structural: `DuoMessage` has no `avatar` prop, and
  `eslint.config.js` enforces that its subtree can never import `OwnerMessage`.
- **`src/components/ConfidenceHairline.tsx`** — the four-state hairline from
  `docs/client-tech-design.md` Part 4, derived from `DraftPipelineResult`'s real fields, never a
  percentage.
- **`src/components/DraftCard.tsx`** — Send / Edit / Ignore, the correction loop's only input.
- **`src/routes/Review.tsx`** — the default surface: every pending draft.
- **`src/routes/Duo.tsx` / `src/components/Composer.tsx`** (#8) — the thread view plus composer at
  `#duo`: every draft (all outcomes) grouped by `threadContext` into one conversation, questions as
  the owner's words and drafts / sent text / escalations as the duo's, each entry named by what
  actually happened (sent, sent-edited, ignored, answered escalation, waiting in Review). The
  composer asks via the existing `POST /drafts` — trimmed question, targeted at the selected group —
  and disposition stays in Review, by design.
- **`src/routes/Trust.tsx`** (#9) — the trust grid at `#trust`: per topic, the duo's tier, autonomy
  level, and whether it earned that or was granted it, with aged trust marked stale. The grid is a
  read; the page's two writes are the deliberate acts the core exposes over its one shared module
  path (`trust-surface.md`, #179): accept or decline an offered promotion (`/trust/promotions`), and
  a plain-words grant (`POST /trust/grant`) whose ambiguous match comes back as a picker, never a
  guess. T4 is never offered.
- **`src/routes/Audit.tsx`** (#10) — the permissions audit at `#audit`: every question someone asked
  this duo and what it answered, newest first, answer text verbatim, declined entries marked
  declined, unresolved askers marked (the raw reference never reads as a name). The asker's
  question carries neither identity — only the duo's answer is `DuoMessage` (AR-13 cuts both ways).
- **`src/routes/Mirror.tsx`** — the Mirror browser (C6): the interruption portrait plus derived
  rules in five buckets, with Approve / Reject / Promote on exactly the actions the daemon's own
  preconditions allow. Each rule opens onto the exchanges it cites (`GET /mirror/rules/:id`, #53),
  and a refusals section shows what the owner told the duo to refuse and why (`GET /mirror/refusals`,
  never-asked told from asked-and-none by the daemon's own `decided` flag). Read-and-disposition
  only — rule and refusal authoring stay in `duo/` on the Mac (AR-18). No percentages anywhere:
  bars and counts, never numerals the data doesn't carry.
- **`src/routes/Escalations.tsx`** (#54) — what the duo keeps having to ask about, at
  `#escalations`: every sent digest (`GET /escalations/history`, all pages) arranged into the
  questions escalated most, each with its count, a share bar, and the daemon's reason; opening one
  reads its latest escalation into the same card Review shows, so the answer that queues a
  standing-order candidate is one click away. The urgent rate (`GET /escalations/rate`) is the
  daemon's counts in words plus its own figure as a bar — never a percentage. It never calls
  `POST /escalations/digest`: assembling a digest is the send, and opening a screen must not send.
  The pattern is pure arrangement in `src/escalations/pattern.ts` (identical wording only).
- **`src/routes/Join.tsx` / `src/api/hosted.ts`** — invite-only hosted mode's front door: an invite
  link `#join?host=<daemon origin>&invite=<code>` asks the person's name, spends the invite
  (`POST {host}/hosted/signup`), and pairs this browser to the new duo at `host + /t/<id>` exactly as
  Setup would, landing on Onboarding. A join hash outranks every other surface, paired or not, and is
  replaced in history once spent. Hosted duos live under a path, so `normalizeBaseUrl` keeps the
  address's path (ws and ask links already append to it). On a server with Google sign-in
  (`GET /hosted/config` names a client id) the name field becomes Continue with Google, and the new
  duo is bound to that account; `already_has_duo` points back to sign-in.
- **`src/routes/Landing.tsx` / `src/components/GoogleSignInButton.tsx`** — a hosted build's front
  door. With `VITE_DUO_DAEMON_URL` set at build time (the Dockerfile takes it as a build arg) the app
  already knows its server, so an unpaired browser sees Sign in with Google rather than an address
  form: the Google ID token goes to `POST /hosted/login`, which answers this account's duo and a
  fresh, revocable device token. The GIS script is loaded once, by script tag, and feature-detected.
  Setup stays reachable under "Advanced: connect to a server by address", and a build without the
  variable is the Setup-first app it always was. Who the browser is signed in as (name, admin flag)
  sits beside the stored connection and leaves with it; the nav and Settings then say **Sign out**
  for the same local forget.
- **`src/components/InvitePeople.tsx`** — Settings → Invite people, for a server's admins only:
  mint a single-use invite (optionally locked to one Google email), shown once with a copy button,
  and see which invites were used, are pending, or expired (`GET/POST {origin}/hosted/invites`,
  authorised by this device's own token).
- **`src/routes/Setup.tsx`** — first run: paste the daemon's tailnet address and a `duo pair new`
  token.
- **`src/routes/Onboarding.tsx`** (#49) — building a duo from the app: upload a Claude data export
  (`conversations.json` → `POST /corpus/import-claude`) or paste one conversation, start and watch
  the embed job (core #176's routes), then "Build my duo" — the daemon's derive job
  (`POST`/`GET /corpus/derive`: pairs, topics, rules, voice), shown stage by stage — and end at the
  Mirror's first rules. A paired duo the daemon reports empty opens here; one built in a terminal
  never does.
- **`src/routes/Settings.tsx`** (#11) — this device's connection at `#settings`: the daemon address
  and a masked token, the address editable with Setup's own validator and wording, and "Forget this
  device" as a local forget behind a confirmation whose copy says exactly that (it does not revoke).
  Forgetting clears the stored connection *and* the persisted query cache, so the old duo's data
  can't outlive its token. Its **Devices** section (#48, on digital-duo #177's routes) lists every
  paired device — name, when paired, when last seen, never a token — and revokes one behind a
  confirmation (`src/components/PairedDevices.tsx`). The daemon doesn't say which row is the
  caller, so "This device" is a mark the owner places once and the pairing remembers; revoking
  that device says so first, revokes before it forgets, and lands on Setup. **Pair another device**
  (`POST /devices`, `src/components/PairAnotherDevice.tsx`) mints a token from here — shown once,
  beside the address to paste — for a hosted duo with no terminal to run `duo pair new` at. **Ask
  links** (`src/components/AskLinks.tsx`) mint, list and revoke a colleague's link; the full
  `ask.html#host=…&token=…` URL is shown once at minting, with a copy button.
- **`ask.html` / `src/routes/Ask.tsx`** (#1/#2) — the no-install asker page: a colleague opens
  `ask.html#host=…&token=…`, asks one question, and gets one of the daemon's three public-answer
  outcomes, rendered verbatim (the fixed passed-on / refusal strings are the contract — #43 AC3).
  Its own Vite entry and its own attribution ("the owner's duo" — the reader isn't the owner), on
  the `POST /ask` contract from digital-duo #157/#159. That route isn't served by the daemon yet,
  so this page is contract-first: fully built and tested against mocked fetches, waiting on the
  core to go live end-to-end.
- **`src/api/ws.ts` / `src/sync.tsx` / `src/components/OfflineBar.tsx`** (C7) — the offline half
  of §3.3: the query cache persists to localStorage and rehydrates at launch; when the daemon goes
  quiet at the network level the persistent bar renders ("Last synced HH:MM. Your Mac is
  unreachable.") while cached views stay up and every mutation control is disabled, not queued
  (AR-15). `useDraftReadySocket` keeps the daemon's one push channel open — auth by first message
  (browsers can't put a Bearer on a WebSocket), reconnect with backoff that resets on clean auth,
  and on `draft-ready` it invalidates `["drafts"]` + `["review"]` (§3.2) and fires the native
  notification callback. Contract-first against digital-duo #162 — the daemon doesn't serve
  `GET /ws` yet, so the socket is exercised against a fake until the core lands.
- **`src-tauri/` / `src/notifications.ts`** (C5) — the Tauri v2 macOS shell: Rust wrapper +
  WKWebView around the same web build, with the notification plugin wired so a `draft-ready` push
  posts a native "A new draft is waiting for your review." In a plain browser tab every
  notifications call feature-detects and quietly no-ops — the web client carries no shell
  dependency.

## Running it

```
npm install
npm run dev      # pair against a real `duo serve` instance from the Setup screen — no dev proxy
npm run build    # tsc -b && vite build
npm test
npm run lint
```

There's no build-time coupling to the CLI/daemon package — this is a separate npm project talking
to `duo serve` over HTTP, the same way the Tauri-wrapped Mac and phone apps eventually will.

### Testing without the real daemon

The real daemon doesn't send CORS headers yet (digital-duo #167), so every browser origin —
including `npm run dev` on this machine — is refused by it today. `mock/daemon.mjs` (#16) is the
stand-in: the daemon's whole route contract from this repo, zero dependencies, with the CORS
header set #167 will add (this file doubles as a live reference for it).

```
npm run mock     # mock daemon on http://127.0.0.1:7720
npm run dev      # then pair with address http://127.0.0.1:7720 and any non-empty token
```

What it serves: every route the client calls, including the three the real daemon doesn't yet —
`POST /ask` (all three public-answer outcomes), the `/ws` handshake, and CORS. State is seeded in
memory and the POST routes really mutate it, so the whole loop works: ask in Duo, send/edit/ignore
in Review, answer an escalation, approve a rule, revoke a paired device (`GET /devices`, #48 — the
mock accepts any bearer, so revoking changes the list, not what a token can do). A restart resets everything.

Question keywords pick the outcome, so you can reach each branch on purpose:

| Keyword in the question | Outcome |
| --- | --- |
| "refuse" | refused escalation |
| "should I" / "escalate" | judgment escalation |
| anything else (drafts) / "pass" (ask) | a draft / passed on |
| "secret" / "salary" / "address" (ask) | declined |

The asker page works against it too — open
`ask.html#host=http%3A%2F%2F127.0.0.1%3A7720&token=ask-token`. And the push channel has a demo:
`POST /mock/push-draft` fabricates a daemon-side draft and broadcasts `draft-ready`, so the socket,
the refetch, and the notification path can all be watched live (mock-only; the real daemon has no
such route and needs none). `EMPTY=1 npm run mock` starts a duo nobody has built (the app opens
on onboarding, #49); after importing and embedding in the app, `POST /mock/derive` stages what
`duo derive` would have produced (mock-only — the real daemon has no route to run derivation).

Swapping to the real daemon when the core work lands is Settings → Forget this device → re-pair
with the real address and token. Nothing in `src/` knows the mock exists.

The Mac shell needs a Rust toolchain (≥1.89 in practice — the current tauri dependency tree):

```
npm run tauri -- dev            # web dev server inside the native shell
npm run tauri -- build          # the .app and .dmg in src-tauri/target/release/bundle/
```

The build is unsigned — the signing decision and its consequences are recorded in
[`docs/shell-release.md`](docs/shell-release.md).

## Deliberately not here yet

- **Tauri iOS/Android targets** (C8) — blocked twice over: `tauri build` for iOS needs a full
  Xcode with signing certificates this machine doesn't have, and the build order pairs C8 with
  C7's *live* push channel, which still waits on the daemon (`GET /ws`, digital-duo #162). The
  macOS shell (C5) is here; the phone halves are not.
- **Live draft-ready push** — the client half of C7 is in (`useDraftReadySocket`), but the
  daemon's `GET /ws` doesn't exist yet (digital-duo #162); until it does, Review refreshes by
  refetch, which was always the floor.
