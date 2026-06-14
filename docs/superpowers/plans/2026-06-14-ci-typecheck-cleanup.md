# CI Typecheck Cleanup (Deployment Task 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the ~31 pre-existing `tsc` errors across `@rovenue/dashboard` (12), `@rovenue/db` (10), and `@rovenue/api` (9) so `pnpm build` is green, then re-enable the CI workflow that was disabled because of them (deferred Deployment-plan Task 4).

**Architecture:** Three independent fix tasks, one per package, each verified by that package's `tsc --noEmit` going clean; then a fourth task that confirms the full `pnpm build` passes and renames `.github/workflows/ci.yml.disabled` → `ci.yml`. Nearly all errors are in **test files** (mock-typing and fixture-shape mismatches under vitest 1.6.1 + `noUnusedLocals`); the only production-source touches are two safe dashboard changes (one type-union member, one removed `as Record<string,unknown>` cast, one router `search` prop) and removing one unused import in an api file. No runtime behavior changes.

**Tech Stack:** TypeScript 5.x strict (`noUnusedLocals`, `noUnusedParameters`), Vitest **1.6.1** (`vi.fn<TArgs extends any[], TReturn>()` — args-tuple generic form), TanStack Router (typed `<Link>` requiring `search`), Drizzle, React 18, GitHub Actions.

**Key constraints discovered during analysis:**
- **Vitest 1.6.1** types `vi.fn` as `vi.fn<TArgs extends any[], TReturn = void>()` — the **first generic is an args tuple, not a function type**. The db test passed a function type (`vi.fn<(set: …) => void>()`), which violates the `any[]` constraint (TS2344) and cascades into TS7053/TS2345 at every `.mock.calls[0][0]` site. One declaration fix clears all 10.
- `apps/api/src/services/copilot/quota.ts` is pulled into **`@rovenue/dashboard`'s** tsc program (cross-package type import), so its unused-import error surfaces under the dashboard build, not the api build. Its fix lives in Task 1.
- Two dashboard fixes are flagged for a re-run check: adding `"unavailable"` to `AppStatus`, and removing the prop-erasing cast in `integration-drawer.tsx` (which could surface a *new* genuine missing-prop error on `StepActivate`). Each task's final `tsc` run is the gate.

---

## File Structure

| File | Package | Change |
|------|---------|--------|
| `apps/api/src/services/copilot/quota.ts` | (api, blocks dashboard build) | Remove unused `Project` import |
| `apps/dashboard/src/components/apps/types.ts` | dashboard | Add `"unavailable"` to `AppStatus` union |
| `apps/dashboard/src/components/apps/app-card.test.tsx` | dashboard | Drop unused `screen` import |
| `apps/dashboard/src/components/apps/apps-section.test.tsx` | dashboard | Drop unused `screen` import |
| `apps/dashboard/src/components/apps/integration-drawer/integration-drawer.flow.test.tsx` | dashboard | Drop unused `within` import |
| `apps/dashboard/src/components/apps/integration-drawer/integration-drawer.tsx` | dashboard | Remove `as Record<string,unknown>` cast on 5 spread sites |
| `apps/dashboard/src/routes/unsubscribe.tsx` | dashboard | Add `search={{ error: undefined }}` to `<Link to="/login">` |
| `packages/db/src/drizzle/repositories/subscribers.test.ts` | db | Fix `vi.fn` generic form (args-tuple) on 2 mock decls |
| `apps/api/src/services/apple/apple-server-api.test.ts` | api | Block-body `afterEach`; augment `ctx` fixture |
| `apps/api/src/services/apple/apple-webhook.app-account-token.test.ts` | api | Fix import source; remove 2 duplicate object keys |
| `apps/api/src/workers/refund-shield-responder.test.ts` | api | Type the spread args tuple |
| `.github/workflows/ci.yml` | repo | Re-enable (rename from `.disabled`) |

---

# Task 1: Clear `@rovenue/dashboard` tsc errors (12)

