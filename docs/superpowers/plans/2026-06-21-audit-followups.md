# Audit Remediation — Follow-Up Tickets Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the non-blocking follow-up items deferred during the 2026-06-20 audit remediation — three dependency-suppression removals (each retires a `pnpm.auditConfig.ignoreGhsas` entry) and five test/doc-hygiene fixes.

**Architecture:** Two independent workstreams. FW1 = dependency major upgrades that each let us DELETE an audit suppression and re-verify the CI gate stays green. FW2 = test/doc hygiene with no runtime impact. Every FW1 task is "upgrade → run the affected package's tests → remove the suppression → confirm `pnpm audit --prod --audit-level=high` exits 0".

**Tech Stack:** pnpm monorepo (Turborepo), Vitest, Astro (apps/landing), drizzle-kit, nodemailer, prom-client. CI: `.github/workflows/ci.yml`.

## Global Constraints

- **Stay on the current branch (`main`); the repo owner manages branching.** Implementers must NOT create/switch branches or worktrees, and must NOT touch `git stash` entries (the owner has parallel work stashed). If a conflict or foreign dirty file appears, STOP and report BLOCKED.
- The audit CI gate is `pnpm audit --prod --audit-level=high` and MUST exit 0 after each FW1 task. Suppressions live in the root `package.json` `pnpm.auditConfig.ignoreGhsas` array; the per-GHSA rationale lives in `.superpowers/sdd/briefs/W5.1-report.md`.
- Never broaden the gate or make the audit step non-blocking to "pass" — fix or keep the documented suppression.
- TypeScript strict; Vitest; conventional commits. Dev infra when needed: `docker compose up -d postgres redis clickhouse` (containers `rovenue-*` already exist). Use `timeout` on any command that can hang (CH/kafka).
- These are LOW/INFO-severity items — prefer the lowest-risk change that resolves each; if a major upgrade proves genuinely breaking, REPORT and keep the (documented) suppression rather than forcing a risky migration.

---

# Workstream FW1 — Dependency Upgrades (retire suppressions)

**Files:** various `package.json` + lockfile; root `package.json` `pnpm.auditConfig.ignoreGhsas`; `.superpowers/sdd/briefs/W5.1-report.md` (rationale doc).

### Task FW1.1: Upgrade vitest 1.x → 3.x+ (retire GHSA-5xrq suppression)

**Context:** `vitest@1.x` is suppressed (CRITICAL GHSA-5xrq-8626-4rwp — the UI server). It's dev/test-only (`vitest run`, never `--ui`, never shipped). VERIFIED 2026-06-21: still `^1.3.0` (installed 1.6.1) in 6 packages; suppression present. The fix needs a major bump — latest is **4.1.9**, so target the lowest fixed major that's a manageable migration (vitest 3.x fixes the advisory with less churn than 4.x; pick 3.x unless 4.x is trivial). Bump across ALL six packages: sdk-rn, email-templates, shared, db, dashboard, api.

- [ ] **Step 1: Inventory** — `grep -rn '"vitest"' --include=package.json . | grep -v node_modules` to list every package on vitest 1.x (and any `@vitest/*`, `vite` peer). Note the versions.
- [ ] **Step 2: Bump** vitest (+ `@vitest/ui` if present, + `vite` to the version vitest 3 requires) to latest 3.x in every owning package.json. `pnpm install`.
- [ ] **Step 3: Run the FULL test suite** to catch vitest-3 breaking changes (config format, API renames, default pool changes): `docker compose up -d postgres redis clickhouse` then `pnpm test` (or per-package `pnpm --filter <pkg> exec vitest run`). Fix any vitest-3 migration breakage (e.g., `environment`/`pool` config, `vi.mock` hoisting, `deps.inline` → `server.deps.inline`). Document each fix.
- [ ] **Step 4: Confirm baseline reds unchanged** — the known pre-existing failures (3 subscriptions VIEWER-403, 1 copilot-intents 500, dashboard-credentials integrations-WIP) should still be the ONLY failures; no NEW failures from the upgrade.
- [ ] **Step 5: Remove the suppression** — delete the `GHSA-5xrq-8626-4rwp` entry from root `package.json` `pnpm.auditConfig.ignoreGhsas`; remove its rationale line from the W5.1 report.
- [ ] **Step 6: Verify gate green** — `pnpm audit --prod --audit-level=high` exits 0 (vitest CVE now resolved, not ignored).
- [ ] **Step 7: Commit** — `git commit -m "chore(test): upgrade vitest to 3.x; retire GHSA-5xrq suppression"`
- [ ] If vitest 3 migration is genuinely too disruptive (large test rewrites), STOP, report the breakage, and leave the suppression in place with an updated note. Do not ship a half-migrated, red suite.

### Task FW1.2: Upgrade Astro 5 → 6 in apps/landing (retire GHSA-8hv8 + GHSA-2pvr)

