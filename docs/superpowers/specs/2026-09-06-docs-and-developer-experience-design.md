# Docs & developer experience — ROADMAP §11

Closes the six open items in ROADMAP §11 (65 → 95). Written 2026-09-06.

## Why

§11 is the last section where the product is materially better than its
documentation. Everything here already works; a developer evaluating Rovenue
cannot find out that it does. Six open checkboxes, and they are not six
instances of "write more prose" — three of them are *build* work (a generated
API spec, generated SDK references, compiled example apps), one is a genuine
backend feature mis-filed under docs, and only two are mostly writing.

The section's real risk is the one this repo has hit repeatedly: shipping a
doc that *describes* behaviour nobody executed. The RevenueCat guide once
described a two-pass Google import that had never worked. The countermeasure
throughout this spec is the same: every generated artifact is generated from
the code that produces the behaviour, and every claim a doc makes is either
executed in CI or explicitly labelled as not verified.

## The six items

Numbered as they appear in ROADMAP §11:

1. **Google purchase-token second pass** — a backend feature, not a doc.
2. **Quickstart + auto-generated API reference per SDK.**
3. **Interactive API explorer.**
4. **Error-code catalog.**
5. **Working example apps (iOS / Android / RN / Flutter).**
6. **Self-host operator handbook.**

**The sections below are ordered by implementation sequence, not by that
numbering** — 1, 4, 5, 6, 2, 3. The reasoning:

- Item 1 goes first: it is the only one that changes runtime behaviour, it
  needs a migration, and the migration number must be claimed before anything
  else lands.
- Items 4, 5 and 6 are independent of each other and of everything else.
- Item 2 is sequenced late because its doc-comment coverage pass is the
  largest single body of work and benefits from the example apps (item 5)
  existing first — the quickstarts document the flow those apps compile.
- Item 3 goes last: it depends on the error-code catalog (item 4) for its
  error documentation, and on the two source fixes it names.

---

## 1. Google purchase-token second pass

### What the ROADMAP asked for, and why it cannot be built as written

The roadmap's follow-up note proposes:

> give this preset its own validation/commit path that patches
> `googlePurchaseToken` onto an existing purchase found by
> (subscriberExternalId, productIdentifier)

Three independent blockers, each verified against the producing code:

**There is nowhere to put the token.** `purchases`
(`packages/db/src/drizzle/schema.ts:958`) has no `googlePurchaseToken`
column. The value exists only as a transient field on `NormalizedRow`
(`packages/shared/src/import/normalize.ts:275`), handed to Phase B's store
call and discarded. A `grep` for `googlePurchaseToken|google_purchase_token`
across `packages/db/src` returns nothing.

**The proposed lookup key is not unique.** The only unique index on
`purchases` is `purchases_store_storeTransactionId_key` on
`(store, storeTransactionId)`. There is no uniqueness — not even a composite
index — on `(subscriberId, productId)`. A subscriber legitimately holds many
purchase rows for one product: every renewal is its own row. "Find the
existing purchase" is ambiguous by construction.

**The gate is doubled.** Relaxing `validateMapping`
(`packages/shared/src/import/mapping.ts:21`) is not sufficient.
`normalizeRow` (`normalize.ts:359`) *independently* hard-requires `store` and
`purchaseDate` on every row, returning `MISSING_REQUIRED_FIELD`, and it is the
one shared row gate called from `plan.ts`, `write.ts` and `verify.ts` alike. A
fix that patched only the mapping validator would review clean and still 400
at runtime.

### What we build instead

A second-pass import is a **different operation from a history import**, and
modelling it as a variant of the existing one is what makes it impossible. It
does not create purchases. It does not accept a mapping. It enriches rows that
a previous import already wrote. So it gets its own job kind, its own
validation, its own writer, and its own report — reusing the upload,
storage, rate-limit, audit and polling machinery unchanged.

