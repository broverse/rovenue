# Server-Configured Default Android Offer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dashboard set a per-product optional Android default base plan (`androidBasePlanId`) + optional offer (`androidOfferId`); flow it through offerings → core → Kotlin SDK so it DRIVES `StoreProduct.defaultOption` (and thus the no-option purchase). When unset, keep today's lowest-price heuristic.

**Architecture:** New nullable `products` columns → dashboard CRUD → offerings response (per package) → core `CoreOfferingProduct` (UDL + binding regen) → Kotlin hydration sets `defaultOption` to the matching `SubscriptionOption` when configured → `Rovenue.purchase(no option)` honors `defaultOption`. Android-only; iOS carries the fields but ignores them.

**Tech Stack:** Drizzle/Postgres (packages/db), Hono+Zod (apps/api), Rust+uniffi (core-rs), Kotlin/Play Billing (sdk-kotlin), React (apps/dashboard), Fumadocs.

## Global Constraints

- New fields are `androidBasePlanId` / `androidOfferId` end-to-end (camelCase on the wire; `android_base_plan_id`/`android_offer_id` in Rust). Nullable everywhere; null = "use lowest-price heuristic".
- Dedicated `products` columns (NOT inside `storeIds`). Migrations are GENERATED: edit `schema.ts` then `pnpm --filter @rovenue/db db:migrate:generate` (drizzle-kit) — commit the generated SQL + meta.
- `androidOfferId` present without `androidBasePlanId` is invalid → API rejects (Zod superRefine).
- Server config DRIVES `StoreProduct.defaultOption`; the no-option purchase uses `defaultOption` (advertised == purchased). Stale config (no matching live Play option at hydration) → fall back to lowest-price `defaultOption` + warn log (do NOT throw — offerings must render).
- core generated bindings gitignored — regen via `npm run sdk:bindings`; never hand-edit/commit `Generated/RovenueFFI.swift` / `generated/librovenue.kt`.
- TS strict; Zod for input; responses `{data}`/`{error:{code,message}}`. Verify sdk-kotlin with `./gradlew testDebugUnitTest`. Stay on `main`, commit per task, conventional commits.
- Spec: `docs/superpowers/specs/2026-06-24-server-default-android-offer-design.md`.

---

## File Structure

- `packages/db/src/drizzle/schema.ts` — products columns; `drizzle/migrations/0083_*` (generated); `repositories/products.ts` — UpdateProductInput + read.
- `apps/api/src/routes/dashboard/products.ts` — Zod create/update + superRefine + route persist + toWire response.
- `apps/api/src/routes/v1/offerings.ts` + the offering repo's `findProductsByIds` — emit the fields per package.
- `packages/core-rs/src/offerings/{types.rs,client.rs}` + `librovenue.udl` + `tests/fixtures/offerings_response.json` + regen.
- `packages/sdk-kotlin/.../internal/OfferingsHydration.kt` (defaultOption) + `Rovenue.kt` (no-option path).
- `apps/dashboard/src/components/products/{product-form-modal.tsx,store-identifier-fields.tsx}`.
- `apps/docs/content/docs/...` product config page.

---

## Task 1: DB — products columns + migration + repo

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts` (products table, after `creditAmount`)
- Generate: `packages/db/drizzle/migrations/0083_*.sql` (+ meta) via drizzle-kit
- Modify: `packages/db/src/drizzle/repositories/products.ts` (`UpdateProductInput`)
- Test: `packages/db/src/drizzle/repositories/products.test.ts` (Create or extend an existing repo test — match the existing pattern in that dir)

**Interfaces:**
- Produces: `products.androidBasePlanId: text | null`, `products.androidOfferId: text | null`; `UpdateProductInput.androidBasePlanId?: string | null`, `androidOfferId?: string | null`.

- [ ] **Step 1: Add the columns to the schema**

In `schema.ts`, inside the `products` table after `creditAmount: integer("creditAmount"),`:

```typescript
    androidBasePlanId: text("androidBasePlanId"),
    androidOfferId: text("androidOfferId"),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @rovenue/db db:migrate:generate`
Expected: a new `packages/db/drizzle/migrations/0083_*.sql` is created adding the two nullable columns, plus updated `meta/_journal.json` + snapshot. Open the generated SQL and confirm it is `ALTER TABLE "products" ADD COLUMN "androidBasePlanId" text;` (+ androidOfferId), nullable, no default/backfill.

- [ ] **Step 3: Extend `UpdateProductInput`**

In `repositories/products.ts`, add to the `UpdateProductInput` interface:

```typescript
  androidBasePlanId?: string | null;
  androidOfferId?: string | null;
