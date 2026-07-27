# P6 — Commerce Binding UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real per-package price/period/trial from the store APIs (Apple ASC / Google Play / Stripe) behind one resolve endpoint, a Binding-tab redesign with period presets over the unchanged wire, real prices in the canvas preview, and a trial-aware CTA label across the three renderers.

**Architecture:** New `offering-price-resolver` orchestrator composes three per-store resolvers with hard per-store isolation and Redis caching; the dashboard consumes it via a react-query hook shared by the Binding tab and the canvas. Period presets are authoring macros that write the existing `packageIds`/`defaultSelected` — no wire change. `purchaseButton.trialLabelKey` is the only schema change and is wave-B-gated.

**Tech Stack:** Hono + Drizzle + Redis (api), react-query + impair VM (dashboard), Zod (shared), Vitest, XCTest, JUnit.

**Spec:** `docs/superpowers/specs/2026-07-27-p6-commerce-binding-design.md` — read it first.

## Global Constraints

- **Stay on the current branch. Never create a branch or worktree.** The user manages branching.
- **Never dispatch implementers in parallel** — tasks run one at a time (shared working tree).
- **P4b wave B runs in parallel on this repo.** Tasks 1–8 are chosen to avoid its files. Tasks 9–13 are **HARD-GATED: do not start until the controller confirms wave B has landed** (its tasks own `packages/shared/src/paywall/*`, `packages/paywall-renderer/src/nodes.tsx`, the Swift/Kotlin PaywallUI files, `inspector/tabs.ts`, `inspector/content-tab.tsx`, `inspector/style-tab.tsx`, `inspector/overrides.tsx`, and `apps/dashboard/src/i18n/locales/en.json`).
- **No magic values.** Every literal (TTL, territory codes, period tables, badge copy, stale times) gets a named constant.
- **New UI copy uses `t("key", "English default")`** — the codebase idiom that renders the default without an `en.json` entry. Do NOT edit `en.json` before Task 13 (it is a wave B file).
- API responses are `{ data: T }` via `ok()` or `{ error: { code, message } }`. TypeScript strict; Zod for input.
- Verification commands: `pnpm --filter @rovenue/api exec vitest run <file>`, `pnpm --filter @rovenue/dashboard exec vitest run <file>`, `pnpm --filter @rovenue/shared exec vitest run`, `pnpm --filter @rovenue/paywall-renderer exec vitest run`, `cd packages/sdk-swift && swift test`, `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`. Typecheck with `pnpm --filter <pkg> exec tsc --noEmit`.
- `@rovenue/db` vitest needs `DATABASE_URL` exported; apps/api tests must not set `process.env` at top of file (use `tests/setup.ts` / `vi.hoisted` — import hoisting parses `lib/env` first).
- Reference region constants: Apple territory `"USA"` (alpha-3), Google region `"US"` (alpha-2). Cache TTL `RESOLVED_PRICE_CACHE_TTL_SECONDS = 900`. Errors are never cached.

## File Structure

**Immediate (Tasks 1–8, no wave B overlap):**
- `packages/shared/src/currency.ts` — NEW: Stripe minor-unit exponent table (single authority; moved from funnel-runner).
- `packages/shared/src/dashboard.ts` — resolved-prices DTO types (append near `OfferingPackage`, ~line 1716).
- `apps/api/src/services/google/google-play-prices.ts` — NEW: base-plan price/period/trial reader.
- `apps/api/src/services/apple/app-store-connect.ts` — extend with `listAppStoreSubscriptionPrices`.
- `apps/api/src/services/offering-price-resolver.ts` — NEW: orchestrator (isolation + cache).
- `apps/api/src/routes/dashboard/offerings.ts` — add `GET /:id/resolved`.
- `apps/dashboard/src/lib/hooks/useOfferingResolvedPrices.ts` — NEW: react-query hook.
- `apps/dashboard/src/components/paywall-builder/inspector/binding-prices.ts` — NEW: pure row/preset/label helpers.
- `apps/dashboard/src/components/paywall-builder/inspector/binding-tab.tsx` — redesigned `PackageListBinding`.
- `apps/dashboard/src/components/paywall-builder/canvas-helpers.ts` + `canvas.tsx` — resolved priceView + dynamic badge.
- `apps/dashboard/src/runner/funnel-runner.tsx` — swap its local exponent table for the shared one (funnel-runner is NOT a wave B file).

**Wave-B-gated (Tasks 9–13):**
- `packages/shared/src/paywall/schema.ts`, `validate.ts`, `render-fixtures.json` — `trialLabelKey`.
- `packages/paywall-renderer/src/nodes.tsx` — trial-aware label.
- `packages/sdk-swift/Sources/Rovenue/PaywallUI/BuilderConfigModel.swift`, `RovenuePaywallView.swift`.
- `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/BuilderConfigModel.kt`, `NodeViewFactory.kt`.
- `apps/dashboard/src/components/paywall-builder/inspector/tabs.ts`, `binding-tab.tsx` (purchaseButton case), `apps/dashboard/src/i18n/locales/en.json`.

---

### Task 1: Shared currency module (minor-unit authority)

**Files:**
- Create: `packages/shared/src/currency.ts`
- Modify: `packages/shared/src/index.ts` (barrel export)
- Modify: `apps/dashboard/src/runner/funnel-runner.tsx:60-109` (delete the local sets + function, re-export from shared)
- Test: `packages/shared/src/currency.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `stripeMinorUnitExponent(currency: string): number` and `decimalToMinorUnits(amount: number, currency: string): number` from `@rovenue/shared`. Task 2/3/4 and funnel-runner rely on these exact names.

The divisor authority is **Stripe's own minor-unit table** (zero-decimal + three-decimal special cases), not Intl/CLDR — UGX/ISK are 2-decimal at Stripe. Copy the two sets **verbatim, comments included,** from `apps/dashboard/src/runner/funnel-runner.tsx:60-109` (the UGX comment is load-bearing).

- [ ] **Step 1: Write the failing test** (`packages/shared/src/currency.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { decimalToMinorUnits, stripeMinorUnitExponent } from "./currency";

