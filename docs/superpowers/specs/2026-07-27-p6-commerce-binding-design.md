# P6 — Commerce Binding UX (design)

**Date:** 2026-07-27
**Phase:** P6 of the paywall-builder gap-analysis plan (`2026-07-23-paywall-builder-gap-analysis.md` §7), scope per §5.3 option (c) / §8 decision 2.
**Status:** Approved design. Feeds an implementation plan.

## 1. What changed since the gap analysis

Two findings revise the P6 premise recorded in P1 and P5a:

1. **§6.11 was struck for the wrong generality.** P1 proved the resolve endpoint cannot be built *from the database* (`products` has no price/period/trial — `packages/db/src/drizzle/schema.ts:599-637` confirms), and the P5a scoping note hardened that into "cannot exist server-side". But server-side ≠ database-side:
   - **Stripe** already has a live server-side resolver — `apps/api/src/services/stripe/price-resolver.ts` returns `unitAmount/currency/interval/intervalCount/trialDays` per package from the connected account, Redis-cached (300s). The funnel runner uses it in production.
   - **Apple** — `apps/api/src/services/apple/app-store-connect.ts` already mints ASC API JWTs from `appleCredentials` (`keyId/issuerId/privateKey/bundleId`, optional fields validated in `apps/api/src/lib/project-credentials.ts`) and lists the catalog for product import. The same key can read subscription price points and intro offers.
   - **Google** — `apps/api/src/services/google/google-play-catalog.ts` already calls `monetization/v3 subscriptions.list` with the stored service account; that response *already contains* `basePlans[]` with `regionalConfigs` (price) and `billingPeriodDuration`. Today the code discards everything but `productId`/name.

   **Decision (user, 2026-07-27): fetch real prices from the store APIs.** No author-entered preview metadata; no new credential fields or forms — reuse what exists, degrade per store when unconfigured (the `STORE_NOT_CONFIGURED` pattern in `apps/api/src/services/store-catalog.ts`).

2. **P4b wave B runs in parallel on this repo.** Its remaining tasks own `inspector/tabs.ts`, `en.json`, `content-tab.tsx`, `style-tab.tsx`, `overrides.tsx`, `paywall-renderer/src/nodes.tsx`, and the Swift/Kotlin `BuilderConfigModel`/render files. **Decision (user): partial parallel** — P6 work that avoids those files starts immediately; everything touching them or `packages/shared/src/paywall` is planned as explicitly wave-B-gated tasks.

## 2. Scope

Delivers gap-analysis row C ergonomics on the existing Offering/Package wire (option (c), already accepted in §8):

- A resolve endpoint returning real per-package price/period/trial per store.
- Binding-tab redesign: period presets, `defaultPeriod` ergonomics, per-store resolved readout.
- Canvas preview upgraded from hardcoded placeholder prices to resolved prices when available.
- `purchaseButton.trialLabelKey` (trial-aware CTA label) across schema + three renderers — **wave-B-gated**.

Out of scope: any wire change to `packageList` (`packageIds`/`defaultSelected` stay the stored form); an "inherit selected plan" toggle (YAGNI — `purchaseButton` already purchases the selected package unconditionally); a persisted price table or background sync; non-US regional price display; consumable/one-time price fetch from Apple/Google (subscriptions only in v1 — see §3.4).

## 3. API — the resolve endpoint

### 3.1 Route

`GET /dashboard/projects/:projectId/offerings/:offeringId/resolved` (dashboard-auth, same middleware as the existing offerings detail route). Response `{ data: OfferingResolvedPrices }`. Unknown offering → 404 (this is a dashboard route; the "never 404" rule is for `/v1/placements` only).

### 3.2 DTO (`packages/shared/src/dashboard.ts` — a file wave B does not touch)

```ts
type ResolvedStoreStatus = "ok" | "not_configured" | "no_mapping" | "error";

interface ResolvedStorePrice {
  status: "ok";
  amountMinor: number;      // minor units, store-reported
  currency: string;         // ISO 4217
  period: string | null;    // ISO-8601 duration (P1W/P1M/P1Y/…); null = one-time
  trialDays: number | null;
}

type ResolvedStoreEntry = ResolvedStorePrice | { status: Exclude<ResolvedStoreStatus, "ok"> };

interface ResolvedPackageInfo {
  packageIdentifier: string;
  productId: string;
  displayName: string;
  stores: { apple?: ResolvedStoreEntry; google?: ResolvedStoreEntry; stripe?: ResolvedStoreEntry };
}

interface OfferingResolvedPrices {
  offeringId: string;
  packages: ResolvedPackageInfo[];
  fetchedAt: string; // ISO timestamp (server clock) — the UI shows staleness, cache decides freshness
}
```

