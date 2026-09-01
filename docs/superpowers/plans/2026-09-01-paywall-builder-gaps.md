# Paywall Builder Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `trialLabelKey` settable as a conditional override, make the override editor's coverage of the schema a compile-time guarantee, and stop the Apple/Google price cache serving prices fetched with a credential that has since changed.

**Architecture:** Both gaps are a hand-maintained link where a structural guarantee belongs. Task 1 replaces "remember to add the combo" with a type error. Task 2 replaces "remember to purge" with a cache key that moves when the credential moves — the pattern the Stripe resolver already proves.

**Tech Stack:** TypeScript (strict), React (Vite) dashboard, Redis, Drizzle/Postgres.

**Spec:** `docs/superpowers/specs/2026-09-01-paywall-builder-gaps-design.md` — read it in full before Task 1. §4.1, §4.2 and the non-goals are requirements, not commentary.

## Global Constraints

- **Never create or switch branches or worktrees.** Commit on whatever HEAD is checked out.
- **Never stage** `apps/dashboard/src/components/assets/asset-library.tsx` or `packages/db/seed.ts`.
- **Throttle:** `nice -n 19` on every heavy command; vitest `--maxWorkers=2`; suites strictly sequential.
- **`docker ps` first for anything DB- or Redis-backed** — and check the services you need are up, not just the daemon. `docker compose up -d redis minio clickhouse redpanda` if not.
- **`apps/api`'s `pnpm test` is two passes**: `vitest run` excludes testcontainer suites; `VITEST_CONTAINER_PASS=1 vitest run` runs them. Any number you report must say which pass it covers.
- TypeScript strict; no magic values; no self-confirming tests.
- **No change to the paywall model's emitted JSON, `render-fixtures.json`, or any renderer.** Task 1 is a type-level change with no runtime effect.
- Conventional commits. One task = one commit unless the task says otherwise.

### Confirmed facts (verified 2026-09-01 — do not re-derive; re-confirm only if something fails)

- `OVERRIDABLE_PROP_KEYS` is at `packages/shared/src/paywall/schema.ts:449`, typed `Record<PaywallNode["type"], readonly string[]>`. `purchaseButton`'s entry (`:455`) already lists `trialLabelKey`.
- The override editor is `apps/dashboard/src/components/paywall-builder/inspector/overrides.tsx`. Its `OverridablePropCombo` union is hand-written (from `:62`), it imports `OVERRIDABLE_PROP_KEYS` (`:12`) only for other purposes, and its `const exhaustive: never = combo` (`:362`) proves the switch covers the union — not that the union covers the schema. `grep -c trialLabelKey overrides.tsx` → 0.
- The base `trialLabelKey` editor already exists in the Binding tab (`inspector/binding-tab.tsx`, tested at `binding-tab.test.tsx:372`).
- Override editor test convention: `inspector/overrides.test.tsx` — RTL + `QueryClientProvider` + `ServiceProvider` (impair), msw, real i18n config, driving `OverridesSection` through `PaywallBuilderViewModel`.
- Price cache: `apps/api/src/services/offering-price-resolver.ts`; key `paywall:resolved:{store}:{projectId}:{offeringId}` (`:65-67`); TTL `RESOLVED_PRICE_CACHE_TTL_SECONDS = 900` (`:43`); purge uses Redis SCAN (`CACHE_PURGE_SCAN_COUNT = 200`).
- Every non-test caller of `purgeResolvedPriceCache` / `purgeProjectCatalogCache`: `products.ts`, `offerings.ts`, `placements.ts`, `experiments.ts`, `paywalls.ts`. **Not** `credentials.ts`.
- Credentials are encrypted JSONB columns on `projects` (`appleCredentials`, `googleCredentials`), written by `writeProjectCredential` (`packages/db/src/drizzle/repositories/projects.ts:339-343`), nulled by its sibling on disconnect. `writeProjectCredential` sets **only** the credential column, and there is no `$onUpdate` in the schema — so `projects.updatedAt` does not move on a credential write.
- Stripe's resolver is already immune: `services/stripe/price-resolver.ts:34` keys on `(accountId, priceId)`. **Do not touch it.**
- Existing test surface to extend: `services/offering-price-resolver.test.ts`, `routes/dashboard/offerings.resolved.test.ts`, `routes/dashboard/products.cache-purge.test.ts`.

---

## Task 1: Make the override union a compile-time consequence of the schema, then close the gap it exposes

**Files:**
- Modify: `packages/shared/src/paywall/schema.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/overrides.tsx`
- Test: `apps/dashboard/src/components/paywall-builder/inspector/overrides.test.tsx`

