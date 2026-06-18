# Auto-fetch product catalog from store APIs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual paste textarea in the "Import from store" modal (for iOS/Android) with an auto-fetched, selectable product catalog pulled live from the Apple App Store Connect API and Google Play Developer API.

**Architecture:** A new `store-catalog` dispatcher in `apps/api` loads the project's existing per-store credentials, calls a store-specific lister (App Store Connect for iOS, Google Play for Android), and returns a normalized, de-duplicated list with an `alreadyImported` flag computed against existing products. A new `GET .../products/store-catalog` endpoint exposes it. The dashboard modal auto-fetches on open and on store change, renders a checkbox list, and sends the selected items to the **unchanged** `POST .../products/import` endpoint.

**Tech Stack:** Hono + Zod (API), Drizzle (DB reads), `jose` (Apple ES256 JWT), `google-auth-library` (Google OAuth token), React + TanStack Query + react-i18next (dashboard), Vitest.

## Global Constraints

- TypeScript strict mode everywhere; no `any` leaks across module boundaries.
- All API responses use the `{ data }` / `{ error: { code, message } }` envelope via `ok()` / `fail()` from `apps/api/src/lib/response.ts`.
- New error codes MUST be added to `ERROR_CODE` in `packages/shared/src/index.ts` before they can be returned (the union is closed).
- Stores in scope: `ios`, `android` only. `web` keeps the existing manual-paste path untouched.
- Apple: reuse existing `appleCredentials` (`keyId`/`issuerId`/`privateKey`/`appAppleId`/`bundleId`). The stored key must have **App Store Connect API** access; on 401/403 surface the upstream message under `STORE_API_ERROR`.
- The import path (`POST /products/import`, `bulkCreateProducts`) is NOT modified.
- Barrel exports: register new service files where the package uses index barrels (Apple/Google service dirs export through their callers, not a barrel — follow the existing pattern of importing the module directly).
- Conventional commits (`feat:`, `test:`, `fix:`).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/shared/src/dashboard.ts` (modify) | `StoreCatalogItem`, `DashboardStoreCatalogResponse` wire types |
| `packages/shared/src/index.ts` (modify) | Add `STORE_NOT_CONFIGURED`, `STORE_API_ERROR` error codes |
| `apps/api/src/services/apple/app-store-connect.ts` (create) | Mint ASC JWT, resolve app, list IAPs + subscriptions, map types |
| `apps/api/src/services/google/google-play-catalog.ts` (create) | List Play subscriptions + managed products, map types |
| `apps/api/src/services/store-catalog.ts` (create) | Dispatcher: load creds → call lister → normalize → mark `alreadyImported`; `StoreCatalogError` |
| `apps/api/src/routes/dashboard/products.ts` (modify) | `GET /store-catalog` endpoint |
| `apps/dashboard/src/lib/hooks/useProjectProducts.ts` (modify) | `useStoreCatalog` query hook |
| `apps/dashboard/src/components/products/import-from-store-modal.tsx` (modify) | Auto-fetch + selectable list UI |
| `apps/dashboard/src/i18n/locales/en.json` (modify) | `products.import.catalog.*` keys |

---

## Task 1: Shared wire types + error codes

**Files:**
- Modify: `packages/shared/src/index.ts:5-20` (ERROR_CODE map)
- Modify: `packages/shared/src/dashboard.ts:1483` (after `DashboardProductImportResponse`)
- Test: `packages/shared/src/__tests__/store-catalog.test.ts` (create)

**Interfaces:**
- Produces:
  - `ERROR_CODE.STORE_NOT_CONFIGURED = "STORE_NOT_CONFIGURED"`, `ERROR_CODE.STORE_API_ERROR = "STORE_API_ERROR"`
  - `StoreCatalogItem = { storeId: string; type: ProductTypeName; name: string; priceLabel?: string; alreadyImported: boolean }`
  - `DashboardStoreCatalogResponse = { items: StoreCatalogItem[] }`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/store-catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ERROR_CODE } from "../index";
import type { StoreCatalogItem, DashboardStoreCatalogResponse } from "../dashboard";

describe("store catalog shared contracts", () => {
  it("exposes the new store error codes", () => {
    expect(ERROR_CODE.STORE_NOT_CONFIGURED).toBe("STORE_NOT_CONFIGURED");
    expect(ERROR_CODE.STORE_API_ERROR).toBe("STORE_API_ERROR");
  });

  it("StoreCatalogItem shape compiles and round-trips", () => {
    const item: StoreCatalogItem = {
      storeId: "com.acme.pro_monthly",
      type: "SUBSCRIPTION",
      name: "Pro Monthly",
      alreadyImported: false,
    };
    const res: DashboardStoreCatalogResponse = { items: [item] };
    expect(res.items[0]?.storeId).toBe("com.acme.pro_monthly");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/shared test -- store-catalog`
Expected: FAIL — `STORE_NOT_CONFIGURED` is `undefined` and the type imports don't resolve.

- [ ] **Step 3: Add the error codes**

In `packages/shared/src/index.ts`, inside the `ERROR_CODE` object (after `API_KEY_KIND_MISMATCH`):

```ts
  API_KEY_KIND_MISMATCH: "API_KEY_KIND_MISMATCH",
  STORE_NOT_CONFIGURED: "STORE_NOT_CONFIGURED",
  STORE_API_ERROR: "STORE_API_ERROR",
```

- [ ] **Step 4: Add the wire types**

In `packages/shared/src/dashboard.ts`, immediately after the `DashboardProductImportResponse` interface (line ~1483):

