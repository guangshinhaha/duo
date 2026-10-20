# Third-party notices

This file lists every file under `src/components/cards/vendor/` copied from
another project's source, under the license that copy was taken under —
required before any such file is merged (`docs/plans/phase1-build-plan.md`
§3, W-S4-8).

`src/components/cards/registry.tsx` borrows assistant-ui's *pattern* only —
a `kind → component` registry, the same shape assistant-ui's own part-type
registry and approval-card state model (request → running → done / denied
/ expired) use — never its source. No file under `src/components/cards/`
is copied from assistant-ui or any other project, so there is nothing to
license here and no `src/components/cards/vendor/` directory exists.

This repository carries no `@assistant-ui/*` runtime dependency and no
`LICENSE` file for borrowed code, because none is vendored.

## Vendored files

None.