```

(`createProduct` takes `NewProduct` (inferred insert type) and spreads it, so the new columns are already accepted on create. `updateProduct` spreads `patch`, so adding them to `UpdateProductInput` is sufficient. Confirm `listProducts`/`findProductById` use `db.select().from(products)` (full row) so the columns are returned; if any selects an explicit column list, add the two columns there.)

- [ ] **Step 4: Write the failing test**

Add to the products repo test (match the file's existing imports/harness — it uses a real test Postgres or the repo's standard test DB; mirror a neighboring test exactly):

```typescript
it("persists and reads androidBasePlanId/androidOfferId", async () => {
  const created = await createProduct(db, {
    projectId, identifier: "pro_x", type: "SUBSCRIPTION", displayName: "Pro X",
    storeIds: { google: "pro_x" }, accessIds: [], isActive: true, metadata: {},
    androidBasePlanId: "annual", androidOfferId: "promo10",
  } as any);
  expect(created.androidBasePlanId).toBe("annual");
  expect(created.androidOfferId).toBe("promo10");

  const updated = await updateProduct(db, projectId, created.id, { androidOfferId: null });
  expect(updated!.androidBasePlanId).toBe("annual");
  expect(updated!.androidOfferId).toBeNull();

  const plain = await createProduct(db, {
    projectId, identifier: "pro_y", type: "SUBSCRIPTION", displayName: "Pro Y",
    storeIds: { google: "pro_y" }, accessIds: [], isActive: true, metadata: {},
  } as any);
  expect(plain.androidBasePlanId).toBeNull();
});
```

- [ ] **Step 5: Run test to verify it fails, then passes**

Run: `cd packages/db && pnpm vitest run src/drizzle/repositories/products.test.ts` (with the test DB the repo tests use)
Expected: FAIL before the column/migration exist (or type error), PASS after migration is applied to the test DB. If repo tests run against a live test Postgres, ensure the migration is applied (the repo test harness typically migrates). Confirm both fields round-trip and default to null.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations packages/db/src/drizzle/repositories/products.ts packages/db/src/drizzle/repositories/products.test.ts
git commit -m "feat(db): products.androidBasePlanId/androidOfferId columns (migration 0083)"
```

---

## Task 2: Dashboard API — accept + persist + return the fields

**Files:**
- Modify: `apps/api/src/routes/dashboard/products.ts` (Zod schemas, route handlers, `toWire`)
- Test: `apps/api/src/routes/dashboard/products.integration.test.ts` (extend) or a focused route test mirroring the existing one

**Interfaces:**
- Consumes: Task 1 repo fields.
- Produces: create/update accept `androidBasePlanId`/`androidOfferId`; product response DTO includes them; `androidOfferId` without `androidBasePlanId` → 400.

- [ ] **Step 1: Write the failing test**

Extend the dashboard products integration test (mirror its existing create/update cases + auth setup):

```typescript
it("persists androidBasePlanId/androidOfferId and returns them", async () => {
  const res = await app.request("/products", { method: "POST", headers: authHeaders,
    body: JSON.stringify({ identifier: "pro_a", type: "SUBSCRIPTION", displayName: "Pro A",
      storeIds: { android: "pro_a" }, androidBasePlanId: "annual", androidOfferId: "promo10" }) });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.product.androidBasePlanId).toBe("annual");
  expect(data.product.androidOfferId).toBe("promo10");
});

it("rejects androidOfferId without androidBasePlanId", async () => {
  const res = await app.request("/products", { method: "POST", headers: authHeaders,
    body: JSON.stringify({ identifier: "pro_b", type: "SUBSCRIPTION", displayName: "Pro B",
      storeIds: { android: "pro_b" }, androidOfferId: "promo10" }) });
  expect(res.status).toBe(400);
});
```

