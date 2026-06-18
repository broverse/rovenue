# Auto-fetch product catalog from store APIs

**Date:** 2026-06-18
**Status:** Approved — ready for implementation plan

## Problem

The "Import from store" modal makes the user **paste** store product identifiers by
hand. We want the modal to **pull the product catalog directly from the store APIs**
(Apple App Store Connect, Google Play) so the user just selects which products to
import.

## Decisions

- **UX:** Auto-fetch the catalog as soon as the modal opens (and on store change). No
  extra "Fetch" button.
- **Stores in scope:** iOS (Apple App Store Connect API) + Android (Google Play
  Developer API). Web/Stripe keep the existing manual-paste path.
- **Apple credentials:** Reuse the existing `appleCredentials`
  (`keyId` / `issuerId` / `privateKey` / `appAppleId`). The stored key **must have App
  Store Connect API access** — distinct from the App Store Server API (In-App Purchase)
  key the receipt verifier uses. If the key lacks access, the fetch surfaces a clear
  error rather than failing silently. A dedicated App Store Connect credential type is
  out of scope for this pass.
- **Import path:** Unchanged. The existing
  `POST /dashboard/projects/:id/products/import` endpoint and `bulkCreateProducts` repo
  receive only the user-selected items.

## Constraint background (why Apple needs care)

- **App Store Server API** (`api.storekit.itunes.apple.com`) verifies
  transactions/subscription status — it **cannot list an app's products**.
- **App Store Connect API** (`api.appstoreconnect.apple.com`) lists IAPs and
  subscription groups. Same ES256 key mechanism, but `aud: appstoreconnect-v1` and
  typically a different API key (App Store Connect access).
- Google Play: the existing service account can call `inappproducts.list` +
  `monetization.subscriptions.list` with the stored `packageName`.

## Data flow

```
Modal opens (store=ios|android)
        │  auto-fetch
        ▼
GET /dashboard/projects/:id/products/store-catalog?store=ios|android
        │
        ▼  store-catalog.ts (dispatcher)
   ┌────┴─────────────────────────┐
  ios                            android
app-store-connect.ts        google-play-catalog.ts
 (ASC API, ES256 JWT)        (Play Dev API, SA OAuth token)
        │                            │
        └──────────┬─────────────────┘
                   ▼
   normalized list [{ storeId, type, name, priceLabel?, alreadyImported }]
                   ▼
   Modal renders selectable list → user checks items →
   existing POST /products/import (unchanged)
```

## Components

### Backend — new modules

- **`apps/api/src/services/apple/app-store-connect.ts`**
  - Mint an App Store Connect JWT: header `{ alg: ES256, kid: keyId, typ: JWT }`,
    payload `{ iss: issuerId, iat, exp, aud: "appstoreconnect-v1" }`. Keep separate from
    `apple-auth.ts` (which mints App Store Server tokens).
  - Resolve the app id via `GET /v1/apps?filter[bundleId]={bundleId}` when `appAppleId`
    is absent; otherwise use `appAppleId` directly.
  - List products:
    - `GET /v1/apps/{id}/inAppPurchasesV2?limit=200` → `attributes.productId`,
      `attributes.name`, `attributes.inAppPurchaseType`.
    - `GET /v1/apps/{id}/subscriptionGroups?include=subscriptions` → each subscription's
      `attributes.productId`, `attributes.name`.
  - Paginate via `links.next`.
  - Type mapping: subscriptions → `SUBSCRIPTION`; `CONSUMABLE` → `CONSUMABLE`;
    `NON_CONSUMABLE` → `NON_CONSUMABLE`; `NON_RENEWING_SUBSCRIPTION` → `NON_CONSUMABLE`.

- **`apps/api/src/services/google/google-play-catalog.ts`**
  - Reuse the existing service-account OAuth token (scope
    `https://www.googleapis.com/auth/androidpublisher`).
  - List `applications/{packageName}/monetization/subscriptions` (→ `productId`,
    `listings[].title`) and `applications/{packageName}/inappproducts` (managed
    products → `sku`, `purchaseType`).
  - Type mapping: subscriptions → `SUBSCRIPTION`; managed products → `CONSUMABLE` /
    `NON_CONSUMABLE` per `purchaseType` (default `NON_CONSUMABLE`).

- **`apps/api/src/services/store-catalog.ts`**
  - Dispatcher. Loads credentials via `project-credentials.ts`, calls the right module,
    normalizes results, and sets `alreadyImported` by cross-referencing existing
    products' `storeIds` for the requested store.

### Backend — endpoint

Modify `apps/api/src/routes/dashboard/products.ts`:

- `GET /products/store-catalog?store=ios|android` — VIEWER+ read.
- Response: `{ data: { items: StoreCatalogItem[] } }` where
  `StoreCatalogItem = { storeId, type, name, priceLabel?, alreadyImported }`.
- Errors (per the `{ error: { code, message } }` convention):
  - `CREDENTIALS_NOT_CONFIGURED` (400) — no Apple/Google creds for this store.
  - `STORE_API_ERROR` (502) — upstream failure; pass the upstream message through
    (covers the "Apple key lacks App Store Connect access" 401 case).

### Frontend

Modify `apps/dashboard/src/lib/hooks/useProjectProducts.ts`:

- Add `useStoreCatalog(projectId, store)` query that fires on open and on store change.

Modify `apps/dashboard/src/components/products/import-from-store-modal.tsx`:

- Replace the paste textarea (for ios/android) with:
  - Loading skeleton while fetching.
  - On success: a selectable list grouped by product type — checkbox per row showing
    name + storeId + price; "select all"; already-imported rows checked-and-disabled.
  - On error: inline message with a link to credential settings.
- "Import N products" calls the existing import endpoint with the **selected** items.

### Shared types + i18n

- Add `DashboardStoreCatalogResponse` / `StoreCatalogItem` to `packages/shared`.
- New `en.json` keys: loading, empty, error states, "Fetched from store", select-all.

## Error handling

- Missing creds → `CREDENTIALS_NOT_CONFIGURED` → modal shows "Connect your store
  credentials" with a settings link.
- Upstream 401/403 (e.g. Apple key without ASC access) → `STORE_API_ERROR` with the
  upstream message → modal shows the message and the settings link.
- Empty catalog → friendly empty state.

## Testing

- Unit: Apple type mapping + pagination against mocked ASC payload fixtures.
- Unit: Google type mapping against mocked Play payload fixtures.
- Unit: `alreadyImported` cross-referencing in `store-catalog.ts`.
- Unit/route: `CREDENTIALS_NOT_CONFIGURED` when creds are absent.

## Out of scope

- Web / Stripe catalog fetch (manual paste retained).
- Price / localization sync into product records.
- Writing back to the store.
- A dedicated App Store Connect credential type (reuse `appleCredentials` for now).
