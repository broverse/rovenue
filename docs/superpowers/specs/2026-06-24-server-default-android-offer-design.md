# Server-Configured Default Android Offer

**Date:** 2026-06-24
**Status:** Approved design, pre-implementation
**Builds on:** the enriched StoreProduct (`subscriptionOptions`/`defaultOption`) and Android offer-selection features. Makes the Android default subscription offer **server-driven** instead of a client-side lowest-price heuristic.

## 1. Problem

A Play subscription product has multiple base plans + offers (basePlanId/offerId). The SDK currently picks the default (`StoreProduct.defaultOption`, and the no-option purchase) via a client-side **lowest-price base-plan heuristic**. The product owner cannot say "for this product, the default plan is the annual base plan" from the dashboard. There is no place in the product catalog (DB, API, offerings response, core, SDK) to carry a server-chosen base plan/offer today.

**Goal:** let the dashboard set, per product, an optional Android **default base plan** (`androidBasePlanId`) and optional **offer** (`androidOfferId`). Flow it through offerings → core → SDK, and have it DRIVE `StoreProduct.defaultOption` (so the no-option purchase redeems the server-chosen plan, and advertised default price == purchased price). When unset, keep today's lowest-price heuristic. Android-only.

## 2. Key facts established (from the codebase)

- `products` table (`packages/db/src/drizzle/schema.ts`): `storeIds` is a free-form JSONB `Record<string,string>` (`{apple, google, stripe}`); NO base-plan/offer field anywhere (DB, dashboard Zod, offerings wire, core `CoreOfferingProduct`, SDK). Latest migration `0082`.
- Dashboard product API (`apps/api/src/routes/dashboard/products.ts`): `storeIds: z.record(z.string())`; create/update schemas have no base-plan field.
- Offerings wire (`apps/api/src/routes/v1/offerings.ts`): per-package `storeIds: Record<string,string>`. Core `OfferingProductWire.store_ids` is a TYPED struct (`apple/google/stripe`) → carrying a new field REQUIRES adding it to the core wire + `CoreOfferingProduct` + UDL (binding regen), regardless of how it's stored server-side.
- Core `CoreOfferingProduct`: `apple_product_id`, `google_product_id` only.
- SDK Kotlin (`internal/OfferingsHydration.kt`, `ProductMapping.kt`): `defaultOption` / `selectOfferToken` no-request branch = lowest `recurringPriceMicros` base plan. `selectOfferToken` already accepts `basePlanId`/`offerId`. `Rovenue.purchase(activity, product, option?=null)` with no option passes `null/null` → lowest-price.

## 3. Decisions (locked)

- **Storage:** dedicated nullable columns `androidBasePlanId` + `androidOfferId` on `products` (migration `0083`). Avoids the storeIds key-normalization risk; explicit and queryable.
- **Semantics:** the server `androidBasePlanId` (+ optional `androidOfferId`) DRIVES `StoreProduct.defaultOption`; the no-option purchase honors `defaultOption`. Advertised default == purchased. When unset → current lowest-price heuristic.
- **Granularity:** `androidBasePlanId` (primary) + optional `androidOfferId`.
- **Naming:** `android*` end-to-end for the new fields (Play base plans are an Android-only concept; iOS has no equivalent and ignores them).

## 4. Architecture / data flow

```
Dashboard product form (Android section): basePlanId + offerId inputs
  → POST/PATCH /dashboard/.../products  { androidBasePlanId?, androidOfferId? }
  → products columns androidBasePlanId / androidOfferId
  → GET /v1/offerings → per-package androidBasePlanId / androidOfferId
  → core OfferingProductWire → CoreOfferingProduct.android_base_plan_id / android_offer_id (UDL + regen)
  → Kotlin hydrateOfferings: if androidBasePlanId set → defaultOption = matching SubscriptionOption
       (normalized basePlanId + offerId match); else current lowest-price heuristic
  → Rovenue.purchase(activity, product, option = null) uses product.defaultOption's basePlanId/offerId
```

## 5. Components

### 5.1 DB (`packages/db`)
- Migration `0083_*` (via `pnpm db:migrate:generate` after editing schema): add `androidBasePlanId text` (nullable) + `androidOfferId text` (nullable) to `products`. No backfill (null = "use heuristic").
- `schema.ts`: add the two columns to the `products` table definition.
- `repositories/products.ts`: include the two fields in product read mapping and create/update writes. (They are top-level columns, NOT inside `storeIds` — bypass the storeIds key-normalization layer entirely.)

### 5.2 Dashboard API (`apps/api/src/routes/dashboard/products.ts`)
- `createBodySchema` + `updateBodySchema`: add `androidBasePlanId: z.string().trim().min(1).max(200).nullable().optional()` and `androidOfferId: z.string().trim().min(1).max(200).nullable().optional()`.
- The route persists them via the repository. The product response DTO includes them (so the dashboard form can read current values).