- [ ] **Step 1: Type the schema's arrays as literal tuples.** `OVERRIDABLE_PROP_KEYS`'s values are `readonly string[]`, which is exactly why nothing keeps the editor in sync. Make each entry a literal tuple so a node type's prop names become a literal union. This is type-level only — **the emitted JSON must not change**, and `render-fixtures.json` and every renderer must be untouched. Confirm that in your report.
- [ ] **Step 2: Bind the editor's union to the schema.** Derive `OverridablePropCombo` from `OVERRIDABLE_PROP_KEYS`, or keep the hand-written union and add a compile-time check that it equals the derived set. Either is acceptable; the requirement is that **a prop present in the schema and absent from the editor fails the build, naming the combo**. Keep the existing `never` check — it covers the opposite direction, and neither implies the other.
- [ ] **Step 3: Capture the failure.** `nice -n 19 npx tsc --noEmit -p apps/dashboard/tsconfig.json` must now fail on `purchaseButton.trialLabelKey`. **Paste the real error into your report.** A mechanism that is green on its first run has not been shown to work — this failure is the entire justification for Steps 1-2.
- [ ] **Step 4: Report every combo the check surfaced.** If it names combos beyond `purchaseButton.trialLabelKey`, each is a real gap of the same kind. **List them all before fixing any**, and say for each whether you are adding it now or flagging it — do not silently add a pile of fields. The count is information about how long the drift has been running.
- [ ] **Step 5: Add the `trialLabelKey` override field.** Follow what the Binding tab already does for the base value so the two editors agree on validation, placeholder and empty-state behaviour — a user should not meet two different rules for the same prop.
- [ ] **Step 6: Test.** Follow `overrides.test.tsx`'s existing convention. Assert that setting a `trialLabelKey` override writes it into the node's `overrides[].props`, and that it round-trips. Then run `nice -n 19 npx vitest run src/components/paywall-builder --maxWorkers=2` from `apps/dashboard`, plus the shared paywall suite, since you changed the schema's types.
- [ ] **Step 7: Commit** `feat(paywall-builder): derive the override editor's props from the schema`.

---

## Task 2: Key the Apple/Google price cache on the credential

**Files:**
- Modify: `apps/api/src/services/offering-price-resolver.ts`
- Test: `apps/api/src/services/offering-price-resolver.test.ts` (+ the route-level cache precedent if it fits)

- [ ] **Step 1: Read `services/stripe/price-resolver.ts` first.** It already solves this problem by keying on `accountId`. You are applying the same idea to a credential that lives as an encrypted JSONB column rather than an account id.
- [ ] **Step 2: Derive a short digest of the stored encrypted credential blob** and include it in the cache key. It must change exactly when the credential changes and never otherwise. **Do not put credential material in the key** — a Redis key is not a secret store and is visible to anyone with Redis access. A one-way digest of the already-encrypted blob is not material; say so in a comment so the next reader does not have to work it out.
- [ ] **Step 3: Handle disconnect as the natural consequence, not a special case.** The column is nulled, so there is no digest, so there is no key and nothing cached to serve. Make sure the code path expresses that rather than falling back to a previous key.
- [ ] **Step 4: Leave `purgeResolvedPriceCache` and its five existing callers alone.** Keying removes the credential-staleness obligation; the purge is still the right tool for the mutations that already call it — a product's identifiers changing does not change the credential. **Do not add a purge call to `credentials.ts`**: that would restore exactly the forget-me mechanism this task removes.
- [ ] **Step 5: The test that matters.** Resolve prices, then change the credential, then resolve again, and assert the second call does **not** return the first call's values. Assert on the returned prices, not on whether a Redis key exists — a key-shape assertion would pass even if the resolver ignored it. Cover the disconnect case too.
- [ ] **Step 6: Commit** `fix(paywall): key resolved-price cache on the credential that produced it`.

---

## Task 3: ROADMAP §3 and the battery

**Files:** `ROADMAP.md`

- [ ] **Step 1: Tick only the two items this plan closed** — `trialLabelKey` override UI and commerce-binding cache invalidation. Correct the cache item's framing while you are there: "no invalidation" was already stale (five routes purge); what was missing was the credential case specifically.
- [ ] **Step 2: Record the recon finding for the node-type item** without ticking it: `carousel`, `timeline` and `video` already exist in the schema, all three renderers and `render-fixtures.json`; only a footer link group appears genuinely absent. Whoever scopes that sub-project should not start from the assumption that four node types are missing.
- [ ] **Step 3: Leave the other five §3 items open.** Tick nothing that did not ship.
- [ ] **Step 4: Battery**, sequential and throttled, reporting real numbers and **naming which api pass each covers**: `nice -n 19 pnpm build --concurrency=2`; `@rovenue/shared`; the dashboard suite; `cd apps/api && nice -n 19 npx vitest run --maxWorkers=2`; then `VITEST_CONTAINER_PASS=1` for the container pass. Known-good baselines: api non-container 405 files / 3482 tests, container 10 files / 62 tests, dashboard 126 files / 1111 tests, shared 44 files / 832 tests, build 9/9. `pnpm --filter @rovenue/docs check:links` already exits 1 on a pre-existing broken link — report it, do not fix it here.
- [ ] **Step 5: Commit** `docs: paywall roadmap §3 update` with the battery numbers in the body.

---

## Self-review notes (for executors)

- **Ordering is 1 → 2 → 3.** They are independent in code; the order is only so the battery runs last.
- Task 1's value dies if the compile-time link is weakened into a runtime assertion or a test that lists the combos by hand. It must fail the **build**.
- **Do not add a purge call to `credentials.ts`** (Task 2, step 4). It would fix the symptom and keep the mechanism — the spec rejects it explicitly.
- Neither task may change `render-fixtures.json`, any renderer, or the paywall model's emitted JSON.