```ts
/** One product as listed by a store's catalog API. */
export interface StoreCatalogItem {
  /** Per-store SKU / product id (e.g. App Store Connect `productId`). */
  storeId: string;
  /** Mapped product type. */
  type: ProductTypeName;
  /** Human-readable reference name from the store. */
  name: string;
  /** Optional formatted price, when the store API surfaces one. */
  priceLabel?: string;
  /** True when a product with this `storeId` already exists for the store. */
  alreadyImported: boolean;
}

export interface DashboardStoreCatalogResponse {
  items: StoreCatalogItem[];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rovenue/shared test -- store-catalog`
Expected: PASS (both tests).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @rovenue/shared build
git add packages/shared/src/index.ts packages/shared/src/dashboard.ts packages/shared/src/__tests__/store-catalog.test.ts
git commit -m "feat(shared): store catalog wire types + error codes"
```

---

## Task 2: App Store Connect catalog lister

**Files:**
- Create: `apps/api/src/services/apple/app-store-connect.ts`
- Test: `apps/api/src/services/apple/app-store-connect.test.ts`

**Interfaces:**
- Consumes: `AppleCredentials` (from `apps/api/src/lib/project-credentials.ts` — `{ bundleId, appAppleId?, keyId?, issuerId?, privateKey? }`), `importPKCS8` + `SignJWT` from `jose`.
- Produces:
  - `interface AppStoreConnectConfig { keyId: string; issuerId: string; privateKey: string; bundleId: string; appAppleId?: number }`
  - `class StoreApiError extends Error { constructor(message: string, status?: number) }`
  - `async function listAppStoreCatalog(config: AppStoreConnectConfig, fetchImpl?: typeof fetch): Promise<RawCatalogItem[]>` where `RawCatalogItem = { storeId: string; type: "SUBSCRIPTION" | "CONSUMABLE" | "NON_CONSUMABLE"; name: string }`

**Notes for the implementer:**
- App Store Connect API base: `https://api.appstoreconnect.apple.com`. JWT payload is `{ iss, iat, exp, aud: "appstoreconnect-v1" }` signed ES256 with `kid: keyId` — do NOT add the `bid` claim (that is an App Store *Server* API concern; the existing `apple-auth.ts` is for that API and must stay separate).
- Resolve numeric app id: if `config.appAppleId` is set, use it; else `GET /v1/apps?filter[bundleId]={bundleId}&limit=1` → `data[0].id`. If empty, throw `StoreApiError("No app found for bundle id ...")`.
- IAPs: `GET /v1/apps/{id}/inAppPurchasesV2?limit=200`. Each `data[i].attributes`: `{ productId, name, inAppPurchaseType }`. Map `inAppPurchaseType`: `CONSUMABLE` → `CONSUMABLE`; `NON_CONSUMABLE` → `NON_CONSUMABLE`; `NON_RENEWING_SUBSCRIPTION` → `NON_CONSUMABLE`.
- Subscriptions: `GET /v1/apps/{id}/subscriptionGroups?include=subscriptions&limit=200`. The included subscriptions are in the top-level `included[]` array with `type: "subscriptions"`; each `attributes`: `{ productId, name }`. Map → `SUBSCRIPTION`.
- Pagination: follow `links.next` (an absolute URL) until absent, for every list call.
- On any non-2xx: throw `StoreApiError(<body text or statusText>, status)`.
- Accept an injectable `fetchImpl` (default global `fetch`) so tests don't touch the network.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/apple/app-store-connect.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { listAppStoreCatalog } from "./app-store-connect";

// A throwaway PKCS8 EC P-256 key for signing in tests (not a real secret).
const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;

const config = {
  keyId: "ABC1234567",
  issuerId: "11111111-2222-3333-4444-555555555555",
  privateKey: TEST_P8,
  bundleId: "com.acme.app",
  appAppleId: 1234567890,
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("listAppStoreCatalog", () => {
  it("maps IAP types and subscriptions, no pagination", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/inAppPurchasesV2")) {
        return jsonResponse({
          data: [
            { attributes: { productId: "coins_100", name: "100 Coins", inAppPurchaseType: "CONSUMABLE" } },
            { attributes: { productId: "remove_ads", name: "Remove Ads", inAppPurchaseType: "NON_CONSUMABLE" } },
          ],
          links: {},
        });
      }
      if (u.includes("/subscriptionGroups")) {
        return jsonResponse({
          data: [{ id: "grp1" }],
          included: [
            { type: "subscriptions", attributes: { productId: "pro_monthly", name: "Pro Monthly" } },
          ],
          links: {},
        });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const items = await listAppStoreCatalog(config, fetchImpl as unknown as typeof fetch);

    expect(items).toEqual(
      expect.arrayContaining([
        { storeId: "coins_100", type: "CONSUMABLE", name: "100 Coins" },
        { storeId: "remove_ads", type: "NON_CONSUMABLE", name: "Remove Ads" },
        { storeId: "pro_monthly", type: "SUBSCRIPTION", name: "Pro Monthly" },
      ]),
    );
    expect(items).toHaveLength(3);
  });

  it("throws StoreApiError on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ detail: "Forbidden" }] }, false, 403));
    await expect(
      listAppStoreCatalog(config, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/403|Forbidden/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- app-store-connect`
Expected: FAIL — module `./app-store-connect` not found.

- [ ] **Step 3: Implement the lister**

Create `apps/api/src/services/apple/app-store-connect.ts`:

```ts
import { SignJWT, importPKCS8 } from "jose";
import { logger } from "../../lib/logger";

const log = logger.child("app-store-connect");

const BASE_URL = "https://api.appstoreconnect.apple.com";
const AUDIENCE = "appstoreconnect-v1";
const ALG = "ES256";
const TOKEN_LIFETIME_SECONDS = 60 * 5; // ASC tokens may live up to 20m; 5m is plenty.

export interface AppStoreConnectConfig {
  keyId: string;
  issuerId: string;
  /** PKCS8 PEM contents of the .p8 file. */
  privateKey: string;
  bundleId: string;
  /** Numeric App Store app id; resolved from bundleId when absent. */
  appAppleId?: number;
}

export type RawCatalogType = "SUBSCRIPTION" | "CONSUMABLE" | "NON_CONSUMABLE";

export interface RawCatalogItem {
  storeId: string;
  type: RawCatalogType;
  name: string;
}

export class StoreApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "StoreApiError";
  }
}

async function mintToken(config: AppStoreConnectConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(config.privateKey, ALG);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, kid: config.keyId, typ: "JWT" })
    .setIssuer(config.issuerId)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_LIFETIME_SECONDS)
    .sign(key);
}