**A new column.** Migration adds `purchases.googlePurchaseToken text` (nullable)
plus a partial index for Phase-B re-verification lookup. Nullable and additive:
expand-phase only, safe under the forward-only migration discipline in
`docs/operations/upgrade.md`.

**A job kind discriminator.** `import_jobs` gains `kind` — `HISTORY` (the
default, every existing row) or `GOOGLE_TOKEN_ENRICHMENT`. The upload endpoint
sets `kind` when `detectPreset` returns `revenuecat_google_token`, instead of
today's behaviour of recording a preset the rest of the pipeline cannot honour.
Backfilled to `HISTORY` with a NOT NULL default so existing jobs are untouched.

**Its own required-field set.** Not a relaxation of the global one — a set
belonging to the kind: `subscriberExternalId`, `productIdentifier`,
`googlePurchaseToken`. Expressed as a table keyed by job kind, so adding a
future kind without declaring its required fields fails to compile rather than
silently inheriting the wrong set. `validateMapping` takes the kind; the
existing single-argument call sites keep working via the `HISTORY` default.

**Its own row parser.** `normalizeRow` is not touched — it is the history
gate and its `store`/`purchaseDate` requirements are correct for history rows.
The enrichment path gets `normalizeEnrichmentRow`, which validates exactly the
three fields it has and never synthesizes a fake `store` or `purchaseDate`.
Synthesizing them would put fabricated data one refactor away from the history
writer; the roadmap's own instruction not to resurrect a broken middle state
applies to fake values as much as to fake features.

**Fail-closed matching.** For each `(subscriberExternalId, productIdentifier)`
the job resolves `subscribers` → `subscriberId` and `products` → `productId`
(both project-scoped unique), then selects `PLAY_STORE` purchase rows for that
pair. Because that is not a unique key, the outcome is decided by an explicit
rule rather than a guess:

- **exactly one subscription chain** (rows sharing an `originalTransactionId`)
  → patch the token onto every row in the chain. A Play `purchaseToken`
  identifies a subscription across its renewals, so the chain, not the row, is
  the correct unit.
- **more than one chain, and the file supplies one token for the pair** →
  `ambiguousMatch`. Reported, not written. This mirrors `plan.ts`'s existing
  ambiguous-product rule (`resolveProduct`, `plan.ts:220`), which already
  fails closed rather than picking.
- **no matching row** → `noMatch`. The common, expected case for a token file
  covering subscribers whose history was never imported.
- **row already has a token** → `alreadyEnriched`, idempotent no-op, so a
  re-run of the same file is safe.

**Re-verification is the point.** Patching a token is worthless on its own —
its value is that Phase B can now re-verify rows that were written as
`androidNoToken` history-only. After a successful enrichment commit, the
enriched chains are eligible for the existing Phase-B verification pass.

### Non-obvious constraint

`write.ts:442-460` documents that a Play row imported with no token is written
anyway, deliberately, as history-only with `verifiedAt` null — dropping it
would have discarded 100% of Android history on the flagship RevenueCat
export. The enrichment path must preserve that: it upgrades those rows, and
must never delete or re-create them. `upsertPurchase` is not the tool here; a
targeted update is.

### Verification

- Unit: the kind-keyed required-field table; `validateMapping` under both
  kinds; `normalizeEnrichmentRow` accepting the 3-column row and rejecting
  malformed ones.
- Integration (real Postgres): the four match outcomes, each asserted against
  rows actually written by a preceding history import — not hand-built
  fixtures. A chain with two renewal rows must receive the token on both.
- Integration: re-running the identical file produces all `alreadyEnriched`
  and zero writes.
- A test that the roadmap's original naive approach stays impossible: a
  `HISTORY` job whose mapping omits `store`/`purchaseDate` still 400s.

### Out of scope

Adapty token files (shape unconfirmed — the same evidentiary bar that kept
Adapty on the generic hand-mapper applies), and Apple/Stripe enrichment (no
equivalent missing-anchor problem exists).

---

## 4. Error-code catalog