describe("stripeMinorUnitExponent", () => {
  it("returns 0 for zero-decimal currencies", () => {
    expect(stripeMinorUnitExponent("JPY")).toBe(0);
    expect(stripeMinorUnitExponent("krw")).toBe(0);
  });
  it("returns 3 for three-decimal currencies", () => {
    expect(stripeMinorUnitExponent("BHD")).toBe(3);
  });
  it("returns 2 by default — including Stripe's special-cased UGX and ISK", () => {
    expect(stripeMinorUnitExponent("USD")).toBe(2);
    expect(stripeMinorUnitExponent("UGX")).toBe(2);
    expect(stripeMinorUnitExponent("ISK")).toBe(2);
  });
});

describe("decimalToMinorUnits", () => {
  it("scales by the currency exponent and rounds to an integer", () => {
    expect(decimalToMinorUnits(9.99, "USD")).toBe(999);
    expect(decimalToMinorUnits(500, "JPY")).toBe(500);
    expect(decimalToMinorUnits(1.234, "BHD")).toBe(1234);
  });
  it("rounds float artifacts instead of truncating", () => {
    expect(decimalToMinorUnits(0.29, "USD")).toBe(29); // 0.29*100 === 28.999…
  });
});
```

- [ ] **Step 2: Run to verify failure:** `pnpm --filter @rovenue/shared exec vitest run src/currency.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement** `packages/shared/src/currency.ts`: move the two sets + `stripeMinorUnitExponent` verbatim from funnel-runner, add:

```ts
export function decimalToMinorUnits(amount: number, currency: string): number {
  return Math.round(amount * 10 ** stripeMinorUnitExponent(currency));
}
```

