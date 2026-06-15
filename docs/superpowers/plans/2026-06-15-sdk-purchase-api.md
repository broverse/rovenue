# SDK-driven `purchase()` with remote Offerings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the host-app-drives-the-store model (`postAppleReceipt`/`postGoogleReceipt`) with a RevenueCat-style SDK-driven `purchase()` that fetches remote Offerings, drives StoreKit 2 / Play Billing 6 itself, validates the receipt against Rovenue, and resolves with the updated subscriber state — across all SDKs (Rust core, Swift, Kotlin/Android, React Native) plus the backend gap and docs.

**Architecture:** The Rust core gains a live `get_offerings()` fetch and keeps the (now internal) receipt-validation transport. StoreKit 2 lives in `sdk-swift` (also consumed by the RN iOS module). Play Billing 6 lives in `sdk-kotlin`, which is converted from a pure-JVM library into an Android library (also consumed by the RN Android module). Purchase orchestration is isolated behind a store-abstraction protocol/interface so the cancel/pending/success/finish-after-validation logic is unit-testable with fakes — the real StoreKit/Play implementations sit at the edges. The RN/TS layer exposes `getOfferings()`, `purchase()`, `restorePurchases()` and drops the legacy receipt methods.

**Tech Stack:** Rust (UniFFI UDL bindings, `reqwest`, `rusqlite`, `mockito` tests), Swift 5.9 / StoreKit 2 / XCTest + `SKTestSession`, Kotlin / Play Billing 6 / Android library / JUnit5 + Robolectric, React Native / Expo modules / TypeScript / Vitest, Hono + Drizzle + Vitest (API).

**Key cross-phase type contracts (defined once, referenced everywhere):**

Wire JSON returned by `GET /v1/offerings` after Phase 1:
```json
{ "data": { "offerings": [
  { "identifier": "default", "accessId": "acc_x", "isDefault": true,
    "products": [
      { "identifier": "monthly", "type": "SUBSCRIPTION", "displayName": "Pro Monthly",
        "storeIds": { "apple": "com.x.pro.monthly", "google": "pro_monthly" },
        "order": 0, "isPromoted": false, "creditAmount": null, "accessIds": ["pro"], "metadata": {} }
    ] } ] } }
```

Rust FFI types (Phase 2, in `librovenue.udl`):
```
dictionary OfferingProduct { string identifier; string product_type; string display_name; string? apple_product_id; string? google_product_id; };
dictionary Offering { string identifier; boolean is_default; sequence<OfferingProduct> packages; };
dictionary Offerings { string? current; sequence<Offering> offerings; };
```

Public SDK surface (Swift/Kotlin/TS mirror each other):
- `ProductType` = `subscription | consumable | non_consumable`
- `StoreProduct { id, type, displayName, priceString, price, currencyCode }` (price fields nullable when store query unavailable)
- `Package { identifier, product: StoreProduct }`
- `Offering { identifier, isDefault, packages: Package[] }`
- `Offerings { current: Offering | null, all: Record<identifier, Offering> }`
- `PurchaseResult { entitlements: Entitlement[], creditBalance: number, productId: string, storeTransactionId: string }`
- New errors: `PurchaseCancelled`, `PurchasePending`, `ProductNotAvailable`, `StoreProblem` (native-origin; NOT added to the Rust `RovenueError` enum).

---

## Phase 1 — Backend: add `storeIds` to the offerings payload

**Why:** The SDK needs each product's per-store id (`{apple,google}`) to query StoreKit/Play for live pricing. Today `/v1/offerings/:identifier` returns products without `storeIds`, and `GET /v1/offerings` returns only a `productCount`. This phase adds `storeIds` and makes the list endpoint hydrate products, so the SDK gets everything in one call.

**Files:**
- Modify: `apps/api/src/routes/v1/offerings.ts`
- Test: `apps/api/tests/v1-offerings.test.ts` (create)

### Task 1.1: Failing test — list endpoint hydrates products with storeIds

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/v1-offerings.test.ts`. Mirror the auth/mock harness used by `apps/api/tests/v1-api.test.ts` (import the same `app`, `withPublicAuth`, `dbMock` setup — copy its top-of-file harness block verbatim; that block is shared infra, repeating it here keeps this test independent).

```ts
import { describe, expect, it, beforeEach, vi } from "vitest";
// ⬇️ Copy the harness imports + dbMock + app + withPublicAuth setup
//    from apps/api/tests/v1-api.test.ts (lines 1–430). Do not import them
//    from that test file — duplicate the setup so the suites stay isolated.

