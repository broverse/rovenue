# Ten Recorded Defects — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the ten defects recorded on the ROADMAP during §11 — three plain corrections, two wire-visible API fixes, two operational fixes, two documentation fixes, and one recorded defect that turns out to be a different defect than written.

**Architecture:** Five phases ordered so a failure in the risky ones cannot strand the cheap ones. Phase H does not begin until H1 proves every SDK façade tolerates an unknown error code. Phases I and J are independent of each other and of H.

**Tech Stack:** TypeScript strict, Hono, Zod 3, Drizzle, pg_partman 5.5.0, Vitest, Gradle composite builds, Expo config plugins, Fumadocs (React Router v7, statically prerendered), AES-256-GCM via `packages/shared/src/crypto.ts`.

**Spec:** `docs/superpowers/specs/2026-09-06-ten-recorded-defects-design.md`

## Global Constraints

- **Stay on `main`.** Do not create or switch branches, do not create worktrees. The user manages branching.
- **Never write to the shared local Postgres** (`rovenue-db-1`). It is the developer's live dev stack. Read-only queries are fine. I1 and I2 verify against a disposable database (testcontainers, or a scratch container), never the shared one.
- **Throttle test runs.** `nice -n 19 npx vitest run --maxWorkers=2 <specific-file>`; builds `--concurrency=2`; strictly sequential.
- **`apps/api` keeps tests in TWO locations** — `apps/api/tests/**` and colocated `apps/api/src/**/*.test.ts`. A directory-scoped run silently misses the other. Name both, or run the package's own `test` script.
- **A passing Vitest suite is not evidence a module loads.** Vitest's resolver masks circular-import TDZ crashes that real Node ESM throws. Verify module-loading properties with `pnpm build` or a real node/tsx subprocess.
- **Every guard added must be watched failing** before it is trusted. Report the actual failure message.
- **No magic values.** Named constants declared once. Structured data tables are the desired form, not a violation.
- **Migrations are forward-only and expand-only.** The next free migration number must be verified at the time of writing, not assumed.
- **Conventional commits.**

---

# Phase G — three corrections

### Task 1: `withRovenueAndroid.ts` emits a resolvable Gradle wiring