Export both from `packages/shared/src/index.ts`.
- [ ] **Step 4: Swap funnel-runner:** delete its local sets + function; add `import { stripeMinorUnitExponent } from "@rovenue/shared";` and `export { stripeMinorUnitExponent };` (the re-export keeps any existing importer/test of `funnel-runner`'s symbol working — check with `grep -rn "stripeMinorUnitExponent" apps/dashboard` and update importers to shared if trivial).
- [ ] **Step 5: Verify:** shared vitest run PASS; `pnpm --filter @rovenue/dashboard exec vitest run src/runner` PASS; `tsc --noEmit` clean on shared + dashboard.
- [ ] **Step 6: Commit:** `feat(shared): move the Stripe minor-unit table to a shared currency module`

---

### Task 2: Google Play base-plan prices

**Files:**
- Create: `apps/api/src/services/google/google-play-prices.ts`
- Test: `apps/api/src/services/google/google-play-prices.test.ts` (mirror `google-play-catalog`'s injected-`fetchImpl` pattern)

**Interfaces:**
- Consumes: `getGoogleAccessToken`, `GoogleServiceAccountCredentials`, `StoreApiError` (as `google-play-catalog.ts` does); `decimalToMinorUnits` from `@rovenue/shared` (Task 1).
- Produces (Task 4 depends on these exact names):

```ts
export interface GooglePlanPrice {
  productId: string;
  basePlanId: string;
  period: string | null;   // ISO-8601 billingPeriodDuration ("P1M")
  amountMinor: number;
  currency: string;        // uppercase ISO-4217
  trialDays: number | null;
}
export const GOOGLE_REFERENCE_REGION = "US";
export function listGooglePlaySubscriptionPrices(
  input: {
    packageName: string;
    serviceAccount: GoogleServiceAccountCredentials;
    wanted: ReadonlyArray<{ productId: string; basePlanId: string }>;
  },
  deps?: { fetchImpl?: typeof fetch; getToken?: typeof getGoogleAccessToken },
): Promise<Map<string, GooglePlanPrice>>; // key `${productId}:${basePlanId}`
```

Behaviour to implement:
1. One paged `subscriptions?pageSize=100` walk (same URL/pagination as `google-play-catalog.ts:41-55`), but only inspect subscriptions whose `productId` is in `wanted`.
2. Per wanted pair, find `basePlans[]` entry with matching `basePlanId`. Period: `basePlan.autoRenewingBasePlanType?.billingPeriodDuration ?? basePlan.prepaidBasePlanType?.billingPeriodDuration ?? null`.
3. Price: the `regionalConfigs[]` entry with `regionCode === GOOGLE_REFERENCE_REGION`, else `basePlan.otherRegionsConfig`. Money shape is `{ currencyCode, units?, nanos? }` → decimal `Number(units ?? 0) + (nanos ?? 0) / 1e9` → `decimalToMinorUnits`. No price object at all → skip the pair (absent from the Map).
4. Trial: `GET {BASE}/{pkg}/subscriptions/{productId}/basePlans/{basePlanId}/offers` per wanted pair; a phase priced free in the reference region (`phase.regionalConfigs[]` entry for `US` with `free` set, or `price.units`/`nanos` both absent/zero) contributes `isoDurationToDays(phase.duration)`; take the first free phase of the first offer that has one. **Any error on the offers call → `trialDays: null`, never a thrown error** (log.warn) — trials degrade, prices don't.
5. `isoDurationToDays(iso: string): number | null` — parse `P<n>D|W|M|Y` with named constants `DAYS_PER_WEEK = 7`, `DAYS_PER_MONTH = 30`, `DAYS_PER_YEAR = 365`; unparseable → null.

- [ ] **Step 1: Write the failing tests.** Build canned JSON pages and a recording `fetchImpl`:

```ts
import { describe, expect, it, vi } from "vitest";
import { listGooglePlaySubscriptionPrices } from "./google-play-prices";

const SERVICE_ACCOUNT = { client_email: "x@y.iam.gserviceaccount.com", private_key: "k" };
const deps = (pages: Record<string, unknown>) => ({
  getToken: vi.fn().mockResolvedValue("tok"),
  fetchImpl: vi.fn(async (url: string | URL) => {
    const u = String(url);
    const hit = Object.entries(pages).find(([frag]) => u.includes(frag));
    if (!hit) return new Response("{}", { status: 404, statusText: "nf" });
    return new Response(JSON.stringify(hit[1]), { status: 200 });
  }) as unknown as typeof fetch,
});

const SUBS_PAGE = {
  subscriptions: [{
    productId: "pro_monthly",
    basePlans: [{
      basePlanId: "monthly",
      autoRenewingBasePlanType: { billingPeriodDuration: "P1M" },
      regionalConfigs: [
        { regionCode: "DE", price: { currencyCode: "EUR", units: "8", nanos: 990000000 } },
        { regionCode: "US", price: { currencyCode: "USD", units: "9", nanos: 990000000 } },
      ],
    }],
  }],
};

it("prices the wanted pair from the US regional config", async () => {
  const d = deps({ "/subscriptions?": SUBS_PAGE, "/offers": { subscriptionOffers: [] } });
  const out = await listGooglePlaySubscriptionPrices(
    { packageName: "app.example", serviceAccount: SERVICE_ACCOUNT,
      wanted: [{ productId: "pro_monthly", basePlanId: "monthly" }] }, d);
  expect(out.get("pro_monthly:monthly")).toMatchObject({
    period: "P1M", amountMinor: 999, currency: "USD", trialDays: null });
});

it("falls back to otherRegionsConfig when no US regional config exists", async () => { /* SUBS_PAGE variant with only otherRegionsConfig: { currencyCode: "USD", units: "59", nanos: 990000000 } → amountMinor 5999 */ });

it("maps a free offer phase to trialDays", async () => { /* offers page: { subscriptionOffers: [{ phases: [{ duration: "P1W", regionalConfigs: [{ regionCode: "US", free: {} }] }] }] } → trialDays 7 */ });

it("a failing offers call degrades to trialDays null, not an error", async () => { /* offers frag missing → 404 → trialDays null, price still present */ });

it("omits a wanted pair whose basePlan is missing", async () => { /* wanted basePlanId "annual" → Map without the key */ });
```

- [ ] **Step 2: Run to verify failure** (module not found).
- [ ] **Step 3: Implement** per the behaviour list. Reuse `gpGet`'s error shape (private copy or export it from `google-play-catalog.ts` — exporting is fine, it's not a wave B file).
- [ ] **Step 4: Run tests** — PASS. `tsc --noEmit` clean on api.
- [ ] **Step 5: Commit:** `feat(api): read Google Play base-plan price, period and trial for the resolve endpoint`

---

### Task 3: Apple subscription prices (extend app-store-connect)

**Files:**
- Modify: `apps/api/src/services/apple/app-store-connect.ts`
- Test: `apps/api/src/services/apple/app-store-connect.test.ts` (append; the file already stubs `fetchImpl` and the JWT mint — follow its existing style)

**Interfaces:**
- Consumes: existing `mintToken`, `resolveAppId`, `ascList`, `AppStoreConnectConfig`; `decimalToMinorUnits` (Task 1).
- Produces (Task 4 depends on these exact names):

```ts
export interface AppleSubscriptionPrice {
  productId: string;
  period: string | null;   // ISO-8601 mapped from subscriptionPeriod
  amountMinor: number;
  currency: string;        // APPLE_REFERENCE_CURRENCY
  trialDays: number | null;
}
export const APPLE_REFERENCE_TERRITORY = "USA";
export const APPLE_REFERENCE_CURRENCY = "USD";
export function listAppStoreSubscriptionPrices(
  config: AppStoreConnectConfig,
  wantedProductIds: ReadonlyArray<string>,
  fetchImpl?: typeof fetch,
): Promise<Map<string, AppleSubscriptionPrice>>; // key = store productId
```

Behaviour:
1. Token + appId + subscription groups + per-group subscriptions — the exact walk `listAppStoreCatalog` already does (`:134-153`). Keep only subscriptions whose `attributes.productId` is in `wantedProductIds`; capture their ASC resource `id` and `attributes.subscriptionPeriod`.
2. Period map (named table `APPLE_PERIOD_TO_ISO`): `ONE_WEEK→P1W`, `ONE_MONTH→P1M`, `TWO_MONTHS→P2M`, `THREE_MONTHS→P3M`, `SIX_MONTHS→P6M`, `ONE_YEAR→P1Y`; unknown → null + `log.warn`.
3. Current price: `ascList` over `${BASE_URL}/v1/subscriptions/{id}/prices?filter[territory]=${APPLE_REFERENCE_TERRITORY}&include=subscriptionPricePoint&limit=200`. Candidates = entries whose `attributes.startDate` is null **or** `<= today` (string compare on YYYY-MM-DD is safe); pick the one with the greatest non-null `startDate`, else the null-startDate one. Its `relationships.subscriptionPricePoint.data.id` → the `included` price point → `attributes.customerPrice` (decimal string) → `decimalToMinorUnits(Number(customerPrice), APPLE_REFERENCE_CURRENCY)`.
4. Trial: `ascList` over `${BASE_URL}/v1/subscriptions/{id}/introductoryOffers?filter[territory]=${APPLE_REFERENCE_TERRITORY}&limit=200`; first entry with `attributes.offerMode === "FREE_TRIAL"` → `isoDurationToDays(attributes.duration) * (attributes.numberOfPeriods ?? 1)`. Move/duplicate `isoDurationToDays` here or export it from a tiny `apps/api/src/lib/iso-duration.ts` shared by Tasks 2+3 (**preferred: the lib file — DRY, and both services import it**).
5. Per-subscription price/intro failures: skip that product (absent from Map) with `log.warn` — one broken SKU must not empty the readout. Failures of the shared walk (token/app/groups) throw `StoreApiError` (the orchestrator maps it to a store-level `error`).

- [ ] **Step 1: Write failing tests** (append to `app-store-connect.test.ts`): canned pages keyed by URL fragment exactly like the existing tests — cases: (a) happy path maps `productId → { period: "P1M", amountMinor: 999, currency: "USD", trialDays: 7 }` from a prices page (one price, null startDate, included pricePoint `customerPrice: "9.99"`) + intro page (`FREE_TRIAL`, `duration: "P1W"`, `numberOfPeriods: 1`); (b) a future-dated price is ignored in favour of the current one; (c) `offerMode: "PAY_AS_YOU_GO"` → `trialDays: null`; (d) unknown `subscriptionPeriod` → `period: null`; (e) prices call 500s for one subscription → that product omitted, others present.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** (`apps/api/src/lib/iso-duration.ts` first: `isoDurationToDays` + constants + its own 4-case test file `iso-duration.test.ts`; then the ASC function; refactor Task 2's local copy to import it).
- [ ] **Step 4: Run** `pnpm --filter @rovenue/api exec vitest run src/services/apple/app-store-connect.test.ts src/lib/iso-duration.test.ts src/services/google/google-play-prices.test.ts` — PASS; tsc clean.
- [ ] **Step 5: Commit:** `feat(api): read App Store subscription price, period and trial for the resolve endpoint`

---

### Task 4: Shared DTO + orchestrator with cache and per-store isolation

**Files:**
- Modify: `packages/shared/src/dashboard.ts` (append after `DashboardOfferingRow`, ~line 1726)
- Create: `apps/api/src/services/offering-price-resolver.ts`
- Test: `apps/api/src/services/offering-price-resolver.test.ts` (mirror `store-catalog.test.ts`'s `Overrides`-injection style; mock `redis` via `vi.mock("../lib/redis", ...)`)

**Interfaces:**
- Consumes: `drizzle.offeringRepo.findOfferingById`, `drizzle.productRepo.findProductsByIds`, `packagesSchema`/`parseStoreIds` from `apps/api/src/lib/offering-hydration.ts`, `loadAppleCredentials`/`loadGoogleCredentials`, `resolvePricesForPackages` (stripe), Task 2's `listGooglePlaySubscriptionPrices`, Task 3's `listAppStoreSubscriptionPrices`, `redis` from `apps/api/src/lib/redis`.
- Produces — shared types (dashboard + route import from `@rovenue/shared`):

```ts
// packages/shared/src/dashboard.ts
export type ResolvedStoreStatus = "ok" | "not_configured" | "no_mapping" | "error";
export interface ResolvedStorePrice {
  status: "ok";
  amountMinor: number;
  currency: string;
  period: string | null;
  trialDays: number | null;
}
export type ResolvedStoreEntry =
  | ResolvedStorePrice
  | { status: Exclude<ResolvedStoreStatus, "ok"> };
export interface ResolvedPackageInfo {
  packageIdentifier: string;
  productId: string;
  displayName: string;
  metadataPeriod: string | null; // products.metadata.period convention, the offline fallback
  stores: { apple?: ResolvedStoreEntry; google?: ResolvedStoreEntry; stripe?: ResolvedStoreEntry };
}
export interface OfferingResolvedPrices {
  offeringId: string;
  packages: ResolvedPackageInfo[];
  fetchedAt: string;
}
```

and the service:

```ts
export const RESOLVED_PRICE_CACHE_TTL_SECONDS = 900;
export async function resolveOfferingPrices(
  projectId: string,
  offeringId: string,
  overrides?: Overrides, // same injection idiom as store-catalog.ts
): Promise<OfferingResolvedPrices | null>; // null = offering not found
```

Behaviour:
1. Load offering; null → return null. Parse `offering.packages` with `packagesSchema`; load products by the packages' `productId`s; skip inactive/missing products (consistent with `hydrateProducts`).
2. Store key presence per package: `apple` key present iff `storeIds.apple`; `google` iff `storeIds.google` **and** `androidBasePlanId` (google without a basePlanId → `{ status: "no_mapping" }`, and google with `androidBasePlanId` but no `storeIds.google` → key absent); `stripe` iff `storeIds.stripe`. **Spec §3.4:** Apple/Google resolve subscriptions only — when the product's `type` is not the subscription value of the productType enum (verify the literal at `packages/db/src/drizzle/schema.ts:607`), the apple/google entries are `{ status: "no_mapping" }` and the product is excluded from both stores' wanted lists (stripe still resolves it; one-time Stripe prices return `interval: null` → `period: null`). `metadataPeriod` = `typeof product.metadata?.period === "string" ? product.metadata.period : null`.
3. **Stripe:** `resolvePricesForPackages(projectId, [{packageIdentifier, stripePriceId}])`; per returned entry → `{ status: "ok", amountMinor: unitAmount, currency: currency.toUpperCase(), period: intervalToIso(interval, intervalCount), trialDays }` where `intervalToIso` maps `("month",1)→"P1M"`, `("year",1)→"P1Y"`, `("week",1)→"P1W"`, `("day",1)→"P1D"`, `("month",3)→"P3M"` etc. (`P${count}${unitLetter}`). Mapped-but-missing from the result → `{ status: "error" }` (the stripe resolver omits unreadable prices). No connected account at all (`resolvePricesForPackages` returns `{}` immediately) is indistinguishable from all-unreadable here; that is acceptable — both render as unavailable. Do NOT add caching around stripe (it caches internally).
4. **Apple:** `loadAppleCredentials`; missing or lacking `keyId`/`issuerId`/`privateKey` → every apple entry `{ status: "not_configured" }`. Else cache-read `paywall:resolved:apple:${projectId}:${offeringId}`; on miss call `listAppStoreSubscriptionPrices(config, wantedAppleStoreIds)` and cache the **successful** serialized Map (as an object) with `EX RESOLVED_PRICE_CACHE_TTL_SECONDS`. A thrown `StoreApiError` → every apple entry `{ status: "error" }`, **nothing cached**. Per-package: hit in map → `ok` entry; miss → `{ status: "error" }` (mapped but unreadable).
5. **Google:** same shape with `loadGoogleCredentials` (null → `not_configured`), key `paywall:resolved:google:${projectId}:${offeringId}`, wanted pairs `{ productId: storeIds.google, basePlanId: androidBasePlanId }`, map key `${storeIds.google}:${androidBasePlanId}`.
6. The three stores resolve independently (`Promise.all` over three wrapped `try/catch`es) — one store's throw must never surface.
7. `fetchedAt: new Date().toISOString()`.

- [ ] **Step 1: Write failing tests** — inject overrides for the repos/creds/store calls; `vi.mock` redis with an in-memory Map. Cases: (a) unknown offering → null; (b) fully-configured happy path: one package with all three store ids → three `ok` entries with correct field mapping (incl. `intervalToIso("month",1) → "P1M"` and currency uppercasing); (c) **isolation**: apple resolver throws → apple entries `error`, google+stripe still `ok`; (d) no apple creds → `not_configured`; google product without `androidBasePlanId` → `no_mapping`; (e) **error-not-cached**: apple throws on call 1, redis has no apple key afterwards; succeeds on call 2 and IS cached (redis.set called with `EX`, 900); (f) cache hit short-circuits the apple lister (spy not called); (g) `metadataPeriod` passthrough and null default; (h) inactive product skipped.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** DTO append + service.
- [ ] **Step 4: Run tests** — PASS; `tsc --noEmit` clean on shared + api.
- [ ] **Step 5: Commit:** `feat(api): offering price resolver — three stores, per-store isolation, cached` (two files in shared+api commit together: the DTO exists for this service).

---

### Task 5: `GET /:id/resolved` route

**Files:**
- Modify: `apps/api/src/routes/dashboard/offerings.ts` (append a `.get("/:id/resolved", ...)` **before** `.get("/:id", ...)` in the chain if Hono matching requires it — verify; Hono matches the more specific path either way, but keep the handlers adjacent for readability)
- Test: `apps/api/src/routes/dashboard/offerings.resolved.test.ts`

**Interfaces:**
- Consumes: `resolveOfferingPrices` (Task 4), `assertProjectAccess`, `MemberRole.CUSTOMER_SUPPORT`, `ok`, `HTTPException`.
- Produces: the wire endpoint the dashboard rpc client calls as `rpc.dashboard.projects[":projectId"].offerings[":id"].resolved.$get`. Response `{ data: OfferingResolvedPrices }`.

Handler body (mirror the existing `.get("/:id")` at `offerings.ts:187-205`):

```ts
.get("/:id/resolved", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  if (!projectId || !id) throw new HTTPException(400, { message: "Missing identifier" });
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
  const resolved = await resolveOfferingPrices(projectId, id);
  if (!resolved) throw new HTTPException(404, { message: "Offering not found" });
  return c.json(ok(resolved));
})
```

- [ ] **Step 1: Write failing tests** — `vi.mock("../../services/offering-price-resolver")` and `vi.mock` the auth/access helpers the way the nearest existing dashboard route unit test does (look at `apps/api/src/routes/dashboard/integrations.test.ts` for the local mocking idiom and copy it; if that file's idiom is a full-app integration style instead, follow that). Cases: 200 envelope `{ data: { offeringId, packages } }`; 404 when the service returns null; access assertion called with `CUSTOMER_SUPPORT`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the handler.
- [ ] **Step 4: Run tests** — PASS; `tsc --noEmit` on api AND dashboard (the hc RPC type must pick the new route up — a dashboard tsc failure here means the route chain broke type inference; fix before committing).
- [ ] **Step 5: Commit:** `feat(api): GET /dashboard/projects/:projectId/offerings/:id/resolved`

---

### Task 6: Dashboard hook + pure binding helpers

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useOfferingResolvedPrices.ts`
- Create: `apps/dashboard/src/components/paywall-builder/inspector/binding-prices.ts`
- Test: `apps/dashboard/src/components/paywall-builder/inspector/binding-prices.test.ts`

**Interfaces:**
- Consumes: `OfferingResolvedPrices`, `ResolvedPackageInfo`, `ResolvedStoreEntry` from `@rovenue/shared`; `rpc`/`unwrap` from `../../lib/api` (hook only); Task 1's `stripeMinorUnitExponent` via `formatMinorAmount` below.
- Produces (Task 7 + Task 8 depend on these exact names):

```ts
// useOfferingResolvedPrices.ts
export const RESOLVED_PRICES_STALE_MS = 60_000;
export function useOfferingResolvedPrices(projectId: string, offeringId: string | null)
  // react-query over rpc...offerings[":id"].resolved.$get, enabled when both ids present,
  // staleTime RESOLVED_PRICES_STALE_MS, select: (r) => r  (unwrap already strips { data })

// binding-prices.ts  — ALL pure, no react imports
export interface PackagePriceRow {
  packageIdentifier: string;
  displayName: string | null;
  period: string | null;        // ISO; see packagePeriod
  periodConflict: boolean;
  stores: ResolvedPackageInfo["stores"] | null; // null when nothing resolved for this id
}
export function packagePeriod(info: ResolvedPackageInfo): { period: string | null; conflict: boolean };
  // distinct periods among status-ok store entries; 1 distinct → it; >1 → most frequent (ties: apple>google>stripe order), conflict true;
  // 0 ok entries → metadataPeriod, conflict false.
export function buildPriceRows(
  offeringPackageIds: readonly string[],
  resolved: OfferingResolvedPrices | undefined,
): PackagePriceRow[];               // one row per offering id, in offering order; unresolved ids get null displayName/stores
export const PERIOD_LABELS: Readonly<Record<string, string>> = {
  P1D: "Daily", P1W: "Weekly", P1M: "Monthly", P3M: "Quarterly", P6M: "6 months", P1Y: "Annual",
};
export function periodLabel(iso: string | null): string | null; // table hit, else the raw ISO string, null in → null out
export interface PeriodPreset { id: string; label: string; periods: readonly string[] }
export function availablePresets(rows: readonly PackagePriceRow[]): PeriodPreset[];
  // distinct known periods across rows, offering order. Singles first (id = the ISO, label = periodLabel),
  // then "P1M+P1Y" combo IFF both exist (label "Monthly + Annual"), then { id: "all", label: "All", periods: every distinct period }.
  // Fewer than 2 distinct periods → [] (presets are pointless).
export function presetSelection(
  rows: readonly PackagePriceRow[], preset: PeriodPreset, currentDefault: string | undefined,
): { packageIds: string[]; defaultSelected: string | undefined };
  // ids of rows whose period ∈ preset.periods (offering order); defaultSelected kept if still included, else undefined.
export function activePresetId(rows: readonly PackagePriceRow[], packageIds: readonly string[]): string | null;
  // the preset whose presetSelection ids array equals packageIds exactly (order-insensitive set equality); empty packageIds → "all"… 
  // NO: empty packageIds means "every package" by schema semantics → matches "all" only when "all" exists; otherwise null (custom).
export function formatMinorAmount(amountMinor: number, currency: string): string;
  // Intl.NumberFormat("en-US", { style: "currency", currency }) over amountMinor / 10 ** stripeMinorUnitExponent(currency);
  // try/catch → fallback `${currency} ${(amountMinor / 100).toFixed(2)}` (bad code must not crash the inspector).
export function storeBadgeText(entry: ResolvedStoreEntry): string;
  // ok → "$9.99" (+ " · 7d trial" when trialDays) ; not_configured → "not configured"; no_mapping → "no mapping"; error → "unavailable".
```

- [ ] **Step 1: Write failing tests** for every pure function. Minimum cases: `packagePeriod` — agreement, majority+conflict flag, metadata fallback, all-null; `buildPriceRows` — offering order preserved, unresolved id row shape; `availablePresets` — single-period offering → `[]`, monthly+annual offering → `["P1M","P1Y","P1M+P1Y","all"]` ids in that order; `presetSelection` — filters + keeps/clears `defaultSelected`; `activePresetId` — exact match, custom → null, `packageIds: []` ↔ "all" semantics; `formatMinorAmount(999,"USD") === "$9.99"`, JPY no decimals, unknown currency falls back; `storeBadgeText` all four statuses + trial suffix.
- [ ] **Step 2: Run to verify failure:** `pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder/inspector/binding-prices.test.ts`.
- [ ] **Step 3: Implement** both files (hook is 20 lines; helpers pure).
- [ ] **Step 4: Run** — PASS; dashboard tsc clean.
- [ ] **Step 5: Commit:** `feat(dashboard): resolved-price hook and pure binding-tab helpers`

---

### Task 7: Binding tab redesign

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/binding-tab.tsx` (only `PackageListBinding` and imports — the `BindingTab` switch and `ButtonBinding` stay untouched)
- Test: `apps/dashboard/src/components/paywall-builder/inspector/binding-tab.test.tsx` (create; follow the render/service-stub idiom of the nearest existing inspector component test — check `inspector/` and `__tests__/` for one, e.g. the tabs or content-tab tests, and copy its mounting pattern for impair `useService`)

**Interfaces:**
- Consumes: Task 6's hook + helpers; existing `vm.updateNode`, `vm.paywall?.offeringPackageIds`, `Checkbox`, `NativeSelect`, `Section`, `Field`.
- Produces: UI only. **All stored writes remain `set({ packageIds, defaultSelected })` — byte-identical semantics to today's `toggle()`.**

Render structure for `PackageListBinding`:

1. `const resolved = useOfferingResolvedPrices(vm.projectId, vm.paywall?.offeringId ?? null);`
   `const rows = buildPriceRows(offeringPackageIds, resolved.data);`
2. **Presets strip** (above the Packages section, only when `availablePresets(rows).length > 0`): preset chips as small buttons; active = `activePresetId(rows, node.packageIds)`; click → `set(presetSelection(rows, preset, node.defaultSelected))`. When no preset is active render a muted "Custom" chip (non-interactive). Copy via `t("paywalls.builder.properties.presetLabel." + preset.id, preset.label)`-style with English defaults.
3. **Package rows** replace the bare-id labels: checkbox (same `toggle`) + `row.displayName ?? id` + period chip (`periodLabel(row.period)`, with a `⚠` `title` tooltip naming a conflict when `row.periodConflict`) + per-store badges from `storeBadgeText` for each present store key (prefix each with the store name: `Apple $9.99 · 7d trial`) + the raw id in `font-rv-mono text-[10px] text-rv-mute-500`. While `resolved.isLoading` or on fetch error, rows render exactly today's id-only checkboxes — **the readout is an enhancement layer, never a gate.**
4. **Default selected** select: option labels become `"${periodLabel(row.period) ?? id} — ${firstOkAmount(row)}"` (helper local to the component: first `ok` store's `formatMinorAmount`, else the raw id). Value/write semantics unchanged.

- [ ] **Step 1: Write failing component tests:** (a) with a stubbed resolved payload (monthly + annual, apple+stripe ok), preset chip "Annual" click calls `updateNode` with exactly the annual package id and clears a now-excluded `defaultSelected`; (b) rows show displayName, period label and store badge text; (c) with the hook erroring (stub rejects), the old id-only rows render and toggling still writes `packageIds`; (d) period-conflict row renders the warning marker.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new test file + the full existing inspector suite (`pnpm --filter @rovenue/dashboard exec vitest run src/components/paywall-builder`) — no regressions (dashboard has 10 known pre-existing failures repo-wide; compare against that baseline, do not misattribute).
- [ ] **Step 5: Commit:** `feat(dashboard): binding tab period presets and resolved price readout`

---

### Task 8: Canvas real prices

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/canvas-helpers.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/binding-prices.ts` (add `periodNoun`; its tests go in the existing `binding-prices.test.ts`)
- Modify: `apps/dashboard/src/components/paywall-builder/canvas.tsx` (lines ~57-68 priceView memo, ~337 badge)
- Test: `apps/dashboard/src/components/paywall-builder/__tests__/canvas-helpers.test.ts` (append if it exists, else create; check for an existing canvas-helpers test first)

**Interfaces:**
- Consumes: `OfferingResolvedPrices` (shared), `PackageView` (`@rovenue/shared/paywall`), Task 6's `formatMinorAmount` + hook, existing `placeholderPriceView`/`toRendererOffering`.
- Produces:

```ts
export const PER_YEAR_MULTIPLIER: Readonly<Record<string, number>> =
  { P1D: 365, P1W: 52, P1M: 12, P3M: 4, P6M: 2, P1Y: 1 };
export type CanvasPriceCoverage = "none" | "partial" | "full";
export function resolvedPriceView(
  offering: RendererOffering | null,
  resolved: OfferingResolvedPrices | undefined,
  platform: "ios" | "android",
): { view: Record<string, PackageView>; coverage: CanvasPriceCoverage };
```

Behaviour of `resolvedPriceView`:
1. Store preference per canvas platform: ios → `apple, google, stripe`; android → `google, apple, stripe` (named const `CANVAS_STORE_PREFERENCE`). First `status: "ok"` entry wins.
2. A package with an ok entry gets a full `PackageView`: `packageName` = displayName; `price` = `formatMinorAmount`; `period` = human period (reuse Task 6's `periodLabel` lowercased to match the SDK's "month" style — add `periodNoun(iso)` to binding-prices.ts: `P1M→"month"`, `P1Y→"year"`, `P1W→"week"`, `P1D→"day"`, multi-unit (`P3M`) → `"3 months"`, unknown → ""); `pricePerPeriod` = `period ? `${price}/${period}` : price` (the funnel-runner formula at `funnel-runner.tsx:164-174`); derived fields from `PER_YEAR_MULTIPLIER[iso]`: `perYearMinor = amountMinor × multiplier`, then `pricePerYear = format(perYearMinor)`, `pricePerMonth = format(perYearMinor/12)`, `pricePerWeek = format(perYearMinor/52)`, `pricePerDay = format(perYearMinor/52/7)` (per-day = per-week / 7, matching `PackageViewMapping.kt:67-71`); `introPeriod` = trialDays ? `${trialDays} days` : undefined (no introPrice — a free trial's intro price is the store's business); `relativeDiscount` = the SDK formula (`PackageViewMapping.kt:95-105`): comparable = packages with a derivable perYear, `<2` comparable or own missing → undefined, else `round((1 − own/max) × 100) + "%"`, max ≤ 0 → undefined. Unknown period ISO (no multiplier) → only the four required fields, no derived ones.
3. Packages without an ok entry keep their `placeholderPriceView` preset (same cycling index behaviour — build the placeholder map first, overwrite resolved ones).
4. `coverage`: all offering packages resolved → "full"; some → "partial"; none/undefined resolved → "none".

Canvas wiring (`canvas.tsx`): add `const resolvedQuery = useOfferingResolvedPrices(vm.projectId, vm.paywall?.offeringId ?? null);` next to `useOfferingById`; replace the `priceView` memo with `resolvedPriceView(offering, resolvedQuery.data, vm.canvasPlatform)` (destructure `view`/`coverage`); badge at ~line 337 becomes a three-way `t()` on coverage: full → `"Preview — live store prices (US)"`, partial → `"Preview — mixed live and placeholder prices"`, none → the existing `"Preview — placeholder prices"` key untouched.

- [ ] **Step 1: Write failing tests:** (a) full coverage: two packages (P1M $9.99, P1Y $59.99 apple-ok) → derived `pricePerMonth` of the annual = "$5.00", `relativeDiscount` present on the monthly ("50%" for 119.88 vs 59.99 → own=119.88 max=119.88 → the ANNUAL gets the discount: assert annual `relativeDiscount === "50%"` and monthly undefined? Compute carefully in the test from the formula — annual perYear 5999, monthly perYear 11988, annual discount = round((1−5999/11988)×100) = 50); (b) platform preference: ios picks apple over stripe, android picks google; (c) partial coverage: unresolved package keeps the placeholder preset at its original cycle index and coverage === "partial"; (d) trialDays → `introPeriod: "7 days"`; (e) unknown period → four fields only; (f) none → byte-equal to `placeholderPriceView` output with coverage "none".
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** helpers, then wire canvas.tsx.
- [ ] **Step 4: Run** the helper tests + full `src/components/paywall-builder` suite + dashboard tsc — pass at baseline.
- [ ] **Step 5: Commit:** `feat(dashboard): canvas preview renders resolved store prices`

---

## ⛔ WAVE-B GATE — do not proceed past this line until P4b wave B is confirmed landed (controller checks `git log` for wave B tasks 3-6 + its final review) ⛔

### Task 9: `purchaseButton.trialLabelKey` in the shared schema

**Files:**
- Modify: `packages/shared/src/paywall/schema.ts` (PurchaseButtonNode ~line 110-117, zod mirror ~line 420-427, `OVERRIDABLE_PROP_KEYS.purchaseButton` ~line 258)
- Modify: `packages/shared/src/paywall/validate.ts` (`LOCALIZED_KEYS.purchaseButton` ~line 62)
- Modify: `packages/shared/src/paywall/render-fixtures.json` (accept entry + new `trialLabel` vector section)
- Test: `packages/shared/src/paywall/validate.test.ts`, `packages/shared/src/paywall/render-fixtures.test.ts` (append)

> Line numbers above are pre-wave-B; re-locate by symbol, wave B has shifted this file.

**Interfaces:**
- Consumes: existing node/zod/table structures.
- Produces: `PurchaseButtonNode.trialLabelKey?: string`; `purchaseButtonSchema` gains `trialLabelKey: z.string().min(1).optional()`; `LOCALIZED_KEYS.purchaseButton: (n) => n.trialLabelKey ? [n.labelKey, n.trialLabelKey] : [n.labelKey]`; `OVERRIDABLE_PROP_KEYS.purchaseButton: ["labelKey", "trialLabelKey"]`. Fixture vector section (consumed by Tasks 10-12):

```json
"trialLabel": {
  "_comment": "expectedKey = which loc key the CTA renders. selectedHasIntroPeriod mirrors PackageView.introPeriod non-empty.",
  "cases": [
    { "name": "trial selected uses trialLabelKey", "trialLabelKey": "cta.trial", "labelKey": "cta.buy", "selectedHasIntroPeriod": true,  "expectedKey": "cta.trial" },
    { "name": "no trial falls back to labelKey",   "trialLabelKey": "cta.trial", "labelKey": "cta.buy", "selectedHasIntroPeriod": false, "expectedKey": "cta.buy" },
    { "name": "absent trialLabelKey always labelKey", "labelKey": "cta.buy", "selectedHasIntroPeriod": true, "expectedKey": "cta.buy" },
    { "name": "no selection is not a trial", "trialLabelKey": "cta.trial", "labelKey": "cta.buy", "selectedHasIntroPeriod": null, "expectedKey": "cta.buy" }
  ]
}
```

plus one `accept` fixture: a minimal config whose purchaseButton carries `trialLabelKey` with both keys present in the default-locale table.

- [ ] **Step 1: Failing tests:** (a) validate.test.ts — a purchaseButton with `trialLabelKey: "cta.trial"` NOT in localizations → `UNKNOWN_LOC_KEY` fires for it (proves `LOCALIZED_KEYS` enrollment); with the key present and blank in the default locale → the blank-default issue fires; without `trialLabelKey` → neither, and the existing labelKey-only tests stay green (pure append). (b) render-fixtures.test.ts — the new accept fixture parses under the STRICT schema; the `trialLabel` vector section exists and each case's `expectedKey` matches a TS evaluator `resolveCtaLabelKey(node, selectedView)` you add to `variables.ts` or a new `cta.ts` in shared/paywall: `(node: { labelKey: string; trialLabelKey?: string }, selected: { introPeriod?: string } | null) => string`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** schema + tables + `resolveCtaLabelKey` + fixtures.
- [ ] **Step 4: Run** the full shared suite — pure-append on existing tests (zero removed lines in validate.test.ts). Mutation-check: invert the introPeriod gate in `resolveCtaLabelKey` — the vector loop must go red; restore.
- [ ] **Step 5: Commit:** `feat(shared): trial-aware purchase button label (trialLabelKey)`

### Task 10: Web renderer trial label

**Files:**
- Modify: `packages/paywall-renderer/src/nodes.tsx` (the purchaseButton render branch)
- Test: `packages/paywall-renderer/src/renderer.test.tsx` (append) — run the shared `trialLabel` vector loop against the real rendered output.

**Interfaces:** consumes `resolveCtaLabelKey` from `@rovenue/shared/paywall` (Task 9) — the renderer must call the shared evaluator, not reimplement the branch. Selected view = the same `resolvePackageView(ctx.offering, ctx.priceView, selectedPackageId)` the packageList uses.

- [ ] Steps: failing vector-loop test (assert the button's text resolves through `expectedKey` for each case, driving `priceView` fixtures with/without `introPeriod`) → verify fail → implement (swap the hardcoded `node.labelKey` for `resolveCtaLabelKey(node, selectedView)`) → full paywall-renderer suite green → commit `feat(paywall-renderer): trial-aware purchase button label`.

### Task 11: SwiftUI trial label

**Files:** `packages/sdk-swift/Sources/Rovenue/PaywallUI/BuilderConfigModel.swift` (PurchaseButtonProps: `let trialLabelKey: String?` + init + CodingKeys + decodeIfPresent — all four dimensions), `RovenuePaywallView.swift` (CTA label resolution), `Tests/RovenueTests/BuilderConfigModelTests.swift` (vector loop over the fixtures `trialLabel` section + decode-retention test).
**Interfaces:** port `resolveCtaLabelKey` semantics byte-for-byte (a `ctaLabelKey(props:selectedView:)` helper next to the existing PackageView helpers); selection source = the same selected `PackageView` the packageList binding uses; `introPeriod` non-nil-and-non-empty is the gate (match the TS truthiness on empty string: empty → NOT a trial).
- [ ] Steps: failing tests (13-vector-style loop naming each case + decodeIfPresent retention on purchaseButton) → `swift test` fail → implement → `swift test` green → mutation-check (invert the gate → vector test red, restore) → commit `feat(sdk-swift): trial-aware purchase button label`.

### Task 12: Android trial label

**Files:** `packages/sdk-kotlin/.../paywallui/BuilderConfigModel.kt` (PurchaseButton props + lenient decode), `NodeViewFactory.kt` (CTA label resolution via a `ctaLabelKey(node, selectedView)` helper in `PaywallHelpers.kt`), tests `BuilderConfigModelTest.kt` (vector loop + decode retention) and `NodeViewFactoryTest.kt`.
**Interfaces:** same semantics as Tasks 10-11; verify with `./gradlew testDebugUnitTest` (NOT compile — compile misses red tests).
- [ ] Steps: failing tests → run fail → implement → `testDebugUnitTest` BUILD SUCCESSFUL → mutation-check → commit `feat(sdk-kotlin): trial-aware purchase button label`.

### Task 13: purchaseButton Binding tab + i18n migration

**Files:**
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/tabs.ts` (binding `appliesTo` gains `"purchaseButton"` — re-read the file first, wave B edited it)
- Modify: `apps/dashboard/src/components/paywall-builder/inspector/binding-tab.tsx` (new `case "purchaseButton":` → `PurchaseButtonBinding`)
- Modify: `apps/dashboard/src/i18n/locales/en.json` (ALL new P6 keys from Tasks 7, 8 and this task — this task owns the migration; grep the P6 components for `t("` calls whose keys are missing from en.json and add every one)
- Test: `binding-tab.test.tsx` (append), the tabs test file wave B/P5a maintains (`inspector/tabs.test.ts` — assert binding now applies to purchaseButton)

**Interfaces:** consumes `vm.updateNode<PurchaseButtonNode>`; `PurchaseButtonNode.trialLabelKey` (Task 9).

`PurchaseButtonBinding` renders: a Section "Purchase" with static copy `t("paywalls.builder.properties.purchaseBinding", "Purchases the selected package.")`; a "Trial-aware label" localized-key input mirroring how the Content tab edits `labelKey` (same input component + key-editing affordance — read `content-tab.tsx` and reuse its idiom), writing `set({ trialLabelKey: value || undefined })` (empty clears the field entirely — never store `""`).

- [ ] Steps: failing tests (purchaseButton gets a Binding tab; input writes/clears `trialLabelKey`; tabs.ts appliesTo assertion) → verify fail → implement → run the full dashboard paywall-builder suite at baseline → grep-audit `t("paywalls.builder` keys vs en.json for the whole P6 surface → commit `feat(dashboard): purchase button binding tab and P6 i18n keys`.

---

## Final verification (controller, after Task 13)

- [ ] `pnpm --filter @rovenue/shared exec vitest run` · `pnpm --filter @rovenue/paywall-renderer exec vitest run` · `pnpm --filter @rovenue/api exec vitest run src/services src/routes/dashboard/offerings.resolved.test.ts` · dashboard paywall-builder suite at the 10-failure repo baseline · `swift test` · `testDebugUnitTest` · tsc clean on shared/api/dashboard/paywall-renderer.
- [ ] Request the whole-feature review per superpowers:requesting-code-review (skip the second code-quality pass per standing preference).