### 5.3 Offerings API (`apps/api/src/routes/v1/offerings.ts`)
- `OfferingProductEntry` (per-package) gains `androidBasePlanId?: string` and `androidOfferId?: string`, populated from the product columns. (Top-level on the package entry, sibling to `storeIds` — NOT inside the storeIds map.) Omit/undefined when null.

### 5.4 Core (`packages/core-rs`)
- `offerings/types.rs`:
  - `OfferingProductWire`: add `#[serde(rename = "androidBasePlanId")] android_base_plan_id: Option<String>` + `#[serde(rename = "androidOfferId")] android_offer_id: Option<String>`.
  - `CoreOfferingProduct`: add `android_base_plan_id: Option<String>` + `android_offer_id: Option<String>`.
- `offerings/client.rs` `map_response`: copy the two fields through.
- `librovenue.udl` `dictionary CoreOfferingProduct`: add `string? android_base_plan_id; string? android_offer_id;`. Regenerate bindings (`npm run sdk:bindings`; gitignored).

### 5.5 Kotlin SDK (`packages/sdk-kotlin`)
- `internal/OfferingsHydration.kt` (`mapProduct`): when `core.androidBasePlanId` is non-null, set `defaultOption` = the `SubscriptionOption` from the queried options whose `basePlanId` matches `androidBasePlanId` and whose `offerId` matches `androidOfferId` (normalize null/"" on both sides, reusing the same equivalence as `selectOfferToken`). If no live option matches (stale config) → fall back to the current lowest-price `defaultOption` (defensive; do not break the product) and `logger`-warn. When `androidBasePlanId` is null → current lowest-price `defaultOption` (unchanged).
- `Rovenue.kt` `purchase(activity, product, option: SubscriptionOption? = null)`: resolve `val effective = option ?: product.defaultOption`; pass `effective?.basePlanId`, `effective?.offerId` to the parts-based `purchase(...)`. (So a no-option purchase redeems the advertised `defaultOption` — server-driven when configured, lowest-price otherwise. Aligns purchased == advertised in all cases.)
- No change to `selectOfferToken` (it already matches by basePlanId/offerId) or the public type shape (`defaultOption` already exists).

### 5.6 Dashboard UI (`apps/dashboard`)
- The product form's Android section (`store-identifier-fields.tsx` or the product form): add two optional inputs under Android — "Base plan ID" and "Offer ID (optional)" — wired into the create/update request as `androidBasePlanId`/`androidOfferId`. Show current values on edit. Help text: "Optional. The default Play base plan / offer to purchase when the app doesn't pick one; leave blank to use the lowest-priced base plan."

### 5.7 Docs (`apps/docs`)
- In the product-configuration / offerings docs: document the optional Android default base plan/offer — what it does (drives the SDK's default offer), that it's Android-only, and that leaving it blank uses the lowest-price base plan.

## 6. Error handling / edge cases

- `androidOfferId` set without `androidBasePlanId`: invalid (an offer belongs to a base plan). API validation rejects `androidOfferId` present while `androidBasePlanId` absent (Zod `superRefine`).
- Stale config (configured base plan/offer no longer exists in live Play `ProductDetails` at hydration): SDK falls back to lowest-price `defaultOption` + warn log; does not throw (offerings must still render). NOTE: this differs from the *purchase-time* OfferNotFound (when the app explicitly passes a now-missing option, that still fails loudly per the prior feature — unchanged).
- Non-subscription products: the columns are ignored (no base plans).
- iOS: `androidBasePlanId`/`androidOfferId` carried in the offerings/core but unused (no Apple base-plan concept).

## 7. Testing

- **DB/repo:** integration test — create/update a product with `androidBasePlanId`/`androidOfferId`, read it back; null when unset.
- **Dashboard API:** product create/update accepts + persists the fields; `androidOfferId` without `androidBasePlanId` → 4xx validation error; product response includes them.
- **Offerings API:** GET /v1/offerings includes `androidBasePlanId`/`androidOfferId` per package when set; absent/undefined when null.
- **Core:** `map_response` carries `android_base_plan_id`/`android_offer_id` from wire → `CoreOfferingProduct` (deserialize test with the camelCase JSON keys).
- **Kotlin (`testDebugUnitTest`):** hydration with a fake store returning options — server `androidBasePlanId` (+offerId) → `defaultOption` = the matching option (not lowest-price); server basePlanId with NO matching live option → falls back to lowest-price; null config → lowest-price (unchanged). A `Rovenue`-level or flow-level check that a no-option purchase forwards `defaultOption.basePlanId/offerId` (mirror the existing offer-threading test).
- **Dashboard UI:** the form renders + submits the new fields (per existing dashboard test patterns).

## 8. Out of scope

- iOS (no base-plan concept).
- Changing `storeIds` shape (we use dedicated columns).
- Server-driven selection of a *specific promotional/intro offer to display* in paywalls beyond the single default (the app already gets all `subscriptionOptions`).
- Multi-offering / per-offering overrides of the default (this is per-product).
- Backend receipt/validation changes (offer-agnostic).