**Files:**
- Modify: `packages/sdk-rn/plugin/withRovenueAndroid.ts`
- Test: `packages/sdk-rn/src/__tests__/` (find the plugin's existing test convention first; if none exists, create one beside the plugin)

**The defect:** the plugin emits `includeBuild(<path>)` plus `implementation("dev.rovenue:sdk:0.1.0")`. Gradle's composite substitution matches by **project name** (`sdk-kotlin`), not the maven coordinate (`dev.rovenue:sdk`), so it never resolves. `packages/sdk-flutter/rovenue_flutter_android/android/settings.gradle` already carries the needed rule — read it first and mirror its shape rather than inventing one.

- [ ] **Step 1: Write the failing test.** Assert the plugin's emitted `settings.gradle` content contains a `dependencySubstitution` block mapping `dev.rovenue:sdk` to the included build's project. Run it; it must fail.
- [ ] **Step 2: Read the Flutter precedent** at `packages/sdk-flutter/rovenue_flutter_android/android/settings.gradle` and quote it in your report — the fix should match its semantics.
- [ ] **Step 3: Emit the substitution rule** from the plugin alongside `includeBuild`.
- [ ] **Step 4: Run the test; it must pass.**
- [ ] **Step 5: Prove it against a real build.** Apply the plugin's *emitted* wiring to `examples/android-kotlin`'s settings (or a scratch copy) and run `./gradlew assembleDebug`. It must succeed. Then remove the substitution rule and confirm it fails with `Could not find dev.rovenue:sdk:0.1.0` — the guard must be watched failing.
- [ ] **Step 6: Commit** — `fix(sdk-rn): emit dependencySubstitution so the Android build resolves`

---

### Task 2: Document the `RovenueFFI.xcframework` prerequisite

**Files:**
- Modify: `packages/sdk-swift/README.md`, `examples/ios-swift/README.md`
- Possibly modify: `packages/sdk-swift/Package.swift` (a clearer failure only if it can be done without breaking resolution)

**The defect:** `Package.swift` requires the xcframework; `.gitignore` excludes it. A fresh clone cannot resolve the Swift package, and nothing says so. CI works only because `sdk.yml` builds it first.

- [ ] **Step 1: Reproduce the failure.** From a state where the xcframework is absent (move it aside, do not delete), attempt `swift build` in `packages/sdk-swift` and capture the real error a newcomer sees. Restore it afterwards.
- [ ] **Step 2: Document the prerequisite** in both READMEs: what to run (`packages/sdk-swift/scripts/build-xcframework.sh`), why it is not committed (build artifact), and the exact error you captured, so the error text is searchable.
- [ ] **Step 3: Do NOT commit the binary.** It is correctly gitignored.
- [ ] **Step 4: Verify** the documented command actually works from a clean state.
- [ ] **Step 5: Commit** — `docs(sdk-swift): document the xcframework build prerequisite`

---

### Task 3: `db:migrate:generate` produces a reachable journal timestamp

**Files:**
- Modify: `packages/db/` migration generation tooling (find what `db:migrate:generate` runs)
- Test: extend `packages/db/tests/journal-monotonic.test.ts` or add beside it

**The defect:** migrations 0121–0126 were hand-set to a synthetic future `+86400000`/day cadence, so the watermark sits days ahead of wall clock and every drizzle-kit-generated `when` lands below it — silently skipped forever on upgrade-path databases. It hit 0125 and 0126 independently. The existing guard catches it, but only after a commit, and only if someone runs it.

- [ ] **Step 1: Establish the current maximum.** Read `packages/db/drizzle/migrations/meta/_journal.json` and report the current max `when` and which entry holds it.
- [ ] **Step 2: Write the failing test.** A generated entry whose `when` is not strictly greater than the current maximum must be rejected by the generation step, not merely by the after-the-fact guard.
- [ ] **Step 3: Make generation correct.** After `drizzle-kit generate` runs, rewrite the new entry's `when` to `max(existing) + 86400000` if it is not already above the maximum. Log loudly when it does so, naming both values — silent correction is how the convention got lost in the first place.
- [ ] **Step 4: Prove it.** Generate a throwaway migration, confirm its `when` lands above the maximum, confirm `journal-monotonic` passes, then delete the throwaway migration and its snapshot and confirm the tree is clean.
- [ ] **Step 5: Do not touch the five pinned legacy exemptions** (0041, 0053–0055, 0059). They are below-watermark by design and the guard exempts them by exact value.
- [ ] **Step 6: Commit** — `fix(db): generate migration timestamps above the journal watermark`

---

# Phase H — the wire-visible API defects

**H1 gates H2. Do not start Task 5 until Task 4 reports.**

### Task 4: Prove every SDK façade tolerates an unknown error code

**Files:**
- Read only: `packages/sdk-rn/src/errors.ts`, `packages/sdk-swift/Sources/Rovenue/Errors.swift`, `packages/sdk-kotlin/src/.../RovenueException.kt` and its mapper, `packages/sdk-flutter/.../errors.dart`
- Test: add a case per façade where one exists

**Why first:** Task 5 makes the API emit four codes it has never emitted. If any façade throws, crashes, or drops the error on an unrecognised code rather than falling back, shipping Task 5 turns a documentation fix into a client-side failure.

- [ ] **Step 1: For each of the four façades**, find the function that maps an API error code to the platform's error kind. Name it and quote its fallback branch.
- [ ] **Step 2: Determine what each does with a code not in its list.** RN's `normalizeKind` is known to map unknown → `Internal`; verify, and establish the equivalent for Swift, Kotlin and Flutter.
- [ ] **Step 3: Write a test per façade** asserting an unknown code falls back rather than throwing. Where a façade already has such a test, note it instead of duplicating.
- [ ] **Step 4: Report a verdict per façade: tolerant / not tolerant.** If ANY is not tolerant, STOP and report — Task 5 must wait, and making that façade tolerant becomes a prerequisite task.
- [ ] **Step 5: Commit** — `test(sdk): pin unknown-error-code tolerance across all façades`

---

### Task 5: Wire `cause` so the five codes actually reach clients

**Files:**
- Modify: `apps/api/src/middleware/api-key-auth.ts`, `apps/api/src/routes/dashboard/funnels.ts`, `apps/api/src/routes/public/funnel-payment.ts`
- Modify: `packages/shared/src/error-catalog.ts` (the five entries currently document them as unreachable)
- Test: `apps/api/tests/` and any colocated route tests

**The defect:** `BEARER_REQUIRED`, `INVALID_API_KEY`, `INVALID_API_KEY_FORMAT` and `API_KEY_KIND_MISMATCH` are in the public enum but `api-key-auth.ts` throws bare `HTTPException`s with no `cause`, so all four collapse to generic `UNAUTHORIZED`/`FORBIDDEN`. Separately `STRIPE_NOT_CONNECTED` is produced properly in `billing-portal.ts` but embedded as a bare string in a `JSON.stringify` message — no `cause` — in two funnel routes.

- [ ] **Step 1: Write the failing tests.** For each of the four auth branches, assert the response body's `error.code` is the specific code, not the generic one. For the two funnel routes, assert `error.code === "STRIPE_NOT_CONNECTED"`. Run them; they must fail with the generic codes.
- [ ] **Step 2: Set `cause`** on each throw site. `middleware/error.ts` already honours a `cause` naming a known `ERROR_CODE`; do not change that mechanism.
- [ ] **Step 3: Run the tests; they must pass.**
- [ ] **Step 4: Correct the catalog in the same change.** The five `ERROR_CATALOG` entries currently describe them as unreachable — that documentation was true and is now false. The catalog and the wire must move together.
- [ ] **Step 5: Regenerate the docs page** (`apps/docs` `generate:errors` runs in its build) and confirm `check:links` still passes.
- [ ] **Step 6: Run the whole api route surface** — both test locations — to confirm nothing depended on the generic codes: `nice -n 19 npx vitest run --maxWorkers=2 apps/api/tests/routes apps/api/src/routes`
- [ ] **Step 7: Commit** — `fix(api): emit the specific auth and Stripe error codes`

---

# Phase I — the operational defects

### Task 6: Rewrite the key-rotation tool against Drizzle, covering all three tables

**Files:**
- Rewrite: `scripts/rotate-encryption-key.ts`
- Modify: `docs/runbooks/secret-rotation.md`
- Test: create beside the script

**The defect:** it does `import prisma, {...} from "@rovenue/db"` — a Prisma-era leftover — and lists `stripeCredentials`, dropped by migration 0087. Only one typecheck error surfaces (TS1192) because `prisma` becomes `any` and everything downstream passes silently.

**The larger finding — `ENCRYPTION_KEY` protects three tables with two wire shapes:**
- `projects.appleCredentials` / `googleCredentials` — the tagged `{v,enc}` wrapper, handled by `encryptCredential`/`decryptCredential`/`isEncryptedCredential` from `@rovenue/db`
- `copilot_credentials.apiKeyEncrypted` — a raw `encrypt()` string
- `integration_connections.credentialsCipher` — raw `encrypt(JSON.stringify(...))`

`isEncryptedCredential` does **not** apply to the latter two. `docs/runbooks/secret-rotation.md` describes only `projects`, so a rewrite following it literally leaves two tables unrotated — worse, in a key-compromise incident, than a tool that fails loudly.

- [ ] **Step 1: Confirm the three tables and both wire shapes yourself** by reading the schema and every caller of the crypto helpers. Report anything the spec missed — a fourth encrypted column would change this task.
- [ ] **Step 2: Write the failing tests** against a DISPOSABLE database (testcontainers — `packages/db` already has it as a devDependency), with synthetic `OLD_KEY`/`NEW_KEY` pairs and fixture rows in all three tables. Assert: every row re-encrypts, values decrypt to the original plaintext under the new key, and a second run is a no-op.
- [ ] **Step 3: Rewrite the script** using Drizzle. Two code paths, one per wire shape. Idempotent: a row already readable under the new key is skipped, not double-encrypted.
- [ ] **Step 4: Run the tests; they must pass.**
- [ ] **Step 5: Prove idempotency and partial-failure behaviour.** Run twice; assert the second run writes nothing. Then make one row undecryptable under either key and confirm the script reports it and does not silently skip or corrupt the rest.
- [ ] **Step 6: Fix the runbook.** `docs/runbooks/secret-rotation.md` must name all three tables and both wire shapes, and stop saying `projects` holds the only encrypted fields.
- [ ] **Step 7: Verify the script typechecks** — `pnpm --filter @rovenue/scripts typecheck` must be clean.
- [ ] **Step 8: NEVER run this against `rovenue-db-1`.** Confirm in your report that every execution was against a disposable database.
- [ ] **Step 9: Commit** — `fix(scripts): rewrite key rotation against Drizzle, covering all three encrypted tables`

---

### Task 7: Register the two partitioned parents past the existing range

**Files:**
- Create: `packages/db/drizzle/migrations/<next>_partman_register_revenue_credit.sql` (verify the next free number)
- Modify: `packages/db/src/fresh-install.ts` (its comment explains the old skip and must be updated)
- Test: `packages/db/tests/` against a disposable database

**The defect:** `revenue_events` and `credit_ledger` have 60 static partitions (2024-01 → 2028-12) and are absent from `partman.part_config`, because fresh installs skip 0019 — **deliberately**: partman v5 names children `_pYYYYMMDD` while migrations 0015/0016 named them `_YYYY_MM`, so `create_parent` attempts an overlapping `ATTACH PARTITION` and Postgres aborts. The skip was reasoned. Its consequence was not recorded: **any insert dated 2029-01-01 or later has no partition.**

- [ ] **Step 1: Reproduce the failure mode on a disposable database.** Restore or build a database in the fresh-install shape, then attempt `partman.create_parent` with `p_start_partition => '2024-01-01'` exactly as 0019 does, and capture the real overlap error. This is what makes the chosen fix defensible rather than assumed.
- [ ] **Step 2: Write the failing test.** Assert that an insert dated 2029-01-01 fails today (no partition), and that after the migration both tables appear in `partman.part_config`.
- [ ] **Step 3: Write the migration.** Call `partman.create_parent` for both parents with `p_start_partition` set **past the last existing partition** (2029-01-01), then `UPDATE partman.part_config` to match what 0019 intended: `retention = '7 years'`, `retention_keep_table = false`, `retention_keep_index = false`, `infinite_time_partitions = true`. Make it idempotent — guard on `part_config` membership so a re-run is a no-op.
- [ ] **Step 4: Do NOT register `outgoing_webhooks`.** Its exclusion is deliberate and documented; a hand-rolled worker owns its composite retention.
- [ ] **Step 4b: Reconcile with the retention machinery that landed in parallel.** Migrations 0128/0129 added `project_retention_overrides` and the DSAR tables, and a retention-automation feature shipped alongside them. Before setting `retention = '7 years'` on these two parents, check whether that feature now owns retention for `revenue_events`/`credit_ledger` — if it does, partman's own retention must NOT be enabled or the two will fight, and this task registers for **premake only**. Read the retention worker and say which owns what.
- [ ] **Step 5: Run the tests against the disposable database; they must pass.** Confirm the naming split (`_YYYY_MM` historically, `_pYYYYMMDD` onward) does not break maintenance — partman works from catalog bounds, not names. Run the maintenance function and assert it creates a 2029 partition.
- [ ] **Step 6: Update `fresh-install.ts`'s comment.** It currently tells operators to run `create_parent` manually. That is no longer the guidance; the comment must say what now happens and why the start partition differs.
- [ ] **Step 7: Verify the journal `when`** is above the watermark (Task 3's generation fix should handle this; confirm rather than assume) and commit the journal and snapshot alongside the SQL.
- [ ] **Step 8: NEVER run this against `rovenue-db-1`.**
- [ ] **Step 9: Commit** — `fix(db): register revenue_events and credit_ledger with pg_partman`

---

# Phase J — the documentation defects

### Task 8: Document the three missing RN method groups

**Files:**
- Modify: `apps/docs/content/docs/reference/methods.mdx`

**The defect:** the reference has no section for Paywalls, Remote Config or Attributes, all exported by `packages/sdk-rn`. This is absent coverage, not false coverage.

- [ ] **Step 1: Enumerate the real exports** from `packages/sdk-rn/src/index.ts` for the three groups. Do not work from the ROADMAP's list — derive it from source.
- [ ] **Step 2: Write each section** matching the file's existing per-method style. Every symbol, parameter and error kind must exist — the 24 canonical `ErrorKind` values are the authority.
- [ ] **Step 3: Do not invent behaviour.** Read each implementation. Where a method has an ordering requirement, a cache-vs-network distinction, or a side effect (e.g. exposure tracking), say so.
- [ ] **Step 4: Verify** `pnpm --filter @rovenue/docs build` and `check:links` pass.
- [ ] **Step 5: Commit** — `docs(reference): document the RN paywall, remote-config and attribute methods`

---

### Task 9: Make docs search work in the static image

**Files:**
- Modify: `apps/docs/app/root.tsx` (or wherever `RootProvider` is configured), `apps/docs/package.json`, `apps/docs/react-router.config.ts`, possibly `apps/docs/app/routes.ts` and `routes/search.ts`
- Possibly modify: `deploy/caddy/Caddyfile.docs`

**The defect:** the production image is `caddy:2-alpine` serving static files, so `routes/search.ts`'s server loader is unreachable. `RootProvider` defaults `search.enabled` to true and is hard-wired to `/api/search`, so a reader sees a search box that opens and finds nothing.

The installed `fumadocs-core@16.10.2` already supports server-less search: `createFromSource(...).staticGET()` exports the index at build time; `oramaStaticClient({ from })` consumes it client-side.

- [ ] **Step 1: Emit the index at build time.** Call `staticGET()` and write its body to a static path that ships in the image. Wire it into the docs `build` script the way `generate:errors` and `generate:openapi` already are, so it cannot go stale.
- [ ] **Step 2: Point the provider at it** via `RootProvider`'s `search` option using `oramaStaticClient({ from })`.
- [ ] **Step 3: Decide the fate of the server route.** Either keep it for `pnpm dev` or remove it — state which and why. Do not leave a route that 404s in production while the UI depends on it.
- [ ] **Step 4: MEASURE THE INDEX SIZE and report it.** This is the one real unknown. If it is large enough to hurt first load, say so with numbers rather than shipping it silently — a slow search is a different defect, not a fix.
- [ ] **Step 5: Verify against the BUILT output**, not the dev server: run `pnpm --filter @rovenue/docs build`, confirm the index file is present under `build/client/`, and confirm the page loads and searches without a Node process. Serving `build/client` with any static server is a fair test.
- [ ] **Step 6: Check the Caddyfile** needs no content-type or cache rule for the new asset.
- [ ] **Step 7: Commit** — `fix(docs): serve search from a static index`

---

# Phase K — the recorded defect that is not the real defect

### Task 10: Rewrite the RN-example ROADMAP entry and make resolution deterministic

**Files:**
- Modify: `ROADMAP.md`, `packages/sdk-rn/package.json`

**The finding:** the ROADMAP blames `examples/sample-rn-expo`'s pins. But root's React Native 0.86.0 is `sdk-rn`'s own unbounded peer floor (`>=0.76`) auto-resolved by pnpm to the newest publish. And that floor has never been built against: `packages/sdk-rn`'s tests stub `react-native` and `expo-modules-core` out entirely, the `rn` CI job never links a real RN, `example-rn` is deliberately typecheck-only, and `core/native.ts` still carries a live code path for Expo SDK 51 — below the declared floor.

So the real defect is: **the SDK declares a peer floor nothing has ever built against.** Upgrading the example would be the first build to test that claim — a migration project with unknown native and codegen fallout, not a fix. This task does not attempt it.

- [ ] **Step 1: Verify the claim yourself** before writing it into the record. Confirm the test stubs exist, confirm the `rn` job does not link a real RN, and confirm `core/native.ts`'s sub-floor code path. Quote each.
- [ ] **Step 2: Rewrite the ROADMAP entry** to name the actual defect: an unverified peer floor, with the example's pins as a symptom. State what verifying it would require, so whoever picks it up knows it is a project.
- [ ] **Step 3: Make resolution deterministic where it is bounded.** An unbounded `>=0.76` re-resolves on every install. Decide whether to add a ceiling, a `devDependency` pin for what CI actually tests against, or a documented `resolutions` entry — and say why. Do NOT narrow the peer range in a way that locks out legitimate consumer versions; a peer range is a compatibility claim, and shrinking it is itself a claim needing evidence.
- [ ] **Step 4: If you conclude nothing bounded can be done here**, say so and leave the peer range alone. An honest "this needs the migration project" beats a change that looks like progress.
- [ ] **Step 5: Verify** `pnpm install --frozen-lockfile` still succeeds and the lockfile diff contains only what your change requires.
- [ ] **Step 6: Commit** — `docs(roadmap): record the real RN peer-floor defect`

---

## Operator steps (not part of implementation)

- After Task 7 ships, existing self-hosted installs that skipped 0019 need the new migration applied — `pnpm db:migrate` handles it, but the naming split is worth knowing before someone inspects partitions by hand.
- Task 5 changes what the API returns for four auth failures and two funnel routes. Clients switching on `UNAUTHORIZED`/`FORBIDDEN` for those specific cases will see the specific codes instead. This is the intended behaviour and is documented in the error catalog.
