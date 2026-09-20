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
- **`src/routes/Mirror.tsx`** — the Mirror browser (C6): the interruption portrait plus derived
  rules in five buckets, with Approve / Reject / Promote on exactly the actions the daemon's own
  preconditions allow. Read-and-disposition only — rule authoring stays in `duo/rules/*.md` on
  the Mac (AR-18). No percentages anywhere: bars and counts, never numerals the data doesn't
  carry.
- **`src/routes/Setup.tsx`** — first run: paste the daemon's tailnet address and a `duo pair new`
  token.

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

## Deliberately not here yet

- **Tauri wrapping** (C5, macOS; C8, iOS/Android) — needs a macOS host with Xcode for the real
  builds, which this environment doesn't have.
- **WebSocket draft-ready push** (C7) — the build order pairs it with the Tauri shell, since the
  notification half of "a new draft is waiting" is native.
- **The Mirror's refusals tab** and **rule-detail-with-evidence view** — `client-tech-design.md`
  §3.1 lists refusals alongside portrait and rules, but no daemon route lists refusals yet, and
  the `GET /mirror/rules/:id` the daemon does expose isn't in §1.4's client route contract. Both
  wait on core work first: a surface must not add a behaviour.