A store key is present iff the package's product has a mapping for it (`storeIds.apple` / `storeIds.google` + `androidBasePlanId` / `storeIds.stripe`); a mapped-but-unreadable store reports `no_mapping`/`error`/`not_configured` instead of being omitted, so the UI can say *why* a price is absent. Minor-unit → display conversion on the dashboard uses the Stripe minor-unit table convention already established (see the `stripe_minor_unit_scale` rule) for Stripe amounts; Apple/Google amounts arrive as decimal strings and are converted to minor units by the resolver, not the UI.

### 3.3 Resolvers (new `apps/api/src/services/offering-price-resolver.ts` orchestrator)

Per-store isolation is a hard requirement: one store throwing yields `{ status: "error" }` for that store on every package, never a failed response (mirrors `resolveFunnelPrices`'s "a Stripe outage degrades to no prices, not no paywall").

- **Stripe:** delegate to the existing `resolvePricesForPackages` (`price-resolver.ts`) unchanged; map `ResolvedPrice` → `ResolvedStorePrice` (`interval`+`intervalCount` → ISO-8601 period).
- **Google:** extend `google-play-catalog.ts` (or a sibling `google-play-prices.ts` if the extension muddies the catalog function) to surface, per subscription productId + basePlanId: `billingPeriodDuration` (already ISO-8601), the **US** `regionalConfigs` price falling back to `otherRegionsConfig`, and trial days from the base plan's zero-price intro offer if one exists. Uses the same paged `subscriptions.list` call — no new Google endpoint. Product→plan mapping: `storeIds.google` + `products.androidBasePlanId` (nullable; null → `no_mapping`).
- **Apple:** extend `app-store-connect.ts` with subscription price reads: resolve the subscription resource by product id (via the app's subscription groups, as the catalog listing already does), then `GET /v1/subscriptions/{id}/prices?filter[territory]=USA&include=subscriptionPricePoint` for the current price, and `introductoryOffers` for trial length. `FREE_TRIAL` intro offers map to `trialDays`; paid intro offers are ignored in v1 (readout shows price + trial only).
- **Reference region:** USA for Apple and Google, named constant `RESOLVED_PRICE_REFERENCE_TERRITORY`. The UI labels the readout "US reference price". Stripe has a single price per Price object — no region concept.

### 3.4 Product-type boundary

Apple/Google resolution covers **subscriptions** in v1. Consumable/non-consumable mappings return `{ status: "no_mapping" }` from those two resolvers (their price APIs differ enough to be a follow-up); Stripe resolves one-time prices already (`interval: null`) and keeps doing so.

### 3.5 Caching

Apple and Google results cached in Redis per `(projectId, store)` — key shape `paywall:resolved:{store}:{projectId}:{offeringId}` — with a named-constant TTL of 15 minutes (`RESOLVED_PRICE_CACHE_TTL_SECONDS = 900`). Stripe keeps its existing 300s cache inside `price-resolver.ts` (do not double-cache). Cache stores the successful payload only; errors are never cached (a transient store failure must not pin "error" for 15 minutes).

## 4. Authoring UX — Binding tab redesign

All in `apps/dashboard/src/components/paywall-builder/inspector/binding-tab.tsx` + new sibling modules + `apps/dashboard/src/lib/services/paywall-builder-api.ts` (adds `fetchOfferingResolvedPrices`) + the VM. None of these files are in wave B's task list.

### 4.1 Data flow

The VM fetches resolved prices alongside `offeringPackageIds` (non-blocking: the tab renders ids immediately, prices hydrate in). Fetch failure degrades to today's id-only UI — the readout is an enhancement layer, never a gate.

### 4.2 Package rows

Each offering package renders as a row: checkbox (membership in `packageIds`, as today) + `displayName` + a **period chip** + per-store price badges:

- Period chip: derived from resolved periods; if stores disagree on period, the chip shows the majority period plus a warning icon with a tooltip naming the disagreement. If nothing resolved, falls back to `products.metadata.period` (the existing `durationFromRow` convention in `dashboard-mappers.ts`); if that's absent too, no chip.
- Store badges: `"$9.99 · 7d trial"` for `ok`; muted `"not configured"` / `"no mapping"` / `"unavailable"` otherwise. Raw package identifier stays visible in small mono type (it is the stored value and the debugging handle).

### 4.3 Period presets and defaultPeriod

Presets are **authoring macros over `packageIds`/`defaultSelected`** — no schema change, per §8 decision 2:

- Preset chips (e.g. Monthly, Annual, Monthly + Annual, All) are generated from the distinct periods available in the offering. Clicking one sets `packageIds` to the packages matching those periods (offering order preserved) and repairs `defaultSelected` if it fell out. A hand-edited selection that matches no preset shows as "Custom" (no chip active).
- **Default plan** control becomes period-first: a select listing the chosen packages as "Monthly — $9.99" style labels (falling back to bare ids when unresolved). It writes `defaultSelected` exactly as today. There is no stored `defaultPeriod` field — the period is presentation over the selected package.

### 4.4 Canvas — real prices in the preview

`apps/dashboard/src/components/paywall-builder/canvas-helpers.ts`: when resolved data is available for a package, build its `PackageView` from it — formatted price, `period`, and derived `pricePerDay/Week/Month/Year` + `relativeDiscount` (reuse the exact derivation formula the SDKs use in `PackageViewMapping.swift`/`.kt` and the web consumers, so the canvas matches devices). Unresolved packages keep the existing `PLACEHOLDER_PRICES` cycle. The canvas badge (canvas.tsx:337) becomes dynamic: "Preview — live store prices (US)" when every rendered package resolved, "Preview — placeholder prices" otherwise. `canvas.tsx`/`canvas-helpers.ts` are outside wave B's file set.

Formatting: `Intl.NumberFormat` with the store-reported currency — display only, never arithmetic (arithmetic stays in minor units).

## 5. `purchaseButton.trialLabelKey` — wave-B-gated

Schema (`packages/shared/src/paywall/schema.ts` + `validate.ts`), all three renderers, and fixtures — every file here is either wave B's or mirrors into wave B's Swift/Kotlin compiles, so these tasks are ordered **after wave B lands** in the plan.

- **Schema:** optional `trialLabelKey?: string` on `purchaseButtonNode` (type + Zod). `LOCALIZED_KEYS.purchaseButton` becomes `(n) => n.trialLabelKey ? [n.labelKey, n.trialLabelKey] : [n.labelKey]` — which automatically enrolls it in `UNKNOWN_LOC_KEY`, `EMPTY_LOC_VALUE`, and `LOCALE_KEY_GAP`. `OVERRIDABLE_PROP_KEYS.purchaseButton` gains `trialLabelKey` next to `labelKey`.
- **Render rule (identical on web / SwiftUI / Android Views):** if the node has `trialLabelKey` AND the *selected* package's `PackageView.introPeriod` is non-empty, render `trialLabelKey`; else `labelKey`. Selection means the same package the button would purchase (global selection; inside a cellTemplate the button is already forbidden by `CELL_TEMPLATE_BAD_NODE`, so no cell-scoped case exists).
- **Contract:** new `render-fixtures.json` entries — an accept fixture carrying `trialLabelKey`, plus resolve-vector-style cases pinning: trial-selected → trial label, no-trial-selected → base label, `trialLabelKey` absent → base label, lenient decoders retain the field. Three-platform contract (RN hosts the natives).
- **Binding tab for purchaseButton:** `tabs.ts` `binding.appliesTo` gains `purchaseButton`; the tab shows the implicit binding ("Purchases the selected package") as static copy + the trial-label field (a localized-key input like Content's labelKey editor). New `en.json` keys land in this task too.

## 6. Validation

No new validator codes. `trialLabelKey` rides the existing localization checks via `LOCALIZED_KEYS` (above). Period-mismatch across stores is a UI tooltip, not a validator issue — it is store data, invisible to the offline validator, and must not gate save/publish (the save-gate lesson from P2-FIX II).

## 7. Testing

- **Resolvers:** unit tests with injected `fetchImpl` per the existing `google-play-catalog.test.ts` / `app-store-connect.test.ts` pattern — price extraction (US region fallback to otherRegions), trial mapping, ISO-period passthrough, `no_mapping`/`not_configured` paths. Stripe mapper test over a canned `ResolvedPrice`.
- **Orchestrator/route:** per-store isolation (Apple throws → apple `error`, google/stripe `ok`), error-not-cached behaviour, 404 on foreign offering.
- **Dashboard:** binding-tab tests — preset click writes `packageIds` + repairs `defaultSelected`; custom selection deactivates chips; unresolved fallback renders id-only rows. Canvas-helper test: resolved → `PackageView` derivation matches the SDK formula on a fixed case; unresolved keeps placeholders; badge text switches.
- **Wave-B-gated:** shared validator tests for the `LOCALIZED_KEYS` change; renderer trial-label tests on all three platforms against the new fixture vectors; mutation-check that removing the introPeriod gate fails the trial-selected vector.

## 8. Sequencing (collision contract with P4b wave B)

Start now (no wave B files): `offering-price-resolver.ts` + store-service extensions + route + DTO; `binding-tab.tsx` redesign + `paywall-builder-api.ts` + VM fetch; `canvas-helpers.ts`/`canvas.tsx`. **`en.json` is a wave B file, so new binding-tab/canvas copy ships as plain strings in the immediate tasks** (the same call wave B's row-list editor made) **and the gated §5 task migrates all of it to `en.json` in one edit.** That task owns the migration explicitly so the strings don't ship untranslated with no owner.

Gated on wave B landing: everything in §5 (shared schema, three renderers, fixtures, `tabs.ts`, `en.json`). The plan must restate this as a hard precondition per task, plus the standing constraints: stay on the current branch, no worktrees, no parallel implementer dispatch, named constants for every literal (TTLs, territory, badge strings via i18n where available).
