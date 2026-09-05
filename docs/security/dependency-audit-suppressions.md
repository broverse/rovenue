# Dependency audit suppressions

`pnpm audit --prod --audit-level=high` gates CI. Every advisory it reports
must end in one of two places: a fixed dependency, or a line in this file
with the reason it cannot be fixed here.

The suppression list itself lives in the root `package.json` under
`pnpm.auditConfig.ignoreGhsas`. JSON has no comments, so the list on its own
is a set of opaque identifiers — which is how it was until now: the original
rationale was written to `.superpowers/sdd/briefs/W5.1-report.md`, inside a
git-ignored scratch directory. A suppression nobody can audit is a
suppression nobody can retire, so the rationale now lives here, in the repo.

## The two grounds for suppressing

**Not in a shipped image.** The four images this repo publishes are
`rovenue-api`, `rovenue-dashboard`, `rovenue-docs` and `rovenue-postgres`.
`pnpm audit` runs at the workspace root, and `pnpm-workspace.yaml` includes
`examples/*` — so an Expo example app's build toolchain is audited exactly
like production code. It is not production code.

**Not installed at all.** `drizzle-orm` declares `@prisma/client` as an
optional peer. Rovenue uses node-postgres, so nothing under `@prisma` is
installed (`apps/api/node_modules/@prisma` does not exist), but the advisory
resolver walks the peer graph and reports it anyway.

Neither ground is "the fix looked hard". A reachable advisory gets fixed.

## Suppressed

| Package | GHSA | Path | Why suppressed |
|---|---|---|---|
| `tar` 6.2.1 | GHSA-34x7-hfp2-rc4v, GHSA-8qq5-rm4j-mr97, GHSA-83g3-92jg-28cx, GHSA-qffp-2rhf-9h96, GHSA-9ppj-qmqm-q256, GHSA-r6q2-hw4h-h46w, GHSA-23hp-3jrh-7fpw, GHSA-8x88-c5mf-7j5w, GHSA-r292-9mhp-454m | `expo > @expo/cli` (also via `cacache`) | Build toolchain, no shipped image. The fix is a 6→7 major inside `@expo/cli`; we declare no direct `tar` dependency, and an override would break `cacache@18`, which requires `^6.1.11`. |
| `@xmldom/xmldom` 0.7.13 | GHSA-wh4c-j3r5-mjhp, GHSA-2v35-w6hq-6mfw, GHSA-f6ww-3ggp-fr8h, GHSA-x6wf-f3px-wcqx, GHSA-j759-j44w-7fr8 | `expo > @expo/cli > @expo/config` | Build toolchain, no shipped image. |
| `image-size` 1.2.1 | GHSA-w3rx-r6r6-pgpr, GHSA-5p2g-fcmc-qvqq | `expo > @expo/cli > @expo/log-box` | Build toolchain, no shipped image — **and there is no fixed version**: the advisory's patched range is empty, so this one cannot be resolved by upgrading at any level. |
| `@remix-run/server-runtime` 2.17.4 | GHSA-8x6r-g9mw-2r78 | `examples/sample-rn-expo > expo-router` | Example app only. |
| `turbo-stream` 2.4.1 | GHSA-rxv8-25v2-qmq8 | `examples/sample-rn-expo > expo-router` | Example app only. |
| `ws` 8.20.1 + 7.5.10 | GHSA-96hv-2xvq-fx4p | `vitest > jsdom` (8.x); react-native CLI in `examples/` (7.x) | Dev-only on both paths. |
| `form-data` 4.0.5 + 3.0.4 | GHSA-hmw2-7cc7-3qxx | `expo@51` CLI; `@types/node-fetch` | Build toolchain and types, no shipped image. |
| `vite` 5.4.21 | GHSA-fx2h-pf6j-xcff | `vitest` | Dev-only. Patched range is vite 6 only. |
| `kysely` 0.28.16 | GHSA-pv5w-4p9q-p3v2 | `better-auth` internals | Not directly declared; retires when better-auth upgrades its own dependency. |
| `deepmerge-ts` 7.1.5 | GHSA-ggr8-5vv4-36mx | `drizzle-orm > @prisma/client (optional peer) > prisma > @prisma/config` | Not installed — see "Not installed at all" above. Fixed in 8.0.0, a major we have no dependency on. |

## Retiring a suppression

Delete the id from `pnpm.auditConfig.ignoreGhsas`, delete its row here, and
run `pnpm audit --prod --audit-level=high`. Green means it was genuinely
resolved upstream; red means it was not, and the row goes back.