### The trap

`ERROR_CODE` (`packages/shared/src/index.ts`) holds **42 codes**, and **five
have a key that differs from the wire value**:

| Key | Actual wire value |
| --- | --- |
| `APPLE_OFFER_SIGNING_UNAVAILABLE` | `apple_offer_signing_unavailable` |
| `APPLE_OFFER_SIGNING_FAILED` | `apple_offer_signing_failed` |
| `ASSET_IN_USE` | `asset_in_use` |
| `ASSET_MISSING` | `asset_missing` |
| `PURCHASE_NOT_PAID` | `purchase_not_paid` |

A catalog generated from the object's keys — the obvious implementation —
publishes five strings no client can ever match against a real response. The
generator emits `Object.values`, and a test pins that a code whose key and
value diverge is documented by its value.

Only **9 of 42** carry an explanatory comment. The remaining 33 need prose
written by hand. This item is therefore not mechanical, and a generator that
emitted 42 rows of "no description" would be worse than nothing.

### What we build

A committed catalog page under `apps/docs/content/docs/reference/`, generated
from a source-of-truth table that lives beside `ERROR_CODE` and is exhaustive
over it by type. Each entry carries: wire value, HTTP status, what causes it,
and what the caller should do. The type is a mapped type over `typeof
ERROR_CODE`, so **adding a code without documenting it fails to compile** —
the same structural guarantee used for the store-lifecycle mapping and the
enum↔key bijection, chosen because a hand-maintained list of 42 strings drifts
within one release.

The existing `reference/errors.mdx` documents *SDK* errors (`RovenueError`
kinds per platform) and stays as it is. The new page documents the *API* error
envelope. They are different audiences and must not be merged; the pages
cross-link.

### Verification

- Compile-time exhaustiveness (deleting an entry breaks the build).
- A test asserting every documented value equals an `ERROR_CODE` value, and
  the counts match — catching both a stale entry and a missing one.
- A test that the five divergent codes are documented by value, not key.

---

## 5. Working example apps

### Current state

- `packages/sdk-flutter/example` — a real end-to-end demo (configure →
  offerings → purchase → entitlements via the changes stream →
  `RovenuePaywallView`), and it is already the best-covered artifact in the
  repo: `sdk.yml` runs `flutter test`, `flutter test integration_test`, and
  `flutter build apk --debug` against it.
- `examples/sample-rn-expo` — demonstrates identify/logOut, offerings,
  purchase, restore, entitlements and credits with a live event log. It is
  **referenced by no CI workflow at all**.
- **No native iOS or Android example exists anywhere.** Every `.xcodeproj`,
  `Package.swift` and `build.gradle.kts` in the repo belongs to a package or
  to Flutter's generated platform wrappers.

### What we build

Two new example apps, one shared demonstrated flow, and CI that compiles them:

- `examples/ios-swift` — SwiftUI, consuming `packages/sdk-swift` by local
  SwiftPM path.
- `examples/android-kotlin` — Compose, consuming `packages/sdk-kotlin` by
  Gradle `includeBuild`.

Both demonstrate the same sequence the Flutter example already does, so the
four apps teach one flow rather than four dialects: configure → identify →
offerings → paywall → purchase → entitlement reaction → restore.

`examples/sample-rn-expo` is brought up to that same flow and, more
importantly, **into CI**.

`examples/*` is already a `pnpm-workspace.yaml` glob, so a new example with a
`package.json` joins the workspace automatically — the native apps deliberately
carry none, to stay out of the JS dependency graph.

### CI

`sdk.yml` already runs `macos-14` jobs (`swift`, `flutter-ios-native`) and
already builds the Flutter example's APK, so this is precedent, not new
infrastructure:

- `example-ios` (macos-14) — `xcodebuild build` for the simulator.
- `example-android` (ubuntu) — `gradle assembleDebug`.
- `example-rn` (ubuntu) — typecheck + bundle; a full native prebuild is not
  attempted, for the reason recorded below.