async function ascGet(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<any> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.text();
      if (body) detail = body;
    } catch {
      /* keep statusText */
    }
    throw new StoreApiError(
      `App Store Connect API error (${res.status}): ${detail}`,
      res.status,
    );
  }
  return res.json();
}

/** Follow `links.next` across pages, accumulating `data` and `included`. */
async function ascList(
  firstUrl: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<{ data: any[]; included: any[] }> {
  const data: any[] = [];
  const included: any[] = [];
  let url: string | undefined = firstUrl;
  while (url) {
    const page = await ascGet(url, token, fetchImpl);
    if (Array.isArray(page.data)) data.push(...page.data);
    if (Array.isArray(page.included)) included.push(...page.included);
    url = page.links?.next;
  }
  return { data, included };
}

async function resolveAppId(
  config: AppStoreConnectConfig,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (config.appAppleId) return String(config.appAppleId);
  const url = `${BASE_URL}/v1/apps?filter[bundleId]=${encodeURIComponent(config.bundleId)}&limit=1`;
  const { data } = await ascList(url, token, fetchImpl);
  const id = data[0]?.id;
  if (!id) {
    throw new StoreApiError(`No App Store app found for bundle id ${config.bundleId}`);
  }
  return String(id);
}

function mapIapType(raw: string): RawCatalogType {
  switch (raw) {
    case "CONSUMABLE":
      return "CONSUMABLE";
    case "NON_CONSUMABLE":
    case "NON_RENEWING_SUBSCRIPTION":
      return "NON_CONSUMABLE";
    default:
      return "NON_CONSUMABLE";
  }
}

export async function listAppStoreCatalog(
  config: AppStoreConnectConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<RawCatalogItem[]> {
  const token = await mintToken(config);
  const appId = await resolveAppId(config, token, fetchImpl);

  const iaps = await ascList(
    `${BASE_URL}/v1/apps/${appId}/inAppPurchasesV2?limit=200`,
    token,
    fetchImpl,
  );
  const subs = await ascList(
    `${BASE_URL}/v1/apps/${appId}/subscriptionGroups?include=subscriptions&limit=200`,
    token,
    fetchImpl,
  );

  const items: RawCatalogItem[] = [];

  for (const row of iaps.data) {
    const a = row.attributes ?? {};
    if (!a.productId) continue;
    items.push({
      storeId: a.productId,
      type: mapIapType(a.inAppPurchaseType ?? ""),
      name: a.name ?? a.productId,
    });
  }

  for (const inc of subs.included) {
    if (inc.type !== "subscriptions") continue;
    const a = inc.attributes ?? {};
    if (!a.productId) continue;
    items.push({ storeId: a.productId, type: "SUBSCRIPTION", name: a.name ?? a.productId });
  }

  log.debug("listed app store catalog", { appId, count: items.length });
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- app-store-connect`
Expected: PASS (both tests). If the test P8 key fails to import, replace `TEST_P8` with a freshly generated key: `openssl ecparam -genkey -name prime256v1 -noout | openssl pkcs8 -topk8 -nocrypt` and paste the PEM.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/apple/app-store-connect.ts apps/api/src/services/apple/app-store-connect.test.ts
git commit -m "feat(api): App Store Connect catalog lister"
```

---

## Task 3: Google Play catalog lister

**Files:**
- Create: `apps/api/src/services/google/google-play-catalog.ts`
- Test: `apps/api/src/services/google/google-play-catalog.test.ts`

**Interfaces:**
- Consumes: `getGoogleAccessToken(credentials)` from `apps/api/src/services/google/google-auth.ts`; `GoogleServiceAccountCredentials` from `./google-types`; `StoreApiError`, `RawCatalogItem` from `../apple/app-store-connect.ts`.
- Produces: `async function listGooglePlayCatalog(input: { packageName: string; serviceAccount: GoogleServiceAccountCredentials }, deps?: { fetchImpl?: typeof fetch; getToken?: typeof getGoogleAccessToken }): Promise<RawCatalogItem[]>`

**Notes for the implementer:**
- Base: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}`.
- Subscriptions: `GET .../subscriptions?pageSize=100` → `{ subscriptions: [{ productId, listings: [{ title }] }], nextPageToken }`. Follow `nextPageToken` via `&pageToken=`. Map → `SUBSCRIPTION`, name = first `listings[].title` ?? `productId`.
- Managed (one-time) products: `GET .../inappproducts?maxResults=100` → `{ inappproduct: [{ sku, defaultLanguage, listings: { <lang>: { title } } }], tokenPagination: { nextPageToken } }`. Follow via `&token=`. The legacy API can't distinguish consumable vs non-consumable, so map all → `NON_CONSUMABLE`; name = `listings[defaultLanguage]?.title` ?? `sku`. (Document this as a known limitation: users can change a product's type after import.)
- Non-2xx → `StoreApiError(<status + body>, status)`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/google/google-play-catalog.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { listGooglePlayCatalog } from "./google-play-catalog";

const serviceAccount = {
  client_email: "svc@proj.iam.gserviceaccount.com",
  private_key: "irrelevant — token is mocked",
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("listGooglePlayCatalog", () => {
  it("maps subscriptions and managed products", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/subscriptions")) {
        return jsonResponse({
          subscriptions: [
            { productId: "pro_monthly", listings: [{ title: "Pro Monthly" }] },
          ],
        });
      }
      if (u.includes("/inappproducts")) {
        return jsonResponse({
          inappproduct: [
            { sku: "coins_100", defaultLanguage: "en-US", listings: { "en-US": { title: "100 Coins" } } },
          ],
        });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const items = await listGooglePlayCatalog(
      { packageName: "com.acme.app", serviceAccount },
      { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: async () => "tok" },
    );

    expect(items).toEqual(
      expect.arrayContaining([
        { storeId: "pro_monthly", type: "SUBSCRIPTION", name: "Pro Monthly" },
        { storeId: "coins_100", type: "NON_CONSUMABLE", name: "100 Coins" },
      ]),
    );
    expect(items).toHaveLength(2);
  });

  it("throws StoreApiError on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "denied" } }, false, 401));
    await expect(
      listGooglePlayCatalog(
        { packageName: "com.acme.app", serviceAccount },
        { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: async () => "tok" },
      ),
    ).rejects.toThrow(/401|denied/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- google-play-catalog`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the lister**

Create `apps/api/src/services/google/google-play-catalog.ts`:

```ts
import { logger } from "../../lib/logger";
import { getGoogleAccessToken } from "./google-auth";
import type { GoogleServiceAccountCredentials } from "./google-types";
import { StoreApiError, type RawCatalogItem } from "../apple/app-store-connect";

const log = logger.child("google-play-catalog");

const BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

interface Deps {
  fetchImpl?: typeof fetch;
  getToken?: typeof getGoogleAccessToken;
}

async function gpGet(url: string, token: string, fetchImpl: typeof fetch): Promise<any> {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.text();
      if (body) detail = body;
    } catch {
      /* keep statusText */
    }
    throw new StoreApiError(`Google Play API error (${res.status}): ${detail}`, res.status);
  }
  return res.json();
}

export async function listGooglePlayCatalog(
  input: { packageName: string; serviceAccount: GoogleServiceAccountCredentials },
  deps: Deps = {},
): Promise<RawCatalogItem[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getToken = deps.getToken ?? getGoogleAccessToken;
  const token = await getToken(input.serviceAccount);
  const pkg = encodeURIComponent(input.packageName);
  const items: RawCatalogItem[] = [];

  // Subscriptions (monetization v3).
  let subUrl: string | undefined = `${BASE}/${pkg}/subscriptions?pageSize=100`;
  while (subUrl) {
    const page = await gpGet(subUrl, token, fetchImpl);
    for (const sub of page.subscriptions ?? []) {
      if (!sub.productId) continue;
      items.push({
        storeId: sub.productId,
        type: "SUBSCRIPTION",
        name: sub.listings?.[0]?.title ?? sub.productId,
      });
    }
    subUrl = page.nextPageToken
      ? `${BASE}/${pkg}/subscriptions?pageSize=100&pageToken=${encodeURIComponent(page.nextPageToken)}`
      : undefined;
  }

  // Managed (one-time) products.
  let prodUrl: string | undefined = `${BASE}/${pkg}/inappproducts?maxResults=100`;
  while (prodUrl) {
    const page = await gpGet(prodUrl, token, fetchImpl);
    for (const p of page.inappproduct ?? []) {
      if (!p.sku) continue;
      const lang = p.defaultLanguage as string | undefined;
      const title = (lang && p.listings?.[lang]?.title) || p.sku;
      items.push({ storeId: p.sku, type: "NON_CONSUMABLE", name: title });
    }
    const next = page.tokenPagination?.nextPageToken;
    prodUrl = next
      ? `${BASE}/${pkg}/inappproducts?maxResults=100&token=${encodeURIComponent(next)}`
      : undefined;
  }

  log.debug("listed google play catalog", { packageName: input.packageName, count: items.length });
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- google-play-catalog`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/google/google-play-catalog.ts apps/api/src/services/google/google-play-catalog.test.ts
git commit -m "feat(api): Google Play catalog lister"
```

---

## Task 4: store-catalog dispatcher

**Files:**
- Create: `apps/api/src/services/store-catalog.ts`
- Test: `apps/api/src/services/store-catalog.test.ts`

**Interfaces:**
- Consumes: `loadAppleCredentials`, `loadGoogleCredentials` from `../lib/project-credentials`; `listAppStoreCatalog`, `listGooglePlayCatalog`, `RawCatalogItem`, `StoreApiError`; `drizzle.productRepo.listProducts`; `StoreCatalogItem` from `@rovenue/shared`.
- Produces:
  - `class StoreCatalogError extends Error { code: "STORE_NOT_CONFIGURED" | "STORE_API_ERROR"; status: number }`
  - `async function getStoreCatalog(projectId: string, store: "ios" | "android", overrides?: { listAppStore?: ...; listGooglePlay?: ...; loadApple?: ...; loadGoogle?: ...; listProducts?: ... }): Promise<StoreCatalogItem[]>`

**Notes for the implementer:**
- `overrides` exists purely so the test can inject fakes without network/db. In production all default to the real implementations.
- iOS: `loadAppleCredentials(projectId)`. If null OR missing any of `keyId`/`issuerId`/`privateKey` → throw `StoreCatalogError("STORE_NOT_CONFIGURED", "Apple App Store Connect credentials are not configured", 400)`. Else call `listAppStoreCatalog({ keyId, issuerId, privateKey, bundleId, appAppleId })`.
- android: `loadGoogleCredentials(projectId)`. If null → `STORE_NOT_CONFIGURED`. Else `listGooglePlayCatalog({ packageName, serviceAccount })`.
- Wrap lister calls: catch `StoreApiError` → rethrow as `StoreCatalogError("STORE_API_ERROR", err.message, 502)`.
- `alreadyImported`: `listProducts(db, { projectId, stores: [store], limit: 1000 })`, build `Set` of each row's `storeIds[store]`, set `alreadyImported = set.has(item.storeId)`.
- De-dupe by `storeId` (a SKU could theoretically appear twice); keep first.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/store-catalog.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { getStoreCatalog, StoreCatalogError } from "./store-catalog";

const raw = [
  { storeId: "pro_monthly", type: "SUBSCRIPTION" as const, name: "Pro Monthly" },
  { storeId: "coins_100", type: "CONSUMABLE" as const, name: "100 Coins" },
];

const baseOverrides = {
  loadApple: async () => ({ bundleId: "com.acme.app", keyId: "k", issuerId: "i", privateKey: "p" }),
  loadGoogle: async () => ({ packageName: "com.acme.app", serviceAccount: { client_email: "e", private_key: "p" } }),
  listAppStore: async () => raw,
  listGooglePlay: async () => raw,
  // one product already imported on ios
  listProducts: async () => [{ storeIds: { ios: "pro_monthly" } }] as any,
};

describe("getStoreCatalog", () => {
  it("marks alreadyImported against existing products", async () => {
    const items = await getStoreCatalog("proj1", "ios", baseOverrides);
    const pro = items.find((i) => i.storeId === "pro_monthly");
    const coins = items.find((i) => i.storeId === "coins_100");
    expect(pro?.alreadyImported).toBe(true);
    expect(coins?.alreadyImported).toBe(false);
  });

  it("throws STORE_NOT_CONFIGURED when apple creds incomplete", async () => {
    await expect(
      getStoreCatalog("proj1", "ios", { ...baseOverrides, loadApple: async () => ({ bundleId: "x" }) as any }),
    ).rejects.toMatchObject({ code: "STORE_NOT_CONFIGURED" });
  });

  it("throws STORE_NOT_CONFIGURED when google creds absent", async () => {
    await expect(
      getStoreCatalog("proj1", "android", { ...baseOverrides, loadGoogle: async () => null }),
    ).rejects.toBeInstanceOf(StoreCatalogError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- store-catalog`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the dispatcher**

Create `apps/api/src/services/store-catalog.ts`:

```ts
import { drizzle } from "@rovenue/db";
import type { StoreCatalogItem } from "@rovenue/shared";
import {
  loadAppleCredentials,
  loadGoogleCredentials,
} from "../lib/project-credentials";
import {
  listAppStoreCatalog,
  StoreApiError,
  type RawCatalogItem,
} from "./apple/app-store-connect";
import { listGooglePlayCatalog } from "./google/google-play-catalog";

export type StoreCatalogErrorCode = "STORE_NOT_CONFIGURED" | "STORE_API_ERROR";

export class StoreCatalogError extends Error {
  constructor(
    public readonly code: StoreCatalogErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "StoreCatalogError";
  }
}

interface Overrides {
  loadApple?: typeof loadAppleCredentials;
  loadGoogle?: typeof loadGoogleCredentials;
  listAppStore?: (config: {
    keyId: string;
    issuerId: string;
    privateKey: string;
    bundleId: string;
    appAppleId?: number;
  }) => Promise<RawCatalogItem[]>;
  listGooglePlay?: (input: {
    packageName: string;
    serviceAccount: { client_email: string; private_key: string };
  }) => Promise<RawCatalogItem[]>;
  listProducts?: (projectId: string, store: string) => Promise<Array<{ storeIds: unknown }>>;
}

async function fetchRaw(
  projectId: string,
  store: "ios" | "android",
  o: Overrides,
): Promise<RawCatalogItem[]> {
  try {
    if (store === "ios") {
      const creds = await (o.loadApple ?? loadAppleCredentials)(projectId);
      if (!creds || !creds.keyId || !creds.issuerId || !creds.privateKey) {
        throw new StoreCatalogError(
          "STORE_NOT_CONFIGURED",
          "Apple App Store Connect credentials are not configured for this project.",
          400,
        );
      }
      const list = o.listAppStore ?? listAppStoreCatalog;
      return await list({
        keyId: creds.keyId,
        issuerId: creds.issuerId,
        privateKey: creds.privateKey,
        bundleId: creds.bundleId,
        appAppleId: creds.appAppleId,
      });
    }
    const creds = await (o.loadGoogle ?? loadGoogleCredentials)(projectId);
    if (!creds) {
      throw new StoreCatalogError(
        "STORE_NOT_CONFIGURED",
        "Google Play credentials are not configured for this project.",
        400,
      );
    }
    const list = o.listGooglePlay ?? listGooglePlayCatalog;
    return await list({
      packageName: creds.packageName,
      serviceAccount: creds.serviceAccount,
    });
  } catch (err) {
    if (err instanceof StoreCatalogError) throw err;
    if (err instanceof StoreApiError) {
      throw new StoreCatalogError("STORE_API_ERROR", err.message, 502);
    }
    throw err;
  }
}

export async function getStoreCatalog(
  projectId: string,
  store: "ios" | "android",
  overrides: Overrides = {},
): Promise<StoreCatalogItem[]> {
  const raw = await fetchRaw(projectId, store, overrides);

  const listProducts =
    overrides.listProducts ??
    ((pid: string, s: string) =>
      drizzle.productRepo.listProducts(drizzle.db, {
        projectId: pid,
        stores: [s as "ios" | "android"],
        limit: 1000,
      }));
  const existing = await listProducts(projectId, store);
  const imported = new Set<string>();
  for (const row of existing) {
    const map = row.storeIds as Record<string, string> | null;
    const sku = map?.[store];
    if (sku) imported.add(sku);
  }

  const seen = new Set<string>();
  const items: StoreCatalogItem[] = [];
  for (const r of raw) {
    if (seen.has(r.storeId)) continue;
    seen.add(r.storeId);
    items.push({
      storeId: r.storeId,
      type: r.type,
      name: r.name,
      alreadyImported: imported.has(r.storeId),
    });
  }
  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- store-catalog`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/store-catalog.ts apps/api/src/services/store-catalog.test.ts
git commit -m "feat(api): store-catalog dispatcher with alreadyImported"
```

---

## Task 5: `GET /store-catalog` endpoint

**Files:**
- Modify: `apps/api/src/routes/dashboard/products.ts` (add import + route, after the `.post("/import", ...)` block ending line ~328)
- Test: `apps/api/src/routes/dashboard/products.store-catalog.test.ts`

**Interfaces:**
- Consumes: `getStoreCatalog`, `StoreCatalogError` from `../../services/store-catalog`; `fail` from `../../lib/response`; `ERROR_CODE` from `@rovenue/shared`.
- Produces: `GET /dashboard/projects/:projectId/products/store-catalog?store=ios|android` → `{ data: { items: StoreCatalogItem[] } }` or `{ error: { code, message } }`.

**Notes:**
- Auth: VIEWER+ read — use `assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT)` (same level as the list endpoint).
- Validate `store` with `z.enum(["ios","android"])` — note `web` is intentionally excluded here.
- Catch `StoreCatalogError` → `return c.json(fail(err.code, err.message), err.status)`. `err.code` values (`STORE_NOT_CONFIGURED`, `STORE_API_ERROR`) are valid `ErrorCode`s after Task 1.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/dashboard/products.store-catalog.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock auth + service so we exercise only routing + envelope mapping.
vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    c.set("user", { id: "u1" });
    await next();
  },
}));
vi.mock("../../lib/project-access", () => ({ assertProjectAccess: async () => {} }));

const getStoreCatalog = vi.fn();
vi.mock("../../services/store-catalog", async () => {
  const actual = await vi.importActual<any>("../../services/store-catalog");
  return { ...actual, getStoreCatalog: (...a: any[]) => getStoreCatalog(...a) };
});

import { Hono } from "hono";
import { productsDashboardRoute } from "./products";
import { StoreCatalogError } from "../../services/store-catalog";

function app() {
  return new Hono().route("/dashboard/projects/:projectId/products", productsDashboardRoute);
}

beforeEach(() => getStoreCatalog.mockReset());

describe("GET /store-catalog", () => {
  it("returns items in the data envelope", async () => {
    getStoreCatalog.mockResolvedValue([
      { storeId: "pro_monthly", type: "SUBSCRIPTION", name: "Pro Monthly", alreadyImported: false },
    ]);
    const res = await app().request("/dashboard/projects/p1/products/store-catalog?store=ios");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { items: [{ storeId: "pro_monthly", type: "SUBSCRIPTION", name: "Pro Monthly", alreadyImported: false }] },
    });
  });

  it("maps StoreCatalogError to the error envelope", async () => {
    getStoreCatalog.mockRejectedValue(
      new StoreCatalogError("STORE_NOT_CONFIGURED", "nope", 400),
    );
    const res = await app().request("/dashboard/projects/p1/products/store-catalog?store=android");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "STORE_NOT_CONFIGURED", message: "nope" } });
  });

  it("rejects store=web", async () => {
    const res = await app().request("/dashboard/projects/p1/products/store-catalog?store=web");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- products.store-catalog`
Expected: FAIL — route returns 404 (not yet defined).

- [ ] **Step 3: Add the import**

At the top of `apps/api/src/routes/dashboard/products.ts`, add to the imports:

```ts
import { ok, fail } from "../../lib/response";
import { ERROR_CODE } from "@rovenue/shared";
import { getStoreCatalog, StoreCatalogError } from "../../services/store-catalog";
import type {
  DashboardStoreCatalogResponse,
} from "@rovenue/shared";
```

(Note: `ok` is already imported on line 10 — change that line to `import { ok, fail } from "../../lib/response";` rather than adding a duplicate. Merge the two `@rovenue/shared` type-import blocks.)

Add a query schema near the other schemas (after `listQuerySchema`):

```ts
const storeCatalogQuerySchema = z.object({
  store: z.enum(["ios", "android"] as const),
});
```

- [ ] **Step 4: Add the route**

In `apps/api/src/routes/dashboard/products.ts`, insert immediately after the `.post("/import", ...)` chain (before `.get("/:id", ...)`):

```ts
  .get(
    "/store-catalog",
    zValidator("query", storeCatalogQuerySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId) {
        throw new HTTPException(400, { message: "Missing projectId" });
      }
      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);
      const { store } = c.req.valid("query");

      try {
        const items = await getStoreCatalog(projectId, store);
        const payload: DashboardStoreCatalogResponse = { items };
        return c.json(ok(payload));
      } catch (err) {
        if (err instanceof StoreCatalogError) {
          return c.json(fail(err.code, err.message), err.status as 400 | 502);
        }
        throw err;
      }
    },
  )
```

**Important:** `/store-catalog` must be registered BEFORE `/:id` so Hono doesn't match it as an id param. Placing it right after `/import` (which is also before `/:id`) satisfies this.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- products.store-catalog`
Expected: PASS (all three).

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter @rovenue/api exec tsc --noEmit
git add apps/api/src/routes/dashboard/products.ts apps/api/src/routes/dashboard/products.store-catalog.test.ts
git commit -m "feat(api): GET products/store-catalog endpoint"
```

---

## Task 6: `useStoreCatalog` dashboard hook

**Files:**
- Modify: `apps/dashboard/src/lib/hooks/useProjectProducts.ts` (add hook + import)

**Interfaces:**
- Consumes: `DashboardStoreCatalogResponse` from `@rovenue/shared`; `api` helper.
- Produces: `useStoreCatalog(projectId: string, store: "ios" | "android", enabled: boolean)` → TanStack `useQuery` returning `DashboardStoreCatalogResponse`.

- [ ] **Step 1: Add the import**

In `apps/dashboard/src/lib/hooks/useProjectProducts.ts`, add `DashboardStoreCatalogResponse` to the existing `@rovenue/shared` type import block.

- [ ] **Step 2: Add the hook**

Append to `apps/dashboard/src/lib/hooks/useProjectProducts.ts`:

```ts
export function useStoreCatalog(
  projectId: string,
  store: "ios" | "android",
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["products", "store-catalog", projectId, store],
    enabled: enabled && Boolean(projectId),
    retry: false,
    staleTime: 60_000,
    queryFn: () =>
      api<DashboardStoreCatalogResponse>(
        `/dashboard/projects/${projectId}/products/store-catalog?store=${store}`,
      ),
  });
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
git add apps/dashboard/src/lib/hooks/useProjectProducts.ts
git commit -m "feat(dashboard): useStoreCatalog query hook"
```

---

## Task 7: Modal auto-fetch + selectable list

**Files:**
- Modify: `apps/dashboard/src/components/products/import-from-store-modal.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json` (`products.import.catalog.*`)
- Test (pure helper): `apps/dashboard/src/components/products/import-from-store-modal.test.ts`

**Interfaces:**
- Consumes: `useStoreCatalog` (Task 6), `useImportProducts` (existing), `StoreCatalogItem`, `DashboardProductImportInput`.

**Behavior:**
- For `store === "web"`: keep the existing paste textarea path unchanged (the catalog hook is disabled).
- For `ios`/`android`: fire `useStoreCatalog(projectId, store, open && store !== "web")`. Render:
  - loading → skeleton/loading text,
  - error → `data.error.message` + a "Check store credentials" link (route to project settings credentials page) — branch the link on `ApiError.code === "STORE_NOT_CONFIGURED"` is optional; always showing the link is acceptable,
  - empty → empty-state text,
  - success → checkbox rows grouped by type; "select all (not yet imported)"; already-imported rows checked + disabled.
- "Import N products" submits only the **checked, not-already-imported** items via the existing import endpoint, then shows the existing results view.

**Note:** The full modal is UI-heavy; the only easily unit-testable pure logic is "which items are selectable / selected count". Extract a small pure helper and test that; verify the rest manually.

- [ ] **Step 1: Write the failing helper test**

Create `apps/dashboard/src/components/products/import-from-store-modal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectableStoreIds, toImportItems } from "./import-from-store-modal";
import type { StoreCatalogItem } from "@rovenue/shared";