(Match the test file's actual app/auth-header/seed helpers — open it and reuse them verbatim.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/routes/dashboard/products.integration.test.ts`
Expected: FAIL — fields not persisted / no validation.

- [ ] **Step 3: Extend the Zod schemas + superRefine**

In `products.ts`, add to BOTH `createBodySchema` and `updateBodySchema` (as object fields):

```typescript
    androidBasePlanId: z.string().trim().min(1).max(200).nullable().optional(),
    androidOfferId: z.string().trim().min(1).max(200).nullable().optional(),
```

Add a superRefine to each schema (chain after the object) enforcing the dependency:

```typescript
  .superRefine((v, ctx) => {
    if (v.androidOfferId && !v.androidBasePlanId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["androidOfferId"],
        message: "androidOfferId requires androidBasePlanId" });
    }
  })
```

(For `updateBodySchema`, keep its existing `.refine(at-least-one-field)` AND add this superRefine — order them so both run; if the existing `.refine` is chained, add `.superRefine(...)` after it.)

- [ ] **Step 4: Pass fields through the handlers + response**

In the POST handler's `createProduct({...})` call, add: `androidBasePlanId: body.androidBasePlanId ?? null, androidOfferId: body.androidOfferId ?? null,`.
The PATCH handler spreads `productUpdateFields` (which already excludes only `currencyGrants`), so the new body fields flow into `updateProduct` automatically — confirm they're not stripped.
In `toWire(row, grants)`, add `androidBasePlanId: row.androidBasePlanId, androidOfferId: row.androidOfferId,` to the returned object (and to the `DashboardProductRow`/response type).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run src/routes/dashboard/products.integration.test.ts` then `pnpm tsc --noEmit`
Expected: PASS + tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/products.ts apps/api/src/routes/dashboard/products.integration.test.ts
git commit -m "feat(api): product CRUD accepts androidBasePlanId/androidOfferId"
```

---

## Task 3: Offerings API — emit the fields per package

**Files:**
- Modify: `apps/api/src/routes/v1/offerings.ts` (`OfferingProductEntry`, `hydrateProducts`, the `productById` map type)
- Modify: the offering repository's `findProductsByIds` (in `packages/db/src/drizzle/repositories/` — the offerings repo) to select/return the two columns
- Test: `apps/api/src/routes/v1/offerings.integration.test.ts` (extend) or the existing offerings route test

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: GET /v1/offerings per-package `androidBasePlanId: string | null`, `androidOfferId: string | null`.

- [ ] **Step 1: Write the failing test**

Extend the offerings route test: seed a product with `androidBasePlanId`/`androidOfferId`, GET the offering, assert the package carries them. (Mirror the test file's seed + request helpers.)

```typescript
it("includes androidBasePlanId/androidOfferId in offering packages", async () => {
  // seed product with androidBasePlanId "annual", androidOfferId null, attached to an offering package
  const res = await app.request("/offerings", { headers: publicKeyHeaders });
  const { data } = await res.json();
  const pkg = data.offerings[0].packages.find((p) => p.identifier === "pro_a");
  expect(pkg.androidBasePlanId).toBe("annual");
  expect(pkg.androidOfferId).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/routes/v1/offerings.integration.test.ts`
Expected: FAIL — fields absent.

- [ ] **Step 3: Select the columns in the offering repo**

Open the offerings repository's `findProductsByIds` (search `findProductsByIds` under `packages/db/src/drizzle/repositories/`). If it selects an explicit column subset, add `androidBasePlanId: products.androidBasePlanId, androidOfferId: products.androidOfferId` to the select and its return type. If it does `db.select().from(products)` (full row), no change needed — note that in the report.

- [ ] **Step 4: Emit in offerings.ts**

Add to `OfferingProductEntry`:
```typescript
  androidBasePlanId: string | null;
  androidOfferId: string | null;
```
Add to the `productById` map value type in `hydrateProducts`:
```typescript
    androidBasePlanId: string | null;
    androidOfferId: string | null;
```
Add to the object returned in `hydrateProducts.map(...)`:
```typescript
        androidBasePlanId: product.androidBasePlanId ?? null,
        androidOfferId: product.androidOfferId ?? null,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run src/routes/v1/offerings.integration.test.ts` then `pnpm tsc --noEmit`
Expected: PASS + tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/v1/offerings.ts packages/db/src/drizzle/repositories apps/api/src/routes/v1/offerings.integration.test.ts
git commit -m "feat(api): offerings response carries androidBasePlanId/androidOfferId per package"
```

---

## Task 4: Core — carry the fields through to CoreOfferingProduct

**Files:**
- Modify: `packages/core-rs/src/offerings/types.rs` (`OfferingProductWire`, `CoreOfferingProduct`)
- Modify: `packages/core-rs/src/offerings/client.rs` (`map_response`)
- Modify: `packages/core-rs/src/librovenue.udl` (`dictionary CoreOfferingProduct`)
- Modify: `packages/core-rs/tests/fixtures/offerings_response.json` (add the keys to a package) + `packages/core-rs/tests/offerings_test.rs` (assert)

**Interfaces:**
- Consumes: Task 3 wire keys `androidBasePlanId`/`androidOfferId`.
- Produces: `CoreOfferingProduct.android_base_plan_id: Option<String>`, `android_offer_id: Option<String>` (Kotlin/Swift binding: `androidBasePlanId`/`androidOfferId`).

- [ ] **Step 1: Write the failing test**

In `tests/offerings_test.rs`, add assertions (and add the keys to the fixture's first package in Step 3):

```rust
    assert_eq!(pkg.android_base_plan_id.as_deref(), Some("annual"));
    assert_eq!(pkg.android_offer_id, None);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-rs && cargo test get_offerings_maps_wire_to_ffi`
Expected: FAIL — field does not exist.

- [ ] **Step 3: Implement**

In `types.rs`, add to `OfferingProductWire` (after `store_ids`):
```rust
    #[serde(rename = "androidBasePlanId", default)]
    pub android_base_plan_id: Option<String>,
    #[serde(rename = "androidOfferId", default)]
    pub android_offer_id: Option<String>,
```
Add to `CoreOfferingProduct` (after `google_product_id`):
```rust
    pub android_base_plan_id: Option<String>,
    pub android_offer_id: Option<String>,
```
In `client.rs` `map_response`, in the `CoreOfferingProduct { ... }` constructor (after `google_product_id`):
```rust
                    android_base_plan_id: p.android_base_plan_id,
                    android_offer_id: p.android_offer_id,
```
In `librovenue.udl`, add to `dictionary CoreOfferingProduct` before the closing brace:
```
    string? android_base_plan_id;
    string? android_offer_id;
```
In `tests/fixtures/offerings_response.json`, add `"androidBasePlanId": "annual"` to the first package object (leave androidOfferId absent to test the default/None path).

- [ ] **Step 4: Run test to verify it passes + regen**

Run: `cd packages/core-rs && cargo test` then `npm run sdk:bindings`
Expected: cargo test green (incl. the new assertions); bindings regenerate (gitignored — do not commit). The regenerated Kotlin `CoreOfferingProduct` now has `androidBasePlanId`/`androidOfferId`.

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/offerings/types.rs packages/core-rs/src/offerings/client.rs packages/core-rs/src/librovenue.udl packages/core-rs/tests/offerings_test.rs packages/core-rs/tests/fixtures/offerings_response.json
git commit -m "feat(core): CoreOfferingProduct carries android_base_plan_id/android_offer_id"
```

---

## Task 5: Kotlin — server config drives defaultOption + no-option purchase

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/OfferingsHydration.kt` (`mapProduct` defaultOption)
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` (no-option purchase path)
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/OfferingsHydrationTest.kt` (extend)

**Interfaces:**
- Consumes: Task 4 generated `CoreOfferingProduct.androidBasePlanId`/`androidOfferId`; `selectOfferToken` normalization semantics; `StoreProduct.defaultOption`/`subscriptionOptions`.
- Produces: server-driven `defaultOption`; `Rovenue.purchase(activity, product, option=null)` uses `defaultOption`.

- [ ] **Step 1: Write the failing test**

Extend `OfferingsHydrationTest.kt` (mirror its FakeStore + core builder). Add a helper to build a `CoreOfferingProduct` with `androidBasePlanId`/`androidOfferId`, a fake store returning two base-plan options ("monthly" cheaper, "annual" pricier):

```kotlin
@Test fun serverBasePlanDrivesDefaultOption() {
    // fake store returns options: basePlanId "monthly" (cheaper), "annual" (pricier)
    val core = coreWith(androidBasePlanId = "annual", androidOfferId = null) // product "premium"
    val offerings = hydrateOfferings(core, fakeStoreWithMonthlyAndAnnual())
    val def = offerings.current!!.packages.first().product.defaultOption
    assertEquals("annual", def?.basePlanId)   // server choice, NOT the cheaper monthly
}

@Test fun missingServerOptionFallsBackToLowestPrice() {
    val core = coreWith(androidBasePlanId = "weekly", androidOfferId = null) // not in live options
    val offerings = hydrateOfferings(core, fakeStoreWithMonthlyAndAnnual())
    val def = offerings.current!!.packages.first().product.defaultOption
    assertEquals("monthly", def?.basePlanId)  // fallback = lowest-price
}

@Test fun noServerConfigUsesLowestPrice() {
    val core = coreWith(androidBasePlanId = null, androidOfferId = null)
    val offerings = hydrateOfferings(core, fakeStoreWithMonthlyAndAnnual())
    assertEquals("monthly", offerings.current!!.packages.first().product.defaultOption?.basePlanId)
}
```

(Match the existing test's `CoreOfferingProduct` constructor arity — after Task 4 regen it has `androidBasePlanId`/`androidOfferId`; the helper `coreWith(...)` sets them. Build the fake store's `ProductInfo.options` so "monthly" has a lower `fullPricePhase.price` than "annual".)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.OfferingsHydrationTest"`
Expected: FAIL — defaultOption is currently always lowest-price (ignores androidBasePlanId).

- [ ] **Step 3: Drive defaultOption from server config in `mapProduct`**

In `OfferingsHydration.kt` `mapProduct`, where `defaultOption` is computed from `options`, replace the unconditional lowest-price pick with: if `p.androidBasePlanId != null`, match it; else lowest-price. Add a local matcher reusing the null/"" normalization:

```kotlin
fun normId(s: String?): String? = if (s.isNullOrEmpty()) null else s

val lowestPriceDefault = options
    ?.filter { it.isBasePlan }
    ?.minByOrNull { it.fullPricePhase?.price ?: Double.MAX_VALUE }
    ?: options?.firstOrNull()

val defaultOption = if (p.androidBasePlanId != null) {
    val want = normId(p.androidOfferId)
    options?.firstOrNull { it.basePlanId == p.androidBasePlanId && normId(it.offerId) == want }
        ?: lowestPriceDefault   // stale config → fall back (do not break the product)
} else {
    lowestPriceDefault
}
```

(Use the EXACT field/var names the current `mapProduct` uses — open it and adapt; the key change is making `defaultOption` server-driven with a lowest-price fallback. If the current code already computes a `defaultOption` val via the lowest-price filter, wrap it as `lowestPriceDefault` and add the conditional.)

- [ ] **Step 4: No-option purchase honors defaultOption (`Rovenue.kt`)**

Change the option-based purchase overload so a null option uses `product.defaultOption`:

```kotlin
suspend fun purchase(activity: Activity, product: StoreProduct, option: SubscriptionOption? = null): PurchaseResult {
    val effective = option ?: product.defaultOption
    return purchase(activity, product, effective?.basePlanId, effective?.offerId)
}
```

(Keep the `Package` overload delegating to this, and the parts-based `purchase(activity, product, basePlanId, offerId)` unchanged.)

- [ ] **Step 5: Run test to verify it passes + full suite**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.OfferingsHydrationTest"` then `./gradlew testDebugUnitTest`
Expected: 3 new tests PASS; full suite green.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/OfferingsHydration.kt packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/OfferingsHydrationTest.kt
git commit -m "feat(sdk-kotlin): server-configured default offer drives defaultOption + no-option purchase"
```

---

## Task 6: Dashboard UI — Android base-plan / offer inputs

**Files:**
- Modify: `apps/dashboard/src/components/products/product-form-modal.tsx` (`FormState`, submit payload, edit-prefill)
- Modify: `apps/dashboard/src/components/products/store-identifier-fields.tsx` (add two Android inputs) OR add them in the form modal's Android section
- Test: per existing dashboard component test patterns (if the products form has a test; else a focused render/submit test)

**Interfaces:**
- Consumes: Task 2 API fields.
- Produces: the product form sends `androidBasePlanId`/`androidOfferId`.

- [ ] **Step 1: Add the form fields**

In `product-form-modal.tsx`, add to `FormState`:
```typescript
  androidBasePlanId: string;
  androidOfferId: string;
```
Initialize them in the form's initial/edit state (empty string for new; from the loaded product on edit). Render two optional text inputs under the Android section (in `store-identifier-fields.tsx` add two inputs below the Android product-id row, or render them in the modal beneath the StoreIdentifiersFieldset): "Base plan ID" and "Offer ID (optional)", bound to `form.androidBasePlanId` / `form.androidOfferId`. Help text: "Optional. Default Play base plan / offer to purchase when the app doesn't pick one; blank = lowest-priced base plan."

- [ ] **Step 2: Send them in the submit payload**

In the `submit` function, add to BOTH the create body and the update patch:
```typescript
  androidBasePlanId: form.androidBasePlanId.trim() || null,
  androidOfferId: form.androidOfferId.trim() || null,
```
(These are top-level fields, NOT inside `storeIds`.) Ensure the dashboard API client types (`DashboardProductCreateInput`/`UpdateInput`) include the two optional fields.

- [ ] **Step 3: Verify**

Run: `cd apps/dashboard && pnpm tsc --noEmit` (+ the dashboard test command if a products-form test exists: `pnpm vitest run` for the relevant file).
Expected: tsc clean; tests pass. Manually confirm (or via test) the inputs render in the Android section and submit maps to the payload.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/products
git commit -m "feat(dashboard): Android default base-plan/offer inputs on the product form"
```

---

## Task 7: Docs — server-configured default Android offer

**Files:**
- Modify: the product-configuration / offerings docs under `apps/docs/content/docs/` (locate the products/offerings config page)

**Interfaces:** none.

- [ ] **Step 1: Document it**

Find the product-config doc: `grep -rl "storeIds\|product\|offering" apps/docs/content`. In the products/offerings configuration page, add a short "Default Android offer" note:
- Optional per-product `androidBasePlanId` (+ optional `androidOfferId`) sets the default Play base plan/offer the SDK selects when the app doesn't pick a `SubscriptionOption`.
- It drives `StoreProduct.defaultOption` and the no-option purchase (so advertised default price == purchased).
- Leave blank to use the lowest-priced base plan.
- Android-only (iOS uses promotional offers; these fields are ignored on iOS).
- If the configured plan/offer no longer exists in Google Play, the SDK falls back to the lowest-priced base plan.

- [ ] **Step 2: Build docs**

Run: `pnpm --filter @rovenue/docs build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add apps/docs
git commit -m "docs: server-configured default Android offer"
```

---

## Self-Review (completed)

**Spec coverage:** §5.1 DB → Task 1; §5.2 dashboard API + offerId-without-basePlanId reject → Task 2; §5.3 offerings → Task 3; §5.4 core+UDL+regen → Task 4; §5.5 Kotlin defaultOption-driven + no-option purchase → Task 5; §5.6 dashboard UI → Task 6; §5.7 docs → Task 7; §6 edge cases (offerId-without-basePlanId → Task 2 superRefine; stale config fallback → Task 5; iOS ignores → carried but unused, no iOS task) all covered. Out-of-scope (iOS, storeIds reshape, receipt changes) excluded.

**Placeholder scan:** no TBD/TODO; code in every code step; tests included. "Mirror the existing test harness / current mapProduct var names" are match-reality directives (the repo's test setup + the exact defaultOption var must match what's on disk), not placeholders.

**Type consistency:** `androidBasePlanId`/`androidOfferId` (camelCase) consistent across DB columns (Task 1), Zod + toWire (Task 2), offerings entry (Task 3), wire serde rename + `android_base_plan_id`/`android_offer_id` Rust + UDL (Task 4), generated Kotlin `androidBasePlanId`/`androidOfferId` consumed in hydration (Task 5), dashboard payload (Task 6). The offerings wire JSON keys `androidBasePlanId`/`androidOfferId` (Task 3) match the core serde renames (Task 4). `defaultOption` semantics: set in hydration (Task 5 Step 3), consumed by no-option purchase (Task 5 Step 4).