### Non-obvious constraint

`examples/sample-rn-expo/README.md` documents a live monorepo hazard:
`ExpoModulesCore.podspec` resolves React Native's version from its own hoisted
location and picks the workspace root's RN (0.86.x) instead of the app's
0.74.5, baking `REACT_NATIVE_TARGET_VERSION=86` into the Pods project and
failing to compile. Until the hoisting is fixed, an iOS prebuild of the RN
example cannot be made green in CI by this work. The RN CI job therefore
verifies what it can honestly verify, and the limitation is stated in the
README rather than hidden behind a job that skips.

### Verification

Compilation in CI is the verification — "working example app" is exactly the
claim that a build job substantiates and prose does not. Every prior
distribution defect in this repo lived in code nothing ever built.

---

## 6. Self-host operator handbook

### What already exists

Better than the roadmap's 65 implies. `docs/operations/backup-restore.md`
covers backup, restore ordering, the `ENCRYPTION_KEY` fingerprint hazard, the
post-restore ClickHouse gap, and mandates a quarterly test-restore.
`docs/operations/upgrade.md` covers expand/contract discipline, ClickHouse
migrations, Kafka-fed materialized-view recreation, and is blunt about
rollback: migrations are forward-only, so rollback means restoring the backup.

### The real gaps

- **ClickHouse / Kafka capacity planning** — nothing.
- **pg_partman partition maintenance** — mentioned in passing three times,
  never as a runbook, despite partition maintenance having previously never
  once completed successfully.
- **Connection pooling** — nothing, anywhere.
- **Monitoring and alerting** — nothing in `docs/`, *despite the assets
  existing*: `deploy/prometheus/rules/slo.yml` ships multi-window burn-rate
  alerts against a 99.9% availability and 99%-under-500ms latency SLO, plus
  correctness alerts on the access-drift circuit breaker, and `deploy/grafana`
  auto-provisions a RED dashboard. An operator has no way to discover any of
  it.
- **Disaster recovery with stated RPO/RTO** — nothing.
- **Secret / key rotation** — disclaimed in one doc, referred to as "a
  separate runbook" in another, and that runbook does not exist.
- **Horizontal scaling** — documented, but only in Turkish
  (`deployment-rehberi.md` §11). It is the sole description of `API_REPLICAS`
  and of the constraint that `dispatcher` and `digest-scheduler` must never
  exceed one replica.
- **No root `README.md` exists.** For an AGPL self-hosted product this is the
  highest-leverage missing document in the repository.

### What we build

A handbook under `docs/operations/` that covers scaling, monitoring,
capacity, partition maintenance, pooling, rotation and disaster recovery, and
**links to** rather than restates backup-restore and upgrade. Plus a root
`README.md`.

Two things it must say plainly rather than paper over:

- **No Alertmanager is wired into `docker-compose.yml`.** The rules labelled
  `page` reach nobody until an operator adds one. Documenting the alerts
  without documenting that they do not page would be exactly the class of
  false claim this section exists to remove.
- **RPO/RTO are derived from the backup cadence the operator chooses**, and
  `backup-restore.md` explicitly declines to implement retention. The handbook
  states the arithmetic and the default, not an invented guarantee.

The English scaling content is reconciled with `deployment-rehberi.md` §11 so
the two do not drift; the Turkish guide keeps its broader walkthrough.

### Verification

Prose cannot be unit-tested, so verification is restricted to what genuinely
can be checked: every command in the handbook is executed once against the
local stack and its real output recorded, every internal link resolves
(`apps/docs` already has `check-links.mjs`), and every metric, alert and
service name is cross-checked against the file that defines it. Anything not
executed is labelled as such.

---

## 2. Quickstart + auto-generated API reference per SDK

### Current state

**No SDK has any doc-generation tooling.** No `cargo doc` config, no `.docc`
catalog, no Dokka plugin, no typedoc, no dartdoc. Public-API doc-comment
density, measured across the five façades:

| SDK | Density |
| --- | --- |
| `core-rs` | ~39% |
| `sdk-swift` | ~25% |
| `sdk-rn` | ~22% |
| `sdk-flutter` | ~15% |
| `sdk-kotlin` | ~8% |

### The consequence for this item

Wiring up five generators over API documented at 8–39% produces five hollow
reference sites — pages of symbol names with no explanation, which is worse
than the hand-written `reference/methods.mdx` (1566 lines) that exists today,
because it *looks* complete.

So this item is two things, and the doc-comment pass is the larger one:

1. **A coverage floor, enforced.** Each SDK gets a documentation-coverage
   check in CI with a threshold that starts at its current measured value and
   is raised as the pass proceeds — a ratchet, so density can never regress.
   Rust uses `#![warn(missing_docs)]`; the others use a small shared script
   measuring documented public symbols, because none of the four ecosystems
   ships a coverage gate we can rely on uniformly.
2. **Generation and hosting**, below.

The public surface is prioritised over internals: the ~46 methods each façade
exposes (the Flutter parity work established that number) are documented to
100% before any internal type is touched.

### Hosting

The chosen outcome is a single domain — `docs.rovenue.app/api/<sdk>/` — with
no `gh-pages` branch. Generating inside the docs Docker image is not possible:
DocC requires macOS and Xcode, and the docs image is Linux. So generation and
serving are separated:

- A CI matrix generates each SDK's docs **on the runner that can build it**
  (`macos-14` for DocC, JDK for Dokka, cargo for rustdoc, node for typedoc,
  Flutter for dartdoc) and uploads each as an artifact.
- The docs image build **downloads those artifacts into
  `apps/docs/public/api/<sdk>/`** before `react-router build`. The served
  result is exactly the chosen outcome; only the moment of generation moves.
- Locally, `pnpm docs:sdk-ref` generates whatever toolchains the machine has.
  The hub page renders a per-SDK card that links the generated site when
  present and states plainly that it was not generated locally when absent —
  it never renders a dead link.

A quickstart per SDK is added under `apps/docs/content/docs/platforms/`
alongside the existing five platform pages, each ending at a working purchase
— and each is the flow the corresponding example app in item 5 compiles, so
the quickstart and the example cannot disagree.

### Verification

- CI fails if any SDK's doc coverage drops below its recorded floor.
- CI fails if a generator produces no output (a silently-empty DocC archive is
  the exact failure mode that shipped a simulator slice labelled as a device
  slice).
- The docs image build fails if an expected artifact is missing, rather than
  serving a 404 under `/api/<sdk>/`.

---

## 3. Interactive API explorer

### What was verified, by experiment rather than by reading

Booting the app to walk its routes is the mechanism, and both load-bearing
assumptions were tested directly rather than inferred:

- **`apps/api/src/app.ts` imports in ~3.1s with no live infrastructure.** No
  Postgres, Redis, ClickHouse or Kafka connection opens at import time (the
  drizzle client is a lazy `Proxy`, the pool is lazy, ioredis is
  `lazyConnect`, Kafka getters are never called at module scope, and `env.ts`
  skips every production-required check outside `NODE_ENV=production`).
  `app.routes` yields **641 entries, 139 of them under `/v1`**, shaped
  `{ basePath, path, method, handler }`.
- **A schema tag attached to `validate()`'s middleware survives into
  `app.routes`.** Hono stores one entry per handler and `@hono/zod-validator`
  returns a bare closure, but functions are objects: a symbol-keyed property
  carrying `{ target, schema }` attaches cleanly and is recoverable from the
  walk, with the zod schema intact and its shape readable.

That makes the request side fully generated and drift-proof.

### The honest limit