**Files (all under repo root):**
- Modify: `apps/api/src/services/copilot/quota.ts`
- Modify: `apps/dashboard/src/components/apps/types.ts`
- Modify: `apps/dashboard/src/components/apps/app-card.test.tsx`
- Modify: `apps/dashboard/src/components/apps/apps-section.test.tsx`
- Modify: `apps/dashboard/src/components/apps/integration-drawer/integration-drawer.flow.test.tsx`
- Modify: `apps/dashboard/src/components/apps/integration-drawer/integration-drawer.tsx`
- Modify: `apps/dashboard/src/routes/unsubscribe.tsx`

- [ ] **Step 1: Confirm the baseline failure (12 errors)**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `12`

- [ ] **Step 2: Remove the unused `Project` import (TS6133)**

In `apps/api/src/services/copilot/quota.ts`, delete the unused import on line 3. First read the file's top imports to confirm `Project` is the only unused symbol (keep `TIER_LIMITS`, `RoviTier`, and any others still referenced). The line to delete:

```typescript
import type { Project } from "@rovenue/db";
```

If `Project` shares an import line with still-used symbols, remove only the `Project` token, not the whole line.

- [ ] **Step 3: Add `"unavailable"` to the `AppStatus` union (TS2367 ×2)**

In `apps/dashboard/src/components/apps/types.ts` (around line 16):

```typescript
// BEFORE
export type AppStatus = "connected" | "available" | "error";
// AFTER
export type AppStatus = "connected" | "available" | "error" | "unavailable";
```

Rationale: `app-card.tsx:21,26` compares `status` against `"unavailable"` to gate click behavior, and the test fixtures produce `status: "unavailable"`. Adding the member is correct (the comparison is live, not dead).

Verify the value is genuinely reachable (not dead code) before trusting this:
Run: `grep -rn '"unavailable"' apps/dashboard/src | grep -v '\.test\.'`
Expected: at least the two `app-card.tsx` comparison sites (and possibly an assignment). If the ONLY non-test occurrences are the two comparisons and nothing ever assigns `"unavailable"`, stop and report DONE_WITH_CONCERNS — the comparisons may be dead code that should be removed instead.

- [ ] **Step 4: Drop unused testing-library imports (TS6133 ×3)**

`apps/dashboard/src/components/apps/app-card.test.tsx:2`:
```typescript
// BEFORE
import { screen, waitFor } from "@testing-library/react";
// AFTER
import { waitFor } from "@testing-library/react";
```

`apps/dashboard/src/components/apps/apps-section.test.tsx:3`:
```typescript
// BEFORE
import { screen, waitFor } from "@testing-library/react";
// AFTER
import { waitFor } from "@testing-library/react";
```

`apps/dashboard/src/components/apps/integration-drawer/integration-drawer.flow.test.tsx:3`:
```typescript
// BEFORE
import { screen, waitFor, within } from "@testing-library/react";
// AFTER
import { screen, waitFor } from "@testing-library/react";
```

(If any of these import lists differ slightly from the above, read the line first and remove only the named unused token — `screen`/`screen`/`within` respectively — preserving the rest.)

- [ ] **Step 5: Remove the prop-erasing cast in `integration-drawer.tsx` (TS2740 ×5)**

In `apps/dashboard/src/components/apps/integration-drawer/integration-drawer.tsx`, lines 218/221/224/227/230, drop the `as Record<string, unknown>` cast so the fully-typed `sharedStepProps` flows to each Step component:

```tsx
// BEFORE (one per line, same shape)
<StepCredentials {...(sharedStepProps as Record<string, unknown>)} />
<StepEvents      {...(sharedStepProps as Record<string, unknown>)} />
<StepMapping     {...(sharedStepProps as Record<string, unknown>)} />
<StepTest        {...(sharedStepProps as Record<string, unknown>)} />
<StepActivate    {...(sharedStepProps as Record<string, unknown>)} />
// AFTER
<StepCredentials {...sharedStepProps} />
<StepEvents      {...sharedStepProps} />
<StepMapping     {...sharedStepProps} />
<StepTest        {...sharedStepProps} />
<StepActivate    {...sharedStepProps} />
```