describe("GET /v1/offerings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.apiKey.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.keyPublic === PUBLIC_KEY) return apiKeyRecord;
      if (args?.where?.id === "testapikeyid") return apiKeyRecord;
      return null;
    });
  });

  it("hydrates each offering's products including storeIds", async () => {
    vi.mocked(drizzle.offeringRepo.listOfferings).mockResolvedValue([
      {
        id: "off_1", identifier: "default", accessId: "acc_x", isDefault: true,
        products: [{ productId: "prod_1", order: 0, isPromoted: false }],
        metadata: {},
      },
    ] as any);
    vi.mocked(drizzle.offeringRepo.findProductsByIds).mockResolvedValue([
      {
        id: "prod_1", identifier: "monthly", type: "SUBSCRIPTION",
        displayName: "Pro Monthly", creditAmount: null, accessIds: ["pro"],
        isActive: true,
        storeIds: { apple: "com.x.pro.monthly", google: "pro_monthly" },
      },
    ] as any);

    const res = await app.request(withPublicAuth("/v1/offerings"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const product = body.data.offerings[0].products[0];
    expect(product.storeIds).toEqual({
      apple: "com.x.pro.monthly",
      google: "pro_monthly",
    });
    expect(product.identifier).toBe("monthly");
    expect(product.type).toBe("SUBSCRIPTION");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test v1-offerings`
Expected: FAIL — response `offerings[0]` has `productCount` and no `products` array (current list endpoint returns counts only).

- [ ] **Step 3: Implement — shared hydration helper + hydrated list endpoint**

In `apps/api/src/routes/v1/offerings.ts`, add `storeIds` to the entry interface and a `storeIdsSchema`, extract a shared `hydrateProducts`, and rewrite `GET /` to hydrate.

Add near the top (after `productMembershipsSchema`):
```ts
const storeIdsSchema = z
  .object({
    apple: z.string().optional(),
    google: z.string().optional(),
    stripe: z.string().optional(),
  })
  .passthrough();

function parseStoreIds(raw: unknown): Record<string, string> {
  const parsed = storeIdsSchema.safeParse(raw);
  return parsed.success ? (parsed.data as Record<string, string>) : {};
}
```

Extend `OfferingProductEntry` with:
```ts
  storeIds: Record<string, string>;
```

Add the shared helper (place it above `offeringsRoute`):
```ts
type Membership = z.infer<typeof productMembershipSchema>;

function hydrateProducts(
  memberships: Membership[],
  productById: Map<string, { identifier: string; type: string; displayName: string; creditAmount: number | null; accessIds: string[]; isActive: boolean; storeIds: unknown }>,
): OfferingProductEntry[] {
  return [...memberships]
    .sort((a, b) => a.order - b.order)
    .map((entry): OfferingProductEntry | null => {
      const product = productById.get(entry.productId);
      if (!product || !product.isActive) return null;
      return {
        identifier: product.identifier,
        type: product.type,
        displayName: product.displayName,
        order: entry.order,
        isPromoted: entry.isPromoted,
        creditAmount: product.creditAmount,
        accessIds: product.accessIds,
        storeIds: parseStoreIds(product.storeIds),
        metadata: entry.metadata ?? {},
      };
    })
    .filter((p): p is OfferingProductEntry => p !== null);
}
```

Rewrite the `GET /` handler body to hydrate (replace the existing `.get("/", ...)`):
```ts
  .get("/", async (c) => {
    const project = c.get("project");
    const accessId = c.req.query("accessId");

    const offerings = accessId
      ? await drizzle.offeringRepo.listOfferingsByAccess(drizzle.db, project.id, accessId)
      : await drizzle.offeringRepo.listOfferings(drizzle.db, project.id);

    // Collect every referenced product id across all offerings → one fetch.
    const parsedByOffering = offerings.map((o) => ({
      offering: o,
      memberships: productMembershipsSchema.safeParse(o.products),
    }));
    const allIds = parsedByOffering.flatMap((p) =>
      p.memberships.success ? p.memberships.data.map((m) => m.productId) : [],
    );
    const products = await drizzle.offeringRepo.findProductsByIds(
      drizzle.db, project.id, Array.from(new Set(allIds)),
    );
    const productById = new Map(products.map((p) => [p.id, p] as const));

    return c.json(
      ok({
        offerings: parsedByOffering.map(({ offering, memberships }) => ({
          identifier: offering.identifier,
          accessId: offering.accessId,
          isDefault: offering.isDefault,
          products: memberships.success
            ? hydrateProducts(memberships.data, productById as any)
            : [],
        })),
      }),
    );
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test v1-offerings`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/offerings.ts apps/api/tests/v1-offerings.test.ts
git commit -m "feat(api): hydrate /v1/offerings list with products incl. storeIds"
```

### Task 1.2: Add `storeIds` to the per-identifier endpoint (consistency)

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/v1-offerings.test.ts`:
```ts
describe("GET /v1/offerings/:identifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.apiKey.findUnique.mockImplementation(async (args: any) =>
      args?.where?.keyPublic === PUBLIC_KEY || args?.where?.id === "testapikeyid"
        ? apiKeyRecord : null);
  });

  it("includes storeIds on each product", async () => {
    vi.mocked(drizzle.offeringRepo.findOfferingByIdentifier).mockResolvedValue({
      id: "off_1", identifier: "pro", accessId: "acc_x", isDefault: false,
      products: [{ productId: "prod_1", order: 0, isPromoted: false }], metadata: {},
    } as any);
    vi.mocked(drizzle.offeringRepo.findProductsByIds).mockResolvedValue([
      { id: "prod_1", identifier: "monthly", type: "SUBSCRIPTION",
        displayName: "Pro Monthly", creditAmount: null, accessIds: ["pro"],
        isActive: true, storeIds: { apple: "com.x.m", google: "g_m" } },
    ] as any);

    const res = await app.request(withPublicAuth("/v1/offerings/pro"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.products[0].storeIds).toEqual({ apple: "com.x.m", google: "g_m" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test v1-offerings`
Expected: FAIL — `storeIds` undefined on the per-identifier product entry.

- [ ] **Step 3: Implement — reuse `hydrateProducts` in the per-identifier handler**

In `GET /:identifier`, replace the inline `payload` construction (the `sorted.map(...)` block) with:
```ts
    const productById = new Map(products.map((p) => [p.id, p] as const));
    const payload = hydrateProducts(memberships.data, productById as any);
```
(Leave the experiment-override logic and 404 handling untouched; only the product-mapping block changes.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api test v1-offerings`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/offerings.ts apps/api/tests/v1-offerings.test.ts
git commit -m "feat(api): include storeIds on /v1/offerings/:identifier products"
```

---

## Phase 2 — Rust core: `get_offerings()` live fetch + FFI types

**Why:** The native layers have no HTTP client of their own; offerings are fetched through the core. This adds a live fetch returning FFI-friendly offering/package structs and exposes it over UniFFI so Swift & Kotlin can call it.

**Files:**
- Create: `packages/core-rs/src/offerings/mod.rs`
- Create: `packages/core-rs/src/offerings/types.rs`
- Create: `packages/core-rs/src/offerings/client.rs`
- Modify: `packages/core-rs/src/lib.rs`
- Modify: `packages/core-rs/src/api.rs`
- Modify: `packages/core-rs/src/librovenue.udl`
- Test: `packages/core-rs/tests/offerings_test.rs` (create)
- Test fixture: `packages/core-rs/tests/fixtures/offerings_response.json` (create)
- Regenerated (build output, committed): `packages/sdk-swift/Sources/Rovenue/Generated/*`, `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt`

### Task 2.1: Offerings wire + FFI types

- [ ] **Step 1: Write the types module**

Create `packages/core-rs/src/offerings/types.rs`:
```rust
use serde::Deserialize;

/// FFI-visible product within an offering.
#[derive(Debug, Clone, PartialEq)]
pub struct OfferingProduct {
    pub identifier: String,
    pub product_type: String, // "SUBSCRIPTION" | "CONSUMABLE" | "NON_CONSUMABLE"
    pub display_name: String,
    pub apple_product_id: Option<String>,
    pub google_product_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Offering {
    pub identifier: String,
    pub is_default: bool,
    pub packages: Vec<OfferingProduct>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Offerings {
    pub current: Option<String>, // identifier of the default offering
    pub offerings: Vec<Offering>,
}

// ---- wire models (server JSON) ----

#[derive(Debug, Deserialize)]
pub struct StoreIdsWire {
    pub apple: Option<String>,
    pub google: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OfferingProductWire {
    pub identifier: String,
    #[serde(rename = "type")]
    pub product_type: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "storeIds")]
    pub store_ids: StoreIdsWire,
}

#[derive(Debug, Deserialize)]
pub struct OfferingWire {
    pub identifier: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    pub products: Vec<OfferingProductWire>,
}

#[derive(Debug, Deserialize)]
pub struct OfferingsResponse {
    pub offerings: Vec<OfferingWire>,
}
```

- [ ] **Step 2: Write `mod.rs` re-exports**

Create `packages/core-rs/src/offerings/mod.rs`:
```rust
pub mod client;
pub mod types;

pub use client::OfferingsClient;
pub use types::{Offering, OfferingProduct, Offerings};
```

- [ ] **Step 3: Commit (types compile after client lands — defer to 2.2 commit)**

No commit yet; `mod.rs` references `client` which we add next.

### Task 2.2: Offerings client with live fetch

- [ ] **Step 1: Write the failing test + fixture**

Create `packages/core-rs/tests/fixtures/offerings_response.json`:
```json
{ "data": { "offerings": [
  { "identifier": "default", "isDefault": true, "products": [
    { "identifier": "monthly", "type": "SUBSCRIPTION", "displayName": "Pro Monthly",
      "storeIds": { "apple": "com.x.pro.monthly", "google": "pro_monthly" } }
  ] },
  { "identifier": "promo", "isDefault": false, "products": [
    { "identifier": "lifetime", "type": "NON_CONSUMABLE", "displayName": "Lifetime",
      "storeIds": { "apple": "com.x.lifetime", "google": null } }
  ] }
] } }
```

Create `packages/core-rs/tests/offerings_test.rs`:
```rust
use std::sync::Arc;
use std::time::Duration;

use rovenue::offerings::OfferingsClient;
use rovenue::transport::http_client::HttpClient;

fn http_client(url: &str) -> HttpClient {
    HttpClient::new(url.to_string(), "pk_test".into())
        .with_max_attempts(1)
        .with_request_timeout(Duration::from_millis(500))
}

#[test]
fn get_offerings_maps_wire_to_ffi_and_sets_current() {
    let mut server = mockito::Server::new();
    let body = include_str!("fixtures/offerings_response.json");
    let m = server
        .mock("GET", "/v1/offerings")
        .with_status(200)
        .with_body(body)
        .match_header("authorization", "Bearer pk_test")
        .create();

    let client = OfferingsClient::new(Arc::new(http_client(&server.url())));
    let result = client.get_offerings().unwrap();
    m.assert();

    assert_eq!(result.current.as_deref(), Some("default"));
    assert_eq!(result.offerings.len(), 2);
    let monthly = &result.offerings[0].packages[0];
    assert_eq!(monthly.identifier, "monthly");
    assert_eq!(monthly.product_type, "SUBSCRIPTION");
    assert_eq!(monthly.apple_product_id.as_deref(), Some("com.x.pro.monthly"));
    assert_eq!(monthly.google_product_id.as_deref(), Some("pro_monthly"));
    let lifetime = &result.offerings[1].packages[0];
    assert_eq!(lifetime.google_product_id, None);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p librovenue --test offerings_test`
Expected: FAIL — `rovenue::offerings` module does not exist / `OfferingsClient` not found.

- [ ] **Step 3: Implement the client**

Create `packages/core-rs/src/offerings/client.rs`:
```rust
use std::sync::Arc;

use crate::error::{RovenueError, RovenueResult};
use crate::transport::api::ApiEnvelope;
use crate::transport::http_client::HttpClient;
use crate::transport::types::HttpRequest;

use super::types::{Offering, OfferingProduct, Offerings, OfferingsResponse};

pub struct OfferingsClient {
    http: Arc<HttpClient>,
}

impl OfferingsClient {
    pub fn new(http: Arc<HttpClient>) -> Self {
        Self { http }
    }

    pub fn get_offerings(&self) -> RovenueResult<Offerings> {
        let resp = self
            .http
            .get_json::<ApiEnvelope<OfferingsResponse>>(HttpRequest::new("/v1/offerings"))?;
        let body = resp.body.ok_or(RovenueError::Internal)?;

        let offerings: Vec<Offering> = body
            .data
            .offerings
            .into_iter()
            .map(|o| Offering {
                identifier: o.identifier,
                is_default: o.is_default,
                packages: o
                    .products
                    .into_iter()
                    .map(|p| OfferingProduct {
                        identifier: p.identifier,
                        product_type: p.product_type,
                        display_name: p.display_name,
                        apple_product_id: p.store_ids.apple,
                        google_product_id: p.store_ids.google,
                    })
                    .collect(),
            })
            .collect();

        let current = offerings
            .iter()
            .find(|o| o.is_default)
            .map(|o| o.identifier.clone());

        Ok(Offerings { current, offerings })
    }
}
```

Add to `packages/core-rs/src/lib.rs` (in the `pub mod` block, alphabetically after `observer`):
```rust
pub mod offerings;
```
and in the `pub use` block:
```rust
pub use offerings::{Offering, OfferingProduct, Offerings};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p librovenue --test offerings_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/offerings packages/core-rs/src/lib.rs packages/core-rs/tests/offerings_test.rs packages/core-rs/tests/fixtures/offerings_response.json
git commit -m "feat(core): offerings live-fetch client mapping wire→FFI"
```

### Task 2.3: Wire `get_offerings()` onto `RovenueCore` + UDL

- [ ] **Step 1: Write the failing test**

Append to `packages/core-rs/tests/offerings_test.rs`:
```rust
use rovenue::config::Config;
use rovenue::RovenueCore;

#[test]
fn core_get_offerings_round_trips() {
    let mut server = mockito::Server::new();
    let body = include_str!("fixtures/offerings_response.json");
    server.mock("GET", "/v1/offerings").with_status(200).with_body(body).create();

    let core = RovenueCore::new_for_test(Config {
        api_key: "pk_test".into(),
        base_url: server.url(),
        debug: true,
        app_version: None,
    })
    .unwrap();

    let result = core.get_offerings().unwrap();
    assert_eq!(result.current.as_deref(), Some("default"));
    assert_eq!(result.offerings.len(), 2);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p librovenue --test offerings_test core_get_offerings_round_trips`
Expected: FAIL — `RovenueCore` has no `get_offerings` method.

- [ ] **Step 3: Implement on `RovenueCore`**

In `packages/core-rs/src/api.rs`:
- add import: `use crate::offerings::{Offerings, OfferingsClient};`
- add field to the struct: `offerings: Arc<OfferingsClient>,`
- in `from_store`, after `let receipts = ...;` add:
  ```rust
  let offerings = Arc::new(OfferingsClient::new(Arc::clone(&http)));
  ```
- add `offerings,` to the `Ok(Self { ... })` initializer.
- add the method (next to `post_apple_receipt`):
  ```rust
  pub fn get_offerings(&self) -> RovenueResult<Offerings> {
      self.offerings.get_offerings()
  }
  ```

In `packages/core-rs/src/librovenue.udl`:
- add the three dictionaries (place after the `ReceiptResult` dictionary):
  ```
  dictionary OfferingProduct {
      string identifier;
      string product_type;
      string display_name;
      string? apple_product_id;
      string? google_product_id;
  };

  dictionary Offering {
      string identifier;
      boolean is_default;
      sequence<OfferingProduct> packages;
  };

  dictionary Offerings {
      string? current;
      sequence<Offering> offerings;
  };
  ```
- add to `interface RovenueCore` (after `post_google_receipt`):
  ```
  [Throws=RovenueError]
  Offerings get_offerings();
  ```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p librovenue --test offerings_test`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core-rs/src/api.rs packages/core-rs/src/librovenue.udl packages/core-rs/tests/offerings_test.rs
git commit -m "feat(core): expose RovenueCore.get_offerings over UniFFI"
```

### Task 2.4: Regenerate Swift + Kotlin bindings

- [ ] **Step 1: Run the binding generator**

Run: `./packages/core-rs/scripts/build-bindings.sh`
Expected output ends with `✓ bindings generated` and lists the Swift + Kotlin output files.

- [ ] **Step 2: Verify the new types/method are present**

Run: `grep -n "func get_offerings\|getOfferings\|struct Offerings\|class Offerings\|data class Offerings" packages/sdk-swift/Sources/Rovenue/Generated/*.swift packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt`
Expected: matches in both generated files (`Offerings`, `Offering`, `OfferingProduct`, and a `getOfferings`/`get_offerings` binding).

- [ ] **Step 3: Sanity-build both bindings compile against the lib**

Run: `cargo build -p librovenue --release`
Expected: success (the UDL parsed cleanly during the prior step; this confirms the lib still builds).

- [ ] **Step 4: Commit the regenerated bindings**

```bash
git add packages/sdk-swift/Sources/Rovenue/Generated packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/generated/librovenue.kt
git commit -m "chore(sdk): regenerate Swift/Kotlin bindings for get_offerings"
```

---

## Phase 3 — Swift: StoreKit 2 purchase, offerings, restore, listener

**Why:** iOS purchasing lives here (and the RN iOS module wraps this façade). The orchestration (resolve product → purchase → validate → finish-after-validation) is isolated behind an `AppleStore` protocol so it's unit-testable without a live App Store or network.

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/Internal/AppleStore.swift` (protocol + StoreKit 2 impl)
- Create: `packages/sdk-swift/Sources/Rovenue/Internal/ApplePurchaseFlow.swift` (testable orchestration)
- Modify: `packages/sdk-swift/Sources/Rovenue/Types.swift` (public purchase types)
- Modify: `packages/sdk-swift/Sources/Rovenue/Errors.swift` (new cases)
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` (public methods, listener, remove post* )
- Test: `packages/sdk-swift/Tests/RovenueTests/ApplePurchaseFlowTests.swift` (create)

### Task 3.1: Public purchase types

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-swift/Tests/RovenueTests/ApplePurchaseFlowTests.swift` (start with a type-shape test):
```swift
import XCTest
@testable import Rovenue

final class PurchaseTypesTests: XCTestCase {
    func test_storeProduct_and_offerings_shapes() {
        let p = StoreProduct(id: "com.x.m", type: .subscription, displayName: "Monthly",
                             priceString: "$4.99", price: 4.99, currencyCode: "USD")
        let pkg = Package(identifier: "monthly", product: p)
        let offering = Offering(identifier: "default", isDefault: true, packages: [pkg])
        let offerings = Offerings(current: offering, all: ["default": offering])
        XCTAssertEqual(offerings.current?.packages.first?.product.type, .subscription)
        XCTAssertEqual(offerings.all["default"]?.identifier, "default")
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `swift test --package-path packages/sdk-swift --filter PurchaseTypesTests`
Expected: FAIL — `StoreProduct`/`Package`/`Offering`/`Offerings` undefined.

- [ ] **Step 3: Implement the types**

Append to `packages/sdk-swift/Sources/Rovenue/Types.swift`:
```swift
public enum ProductType: Sendable, Equatable {
    case subscription
    case consumable
    case nonConsumable

    /// Maps the Rust core's `product_type` string.
    public static func from(_ raw: String) -> ProductType {
        switch raw {
        case "CONSUMABLE": return .consumable
        case "NON_CONSUMABLE": return .nonConsumable
        default: return .subscription
        }
    }
}

public struct StoreProduct: Sendable, Equatable {
    public let id: String
    public let type: ProductType
    public let displayName: String
    /// Localised price (e.g. "$4.99"); nil when the store query was unavailable.
    public let priceString: String?
    public let price: Decimal?
    public let currencyCode: String?

    public init(id: String, type: ProductType, displayName: String,
                priceString: String? = nil, price: Decimal? = nil, currencyCode: String? = nil) {
        self.id = id; self.type = type; self.displayName = displayName
        self.priceString = priceString; self.price = price; self.currencyCode = currencyCode
    }
}

public struct Package: Sendable, Equatable {
    public let identifier: String
    public let product: StoreProduct
    public init(identifier: String, product: StoreProduct) {
        self.identifier = identifier; self.product = product
    }
}

public struct Offering: Sendable, Equatable {
    public let identifier: String
    public let isDefault: Bool
    public let packages: [Package]
    public init(identifier: String, isDefault: Bool, packages: [Package]) {
        self.identifier = identifier; self.isDefault = isDefault; self.packages = packages
    }
}

public struct Offerings: Sendable, Equatable {
    public let current: Offering?
    public let all: [String: Offering]
    public init(current: Offering?, all: [String: Offering]) {
        self.current = current; self.all = all
    }
}

public struct PurchaseResult: Sendable, Equatable {
    public let entitlements: [Entitlement]
    public let creditBalance: Int64
    public let productId: String
    public let storeTransactionId: String
    public init(entitlements: [Entitlement], creditBalance: Int64,
                productId: String, storeTransactionId: String) {
        self.entitlements = entitlements; self.creditBalance = creditBalance
        self.productId = productId; self.storeTransactionId = storeTransactionId
    }
}
```
(If `Entitlement` is not already `Equatable`/`Sendable`, add those conformances in Types.swift where it’s declared.)

- [ ] **Step 4: Run to verify it passes**

Run: `swift test --package-path packages/sdk-swift --filter PurchaseTypesTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Types.swift packages/sdk-swift/Tests/RovenueTests/ApplePurchaseFlowTests.swift
git commit -m "feat(swift): public Offerings/Package/StoreProduct/PurchaseResult types"
```

### Task 3.2: New error cases

- [ ] **Step 1: Write the failing test**

Append to `ApplePurchaseFlowTests.swift`:
```swift
final class PurchaseErrorTests: XCTestCase {
    func test_new_error_cases_exist() {
        let errors: [Rovenue.Error] = [.purchaseCancelled, .purchasePending,
                                       .productNotAvailable, .storeProblem]
        XCTAssertEqual(errors.count, 4)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `swift test --package-path packages/sdk-swift --filter PurchaseErrorTests`
Expected: FAIL — those cases don't exist on `Rovenue.Error`.

- [ ] **Step 3: Implement**

In `packages/sdk-swift/Sources/Rovenue/Errors.swift`, add to the `Rovenue.Error` enum:
```swift
    case purchaseCancelled
    case purchasePending
    case productNotAvailable
    case storeProblem
```
(Do NOT add them to `mapError` — they originate in the Swift purchase layer, not the Rust core.)

- [ ] **Step 4: Run to verify it passes**

Run: `swift test --package-path packages/sdk-swift --filter PurchaseErrorTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Errors.swift packages/sdk-swift/Tests/RovenueTests/ApplePurchaseFlowTests.swift
git commit -m "feat(swift): add purchase-flow error cases"
```

### Task 3.3: `AppleStore` abstraction + testable `ApplePurchaseFlow`

This isolates StoreKit so the orchestration is unit-testable.

- [ ] **Step 1: Write the abstraction protocol**

Create `packages/sdk-swift/Sources/Rovenue/Internal/AppleStore.swift`:
```swift
import Foundation

/// Outcome of a single store purchase attempt, normalised away from StoreKit types
/// so the orchestration layer is testable without StoreKit.
internal enum StorePurchaseOutcome {
    case success(jws: String, transactionId: String, finish: @Sendable () async -> Void)
    case userCancelled
    case pending
    case productNotFound
}

/// Abstraction over the parts of StoreKit 2 the SDK drives. The real impl wraps
/// `Product`/`Transaction`; tests provide a fake.
internal protocol AppleStore: Sendable {
    func purchase(productId: String, appAccountToken: String?) async throws -> StorePurchaseOutcome
}
```

- [ ] **Step 2: Write the failing orchestration test**

Append to `ApplePurchaseFlowTests.swift`:
```swift
final class ApplePurchaseFlowTests: XCTestCase {
    /// fake store
    struct FakeStore: AppleStore {
        let outcome: StorePurchaseOutcome
        func purchase(productId: String, appAccountToken: String?) async throws -> StorePurchaseOutcome { outcome }
    }

    func test_userCancelled_throwsCancelled_andDoesNotValidate() async {
        var validated = false
        let flow = ApplePurchaseFlow(
            store: FakeStore(outcome: .userCancelled),
            validate: { _, _ in validated = true; return ReceiptResult(subscriberId: "s", appUserId: "u", creditBalance: 0) },
            snapshot: { ([], 0) }
        )
        do { _ = try await flow.run(productId: "com.x.m", appAccountToken: nil); XCTFail("expected throw") }
        catch { XCTAssertEqual(error as? Rovenue.Error, .purchaseCancelled) }
        XCTAssertFalse(validated, "must not validate on cancel")
    }

    func test_pending_throwsPending() async {
        let flow = ApplePurchaseFlow(
            store: FakeStore(outcome: .pending),
            validate: { _, _ in ReceiptResult(subscriberId: "s", appUserId: "u", creditBalance: 0) },
            snapshot: { ([], 0) }
        )
        do { _ = try await flow.run(productId: "com.x.m", appAccountToken: nil); XCTFail() }
        catch { XCTAssertEqual(error as? Rovenue.Error, .purchasePending) }
    }

    func test_success_validatesThenFinishes_andReturnsResult() async throws {
        let finished = Expectation()
        let flow = ApplePurchaseFlow(
            store: FakeStore(outcome: .success(jws: "JWS", transactionId: "42",
                                               finish: { await finished.fulfill() })),
            validate: { jws, pid in
                XCTAssertEqual(jws, "JWS"); XCTAssertEqual(pid, "com.x.m")
                return ReceiptResult(subscriberId: "s", appUserId: "u", creditBalance: 7)
            },
            snapshot: { ([], 7) }
        )
        let result = try await flow.run(productId: "com.x.m", appAccountToken: "tok")
        XCTAssertEqual(result.creditBalance, 7)
        XCTAssertEqual(result.storeTransactionId, "42")
        await finished.wait()  // finish() ran (after validation)
    }

    func test_validationFailure_doesNotFinish() async {
        let finished = Expectation()
        let flow = ApplePurchaseFlow(
            store: FakeStore(outcome: .success(jws: "JWS", transactionId: "1",
                                               finish: { await finished.fulfill() })),
            validate: { _, _ in throw Rovenue.Error.networkUnavailable },
            snapshot: { ([], 0) }
        )
        do { _ = try await flow.run(productId: "com.x.m", appAccountToken: nil); XCTFail() }
        catch { XCTAssertEqual(error as? Rovenue.Error, .networkUnavailable) }
        XCTAssertFalse(finished.wasFulfilled, "must not finish when validation fails")
    }
}

/// tiny async expectation helper
actor Expectation {
    private(set) var wasFulfilled = false
    func fulfill() { wasFulfilled = true }
    func wait() async { /* state already set synchronously in these tests */ }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `swift test --package-path packages/sdk-swift --filter ApplePurchaseFlowTests`
Expected: FAIL — `ApplePurchaseFlow` undefined.

- [ ] **Step 4: Implement the orchestration**

Create `packages/sdk-swift/Sources/Rovenue/Internal/ApplePurchaseFlow.swift`:
```swift
import Foundation

/// Store-agnostic purchase orchestration. Sequence: store purchase → (on success)
/// server validation → finish ONLY after validation succeeds → return snapshot.
internal struct ApplePurchaseFlow {
    let store: AppleStore
    /// Validates the receipt server-side (wraps core.postAppleReceipt). Throwing.
    let validate: @Sendable (_ jws: String, _ productId: String) async throws -> ReceiptResult
    /// Reads the post-validation entitlement + credit snapshot.
    let snapshot: @Sendable () async -> ([Entitlement], Int64)

    func run(productId: String, appAccountToken: String?) async throws -> PurchaseResult {
        let outcome = try await store.purchase(productId: productId, appAccountToken: appAccountToken)
        switch outcome {
        case .userCancelled:   throw Rovenue.Error.purchaseCancelled
        case .pending:         throw Rovenue.Error.purchasePending
        case .productNotFound: throw Rovenue.Error.productNotAvailable
        case let .success(jws, transactionId, finish):
            let receipt = try await validate(jws, productId) // throws → finish never runs
            await finish()                                   // only after validation OK
            let (entitlements, _) = await snapshot()
            return PurchaseResult(entitlements: entitlements,
                                  creditBalance: receipt.creditBalance,
                                  productId: productId,
                                  storeTransactionId: transactionId)
        }
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `swift test --package-path packages/sdk-swift --filter ApplePurchaseFlowTests`
Expected: PASS (4 cases).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Internal/AppleStore.swift packages/sdk-swift/Sources/Rovenue/Internal/ApplePurchaseFlow.swift packages/sdk-swift/Tests/RovenueTests/ApplePurchaseFlowTests.swift
git commit -m "feat(swift): testable ApplePurchaseFlow + AppleStore abstraction"
```

### Task 3.4: Real StoreKit 2 `AppleStore` + public Rovenue methods + listener

- [ ] **Step 1: Implement the real StoreKit store**

Append to `packages/sdk-swift/Sources/Rovenue/Internal/AppleStore.swift`:
```swift
import StoreKit

@available(iOS 15.0, macOS 12.0, *)
internal struct StoreKitAppleStore: AppleStore {
    func purchase(productId: String, appAccountToken: String?) async throws -> StorePurchaseOutcome {
        let products = try await Product.products(for: [productId])
        guard let product = products.first else { return .productNotFound }

        var options: Set<Product.PurchaseOption> = []
        if let token = appAccountToken, let uuid = UUID(uuidString: token) {
            options.insert(.appAccountToken(uuid))
        }

        let result = try await product.purchase(options: options)
        switch result {
        case .userCancelled: return .userCancelled
        case .pending:       return .pending
        case let .success(verification):
            guard case let .verified(transaction) = verification else {
                throw Rovenue.Error.receiptInvalid
            }
            let jws = verification.jwsRepresentation
            return .success(jws: jws,
                            transactionId: String(transaction.id),
                            finish: { await transaction.finish() })
        @unknown default:
            throw Rovenue.Error.storeProblem
        }
    }

    /// Live price metadata for offering products. Missing ids simply omit price.
    func products(for ids: [String]) async -> [String: Product] {
        guard let fetched = try? await Product.products(for: ids) else { return [:] }
        return Dictionary(uniqueKeysWithValues: fetched.map { ($0.id, $0) })
    }
}
```

- [ ] **Step 2: Add public methods + listener to `Rovenue.swift`**

In `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`:

Add a stored listener task to the instance state:
```swift
    private var transactionListener: Task<Void, Never>?
```

Start it at the end of `private init(...)`:
```swift
        if #available(iOS 15.0, macOS 12.0, *) {
            self.startTransactionListener()
        }
```

Cancel it in `shutdown()` and `resetForTesting()` (add `s.transactionListener?.cancel()` next to the existing cleanup in resetForTesting; add `transactionListener?.cancel()` in `shutdown()`).

Add the methods (in a new `// MARK: - Purchasing` section, replacing the Receipts section — see Task 3.5 for removal):
```swift
    @available(iOS 15.0, macOS 12.0, *)
    public func getOfferings() async throws -> Offerings {
        let ffi = try await dispatcher.run { [core] in
            do { return try core.getOfferings() }
            catch let e as RovenueError { throw mapError(e) }
        }
        let store = StoreKitAppleStore()
        // Gather every apple product id across offerings → one StoreKit query.
        let ids = ffi.offerings.flatMap { $0.packages.compactMap { $0.appleProductId } }
        let skProducts = await store.products(for: Array(Set(ids)))

        func toStoreProduct(_ p: OfferingProduct) -> StoreProduct {
            let sk = p.appleProductId.flatMap { skProducts[$0] }
            return StoreProduct(
                id: p.appleProductId ?? p.identifier,
                type: ProductType.from(p.productType),
                displayName: sk?.displayName ?? p.displayName,
                priceString: sk?.displayPrice,
                price: sk?.price,
                currencyCode: sk?.priceFormatStyle.currencyCode
            )
        }
        var all: [String: Offering] = [:]
        var current: Offering?
        for o in ffi.offerings {
            let offering = Offering(
                identifier: o.identifier, isDefault: o.isDefault,
                packages: o.packages.map { Package(identifier: $0.identifier, product: toStoreProduct($0)) }
            )
            all[o.identifier] = offering
            if o.identifier == ffi.current { current = offering }
        }
        return Offerings(current: current, all: all)
    }

    @available(iOS 15.0, macOS 12.0, *)
    public func purchase(_ package: Package) async throws -> PurchaseResult {
        try await purchase(package.product)
    }

    @available(iOS 15.0, macOS 12.0, *)
    public func purchase(_ product: StoreProduct) async throws -> PurchaseResult {
        Self.emit(LogEntry(level: "info", message: "purchase"))
        let token = try? await getAppAccountToken()
        let flow = ApplePurchaseFlow(
            store: StoreKitAppleStore(),
            validate: { [core, dispatcher] jws, productId in
                try await dispatcher.run {
                    do { return try core.postAppleReceipt(receipt: jws, productId: productId, appAccountToken: token) }
                    catch let e as RovenueError { throw mapError(e) }
                }
            },
            snapshot: { [weak self] in
                guard let self else { return ([], 0) }
                return (await self.entitlementsAll(), await self.creditBalance())
            }
        )
        return try await flow.run(productId: product.id, appAccountToken: token)
    }

    @available(iOS 15.0, macOS 12.0, *)
    public func restorePurchases() async throws -> PurchaseResult {
        try? await AppStore.sync()
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result else { continue }
            _ = try? await dispatcher.run { [core] in
                try? core.postAppleReceipt(receipt: result.jwsRepresentation,
                                           productId: transaction.productID, appAccountToken: nil)
            }
        }
        try await refreshEntitlements()
        return PurchaseResult(entitlements: await entitlementsAll(),
                              creditBalance: await creditBalance(),
                              productId: "", storeTransactionId: "")
    }

    @available(iOS 15.0, macOS 12.0, *)
    private func startTransactionListener() {
        transactionListener = Task.detached { [weak self] in
            for await update in Transaction.updates {
                guard let self, case .verified(let transaction) = update else { continue }
                _ = try? await self.dispatcher.run { [core = self.core] in
                    try? core.postAppleReceipt(receipt: update.jwsRepresentation,
                                               productId: transaction.productID, appAccountToken: nil)
                }
                await transaction.finish()
            }
        }
    }
```

- [ ] **Step 3: Build (no live StoreKit test here; orchestration already covered in 3.3)**

Run: `swift build --package-path packages/sdk-swift`
Expected: success.

- [ ] **Step 4: Run the full Swift suite**

Run: `swift test --package-path packages/sdk-swift`
Expected: PASS (existing tests + purchase tests; note: the existing post-receipt façade tests are removed in Task 3.5, do that before this passes cleanly — run after 3.5).

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue
git commit -m "feat(swift): getOfferings/purchase/restorePurchases + Transaction.updates listener"
```

### Task 3.5: Remove the legacy receipt methods from the Swift surface

- [ ] **Step 1: Update tests first (delete obsolete, expect removal)**

Delete the `postAppleReceipt`/`postGoogleReceipt` test methods from the existing Swift test files (search and remove):
Run: `grep -rln "postAppleReceipt\|postGoogleReceipt" packages/sdk-swift/Tests`
Remove those test methods.

- [ ] **Step 2: Remove the methods**

In `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`, delete the entire `// MARK: - Receipts` section (`postAppleReceipt` and `postGoogleReceipt` public methods). The core still exposes them (the listener/purchase flow call `core.postAppleReceipt` internally) — only the public Swift façade methods go away.

- [ ] **Step 3: Run to verify everything compiles + passes**

Run: `swift test --package-path packages/sdk-swift`
Expected: PASS; `grep -rn "func postAppleReceipt\|func postGoogleReceipt" packages/sdk-swift/Sources` returns nothing.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-swift
git commit -m "refactor(swift)!: remove postAppleReceipt/postGoogleReceipt public methods"
```

---

## Phase 4 — Kotlin/Android: convert to Android library + Play Billing 6

**Why:** Play Billing 6 requires Android + an `Activity`. `sdk-kotlin` is pure-JVM today; this phase converts it to an Android library and adds the billing-driven purchase flow, mirroring the Swift orchestration (isolated `PlayStore` interface for testability).

**Files:**
- Modify: `packages/sdk-kotlin/build.gradle.kts` (Android library plugin, billing dep, Robolectric)
- Create: `packages/sdk-kotlin/src/main/AndroidManifest.xml`
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayStore.kt` (interface + outcome)
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayBillingStore.kt` (real impl)
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayPurchaseFlow.kt` (testable orchestration)
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` (types, methods, remove post*)
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/PlayPurchaseFlowTest.kt` (create)

### Task 4.1: Convert build to an Android library

- [ ] **Step 1: Rewrite `build.gradle.kts`**

Replace `packages/sdk-kotlin/build.gradle.kts` plugins/config with an Android library setup (keep JNA + coroutines + serialization deps):
```kotlin
plugins {
    id("com.android.library") version "8.2.0"
    kotlin("android") version "1.9.23"
    kotlin("plugin.serialization") version "1.9.23"
    `maven-publish`
}

android {
    namespace = "dev.rovenue.sdk"
    compileSdk = 34
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests { isReturnDefaultValues = true; isIncludeAndroidResources = true } }
}

dependencies {
    implementation("net.java.dev.jna:jna:5.14.0@aar")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("com.android.billingclient:billing-ktx:6.2.0")

    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.0")
    testImplementation("org.robolectric:robolectric:4.11.1")
    testImplementation("io.mockk:mockk:1.13.10")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<Test> { useJUnitPlatform() }
```
Note: JNA switches to the `@aar` artifact for Android. The `jna.library.path` system property used previously is replaced by packaging the native lib under `jniLibs` — for unit tests we still point JNA at the host `target/release` build via a Robolectric-friendly property; keep the existing `systemProperty("jna.library.path", ...)` inside a `tasks.withType<Test>` block.

- [ ] **Step 2: Add the manifest**

Create `packages/sdk-kotlin/src/main/AndroidManifest.xml`:
```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.rovenue.sdk">
    <uses-permission android:name="com.android.vending.BILLING" />
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
```

- [ ] **Step 3: Verify the project configures**

Run: `./gradlew :sdk-kotlin:tasks` (from `packages/sdk-kotlin`, or the repo's gradle wrapper path)
Expected: the Android library tasks (e.g. `assembleDebug`, `testDebugUnitTest`) are listed — confirms the plugin applied.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-kotlin/build.gradle.kts packages/sdk-kotlin/src/main/AndroidManifest.xml
git commit -m "build(kotlin)!: convert sdk-kotlin to an Android library with Play Billing 6"
```

### Task 4.2: Public purchase types (Kotlin)

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/PlayPurchaseFlowTest.kt` (start with a type test):
```kotlin
package dev.rovenue.sdk

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class PurchaseTypesTest {
    @Test fun shapes() {
        val p = StoreProduct("g_m", ProductType.SUBSCRIPTION, "Monthly", "$4.99", 4.99, "USD")
        val pkg = Package("monthly", p)
        val offering = Offering("default", true, listOf(pkg))
        val offerings = Offerings(offering, mapOf("default" to offering))
        assertEquals(ProductType.SUBSCRIPTION, offerings.current?.packages?.first()?.product?.type)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `./gradlew :sdk-kotlin:testDebugUnitTest --tests "dev.rovenue.sdk.PurchaseTypesTest"`
Expected: FAIL — types undefined.

- [ ] **Step 3: Implement the types**

In `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt` (or a new `Types.kt` in the same package — match the package’s existing file convention; if types live inline today, add here):
```kotlin
enum class ProductType {
    SUBSCRIPTION, CONSUMABLE, NON_CONSUMABLE;
    companion object {
        fun from(raw: String): ProductType = when (raw) {
            "CONSUMABLE" -> CONSUMABLE
            "NON_CONSUMABLE" -> NON_CONSUMABLE
            else -> SUBSCRIPTION
        }
    }
}

data class StoreProduct(
    val id: String,
    val type: ProductType,
    val displayName: String,
    val priceString: String? = null,
    val price: Double? = null,
    val currencyCode: String? = null,
)

data class Package(val identifier: String, val product: StoreProduct)
data class Offering(val identifier: String, val isDefault: Boolean, val packages: List<Package>)
data class Offerings(val current: Offering?, val all: Map<String, Offering>)
data class PurchaseResult(
    val entitlements: List<Entitlement>,
    val creditBalance: Long,
    val productId: String,
    val storeTransactionId: String,
)
```

- [ ] **Step 4: Run to verify it passes**

Run: `./gradlew :sdk-kotlin:testDebugUnitTest --tests "dev.rovenue.sdk.PurchaseTypesTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/PlayPurchaseFlowTest.kt
git commit -m "feat(kotlin): public Offerings/Package/StoreProduct/PurchaseResult types"
```

### Task 4.3: `PlayStore` abstraction + testable `PlayPurchaseFlow`

- [ ] **Step 1: Write the abstraction**

Create `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayStore.kt`:
```kotlin
package dev.rovenue.sdk.internal

import android.app.Activity

/** Normalised outcome of a Play Billing purchase, decoupled from BillingClient types. */
sealed interface StorePurchaseOutcome {
    data class Success(
        val purchaseToken: String,
        val orderId: String,
        val acknowledge: suspend () -> Unit,
    ) : StorePurchaseOutcome
    data object UserCancelled : StorePurchaseOutcome
    data object Pending : StorePurchaseOutcome
    data object ProductNotFound : StorePurchaseOutcome
}

/** Abstraction over the Play Billing pieces the SDK drives. Real impl wraps BillingClient. */
interface PlayStore {
    suspend fun purchase(
        activity: Activity,
        productId: String,
        productType: dev.rovenue.sdk.ProductType,
        obfuscatedAccountId: String?,
    ): StorePurchaseOutcome
}
```

- [ ] **Step 2: Write the failing orchestration test**

Append to `PlayPurchaseFlowTest.kt`:
```kotlin
import dev.rovenue.sdk.internal.PlayPurchaseFlow
import dev.rovenue.sdk.internal.PlayStore
import dev.rovenue.sdk.internal.StorePurchaseOutcome
import android.app.Activity
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PlayPurchaseFlowTest {
    private val activity = mockk<Activity>(relaxed = true)

    private fun store(outcome: StorePurchaseOutcome) = object : PlayStore {
        override suspend fun purchase(a: Activity, p: String, t: ProductType, o: String?) = outcome
    }

    @Test fun cancelled_throws_and_does_not_validate() = runTest {
        var validated = false
        val flow = PlayPurchaseFlow(
            store = store(StorePurchaseOutcome.UserCancelled),
            validate = { _, _ -> validated = true; ReceiptResult("s", "u", 0) },
            snapshot = { emptyList<Entitlement>() to 0L },
        )
        val ex = assertThrows(RovenueException.PurchaseCancelled::class.java) {
            runTest { flow.run(activity, "g_m", ProductType.SUBSCRIPTION, null) }
        }
        assertNotNull(ex)
        assertFalse(validated)
    }

    @Test fun success_validates_then_acknowledges() = runTest {
        var acked = false
        val flow = PlayPurchaseFlow(
            store = store(StorePurchaseOutcome.Success("tok", "order_1", acknowledge = { acked = true })),
            validate = { token, pid ->
                assertEquals("tok", token); assertEquals("g_m", pid)
                ReceiptResult("s", "u", 9)
            },
            snapshot = { emptyList<Entitlement>() to 9L },
        )
        val result = flow.run(activity, "g_m", ProductType.SUBSCRIPTION, null)
        assertEquals(9L, result.creditBalance)
        assertEquals("order_1", result.storeTransactionId)
        assertTrue(acked)
    }

    @Test fun validation_failure_does_not_acknowledge() = runTest {
        var acked = false
        val flow = PlayPurchaseFlow(
            store = store(StorePurchaseOutcome.Success("tok", "o", acknowledge = { acked = true })),
            validate = { _, _ -> throw RovenueException.NetworkUnavailable("offline") },
            snapshot = { emptyList<Entitlement>() to 0L },
        )
        assertThrows(RovenueException.NetworkUnavailable::class.java) {
            runTest { flow.run(activity, "g_m", ProductType.SUBSCRIPTION, null) }
        }
        assertFalse(acked)
    }
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `./gradlew :sdk-kotlin:testDebugUnitTest --tests "dev.rovenue.sdk.PlayPurchaseFlowTest"`
Expected: FAIL — `PlayPurchaseFlow` undefined.

- [ ] **Step 4: Implement the orchestration**

Create `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayPurchaseFlow.kt`:
```kotlin
package dev.rovenue.sdk.internal

import android.app.Activity
import dev.rovenue.sdk.Entitlement
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.PurchaseResult
import dev.rovenue.sdk.RovenueException
import dev.rovenue.sdk.generated.ReceiptResult

/** Store-agnostic purchase orchestration: purchase → validate → finish-after-validation. */
class PlayPurchaseFlow(
    private val store: PlayStore,
    private val validate: suspend (token: String, productId: String) -> ReceiptResult,
    private val snapshot: suspend () -> Pair<List<Entitlement>, Long>,
) {
    suspend fun run(
        activity: Activity,
        productId: String,
        productType: ProductType,
        obfuscatedAccountId: String?,
    ): PurchaseResult {
        when (val outcome = store.purchase(activity, productId, productType, obfuscatedAccountId)) {
            is StorePurchaseOutcome.UserCancelled -> throw RovenueException.PurchaseCancelled("cancelled")
            is StorePurchaseOutcome.Pending -> throw RovenueException.PurchasePending("pending")
            is StorePurchaseOutcome.ProductNotFound -> throw RovenueException.ProductNotAvailable("not found")
            is StorePurchaseOutcome.Success -> {
                val receipt = validate(outcome.purchaseToken, productId) // throws → no ack
                outcome.acknowledge()                                    // only after validation
                val (entitlements, _) = snapshot()
                return PurchaseResult(entitlements, receipt.creditBalance, productId, outcome.orderId)
            }
        }
    }
}
```

Add the new exception subclasses. Since `RovenueException` is a generated sealed class, do NOT edit the generated file — declare the purchase-flow exceptions as a separate sealed hierarchy is not possible (sealed). Instead add them as top-level exceptions in `Rovenue.kt`:
```kotlin
// Native-origin purchase errors (not from the Rust core). Kept as siblings of the
// generated RovenueException; consumers catch these directly.
class PurchaseCancelledException(message: String) : Exception(message)
class PurchasePendingException(message: String) : Exception(message)
class ProductNotAvailableException(message: String) : Exception(message)
class StoreProblemException(message: String) : Exception(message)
```
Then in the test and flow, replace `RovenueException.PurchaseCancelled` etc. with `PurchaseCancelledException` etc. (Adjust the Step-2 test imports/asserts accordingly before running.)

- [ ] **Step 5: Run to verify it passes**

Run: `./gradlew :sdk-kotlin:testDebugUnitTest --tests "dev.rovenue.sdk.PlayPurchaseFlowTest"`
Expected: PASS (3 cases).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/PlayPurchaseFlowTest.kt
git commit -m "feat(kotlin): testable PlayPurchaseFlow + PlayStore abstraction"
```

### Task 4.4: Real Play Billing store + public methods + listener; remove post*

- [ ] **Step 1: Implement `PlayBillingStore`**

Create `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayBillingStore.kt`:
```kotlin
package dev.rovenue.sdk.internal

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.*
import dev.rovenue.sdk.ProductType
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Real Play Billing 6 implementation. Connects lazily, queries ProductDetails,
 * launches the billing flow, and surfaces a normalised outcome. Acknowledge/consume
 * is deferred to the returned Success.acknowledge so it only runs post-validation.
 */
class PlayBillingStore(private val context: Context) : PlayStore {
    @Volatile private var client: BillingClient? = null

    private suspend fun connected(): BillingClient = suspendCancellableCoroutine { cont ->
        val existing = client
        if (existing != null && existing.isReady) { cont.resume(existing); return@suspendCancellableCoroutine }
        val c = BillingClient.newBuilder(context)
            .enablePendingPurchases()
            .setListener { _, _ -> /* updates handled via query after launch */ }
            .build()
        c.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    client = c; cont.resume(c)
                } else cont.cancel(StoreProblemSignal())
            }
            override fun onBillingServiceDisconnected() {}
        })
    }

    override suspend fun purchase(
        activity: Activity, productId: String, productType: ProductType, obfuscatedAccountId: String?,
    ): StorePurchaseOutcome {
        val billing = connected()
        val skuType = if (productType == ProductType.SUBSCRIPTION) BillingClient.ProductType.SUBS
                      else BillingClient.ProductType.INAPP
        val details = queryDetails(billing, productId, skuType) ?: return StorePurchaseOutcome.ProductNotFound

        val offerToken = details.subscriptionOfferDetails?.firstOrNull()?.offerToken
        val paramsProduct = BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(details)
            .apply { if (offerToken != null) setOfferToken(offerToken) }
            .build()
        val flowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(paramsProduct))
            .apply { if (obfuscatedAccountId != null) setObfuscatedAccountId(obfuscatedAccountId) }
            .build()

        return launchAndAwait(billing, activity, flowParams, productType)
    }

    private suspend fun queryDetails(billing: BillingClient, productId: String, type: String): ProductDetails? =
        suspendCancellableCoroutine { cont ->
            val params = QueryProductDetailsParams.newBuilder().setProductList(listOf(
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(productId).setProductType(type).build())).build()
            billing.queryProductDetailsAsync(params) { _, list -> cont.resume(list.firstOrNull()) }
        }

    private suspend fun launchAndAwait(
        billing: BillingClient, activity: Activity, params: BillingFlowParams, productType: ProductType,
    ): StorePurchaseOutcome = suspendCancellableCoroutine { cont ->
        // Re-create a client bound to a one-shot listener for this flow.
        val flowClient = BillingClient.newBuilder(context).enablePendingPurchases()
            .setListener { result, purchases ->
                when (result.responseCode) {
                    BillingClient.BillingResponseCode.USER_CANCELED -> cont.resume(StorePurchaseOutcome.UserCancelled)
                    BillingClient.BillingResponseCode.OK -> {
                        val p = purchases?.firstOrNull()
                        if (p == null) { cont.resume(StorePurchaseOutcome.ProductNotFound); return@setListener }
                        if (p.purchaseState == Purchase.PurchaseState.PENDING) {
                            cont.resume(StorePurchaseOutcome.Pending); return@setListener
                        }
                        cont.resume(StorePurchaseOutcome.Success(
                            purchaseToken = p.purchaseToken,
                            orderId = p.orderId ?: p.purchaseToken,
                            acknowledge = {
                                if (productType == ProductType.CONSUMABLE) {
                                    consume(billing, p.purchaseToken)
                                } else if (!p.isAcknowledged) {
                                    acknowledge(billing, p.purchaseToken)
                                }
                            },
                        ))
                    }
                    else -> cont.resume(StorePurchaseOutcome.ProductNotFound)
                }
            }.build()
        flowClient.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(r: BillingResult) {
                flowClient.launchBillingFlow(activity, params)
            }
            override fun onBillingServiceDisconnected() {}
        })
    }

    private suspend fun acknowledge(billing: BillingClient, token: String) = suspendCancellableCoroutine<Unit> { cont ->
        billing.acknowledgePurchase(
            AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build()) { cont.resume(Unit) }
    }
    private suspend fun consume(billing: BillingClient, token: String) = suspendCancellableCoroutine<Unit> { cont ->
        billing.consumeAsync(ConsumeParams.newBuilder().setPurchaseToken(token).build()) { _, _ -> cont.resume(Unit) }
    }
}

private class StoreProblemSignal : Exception()
```
Note: this is the integration edge — its correctness is verified by manual/instrumented testing, not the unit suite (the unit suite covers orchestration via the fake `PlayStore`). Keep it minimal and idiomatic; refine connection reuse during manual verification.

- [ ] **Step 2: Add public methods to `Rovenue.kt`**

Add (suspend functions, threading through `dispatcher` like the existing methods). `purchase` needs an `Activity`:
```kotlin
suspend fun getOfferings(): Offerings {
    val ffi = dispatcher.run { core.getOfferings() }
    // Play price hydration requires a BillingClient query; v1 returns config-only
    // prices (null) here and lets callers query details if needed. Price hydration
    // via PlayBillingStore.queryDetails can be layered in during manual verification.
    val all = HashMap<String, Offering>()
    var current: Offering? = null
    for (o in ffi.offerings) {
        val offering = Offering(o.identifier, o.isDefault, o.packages.map {
            Package(it.identifier, StoreProduct(
                id = it.googleProductId ?: it.identifier,
                type = ProductType.from(it.productType),
                displayName = it.displayName,
            ))
        })
        all[o.identifier] = offering
        if (o.identifier == ffi.current) current = offering
    }
    return Offerings(current, all)
}

suspend fun purchase(activity: Activity, pkg: Package): PurchaseResult =
    purchase(activity, pkg.product)

suspend fun purchase(activity: Activity, product: StoreProduct): PurchaseResult {
    val token = try { getAppAccountToken() } catch (e: Throwable) { null }
    val flow = PlayPurchaseFlow(
        store = PlayBillingStore(appContext),
        validate = { purchaseToken, productId ->
            dispatcher.run { core.postGoogleReceipt(purchaseToken, productId, token, null) }
        },
        snapshot = { entitlementsAll() to creditBalance() },
    )
    return flow.run(activity, product.id, product.type, token)
}

suspend fun restorePurchases(activity: Activity): PurchaseResult {
    // Query existing purchases and re-validate each; details in manual verification.
    refreshEntitlements()
    return PurchaseResult(entitlementsAll(), creditBalance(), "", "")
}
```
`appContext` must be captured at `configure()` time. Add an `appContext: Context` parameter to `Rovenue.configure(...)` (Android libraries get it from the host); store it on the singleton. Update the RN Android module call site in Phase 5 accordingly.

- [ ] **Step 3: Remove the legacy receipt methods**

Delete `postAppleReceipt` and `postGoogleReceipt` public functions from `Rovenue.kt` (the core binding still exposes them; only the public façade methods are removed). Delete `PostReceiptWithTokenTest.kt`.

- [ ] **Step 4: Run the Kotlin suite**

Run: `./gradlew :sdk-kotlin:testDebugUnitTest`
Expected: PASS; `grep -rn "fun postAppleReceipt\|fun postGoogleReceipt" packages/sdk-kotlin/src/main` returns nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin
git commit -m "feat(kotlin)!: Play Billing purchase/getOfferings/restore; remove post* methods"
```

---

## Phase 5 — React Native: getOfferings / purchase / restorePurchases

**Why:** This is the surface the user cares about. New TS types + errors + API functions, native-spec + Expo-module wiring (iOS Swift + Android Kotlin), mock + tests, and removal of the legacy receipt surface.

**Files:**
- Modify: `packages/sdk-rn/src/types.ts` (purchase types)
- Modify: `packages/sdk-rn/src/errors.ts` (new error classes + mapping)
- Create: `packages/sdk-rn/src/api/purchases.ts` (getOfferings/purchase/restorePurchases)
- Delete: `packages/sdk-rn/src/api/receipts.ts`
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts` (native DTOs)
- Modify: `packages/sdk-rn/src/index.ts` (export new, drop old)
- Modify: `packages/sdk-rn/src/__tests__/_mockNative.ts` (mock new methods, drop old)
- Modify: `packages/sdk-rn/src/__tests__/api.test.ts` (replace receipt tests)
- Modify: `packages/sdk-rn/ios/RovenueModule.swift` (wire purchase/getOfferings)
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt` (wire purchase/getOfferings)

### Task 5.1: TS types + error classes

- [ ] **Step 1: Write the failing test**

In `packages/sdk-rn/src/__tests__/errors.test.ts`, append:
```ts
import {
  PurchaseCancelledError, PurchasePendingError,
  ProductNotAvailableError, StoreProblemError,
} from "../errors";
import { mapNativeError } from "../errors";

describe("purchase error mapping", () => {
  it("maps native purchase codes to typed errors", () => {
    expect(mapNativeError("PurchaseCancelled", "x")).toBeInstanceOf(PurchaseCancelledError);
    expect(mapNativeError("PurchasePending", "x")).toBeInstanceOf(PurchasePendingError);
    expect(mapNativeError("ProductNotAvailable", "x")).toBeInstanceOf(ProductNotAvailableError);
    expect(mapNativeError("StoreProblem", "x")).toBeInstanceOf(StoreProblemError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @rovenue/sdk-rn test errors`
Expected: FAIL — those classes are not exported.

- [ ] **Step 3: Implement error classes + mapping**

In `packages/sdk-rn/src/errors.ts`, add four classes (mirroring the existing pattern) before `InternalError`:
```ts
export class PurchaseCancelledError extends RovenueError {
  constructor(message: string) { super("PurchaseCancelled", message); this.name = "PurchaseCancelledError"; }
}
export class PurchasePendingError extends RovenueError {
  constructor(message: string) { super("PurchasePending", message); this.name = "PurchasePendingError"; }
}
export class ProductNotAvailableError extends RovenueError {
  constructor(message: string) { super("ProductNotAvailable", message); this.name = "ProductNotAvailableError"; }
}
export class StoreProblemError extends RovenueError {
  constructor(message: string) { super("StoreProblem", message); this.name = "StoreProblemError"; }
}
```
Add the cases to `mapNativeError`'s switch (before `default`):
```ts
    case "PurchaseCancelled":     return new PurchaseCancelledError(message);
    case "PurchasePending":       return new PurchasePendingError(message);
    case "ProductNotAvailable":   return new ProductNotAvailableError(message);
    case "StoreProblem":          return new StoreProblemError(message);
```

- [ ] **Step 4: Add the purchase types**

In `packages/sdk-rn/src/types.ts`, add (and remove the `ReceiptResult` type — it's no longer used):
```ts
export type ProductType = 'subscription' | 'consumable' | 'non_consumable';

export type StoreProduct = {
  id: string;
  type: ProductType;
  displayName: string;
  priceString: string | null;
  price: number | null;
  currencyCode: string | null;
};

export type Package = { identifier: string; product: StoreProduct };
export type Offering = { identifier: string; isDefault: boolean; packages: Package[] };
export type Offerings = { current: Offering | null; all: Record<string, Offering> };

export type PurchaseResult = {
  entitlements: Entitlement[];
  creditBalance: number;
  productId: string;
  storeTransactionId: string;
};
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @rovenue/sdk-rn test errors`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-rn/src/errors.ts packages/sdk-rn/src/types.ts packages/sdk-rn/src/__tests__/errors.test.ts
git commit -m "feat(sdk-rn): purchase types + purchase-flow error classes"
```

### Task 5.2: Native DTOs + purchases API

- [ ] **Step 1: Update the native spec DTOs**

In `packages/sdk-rn/src/specs/RovenueModule.types.ts`:
- Remove `ReceiptResultDTO`, `postAppleReceipt`, `postGoogleReceipt`.
- Add:
```ts
export type ProductTypeDTO = "subscription" | "consumable" | "non_consumable";
export type StoreProductDTO = {
  id: string; type: ProductTypeDTO; displayName: string;
  priceString: string | null; price: number | null; currencyCode: string | null;
};
export type PackageDTO = { identifier: string; product: StoreProductDTO };
export type OfferingDTO = { identifier: string; isDefault: boolean; packages: PackageDTO[] };
export type OfferingsDTO = { current: string | null; offerings: OfferingDTO[] };
export type PurchaseResultDTO = {
  entitlements: EntitlementDTO[]; creditBalance: number;
  productId: string; storeTransactionId: string;
};
```
- In `RovenueModuleSpec`, replace the Receipts section with:
```ts
  // Purchasing
  getOfferings(): Promise<OfferingsDTO>;
  purchase(productId: string, productType: ProductTypeDTO): Promise<PurchaseResultDTO>;
  restorePurchases(): Promise<PurchaseResultDTO>;
```

- [ ] **Step 2: Write the failing API test**

In `packages/sdk-rn/src/__tests__/api.test.ts`:
- remove the `postAppleReceipt`/`postGoogleReceipt` imports and their `-------- receipts --------` test block.
- add at the top: `import { getOfferings, purchase, restorePurchases } from "../api/purchases";`
- add:
```ts
  // -------- purchases --------
  it("getOfferings maps DTO (current id → current offering)", async () => {
    native.getOfferings = vi.fn(async () => ({
      current: "default",
      offerings: [{
        identifier: "default", isDefault: true,
        packages: [{ identifier: "monthly", product: {
          id: "com.x.m", type: "subscription", displayName: "Monthly",
          priceString: "$4.99", price: 4.99, currencyCode: "USD" } }],
      }],
    }));
    const offerings = await getOfferings();
    expect(offerings.current?.identifier).toBe("default");
    expect(offerings.all["default"].packages[0].product.id).toBe("com.x.m");
  });

  it("purchase forwards id+type and returns PurchaseResult", async () => {
    native.purchase = vi.fn(async () => ({
      entitlements: [], creditBalance: 5, productId: "com.x.m", storeTransactionId: "42",
    }));
    const r = await purchase({ identifier: "monthly", product: {
      id: "com.x.m", type: "subscription", displayName: "M",
      priceString: null, price: null, currencyCode: null } });
    expect(native.purchase).toHaveBeenCalledWith("com.x.m", "subscription");
    expect(r.creditBalance).toBe(5);
  });

  it("purchase maps a native cancel code to PurchaseCancelledError", async () => {
    native.purchase = vi.fn(async () => { const e: any = new Error("x"); e.code = "PurchaseCancelled"; throw e; });
    await expect(purchase({ identifier: "m", product: {
      id: "com.x.m", type: "subscription", displayName: "M",
      priceString: null, price: null, currencyCode: null } })).rejects.toBeInstanceOf(PurchaseCancelledError);
  });
```
(import `PurchaseCancelledError` at the top.)

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @rovenue/sdk-rn test api`
Expected: FAIL — `../api/purchases` does not exist.

- [ ] **Step 4: Implement the purchases API + update the mock**

Create `packages/sdk-rn/src/api/purchases.ts`:
```ts
import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import type { Offerings, Offering, Package, PurchaseResult, StoreProduct } from "../types";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

export async function getOfferings(): Promise<Offerings> {
  const dto = await call(() => getNative().getOfferings());
  const all: Record<string, Offering> = {};
  let current: Offering | null = null;
  for (const o of dto.offerings) {
    const offering: Offering = {
      identifier: o.identifier,
      isDefault: o.isDefault,
      packages: o.packages.map((p) => ({ identifier: p.identifier, product: p.product as StoreProduct })),
    };
    all[o.identifier] = offering;
    if (o.identifier === dto.current) current = offering;
  }
  return { current, all };
}

export async function purchase(target: Package | StoreProduct): Promise<PurchaseResult> {
  const product = "product" in target ? target.product : target;
  return call(() => getNative().purchase(product.id, product.type));
}

export async function restorePurchases(): Promise<PurchaseResult> {
  return call(() => getNative().restorePurchases());
}
```

In `packages/sdk-rn/src/__tests__/_mockNative.ts`:
- remove `postAppleReceipt`/`postGoogleReceipt` and the `ReceiptResultDTO` import.
- add to the mock object:
```ts
    getOfferings: vi.fn(async () => ({ current: null, offerings: [] })),
    purchase: vi.fn(async () => ({
      entitlements: [], creditBalance: 0, productId: "", storeTransactionId: "",
    })),
    restorePurchases: vi.fn(async () => ({
      entitlements: [], creditBalance: 0, productId: "", storeTransactionId: "",
    })),
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @rovenue/sdk-rn test api`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-rn/src/api/purchases.ts packages/sdk-rn/src/specs/RovenueModule.types.ts packages/sdk-rn/src/__tests__/_mockNative.ts packages/sdk-rn/src/__tests__/api.test.ts
git commit -m "feat(sdk-rn): getOfferings/purchase/restorePurchases API + native DTOs"
```

### Task 5.3: Wire the public namespace; delete receipts.ts

- [ ] **Step 1: Update `index.ts`**

In `packages/sdk-rn/src/index.ts`:
- replace `import { postAppleReceipt, postGoogleReceipt } from "./api/receipts";` with `import { getOfferings, purchase, restorePurchases } from "./api/purchases";`
- in the exported `type { ... } from "./types"` list: remove `ReceiptResult`, add `ProductType, StoreProduct, Package, Offering, Offerings, PurchaseResult`.
- in the `export { ... } from "./errors"` list, add the four new error classes.
- in the `Rovenue` object literal: remove `postAppleReceipt, postGoogleReceipt`; add `getOfferings, purchase, restorePurchases`.

- [ ] **Step 2: Delete the obsolete file**

Run: `git rm packages/sdk-rn/src/api/receipts.ts`

- [ ] **Step 3: Run the full RN suite + typecheck**

Run: `pnpm --filter @rovenue/sdk-rn test && pnpm --filter @rovenue/sdk-rn build`
Expected: PASS + clean build; `grep -rn "postAppleReceipt\|postGoogleReceipt" packages/sdk-rn/src` returns nothing.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-rn/src/index.ts
git commit -m "feat(sdk-rn)!: expose purchase API on Rovenue; remove receipts surface"
```

### Task 5.4: Wire the Expo native modules (iOS + Android)

These are integration edges — verified by build, not unit tests.

- [ ] **Step 1: iOS module**

In `packages/sdk-rn/ios/RovenueModule.swift`:
- remove the `postAppleReceipt` / `postGoogleReceipt` `AsyncFunction`s.
- add (mapping the Swift façade types to JS dictionaries):
```swift
AsyncFunction("getOfferings") { () -> [String: Any] in
    let offerings = try await Rovenue.shared.getOfferings()
    return RovenueModule.encode(offerings)
}
AsyncFunction("purchase") { (productId: String, productType: String) -> [String: Any] in
    // Resolve a minimal StoreProduct; the Swift layer re-queries StoreKit by id.
    let product = StoreProduct(id: productId, type: ProductType.from(productType.uppercased() == "SUBSCRIPTION" ? "SUBSCRIPTION" : productType == "consumable" ? "CONSUMABLE" : "NON_CONSUMABLE"), displayName: "")
    let result = try await Rovenue.shared.purchase(product)
    return RovenueModule.encode(result)
}
AsyncFunction("restorePurchases") { () -> [String: Any] in
    RovenueModule.encode(try await Rovenue.shared.restorePurchases())
}
```
Add private `encode(_:)` helpers converting `Offerings`/`PurchaseResult` to `[String: Any]` matching the DTO shapes in `RovenueModule.types.ts` (offerings → `{ current, offerings: [...] }`, purchaseResult → `{ entitlements, creditBalance, productId, storeTransactionId }`). Map purchase errors to Expo error codes (`PurchaseCancelled`, etc.) so `mapNativeError` picks the right class.

- [ ] **Step 2: Android module**

In `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`:
- remove the `postAppleReceipt`/`postGoogleReceipt` functions.
- pass the Android context/activity into `Rovenue.configure(...)` (use `appContext.reactContext` for the Context; obtain the current `Activity` via `appContext.currentActivity` inside `purchase`).
- add `AsyncFunction`s for `getOfferings`, `purchase(productId, productType)` (calling `Rovenue.shared.purchase(activity, ...)`), and `restorePurchases`, encoding results to the DTO maps. Map the purchase exceptions to codes (`PurchaseCancelled`, etc.).

- [ ] **Step 3: Build both native modules**

Run the example/build task that compiles the Expo module (e.g. `pnpm --filter @rovenue/sdk-rn build` for TS, plus the iOS `swift build` for the wrapped package and `./gradlew :sdk-kotlin:assembleDebug`). Confirm no references to the removed methods remain:
Run: `grep -rn "postAppleReceipt\|postGoogleReceipt" packages/sdk-rn/ios packages/sdk-rn/android`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-rn/ios packages/sdk-rn/android
git commit -m "feat(sdk-rn): wire purchase/getOfferings/restore through Expo iOS+Android modules"
```

---

## Phase 6 — Docs

**Why:** Every guide currently says "the SDK does not call StoreKit/Play Billing." That's now false. Rewrite the purchase guides and flip the RevenueCat-migration narrative.

**Files:**
- Modify: `apps/docs/content/docs/guides/processing-purchases.mdx`
- Modify: `apps/docs/content/docs/getting-started/quickstart.mdx`
- Modify: `apps/docs/content/docs/platforms/react-native.mdx`
- Modify: `apps/docs/content/docs/index.mdx`
- Modify: `apps/docs/content/docs/resources/migrating-from-revenuecat.mdx`

### Task 6.1: Rewrite the purchase guide

- [ ] **Step 1: Rewrite `processing-purchases.mdx`**

Replace the "SDK does not call StoreKit/Play Billing; run your store flow then post the receipt" content with the new flow:
```md
## Purchasing

Fetch your remote-configured offerings, then purchase a package. The SDK drives the
native store flow (StoreKit 2 / Play Billing 6), validates the receipt with Rovenue,
and resolves with your updated entitlements.

```ts
const offerings = await Rovenue.getOfferings();
const pkg = offerings.current?.packages[0];
if (pkg) {
  try {
    const result = await Rovenue.purchase(pkg);
    // result.entitlements / result.creditBalance are already up to date
  } catch (e) {
    if (e instanceof PurchaseCancelledError) { /* user dismissed — ignore */ }
    else if (e instanceof PurchasePendingError) { /* Ask-to-Buy / deferred */ }
    else throw e;
  }
}

// Restore on a new device / reinstall:
await Rovenue.restorePurchases();
```

Validation happens transparently. Subscriptions and one-time products are both
handled — Rovenue decides entitlements vs. credits server-side from your product
config.
```

- [ ] **Step 2: Verify no stale "does not call StoreKit" lines remain in this file**

Run: `grep -n "does not call StoreKit\|do not call StoreKit\|hands the resulting\|postAppleReceipt\|postGoogleReceipt" apps/docs/content/docs/guides/processing-purchases.mdx`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add apps/docs/content/docs/guides/processing-purchases.mdx
git commit -m "docs: rewrite processing-purchases for SDK-driven purchase()"
```

### Task 6.2: Update quickstart, react-native, index, and flip the RevenueCat migration

- [ ] **Step 1: Edit the remaining four files**

- `quickstart.mdx`: replace the "run your store's purchase flow, then post the receipt" snippet with the `getOfferings()` + `purchase(pkg)` flow.
- `platforms/react-native.mdx`: remove "The SDK does not call StoreKit or Play Billing" line; document `getOfferings`/`purchase`/`restorePurchases`.
- `index.mdx`: remove the "It does not call StoreKit or Play Billing. Your app performs the…" bullet; replace with a one-line "Rovenue drives the store purchase and validates it for you."
- `migrating-from-revenuecat.mdx`: flip the comparison table row to show Rovenue's `purchase(pkg)` as the equivalent of RevenueCat's `purchasePackage`, and rewrite the prose paragraph (currently "Rovenue does not own the purchase UI or flow") to "Rovenue drives the purchase like RevenueCat — call `getOfferings()` then `purchase(pkg)`; receipts are validated automatically."

- [ ] **Step 2: Verify the stale claim is gone repo-wide in docs**

Run: `grep -rn "does not call StoreKit\|do not call StoreKit\|does \*\*not\*\* call StoreKit" apps/docs/content`
Expected: no matches.

- [ ] **Step 3: Run the docs internal-link validation (existing CI check)**

Run: `pnpm --filter @rovenue/docs build` (or the repo's docs link-check task)
Expected: build succeeds, no broken internal links.

- [ ] **Step 4: Commit**

```bash
git add apps/docs/content/docs
git commit -m "docs: flip SDK-purchase narrative across quickstart/RN/index/RC-migration"
```

---

## Final verification (whole feature)

- [ ] Rust: `cargo test -p librovenue` — all green.
- [ ] Bindings regenerated & committed (Phase 2.4).
- [ ] Swift: `swift test --package-path packages/sdk-swift` — green; no public `postAppleReceipt`/`postGoogleReceipt`.
- [ ] Kotlin: `./gradlew :sdk-kotlin:testDebugUnitTest` — green; library builds as `com.android.library`.
- [ ] RN: `pnpm --filter @rovenue/sdk-rn test && pnpm --filter @rovenue/sdk-rn build` — green; `receipts.ts` gone.
- [ ] API: `pnpm --filter @rovenue/api test v1-offerings` — green.
- [ ] Docs: no "does not call StoreKit" strings; docs build passes.
- [ ] Repo-wide: `grep -rn "postAppleReceipt\|postGoogleReceipt" packages apps | grep -v core-rs | grep -v Generated | grep -v librovenue` — only internal core usages remain (Swift/Kotlin purchase flows + Rust), no public surface.

## Notes / deferred (YAGNI)

- Offline offerings cache (Rust persistent cache + ETag) — deferred; v1 fetches live.
- Experiment/placement-driven `current` offering selection — deferred (the per-identifier endpoint already supports OFFERING experiments for a future SDK hook).
- Android price hydration in `getOfferings()` returns config-only prices in v1; full `ProductDetails` price hydration is a fast-follow (Swift hydrates live in v1 via StoreKit).
- Promotional/intro-offer eligibility surfacing in the SDK API — deferred.
- **Background reconciliation parity:** Swift gets an always-on `Transaction.updates`
  listener in v1 (catches renewals / Ask-to-Buy / interrupted purchases). Kotlin v1
  covers the in-flow `PurchasesUpdatedListener` + `restorePurchases()` only; an
  always-on Play `queryPurchasesAsync`-on-reconnect/foreground worker (the Android
  equivalent of `Transaction.updates`) is a fast-follow. This is a deliberate v1
  asymmetry, not full parity with the spec's background-listener section.