**Context:** `astro@5.x` is suppressed for two vulns (GHSA-8hv8-536x-4wqp reflected XSS in dev-server error overlay; GHSA-2pvr-wf23-7pc7 prerender Host-header SSRF). `apps/landing` is `output: 'static'` so the served build is unaffected, but both are patched only in astro ≥6.

- [ ] **Step 1: Read** `apps/landing/package.json` + `apps/landing/astro.config.*` for current astro version, integrations, and `output` mode. List astro integrations that also need a 6-compatible bump.
- [ ] **Step 2: Bump** `astro` to latest 6.x (+ each `@astrojs/*` integration to its astro-6-compatible version) in `apps/landing/package.json`. `pnpm install`.
- [ ] **Step 3: Build** — `pnpm --filter <landing-pkg> build` (find the filter name in its package.json). Fix any astro-6 breaking changes (config schema, integration API, content-collections changes). Confirm `output: 'static'` still produces the static site.
- [ ] **Step 4: Smoke** — `pnpm --filter <landing-pkg> preview` (or inspect `dist/`) to confirm the landing pages render.
- [ ] **Step 5: Remove suppression** — delete `GHSA-8hv8-536x-4wqp` and `GHSA-2pvr-wf23-7pc7` from `ignoreGhsas`; remove their rationale lines from the W5.1 report.
- [ ] **Step 6: Verify** `pnpm audit --prod --audit-level=high` exits 0.
- [ ] **Step 7: Commit** — `git commit -m "chore(landing): upgrade astro to 6.x; retire astro XSS/SSRF suppressions"`
- [ ] If astro 6 migration breaks the landing build beyond quick fixes, STOP and report; keep the suppression (the static output is not exploitable).

### Task FW1.3: Re-evaluate drizzle-kit / @esbuild-kit (F13)

**Context:** F13 was deferred — `drizzle-kit@0.31.10` (the only stable release) directly depends on `@esbuild-kit/esm-loader` + `esbuild ^0.25.4`, pulling deprecated `@esbuild-kit/*` + `esbuild@0.18.20`. The whole 1.x line is pre-release. No CVE; dev-build-only. RE-VERIFIED 2026-06-21: drizzle-kit `dist-tags.latest` is STILL `0.31.10` — **no stable fix exists yet, so this task is currently a no-op re-check** (Step 2b). Run it only when a newer stable drizzle-kit ships.

- [ ] **Step 1: Check** `pnpm view drizzle-kit dist-tags` — has `latest` moved off 0.31.10 to a stable 1.x (or newer 0.3x that dropped @esbuild-kit)? Also `pnpm view drizzle-kit@<candidate> dependencies | grep -i esbuild`.
- [ ] **Step 2a (if a stable drizzle-kit that drops @esbuild-kit exists):** bump `drizzle-kit` in `packages/db/package.json`; `pnpm install`; **verify the migration CLI still works with the repo config** — `timeout 120 pnpm db:migrate:generate` against a scratch schema change (or a dry/help invocation) and `timeout 120 pnpm db:migrate` on a fresh local Postgres; confirm no config-format breakage. Then `pnpm dedupe`; confirm `pnpm why @esbuild-kit/core-utils` is empty and `grep -c "@esbuild-kit" pnpm-lock.yaml` is 0. Commit `chore(db): upgrade drizzle-kit; drop deprecated @esbuild-kit toolchain (F13)`.
- [ ] **Step 2b (if still no safe stable):** no action — update the F13 note in the W5.1 report / ledger with the date checked and the still-blocking reason. This task then closes as "re-checked, still deferred."

---

# Workstream FW2 — Test & Doc Hygiene (no runtime impact)

**Files:** `apps/api/src/middleware/webhook-verify.test.ts`, `apps/api/src/workers/webhook-reaper.integration.test.ts`, the funnel/billing rate-limit tests, 5 route files with stale comments, `apps/api/package.json` (@types/nodemailer).

### Task FW2.1: Real 429 assertions for the new rate limiters (W4-min1)

**Context:** The billing/SES (W4.1) and funnel (W4.3) rate-limit tests assert the limiter is *mounted*, not that it returns 429. `endpointRateLimit` is independently tested infra, but a real end-to-end 429 assertion is stronger.

- [ ] **Step 1: Find** the existing rate-limit test pattern: `grep -rn "429\|endpointRateLimit\|X-RateLimit" apps/api/src --include='*.test.ts'`. If a pattern exists that drives a limiter to 429 (e.g., a spy-backed counter or N+1 requests against a low `max`), reuse it.
- [ ] **Step 2: Add** one real-429 test for the funnel `POST /funnels/:slug/sessions` limiter (`max: 30`): issue `max+1` requests (same client IP / `clientIp` default) and assert the last returns 429 with `Retry-After`. If 31 real requests is impractical, construct a test app mounting `endpointRateLimit` with a tiny `max` (e.g. 2) and assert the 3rd call is 429 — proving the wiring rejects, not just mounts.
- [ ] **Step 3: Run** `pnpm --filter @rovenue/api exec vitest run <the funnel test file>` — PASS.
- [ ] **Step 4: Commit** — `git commit -m "test(api): assert real 429 on funnel rate limiter"`