**Nothing in the codebase describes a response body as data.** `ok<T>(data)`
(`apps/api/src/lib/response.ts`) is a bare identity generic; `T` is inferred
structurally at compile time and erased at runtime. There is no response zod
schema anywhere under `routes/v1/`. Equally, **no route uses
`validate("query")` or `validate("param")`** — every `:appUserId`,
`:identifier` and `?locale` is read ad hoc via `c.req.param()` /
`c.req.query()`.

So a route-walk can generate requests and auth requirements, and cannot
generate responses or parameters. Claiming otherwise would be the same
category of false statement this section exists to delete.

The resolution is not to hand-write the whole spec, and not to pretend the
generated half covers everything. It is to make **the generated half the
index of record**: the walk enumerates every real endpoint, and a companion
file supplies the response and parameter documentation. A contract test
asserts the two sets are equal. Adding an endpoint without documenting it
**fails CI by name** — drift is converted from silent divergence into a build
failure, which is the actual guarantee that was wanted.

### Two small source fixes the generator needs

Both are corrections in their own right, not scaffolding:

- **`validate()` tags its middleware** with target + schema
  (`apps/api/src/lib/validate.ts`). Three lines; the generic signature that
  preserves `hc` client inference is untouched.
- **`requirePublicApiKey` is promoted to a shared export.** It is currently
  declared *twice, independently* — `routes/v1/events.ts:34` and
  `routes/v1/sdk-sessions.ts:87` — as separate closures with the same name.
  `requireSecretKey` is a proper exported singleton and is detectable by
  reference; its public counterpart is not. Two copies of one security
  predicate is a latent inconsistency regardless of documentation.

### Two shapes the generator must special-case

- **`v1Route` is mounted twice** — `/v1` and `/v1/web/:publicKey` — so the
  raw table double-counts every endpoint. The browser surface is documented
  as the CORS-restricted variant it is, not as duplicate endpoints.
- **Two endpoints bypass `v1Route` entirely**: `config-stream.ts` mounts its
  own `/v1/config/stream` with its own `apiKeyAuth`, and `paywall-preview.ts`
  mounts `/v1/preview/paywalls/:token` with **no API-key auth at all**,
  guarded only by rate limiting and an opaque token. A generator assuming
  "everything under `/v1` is `v1Route`" would silently mis-document both,
  including the auth posture of the unauthenticated one.

The real surface is **33 distinct endpoints**, not the 54 a naive
`grep` for `.get(`/`.post(` suggests — that count is inflated by `c.get(...)`
context reads and by the double mount.

### Rendering

The docs site's production image is **Caddy serving static files with no Node
process** (`react-router.config.ts` prerenders every page; the Dockerfile's
runtime stage copies `build/client` into `/srv`). The explorer must therefore
be pure client-side JavaScript, SSR-guarded so it does not execute during the
prerender pass — `app/routes/docs.tsx` already establishes that boundary with
fumadocs' `createClientLoader`, and the widget follows it.

"Try it" calls the operator's own API from the browser, with the base URL
entered by the reader — a self-hosted product has no single canonical host to
default to.

### A latent defect found while planning

Because production serves static files with no Node runtime, the `/api/search`
server loader (`app/routes/search.ts`) is **unreachable in the shipped image**.
Documentation search is therefore dead in production today. This is out of
scope for §11 but is recorded here and raised as its own item rather than
being quietly fixed inside a docs batch.

### Verification

- The contract test above: generated endpoint set ≡ documented endpoint set.
- A test that both non-`v1Route` endpoints appear, with correct auth — in
  particular that the preview endpoint is documented as unauthenticated.
- A test that the browser mount does not produce duplicate endpoints.
- The spec validates against the OpenAPI 3.1 schema in CI.

---

## Global constraints

- No magic values: thresholds, paths, job kinds and coverage floors are named
  constants, declared once.
- Every generated artifact is generated from the code that produces the
  behaviour it documents. No second source of truth.
- Structural guarantees over hand-maintained lists: mapped types and
  compile-time exhaustiveness wherever a list must stay in step with code.
- Nothing is described as working that CI does not execute. Where something
  cannot be verified, the doc says so.