`sharedStepProps` (defined ~line 119-128 in the same file) already carries `state, onChange, onNext, onBack, onClose, existingConnection, providerId, projectId`. **After this edit, the Step 8 `tsc` run is the gate:** if `StepActivate` (which required "4 more" vs the others' "3 more") surfaces a NEW missing-prop error, that is a genuine wiring gap — stop and report DONE_WITH_CONCERNS with the missing prop name rather than papering over it.

- [ ] **Step 6: Add the required `search` prop to the login `<Link>` (TS2741)**

In `apps/dashboard/src/routes/unsubscribe.tsx` (~line 111), TanStack Router's `/login` route requires a `search` param. Match the pattern used elsewhere (`index.tsx`, `2fa.tsx` pass `search={{ error: undefined }}`):

```tsx
// BEFORE
<Link
  to="/login"
  className="rounded-md bg-rv-accent-500 px-3 py-1.5 text-[12px] font-medium text-white"
>
// AFTER
<Link
  to="/login"
  search={{ error: undefined }}
  className="rounded-md bg-rv-accent-500 px-3 py-1.5 text-[12px] font-medium text-white"
>
```

(Before editing, confirm the exact required search shape: `grep -rn 'to="/login"' apps/dashboard/src | grep search` and copy whatever shape the other call sites use.)

- [ ] **Step 7: Run the dashboard build to confirm the bundle still builds**

Run: `pnpm --filter @rovenue/dashboard exec vite build`
Expected: build succeeds (this proves the JSX/source edits in Steps 3,5,6 don't break the actual bundle).

- [ ] **Step 8: Verify tsc is clean (the gate)**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `0`. If any error remains (e.g. a new `StepActivate` prop error from Step 5), STOP and report it — do not commit a partial.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/copilot/quota.ts apps/dashboard/src/components/apps/types.ts apps/dashboard/src/components/apps/app-card.test.tsx apps/dashboard/src/components/apps/apps-section.test.tsx apps/dashboard/src/components/apps/integration-drawer/integration-drawer.flow.test.tsx apps/dashboard/src/components/apps/integration-drawer/integration-drawer.tsx apps/dashboard/src/routes/unsubscribe.tsx
git commit -m "fix(dashboard): clear 12 tsc errors (AppStatus union, drawer prop types, login Link search, unused imports)"
```

---

# Task 2: Clear `@rovenue/db` tsc errors (10)

**Root cause:** vitest 1.6.1's `vi.fn` generic is `<TArgs extends any[], TReturn>` (args tuple), but `subscribers.test.ts` passes a function type. One declaration fix clears all 10 errors (the 8 downstream TS7053/TS2345 at `.mock.calls[...]` sites resolve automatically).

**Files:**
- Modify: `packages/db/src/drizzle/repositories/subscribers.test.ts`

- [ ] **Step 1: Confirm the baseline failure (10 errors)**

Run: `pnpm --filter @rovenue/db exec tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `10`

- [ ] **Step 2: Fix the `vi.fn` generic to the args-tuple form**

In `packages/db/src/drizzle/repositories/subscribers.test.ts` (~lines 37-39):

```typescript
// BEFORE
  const setSpy = vi.fn<(set: Record<string, unknown>) => void>();
  const valuesSpy =
    vi.fn<(values: Record<string, unknown>) => void>();
// AFTER
  const setSpy = vi.fn<[Record<string, unknown>], void>();
  const valuesSpy =
    vi.fn<[Record<string, unknown>], void>();
```

Read the actual lines first — match the exact existing whitespace/wrapping when replacing, and apply the same `<[ArgsTuple], void>` transformation to BOTH spies even if their formatting differs from the snippet above.

- [ ] **Step 3: Verify tsc is clean (the gate)**

Run: `pnpm --filter @rovenue/db exec tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `0` (all 10 — the 2 declarations + 8 downstream sites — resolve from this single fix). If any TS7053/TS2345 remains at an assertion site, read that line and cast `.mock.calls[i]` to the tuple, but the single fix above should suffice.

- [ ] **Step 4: Confirm the test still runs green (behavior unchanged)**

Run: `pnpm --filter @rovenue/db exec vitest run src/drizzle/repositories/subscribers.test.ts 2>&1 | tail -5`
Expected: tests pass (this is a types-only change; runtime mock behavior is identical).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/subscribers.test.ts
git commit -m "fix(db): use vitest args-tuple vi.fn generic in subscribers.test (clears 10 tsc errors)"
```

---

# Task 3: Clear `@rovenue/api` tsc errors (9)

All 9 are in test files; **zero production-source changes**.

**Files:**
- Modify: `apps/api/src/services/apple/apple-server-api.test.ts`
- Modify: `apps/api/src/services/apple/apple-webhook.app-account-token.test.ts`
- Modify: `apps/api/src/workers/refund-shield-responder.test.ts`

- [ ] **Step 1: Confirm the baseline failure (9 errors)**

Run: `pnpm --filter @rovenue/api exec tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `9`

- [ ] **Step 2: `apple-server-api.test.ts` — block-body `afterEach` (TS2322)**

Line 18 — the concise arrow returns `VitestUtils`; give it a block body:

```typescript
// BEFORE
afterEach(() => vi.restoreAllMocks());
// AFTER
afterEach(() => { vi.restoreAllMocks(); });
```

- [ ] **Step 3: `apple-server-api.test.ts` — augment the `ctx` fixture (TS2345 ×4)**

`ProjectAppleContext` extends `AppleAuthConfig`, which also requires `keyId`, `issuerId`, `privateKey`. The shared `ctx` fixture (~lines 4-7) supplies only `bundleId`/`environment`; fix it once to clear all four call sites (35,53,68,80). `getAppleAuthToken` is already mocked in this file, so these dummy credentials are never used at runtime:

```typescript
// BEFORE
const ctx = {
  bundleId: "com.example.app",
  environment: "PRODUCTION" as const,
};
// AFTER
const ctx = {
  bundleId: "com.example.app",
  environment: "PRODUCTION" as const,
  keyId: "TESTKEY0001",
  issuerId: "00000000-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
};
```

Read the actual `ctx` declaration first (it may already have `as const`/`satisfies`); add the three missing fields without disturbing existing annotations. If `ProjectAppleContext` requires a *different* set of fields than `keyId/issuerId/privateKey`, copy the exact required field names from the type definition (`grep -rn 'ProjectAppleContext\|AppleAuthConfig' apps/api/src/services/apple`).

- [ ] **Step 4: `apple-webhook.app-account-token.test.ts` — fix the import source (TS2724)**

`AppleNotificationVerifier` is exported from `./apple-verify`, not `./apple-types`. Move it (lines ~76-82):

```typescript
// BEFORE
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_TYPE,
  type AppleJwsTransactionPayload,
  type AppleNotificationVerifier,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
// AFTER
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_TYPE,
  type AppleJwsTransactionPayload,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import type { AppleNotificationVerifier } from "./apple-verify";
```

(Confirm the export location first: `grep -rn 'AppleNotificationVerifier' apps/api/src/services/apple/apple-verify.ts`.)

- [ ] **Step 5: `apple-webhook.app-account-token.test.ts` — remove duplicate object keys (TS2783 ×2)**

In `makeFakeJwsTransactionPayload` (~lines 98-117), `originalTransactionId` (line 100) and `productId` (line 102) are set explicitly AND again via the trailing `...overrides` spread. Remove the two redundant explicit lines (the spread is the intended winner; values are provably identical):

```typescript
// Remove these two lines from the returned object literal:
    originalTransactionId: overrides.originalTransactionId,
    productId: overrides.productId,
```

Keep `transactionId: overrides.originalTransactionId` (first line) — `overrides` has no `transactionId` key, so the spread does not duplicate it.

- [ ] **Step 6: `refund-shield-responder.test.ts` — type the spread args (TS2556)**

Line ~75 — `args: unknown[]` is not a tuple, so the spread into `auditMock` fails. Type it from the mock's parameters:

```typescript
// BEFORE
  audit: (...args: unknown[]) => auditMock(...args),
// AFTER
  audit: (...args: Parameters<typeof auditMock>) => auditMock(...args),
```

- [ ] **Step 7: Verify tsc is clean (the gate)**

Run: `pnpm --filter @rovenue/api exec tsc --noEmit 2>&1 | grep -c 'error TS'`
Expected: `0`. If anything remains, read the line and address it before committing.

- [ ] **Step 8: Confirm the touched tests still run green**

Run:
```bash
pnpm --filter @rovenue/api exec vitest run \
  src/services/apple/apple-server-api.test.ts \
  src/services/apple/apple-webhook.app-account-token.test.ts \
  src/workers/refund-shield-responder.test.ts 2>&1 | tail -6
```
Expected: all pass (types-only fixtures changes; no runtime behavior change).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/apple/apple-server-api.test.ts apps/api/src/services/apple/apple-webhook.app-account-token.test.ts apps/api/src/workers/refund-shield-responder.test.ts
git commit -m "fix(api): clear 9 tsc errors in apple + refund-shield test files (fixtures, imports, mock typing)"
```

---

# Task 4: Verify `pnpm build` green + re-enable CI

**Files:**
- Create (rename): `.github/workflows/ci.yml`

- [ ] **Step 1: Confirm all three packages now typecheck clean**

Run:
```bash
for p in @rovenue/dashboard @rovenue/db @rovenue/api; do
  echo -n "$p: "; pnpm --filter $p exec tsc --noEmit 2>&1 | grep -c 'error TS'
done
```
Expected: each prints `0`.

- [ ] **Step 2: Confirm the full monorepo build passes**

Run: `pnpm build 2>&1 | tail -20`
Expected: turbo reports all package build tasks succeeding (exit 0). If a package OTHER than the three fixed here fails (e.g. `apps/docs`), STOP and report it — that is a newly-surfaced build gap outside this plan's scope; do not rename CI on a red build.

- [ ] **Step 3: Re-enable the CI workflow**

Run: `git mv .github/workflows/ci.yml.disabled .github/workflows/ci.yml`

- [ ] **Step 4: Validate the workflow YAML**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('CI YAML VALID')"
```
Expected: `CI YAML VALID`. (If `pyyaml` is unavailable, instead confirm the file is non-empty and contains `jobs:` with `grep -c 'jobs:' .github/workflows/ci.yml`.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: re-enable build + test workflow (tsc errors cleared)"
```

---

## Risks / Out of Scope (read before executing)

- **`pnpm test` in CI vs. locally:** This plan makes `pnpm build` green and re-enables the workflow (which runs `pnpm build` + `pnpm test`). The DB-backed suites under `apps/api/tests/*` and the `*.integration.test.ts` suites need a database/testcontainers. They pass in GitHub Actions only if the runner provides Docker (testcontainers) and/or a `DATABASE_URL`. **Watch the first CI run after merge**; if those suites fail for environment reasons, that is a separate follow-up (add a Postgres service / testcontainers setup to the workflow), NOT a regression from this cleanup. Do not expand this plan to fix the CI test environment unless the build itself is red.
- **No production behavior changes:** the only non-test edits are `AppStatus` gaining a union member, the removed cast in `integration-drawer.tsx`, the added `search` prop on one `<Link>`, and a removed unused import — all type-level. If Task 1 Step 5 surfaces a real `StepActivate` wiring bug, treat it as a genuine finding (DONE_WITH_CONCERNS), not part of the mechanical cleanup.

## Self-Review Notes

- **Error coverage:** dashboard 12 (Task 1: 1 quota import + 3 unused test imports + 2 AppStatus comparisons via 1 union edit + 5 drawer casts + 1 Link) = 12 ✓; db 10 (Task 2: 1 generic fix clears 2 decls + 8 downstream) ✓; api 9 (Task 3: 1 afterEach + 4 fixture + 1 import + 2 dup-keys + 1 spread) ✓. Total 31.
- **Each task is independently shippable** and self-gating on `tsc --noEmit == 0`; Task 4 only re-enables CI after `pnpm build` is confirmed green.
- **Verified-identical-behavior fixes** (db generic, api fixtures/imports/dedup) each have a vitest run step proving tests still pass.