const items: StoreCatalogItem[] = [
  { storeId: "a", type: "SUBSCRIPTION", name: "A", alreadyImported: false },
  { storeId: "b", type: "CONSUMABLE", name: "B", alreadyImported: true },
  { storeId: "c", type: "NON_CONSUMABLE", name: "C", alreadyImported: false },
];

describe("import-from-store-modal helpers", () => {
  it("selectableStoreIds excludes already-imported", () => {
    expect(selectableStoreIds(items)).toEqual(["a", "c"]);
  });

  it("toImportItems builds import payload from selected ids", () => {
    const out = toImportItems(items, new Set(["a", "c"]));
    expect(out).toEqual([
      { storeId: "a", type: "SUBSCRIPTION" },
      { storeId: "c", type: "NON_CONSUMABLE" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard test -- import-from-store-modal`
Expected: FAIL — `selectableStoreIds` / `toImportItems` not exported.

- [ ] **Step 3: Add the pure helpers (exported)**

At the bottom of `apps/dashboard/src/components/products/import-from-store-modal.tsx`, add:

```ts
/** Store ids the user is allowed to toggle (already-imported are locked). */
export function selectableStoreIds(
  items: ReadonlyArray<StoreCatalogItem>,
): string[] {
  return items.filter((i) => !i.alreadyImported).map((i) => i.storeId);
}

/** Build the import payload items for a set of selected store ids. */
export function toImportItems(
  items: ReadonlyArray<StoreCatalogItem>,
  selected: ReadonlySet<string>,
): Array<{ storeId: string; type: ProductTypeName }> {
  return items
    .filter((i) => selected.has(i.storeId) && !i.alreadyImported)
    .map((i) => ({ storeId: i.storeId, type: i.type }));
}
```

Add `StoreCatalogItem` to the `@rovenue/shared` import at the top of the file.

- [ ] **Step 4: Run helper test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- import-from-store-modal`
Expected: PASS (both).

- [ ] **Step 5: Add i18n keys**

In `apps/dashboard/src/i18n/locales/en.json`, add a `catalog` object inside `products.import` (alongside `fields`, `stores`, etc.):

```json
"catalog": {
  "loading": "Fetching products from the store…",
  "empty": "No products found in this store.",
  "errorTitle": "Couldn't fetch products",
  "credentialsLink": "Check store credentials",
  "selectAll": "Select all",
  "imported": "Already imported",
  "webHint": "Web (Stripe) products are added by pasting price IDs.",
  "fetchedSubtitle": "Select the products to import. Already-imported products are disabled."
}
```

- [ ] **Step 6: Rewrite the modal body for ios/android**

Replace the input step in `apps/dashboard/src/components/products/import-from-store-modal.tsx` so that:
- the STORE select stays (drives the fetch); the PRODUCT TYPE select and the textarea are shown **only when `store === "web"`**;
- for `ios`/`android`, render the catalog list from `useStoreCatalog`.

Concretely, inside the component add:

```tsx
  const isApiStore = store !== "web";
  const catalog = useStoreCatalog(projectId, store === "web" ? "ios" : store, open && isApiStore);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset selection whenever a fresh catalog arrives or the store changes.
  useEffect(() => {
    setSelected(new Set());
  }, [store, catalog.data]);
```

Update `submit` to branch on store:

```tsx
  const submit = async () => {
    if (importMut.isPending) return;
    setError(null);
    const items = isApiStore
      ? toImportItems(catalog.data?.items ?? [], selected)
      : parsed.map((storeId) => ({ storeId, type }));
    if (items.length === 0) return;
    const body: DashboardProductImportInput = { store, items };
    try {
      const res = await importMut.mutateAsync(body);
      setResult(res);
      setStep("results");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("products.import.errors.unknown"));
    }
  };
```

Render the catalog list (replace the textarea + preview block when `isApiStore`):

```tsx
{isApiStore ? (
  <CatalogList
    state={catalog}
    selected={selected}
    onToggle={(id) =>
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      })
    }
    onSelectAll={() =>
      setSelected(new Set(selectableStoreIds(catalog.data?.items ?? [])))
    }
  />
) : (
  /* existing textarea + preview block for web */
)}
```

Add the `CatalogList` presentational sub-component (loading / error-with-credentials-link / empty / list with checkboxes; already-imported rows render `disabled checked` with the `catalog.imported` label). Use the existing `Field`/styling idioms in the file. Drive the footer submit count from `selected.size` (api stores) or `parsed.length` (web).

- [ ] **Step 7: Manual verification**

```bash
pnpm dev
```
- Open a project → Products → "Import from store".
- iOS with no Apple creds → error state + "Check store credentials" link.
- iOS with valid App Store Connect creds → list populates; already-imported rows disabled; select some → "Import N products" → results view shows created/skipped.
- Switch to Android → re-fetches; switch to Web → textarea returns.

- [ ] **Step 8: Typecheck + commit**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
git add apps/dashboard/src/components/products/import-from-store-modal.tsx apps/dashboard/src/components/products/import-from-store-modal.test.ts apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): auto-fetch store catalog in import modal"
```

---

## Task 8: Full-suite verification

- [ ] **Step 1: Run the affected package test suites**

```bash
pnpm --filter @rovenue/shared test
pnpm --filter @rovenue/api test -- app-store-connect google-play-catalog store-catalog products.store-catalog
pnpm --filter @rovenue/dashboard test -- import-from-store-modal
```
Expected: all PASS.

- [ ] **Step 2: Build the workspaces touched**

```bash
pnpm --filter @rovenue/shared --filter @rovenue/api --filter @rovenue/dashboard build
```
Expected: green. (Pre-existing red integration tests on `main` are unrelated — see memory note `main_preexisting_red_integrations`; do not block on them.)

- [ ] **Step 3: Final commit if anything was fixed up**

```bash
git add -A && git commit -m "chore: store-catalog autofetch verification fixes" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** auto-fetch on open (Task 7, `enabled: open && isApiStore`); iOS via ASC (Task 2); Android via Play (Task 3); reuse `appleCredentials` with ASC-access caveat (Task 4 not-configured + `STORE_API_ERROR` passthrough); `alreadyImported` (Task 4); endpoint with `CREDENTIALS_NOT_CONFIGURED`→`STORE_NOT_CONFIGURED` / `STORE_API_ERROR` (Tasks 1 + 5); selectable list + import via existing endpoint (Task 7); shared types + i18n (Tasks 1 + 7); web/Stripe retained (Task 7). All covered.
- **Naming consistency:** `StoreApiError` (lister-level) vs `StoreCatalogError` (dispatcher-level) are intentionally distinct; the dispatcher converts the former to the latter. `RawCatalogItem` (internal) → `StoreCatalogItem` (wire). `getStoreCatalog`, `listAppStoreCatalog`, `listGooglePlayCatalog`, `useStoreCatalog`, `selectableStoreIds`, `toImportItems` are used identically across tasks.
- **Known limitation (documented):** Google managed products map to `NON_CONSUMABLE` (the legacy API doesn't expose consumability); users adjust type after import.
- **Error code note:** the spec used `CREDENTIALS_NOT_CONFIGURED`; the implementation uses `STORE_NOT_CONFIGURED` to fit the existing closed `ERROR_CODE` union naming. Functionally identical.