### Task FW2.2: Unit test for the reaper counter increment (W3-min2)

**Context:** `webhookEventsReclaimedTotal` is incremented in `runWebhookReaper` when `reclaimed > 0` but is only exercised via the integration path; no test asserts the counter value.

- [ ] **Step 1: Add** a test (unit-style, mock the repo) in/next to `apps/api/src/workers/webhook-reaper.integration.test.ts` (or a new `webhook-reaper.test.ts`): stub `drizzle.webhookEventRepo.reclaimStaleWebhookEvents` to return `2`, call `runWebhookReaper()`, then read `webhookEventsReclaimedTotal.get()` (prom-client) and assert the sample value increased by 2. Use `registry.resetMetrics()` in `beforeEach` for isolation (mirror the replay-guard counter test from W3.2).
- [ ] **Step 2: Run** `pnpm --filter @rovenue/api exec vitest run <the reaper test file>` — PASS.
- [ ] **Step 3: Commit** — `git commit -m "test(api): assert webhook reaper increments reclaimed counter"`

### Task FW2.3: Remove dead top-level vi.mock + stale zValidator comments (W3-min1, W4-min2)

- [ ] **Step 1: Remove dead mock** — in `apps/api/src/middleware/webhook-verify.test.ts`, delete the top-level `vi.mock("../lib/env", ...)` that never operates (each test uses `vi.doMock` + `vi.resetModules()` + `await import()`; the top-level mock is dead). Run the file: `pnpm --filter @rovenue/api exec vitest run src/middleware/webhook-verify.test.ts` — still PASS (4 tests).
- [ ] **Step 2: Fix stale comments** — update the 5 code comments that still say "zValidator" where the code now calls `validate()`: `apps/api/src/routes/v1/subscribers.ts:75`, `apps/api/src/routes/v1/experiments.ts:27`, `apps/api/src/routes/dashboard/experiments.ts:238`, `apps/api/src/routes/dashboard/experiments.ts:551`, `apps/api/src/routes/dashboard/credentials.ts:36`. Change "zValidator" → "validate" (or rephrase) so the comment matches the code. (Re-grep to confirm: `grep -rn "zValidator" apps/api/src --include='*.ts'` should return only the import inside `lib/validate.ts`.)
- [ ] **Step 3: Typecheck** — `pnpm --filter @rovenue/api exec tsc --noEmit` clean (comment-only + test-only changes).
- [ ] **Step 4: Commit** — `git commit -m "chore(api): drop dead env mock; fix stale zValidator comments"`

### Task FW2.4: ~~Align @types/nodemailer with runtime v9~~ — NON-ISSUE (optional patch only)

**RE-VERIFIED 2026-06-21 — this is essentially a false alarm; SKIP unless you want the latest patch.** `@types/nodemailer` versioning does NOT track the nodemailer runtime major. Its `dist-tags.latest` is **8.0.1** (there is no "v9" types package). The repo has `@types/nodemailer@8.0.0` installed — i.e. it is already on the current major, which is the correct/compatible types for nodemailer 9 (mailer test 3/3 green, `tsc --noEmit` clean). There is NO real version mismatch.

- [ ] **Optional:** bump `^8.0.0` → `^8.0.1` in `apps/api/package.json` for the latest patch, `pnpm install`, confirm `tsc --noEmit` + `mailer-smtp.test.ts` still green, commit `chore(api): bump @types/nodemailer to 8.0.1`. Otherwise close this ticket as a verified non-issue — no action needed.

---

## Self-Review (coverage)

- vitest GHSA-5xrq → FW1.1 ✓  astro GHSA-8hv8/2pvr → FW1.2 ✓  F13 → FW1.3 ✓  429 tests (W4-min1) → FW2.1 ✓  reaper counter (W3-min2) → FW2.2 ✓  dead vi.mock (W3-min1) + stale comments (W4-min2) → FW2.3 ✓  @types/nodemailer → FW2.4 ✓
- Each FW1 task pairs its upgrade with suppression removal + `pnpm audit --prod --audit-level=high` re-verification, so the gate never regresses.
- All tasks are independent; recommended order FW2 (cheap, low-risk) then FW1 (upgrades), or any order. Each is independently reviewable.

## Notes carried from the remediation

- Do NOT touch the owner's stashes (`rovi-drift-pre-merge`, `GitHub_Desktop`) or commit `51866667` (M7 SDK work).
- The append-only `credit_ledger` trigger means any NEW delete path must use `withLedgerDeleteAuthorized` — unrelated to these tasks but keep in mind if a test seeds + deletes ledger rows.
