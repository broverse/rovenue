# iOS Promotional-Offer Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make iOS promotional offers (already exposed via `StoreProduct.discounts`) purchasable by adding a server endpoint that ECDSA-signs the Apple promotional-offer payload, a Rust-core method to fetch the signature, and a Swift purchase path that injects it into StoreKit's `promotionalOffer` purchase option.

**Architecture:** App picks a promotional `Discount` → SDK generates one `appAccountToken` → core `get_apple_offer_signature` → `POST /v1/purchases/apple-offer-signature` (project API-key auth) signs with the project's existing Apple `.p8` (`privateKey`+`keyId`) → `{keyIdentifier,nonce,signature,timestamp}` → Swift injects `.promotionalOffer(...)` + the same `.appAccountToken(...)` into `product.purchase(options:)` → existing receipt-validation flow unchanged.

**Tech Stack:** Hono + Zod + Node `crypto` (ECDSA P-256/SHA-256, DER, Base64) (apps/api); Rust + uniffi (core-rs); Swift StoreKit 2 (sdk-swift); TypeScript + Expo native bridges (sdk-rn); Vitest / cargo test / XCTest.

## Global Constraints

- Reuse the project's EXISTING Apple key (`appleCredentials.privateKey` + `keyId`) — NO new credential field, NO dashboard change, NO Rust receipt-flow change.
- Apple offer-signature payload: UTF-8, separated by U+2063 (`⁣`), in EXACT order: `bundleId ⁣ keyId ⁣ productId ⁣ offerId ⁣ appAccountToken ⁣ nonce ⁣ timestamp`.
- `nonce` = fresh lowercase UUID per request; `appAccountToken` lowercased and MUST equal the token passed to StoreKit `.appAccountToken(...)`; `timestamp` = `Date.now()` (ms).
- Signature: ECDSA P-256 + SHA-256 → DER bytes → Base64 string. StoreKit 2 `signature: Data` = Base64-decoded DER bytes.
- Only `Discount.type == .promotional` or `.winBack` get signed; `.introductory` MUST throw (StoreKit applies intro automatically).
- API responses: `{ data: T }` via `ok(...)` or `{ error: { code, message } }` via `fail(code, message)` (apps/api/src/lib/response.ts). TS strict; Zod for input.
- core-rs generated bindings are gitignored — regen via `npm run sdk:bindings`; never hand-edit `Generated/RovenueFFI.swift` / `generated/librovenue.kt`.
- Android: the unified purchase API accepts the optional offer param but it is a documented NO-OP on Android (Play offerToken model is out of scope).
- Branch: stay on `main`, commit per task, conventional commits. Verify sdk-kotlin with `testDebugUnitTest`.
- Spec: `docs/superpowers/specs/2026-06-23-ios-promo-offer-signing-design.md`.

---

## File Structure

**apps/api**
- `src/services/apple/offer-signature.ts` — **NEW**: pure `buildOfferSignaturePayload(...)` + `signOfferPayload(...)` (Node crypto).
- `src/routes/v1/purchases.ts` — **NEW**: `POST /apple-offer-signature` route.
- `src/routes/v1/index.ts` — mount `/purchases`.
- the `ErrorCode` definition — add two new codes.

**packages/core-rs**
- `src/librovenue.udl` — add `AppleOfferSignature` dictionary + `get_apple_offer_signature(...)`.
- `src/receipts/client.rs` (or a sibling like `src/purchases/client.rs`) — implement the HTTP call (project-scoped, mirror `get_offerings`).
- `src/lib.rs` / api wiring — expose the method on `RovenueCore`.

**packages/sdk-swift**
- `Sources/Rovenue/Internal/AppleStore.swift` — accept an optional signed offer, inject `.promotionalOffer`.
- `Sources/Rovenue/Internal/ApplePurchaseFlow.swift` — fetch signature before purchase when an offer is requested.
- `Sources/Rovenue/Rovenue.swift` — public `purchase(_, promotionalOffer:)` + id-based overload.

**packages/sdk-rn**
- `src/specs/RovenueModule.types.ts` — purchase method gains optional `promotionalOfferId`.
- `src/api/purchases.ts` — `purchase(target, options?)`.
- `ios/RovenueModule.swift` — thread `promotionalOfferId` to the façade.
- `android/.../RovenueModule.kt` — accept + ignore (no-op).

**apps/docs** — promotional-offer purchase guide.

---

## Task 1: API — offer-signature pure helpers

**Files:**
- Create: `apps/api/src/services/apple/offer-signature.ts`
- Test: `apps/api/src/services/apple/offer-signature.test.ts` (Create)

**Interfaces:**
- Produces:
  - `buildOfferSignaturePayload(p: { bundleId: string; keyId: string; productId: string; offerId: string; appAccountToken: string; nonce: string; timestamp: number }): string`
  - `signOfferPayload(payload: string, privateKeyPem: string): string` (returns Base64-encoded DER ECDSA signature)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/apple/offer-signature.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { buildOfferSignaturePayload, signOfferPayload } from "./offer-signature";

const SEP = "⁣";

describe("buildOfferSignaturePayload", () => {
  it("joins fields in Apple's exact order with U+2063", () => {
    const payload = buildOfferSignaturePayload({
      bundleId: "com.acme.app", keyId: "ABC123DEFG", productId: "premium_monthly",
      offerId: "winback10", appAccountToken: "a1b2", nonce: "11111111-1111-1111-1111-111111111111",
      timestamp: 1719100000000,
    });
    expect(payload).toBe(
      ["com.acme.app", "ABC123DEFG", "premium_monthly", "winback10", "a1b2",
       "11111111-1111-1111-1111-111111111111", "1719100000000"].join(SEP)
    );
  });
});

describe("signOfferPayload", () => {
  it("produces a Base64 DER ECDSA-SHA256 signature that verifies", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const payload = "hello⁣world";
    const sigB64 = signOfferPayload(payload, pem);
    const ok = cryptoVerify(
      "sha256", Buffer.from(payload, "utf8"),
      { key: createPublicKey(publicKey), dsaEncoding: "der" },
      Buffer.from(sigB64, "base64"),
    );
    expect(ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/services/apple/offer-signature.test.ts`
Expected: FAIL — module/functions not found.

- [ ] **Step 3: Implement the helpers**

Create `apps/api/src/services/apple/offer-signature.ts`:

```ts
import { createPrivateKey, sign as cryptoSign } from "node:crypto";

/** Apple's invisible separator (U+2063) for the offer-signature payload. */
const SEP = "⁣";

export function buildOfferSignaturePayload(p: {
  bundleId: string;
  keyId: string;
  productId: string;
  offerId: string;
  appAccountToken: string;
  nonce: string;
  timestamp: number;
}): string {
  return [
    p.bundleId,
    p.keyId,
    p.productId,
    p.offerId,
    p.appAccountToken,
    p.nonce,
    String(p.timestamp),
  ].join(SEP);
}

/**
 * Sign the offer payload with the project's In-App Purchase .p8 (PKCS#8 PEM)
 * using ECDSA P-256 + SHA-256, DER-encoded, returned Base64. StoreKit decodes
 * this Base64 back into the `signature: Data` purchase option.
 */
export function signOfferPayload(payload: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  const der = cryptoSign("sha256", Buffer.from(payload, "utf8"), {
    key,
    dsaEncoding: "der",
  });
  return der.toString("base64");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run src/services/apple/offer-signature.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/apple/offer-signature.ts apps/api/src/services/apple/offer-signature.test.ts
git commit -m "feat(api): apple promotional-offer signature payload + signing helpers"
```

---

## Task 2: API — `POST /v1/purchases/apple-offer-signature`

**Files:**
- Create: `apps/api/src/routes/v1/purchases.ts`
- Modify: `apps/api/src/routes/v1/index.ts` (mount `/purchases`)
- Modify: the `ErrorCode` definition (add two codes)
- Test: `apps/api/src/routes/v1/purchases.test.ts` (Create)

**Interfaces:**
- Consumes: Task 1 (`buildOfferSignaturePayload`, `signOfferPayload`); `loadAppleCredentials(projectId)` from `apps/api/src/lib/project-credentials.ts`; `ok`/`fail` from `apps/api/src/lib/response.ts`.
- Produces: route `POST /v1/purchases/apple-offer-signature`, body `{ productId, offerId, appAccountToken? }`, response `{ data: { keyIdentifier, nonce, signature, timestamp } }`.

- [ ] **Step 1: Add the two error codes**

Find the `ErrorCode` definition: `grep -rn "apple_receipt\|ErrorCode" apps/api/src packages/shared/src | grep -i "type ErrorCode\|ErrorCode =" ` (it is the union accepted by `fail()`). Add `"apple_offer_signing_unavailable"` and `"apple_offer_signing_failed"` to that union/enum. (No test for this step alone — it unblocks compilation in Step 3.)

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/routes/v1/purchases.test.ts`. This mounts the route behind a fake project-context middleware (bypassing real API-key auth) and mocks `loadAppleCredentials`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync, createPublicKey, verify as cryptoVerify } from "node:crypto";

const loadAppleCredentials = vi.fn();
vi.mock("../../lib/project-credentials", () => ({ loadAppleCredentials }));

import { purchasesRoute } from "./purchases";

function appWithProject() {
  return new Hono()
    .use("*", async (c, next) => { c.set("project", { id: "proj_1", name: "t", keyKind: "PUBLIC", apiKeyId: "k" } as any); await next(); })
    .route("/purchases", purchasesRoute);
}

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

beforeEach(() => loadAppleCredentials.mockReset());

describe("POST /purchases/apple-offer-signature", () => {
  it("returns a verifiable signature payload", async () => {
    loadAppleCredentials.mockResolvedValue({ bundleId: "com.acme.app", keyId: "ABC123DEFG", privateKey: pem });
    const res = await appWithProject().request("/purchases/apple-offer-signature", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productId: "premium_monthly", offerId: "winback10", appAccountToken: "A1B2" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.keyIdentifier).toBe("ABC123DEFG");
    expect(json.data.nonce).toBe(json.data.nonce.toLowerCase());
    expect(typeof json.data.timestamp).toBe("number");
    // The returned signature verifies over the reconstructed payload.
    const SEP = "⁣";
    const payload = ["com.acme.app","ABC123DEFG","premium_monthly","winback10","a1b2",json.data.nonce,String(json.data.timestamp)].join(SEP);
    const okSig = cryptoVerify("sha256", Buffer.from(payload,"utf8"), { key: createPublicKey(publicKey), dsaEncoding: "der" }, Buffer.from(json.data.signature, "base64"));
    expect(okSig).toBe(true);
  });

  it("returns 400 apple_offer_signing_unavailable when creds missing", async () => {
    loadAppleCredentials.mockResolvedValue(null);
    const res = await appWithProject().request("/purchases/apple-offer-signature", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ productId: "p", offerId: "o" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("apple_offer_signing_unavailable");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/routes/v1/purchases.test.ts`
Expected: FAIL — `./purchases` module not found.

- [ ] **Step 4: Implement the route**

Create `apps/api/src/routes/v1/purchases.ts`. Mirror the `validate` import + `c.req.valid("json")` usage from `apps/api/src/routes/v1/receipts.ts` (copy its exact `validate` import path):

```ts
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validate } from "../../middleware/validate"; // ← match the path receipts.ts imports `validate` from
import { ok, fail } from "../../lib/response";
import { loadAppleCredentials } from "../../lib/project-credentials";
import { buildOfferSignaturePayload, signOfferPayload } from "../../services/apple/offer-signature";
import { logger } from "../../lib/logger";

const log = logger.child("apple-offer-signature");

const bodySchema = z.object({
  productId: z.string().min(1),
  offerId: z.string().min(1),
  appAccountToken: z.string().optional(),
});

export const purchasesRoute = new Hono().post(
  "/apple-offer-signature",
  validate("json", bodySchema),
  async (c) => {
    const project = c.get("project");
    const body = c.req.valid("json");
    const creds = await loadAppleCredentials(project.id);
    if (!creds || !creds.privateKey || !creds.keyId || !creds.bundleId) {
      return c.json(
        fail("apple_offer_signing_unavailable", "Apple credentials are not configured for promotional-offer signing"),
        400,
      );
    }
    const nonce = randomUUID().toLowerCase();
    const timestamp = Date.now();
    const appAccountToken = (body.appAccountToken ?? "").toLowerCase();
    const payload = buildOfferSignaturePayload({
      bundleId: creds.bundleId, keyId: creds.keyId, productId: body.productId,
      offerId: body.offerId, appAccountToken, nonce, timestamp,
    });
    let signature: string;
    try {
      signature = signOfferPayload(payload, creds.privateKey);
    } catch {
      log.warn("offer signing failed", { projectId: project.id, productId: body.productId, offerId: body.offerId });
      return c.json(fail("apple_offer_signing_failed", "Failed to sign the promotional offer"), 400);
    }
    log.info("offer signature issued", { projectId: project.id, productId: body.productId, offerId: body.offerId });
    return c.json(ok({ keyIdentifier: creds.keyId, nonce, signature, timestamp }));
  },
);
```

If the `validate` import path differs, open `receipts.ts` and copy its exact `import { validate } from "..."` line.

- [ ] **Step 5: Mount the route**

In `apps/api/src/routes/v1/index.ts`, add the import near the other route imports and the `.route("/purchases", purchasesRoute)` call after `.route("/offerings", offeringsRoute)`:

```ts
import { purchasesRoute } from "./purchases";
// ...
  .route("/offerings", offeringsRoute)
  .route("/purchases", purchasesRoute)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run src/routes/v1/purchases.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck**

Run: `cd apps/api && pnpm tsc --noEmit` (or the api package's typecheck script)
Expected: clean (confirms the new ErrorCode values type-check in `fail(...)`).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/v1/purchases.ts apps/api/src/routes/v1/index.ts apps/api/src/routes/v1/purchases.test.ts
git add -A   # include the ErrorCode file edited in Step 1
git commit -m "feat(api): POST /v1/purchases/apple-offer-signature (reuses project Apple key)"
```

---

## Task 3: Rust core — `get_apple_offer_signature`

**Files:**
- Modify: `packages/core-rs/src/librovenue.udl`
- Create: `packages/core-rs/src/purchases/mod.rs` + `packages/core-rs/src/purchases/client.rs` (or add to an existing module — mirror `receipts/client.rs`)
- Modify: `packages/core-rs/src/lib.rs` (module decl + re-export) and the `RovenueCore` api file that exposes receipt methods (add `get_apple_offer_signature`)
- Test: alongside the client (mirror the existing receipts client test harness)

**Interfaces:**
- Consumes: the HTTP client used by `receipts/client.rs` (`post_json`, `HttpPostRequest`, `ApiEnvelope`).
- Produces (UDL + Rust):
  - `AppleOfferSignature { key_identifier: String, nonce: String, signature: String, timestamp: i64 }`
  - `RovenueCore::get_apple_offer_signature(&self, product_id: String, offer_id: String, app_account_token: Option<String>) -> RovenueResult<AppleOfferSignature>`

- [ ] **Step 1: Write the failing test**

Mirror the existing receipts/offerings client test (find it: `grep -rn "fn .*offer\|mock\|MockHttp\|post_apple" packages/core-rs/src`). Add a test that, given a mocked HTTP response `{"data":{"keyIdentifier":"K","nonce":"n","signature":"s","timestamp":123}}`, `get_apple_offer_signature("p","o",None)` returns `AppleOfferSignature { key_identifier:"K", nonce:"n", signature:"s", timestamp:123 }`. Use the same mock-HTTP pattern the receipts client test uses (copy its setup verbatim, change path/body/response).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-rs && cargo test get_apple_offer_signature`
Expected: FAIL — method/type does not exist.

- [ ] **Step 3: Add the UDL**

In `src/librovenue.udl`, add the dictionary near `ReceiptResult`:

```
dictionary AppleOfferSignature {
    string key_identifier;
    string nonce;
    string signature;
    i64 timestamp;
};
```

and inside the `interface RovenueCore { ... }` block, near `post_apple_receipt`:

```
[Throws=RovenueErrorFfi]
AppleOfferSignature get_apple_offer_signature(
    string product_id,
    string offer_id,
    string? app_account_token
);
```

- [ ] **Step 4: Implement the client + core method**

Create `src/purchases/client.rs` mirroring `receipts/client.rs`, but **project-scoped** (this endpoint authenticates by the project API key only — do NOT call `.user_scope(...)` or `.idempotency_key(...)`; mirror the request shape used by the offerings client `get_offerings`, which is project-scoped). Define the request/response structs and the method:

```rust
use serde::{Deserialize, Serialize};
use crate::error::{RovenueError, RovenueResult};
use crate::http::{ApiEnvelope, HttpClient, HttpPostRequest};
use std::sync::Arc;

#[derive(Serialize)]
struct OfferSignatureBody<'a> {
    #[serde(rename = "productId")] product_id: &'a str,
    #[serde(rename = "offerId")] offer_id: &'a str,
    #[serde(rename = "appAccountToken", skip_serializing_if = "Option::is_none")] app_account_token: Option<&'a str>,
}

#[derive(Deserialize)]
struct OfferSignatureResponse {
    #[serde(rename = "keyIdentifier")] key_identifier: String,
    nonce: String,
    signature: String,
    timestamp: i64,
}

pub struct AppleOfferSignature {
    pub key_identifier: String,
    pub nonce: String,
    pub signature: String,
    pub timestamp: i64,
}

pub struct PurchasesClient { http: Arc<HttpClient> }

impl PurchasesClient {
    pub fn new(http: Arc<HttpClient>) -> Self { Self { http } }

    pub fn get_apple_offer_signature(
        &self, product_id: &str, offer_id: &str, app_account_token: Option<&str>,
    ) -> RovenueResult<AppleOfferSignature> {
        let body = OfferSignatureBody { product_id, offer_id, app_account_token };
        let resp = self.http.post_json::<OfferSignatureBody<'_>, ApiEnvelope<OfferSignatureResponse>>(
            HttpPostRequest::new("/v1/purchases/apple-offer-signature"),
            &body,
        )?;
        let data = resp.body.ok_or(RovenueError::Internal())?.data;
        Ok(AppleOfferSignature {
            key_identifier: data.key_identifier,
            nonce: data.nonce,
            signature: data.signature,
            timestamp: data.timestamp,
        })
    }
}
```

(Adjust `use` paths + `HttpClient`/`ApiEnvelope`/`HttpPostRequest` names to match `receipts/client.rs` exactly — open it and mirror.) Add `pub mod purchases;` to `lib.rs` and re-export `AppleOfferSignature`. On `RovenueCore` (the same struct that has `post_apple_receipt`), add:

```rust
pub fn get_apple_offer_signature(
    &self, product_id: String, offer_id: String, app_account_token: Option<String>,
) -> RovenueResult<AppleOfferSignature> {
    self.purchases.get_apple_offer_signature(&product_id, &offer_id, app_account_token.as_deref())
}
```

building `PurchasesClient` from the same `Arc<HttpClient>` the receipts client uses (in the shared constructor in `api.rs`).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core-rs && cargo test get_apple_offer_signature`
Expected: PASS.

- [ ] **Step 6: Regenerate bindings + full core test**

Run: `npm run sdk:bindings` (or `./packages/core-rs/scripts/build-bindings.sh`), then `cd packages/core-rs && cargo test`
Expected: bindings regenerate (gitignored — do not commit them); cargo test green.

- [ ] **Step 7: Commit**

```bash
git add packages/core-rs/src/librovenue.udl packages/core-rs/src/purchases packages/core-rs/src/lib.rs packages/core-rs/src/api.rs
git commit -m "feat(core): get_apple_offer_signature core method + UDL"
```

---

## Task 4: Swift — purchase with promotional offer

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Internal/AppleStore.swift`
- Modify: `packages/sdk-swift/Sources/Rovenue/Internal/ApplePurchaseFlow.swift`
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`
- Test: `packages/sdk-swift/Tests/RovenueTests/PromotionalOfferPurchaseTests.swift` (Create)

**Interfaces:**
- Consumes: `core.getAppleOfferSignature(productId:offerId:appAccountToken:)` (Task 3 generated binding → Swift `AppleOfferSignature { keyIdentifier, nonce, signature, timestamp }`); `Discount` (`identifier`, `type`); `getAppAccountToken()`.
- Produces:
  - internal `struct AppleSignedOffer { let offerId: String; let keyId: String; let nonce: String; let signatureBase64: String; let timestamp: Int }`
  - `AppleStore.purchase(productId:appAccountToken:signedOffer:)` (new optional `signedOffer` param)
  - public `Rovenue.purchase(_ product: StoreProduct, promotionalOffer: Discount?) async throws -> PurchaseResult` and `Rovenue.purchase(_ package: Package, promotionalOffer: Discount?)`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-swift/Tests/RovenueTests/PromotionalOfferPurchaseTests.swift`. Define a fake `AppleStore` capturing the `signedOffer`, and drive `ApplePurchaseFlow` with a fake sign closure:

```swift
import XCTest
@testable import Rovenue

@available(iOS 15.0, macOS 12.0, *)
final class PromotionalOfferPurchaseTests: XCTestCase {
    final class CapturingStore: AppleStore, @unchecked Sendable {
        var capturedOffer: AppleSignedOffer?
        var capturedToken: String?
        func purchase(productId: String, appAccountToken: String?, signedOffer: AppleSignedOffer?) async -> PurchaseOutcome {
            capturedOffer = signedOffer
            capturedToken = appAccountToken
            return .success(jws: "jws", transactionId: "t1", finish: {})
        }
    }

    func testPromotionalOfferIsSignedAndInjected() async throws {
        let store = CapturingStore()
        var signArgs: (String, String, String)?
        let flow = ApplePurchaseFlow(
            store: store,
            validate: { _, _ in ReceiptResult(subscriberId: "s", appUserId: "u", virtualCurrencies: [:], entitlements: []) },
            signOffer: { productId, offerId, token in
                signArgs = (productId, offerId, token)
                return AppleSignedOffer(offerId: offerId, keyId: "K", nonce: "11111111-1111-1111-1111-111111111111", signatureBase64: "AAAA", timestamp: 123)
            }
        )
        _ = try await flow.run(productId: "premium_monthly", appAccountToken: "abc", promotionalOfferId: "winback10")
        XCTAssertEqual(store.capturedOffer?.offerId, "winback10")
        XCTAssertEqual(store.capturedOffer?.keyId, "K")
        XCTAssertEqual(store.capturedToken, "abc")           // same token used for sign + purchase
        XCTAssertEqual(signArgs?.0, "premium_monthly")
        XCTAssertEqual(signArgs?.1, "winback10")
        XCTAssertEqual(signArgs?.2, "abc")
    }

    func testNoOfferDoesNotSign() async throws {
        let store = CapturingStore()
        var signCalled = false
        let flow = ApplePurchaseFlow(
            store: store,
            validate: { _, _ in ReceiptResult(subscriberId: "s", appUserId: "u", virtualCurrencies: [:], entitlements: []) },
            signOffer: { _, _, _ in signCalled = true; return AppleSignedOffer(offerId: "", keyId: "", nonce: "", signatureBase64: "", timestamp: 0) }
        )
        _ = try await flow.run(productId: "p", appAccountToken: nil, promotionalOfferId: nil)
        XCTAssertNil(store.capturedOffer)
        XCTAssertFalse(signCalled)
    }
}
```

(Match the real `ReceiptResult` initializer — open `Types.swift`/the generated file and use its exact field labels; the test only needs a valid value.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-swift && swift test --filter PromotionalOfferPurchaseTests`
Expected: FAIL — `AppleSignedOffer` / the new `signedOffer`/`signOffer`/`promotionalOfferId` params don't exist.

- [ ] **Step 3: Extend AppleStore**

In `AppleStore.swift`: add the struct and extend the protocol + `StoreKitAppleStore`:

```swift
internal struct AppleSignedOffer: Sendable {
    let offerId: String
    let keyId: String
    let nonce: String
    let signatureBase64: String
    let timestamp: Int
}
```

Change the protocol method to `func purchase(productId: String, appAccountToken: String?, signedOffer: AppleSignedOffer?) async -> PurchaseOutcome` (add `signedOffer`). In `StoreKitAppleStore.purchase`, after building the existing `options` set with `.appAccountToken(...)`, inject the offer:

```swift
if let o = signedOffer {
    guard let nonceUUID = UUID(uuidString: o.nonce),
          let sigData = Data(base64Encoded: o.signatureBase64) else {
        return .ineligible   // malformed signature material
    }
    options.insert(.promotionalOffer(offerID: o.offerId, keyID: o.keyId, nonce: nonceUUID, signature: sigData, timestamp: o.timestamp))
}
```

Update every existing call site of `store.purchase(productId:appAccountToken:)` to pass `signedOffer: nil` (so non-offer purchases are unchanged).

- [ ] **Step 4: Extend ApplePurchaseFlow**

In `ApplePurchaseFlow.swift`, add a stored `signOffer` closure and a `promotionalOfferId` param to `run`:

```swift
internal struct ApplePurchaseFlow {
    let store: AppleStore
    let validate: @Sendable (_ jws: String, _ productId: String) async throws -> ReceiptResult
    let signOffer: @Sendable (_ productId: String, _ offerId: String, _ appAccountToken: String) async throws -> AppleSignedOffer

    func run(productId: String, appAccountToken: String?, promotionalOfferId: String? = nil) async throws -> PurchaseResult {
        var signedOffer: AppleSignedOffer?
        if let offerId = promotionalOfferId {
            signedOffer = try await signOffer(productId, offerId, appAccountToken ?? "")
        }
        let outcome = try await store.purchase(productId: productId, appAccountToken: appAccountToken, signedOffer: signedOffer)
        // ... existing switch unchanged ...
    }
}
```

(Keep the existing `switch outcome` body verbatim.)

- [ ] **Step 5: Wire the public API**

In `Rovenue.swift`, update the purchase methods. The existing `purchase(_ product:)` constructs `ApplePurchaseFlow` — now also pass `signOffer:` and thread the offer. Add the `promotionalOffer:` parameter (default nil) and a guard:

```swift
@available(iOS 15.0, macOS 12.0, *)
public func purchase(_ package: Package, promotionalOffer: Discount? = nil) async throws -> PurchaseResult {
    try await purchase(package.product, promotionalOffer: promotionalOffer)
}

@available(iOS 15.0, macOS 12.0, *)
public func purchase(_ product: StoreProduct, promotionalOffer: Discount? = nil) async throws -> PurchaseResult {
    var offerId: String? = nil
    if let offer = promotionalOffer {
        guard offer.type != .introductory else {
            throw RovenueError(kind: .ineligible, message: "Introductory offers are applied automatically; do not pass them as a promotional offer.")
        }
        guard let id = offer.identifier else {
            throw RovenueError(kind: .ineligible, message: "Promotional offer is missing an identifier.")
        }
        offerId = id
    }
    let token = try? await getAppAccountToken()
    let flow = ApplePurchaseFlow(
        store: StoreKitAppleStore(),
        validate: { [core] jws, pid in
            try await self.dispatcher.run {
                do { return try core.postAppleReceipt(receipt: jws, productId: pid, appAccountToken: token) }
                catch let err as RovenueErrorFfi { throw mapError(err) }
            }
        },
        signOffer: { [core] pid, oid, tok in
            try await self.dispatcher.run {
                do {
                    let sig = try core.getAppleOfferSignature(productId: pid, offerId: oid, appAccountToken: tok.isEmpty ? nil : tok)
                    return AppleSignedOffer(offerId: oid, keyId: sig.keyIdentifier, nonce: sig.nonce, signatureBase64: sig.signature, timestamp: Int(sig.timestamp))
                } catch let err as RovenueErrorFfi { throw mapError(err) }
            }
        }
    )
    return try await flow.run(productId: product.id, appAccountToken: token, promotionalOfferId: offerId)
}
```

(Match the exact `dispatcher.run`/`mapError` shapes already in the file. If `getAppAccountToken()` may return a non-UUID, that is pre-existing behavior; the signing endpoint lowercases whatever token is sent and StoreKit uses the same value.)

- [ ] **Step 6: Run the test + full suite**

Run: `cd packages/sdk-swift && swift test`
Expected: PASS (new `PromotionalOfferPurchaseTests` + existing suite green; existing `purchase` call sites updated).

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Internal/AppleStore.swift packages/sdk-swift/Sources/Rovenue/Internal/ApplePurchaseFlow.swift packages/sdk-swift/Sources/Rovenue/Rovenue.swift packages/sdk-swift/Tests/RovenueTests/PromotionalOfferPurchaseTests.swift
git commit -m "feat(sdk-swift): purchase with signed promotional offer"
```

---

## Task 5: React Native — optional promotional offer through to iOS

**Files:**
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts`
- Modify: `packages/sdk-rn/src/api/purchases.ts`
- Modify: `packages/sdk-rn/ios/RovenueModule.swift`
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`
- Test: `packages/sdk-rn/src/__tests__/purchase-offer.test.ts` (Create)

**Interfaces:**
- Consumes: native `purchase(...)` bridge.
- Produces: JS `purchase(target, options?: { promotionalOfferId?: string })`; native spec `purchase(productId, productType, promotionalOfferId?)`.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-rn/src/__tests__/purchase-offer.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

const purchaseSpy = vi.fn(async () => ({
  entitlements: [], virtualCurrencies: {}, productId: "premium_monthly", storeTransactionId: "t", isDeferred: false,
}));
vi.mock("../core/native", () => ({ getNative: () => ({ purchase: purchaseSpy }) }));

import { purchase } from "../api/purchases";

describe("purchase with promotional offer", () => {
  it("forwards promotionalOfferId to native", async () => {
    const product = { id: "premium_monthly", type: "subscription" } as any;
    await purchase(product, { promotionalOfferId: "winback10" });
    expect(purchaseSpy).toHaveBeenCalledWith("premium_monthly", "subscription", "winback10");
  });
  it("passes undefined when no offer", async () => {
    const product = { id: "premium_monthly", type: "subscription" } as any;
    await purchase(product);
    expect(purchaseSpy).toHaveBeenCalledWith("premium_monthly", "subscription", undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-rn && pnpm vitest run src/__tests__/purchase-offer.test.ts`
Expected: FAIL — `purchase` ignores the second arg / calls native with 2 args.

- [ ] **Step 3: Update the JS purchase + spec type**

In `src/specs/RovenueModule.types.ts`, change the spec method to:
```ts
purchase(productId: string, productType: ProductTypeDTO, promotionalOfferId?: string): Promise<PurchaseResultDTO>;
```
In `src/api/purchases.ts`:
```ts
export async function purchase(
  target: Package | StoreProduct,
  options?: { promotionalOfferId?: string },
): Promise<PurchaseResult> {
  const product = "product" in target ? target.product : target;
  return call(() => getNative().purchase(product.id, product.type, options?.promotionalOfferId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-rn && pnpm vitest run src/__tests__/purchase-offer.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread through native bridges**

iOS `packages/sdk-rn/ios/RovenueModule.swift` — change the `purchase` AsyncFunction to accept the optional offer id and pass it to the façade:
```swift
AsyncFunction("purchase") { (productId: String, productType: String, promotionalOfferId: String?) -> [String: Any?] in
    guard #available(iOS 15.0, macOS 12.0, *) else { throw StoreProblemFallbackException("Purchases require iOS 15 / macOS 12 or newer") }
    let product = StoreProduct(id: productId, type: Self.productType(from: productType), displayName: "")
    do {
        let r: PurchaseResult
        if let offerId = promotionalOfferId {
            r = try await Rovenue.shared.purchase(product, promotionalOffer: Discount(identifier: offerId, price: nil, priceString: nil, currencyCode: nil, period: Period(value: 0, unit: .month, iso8601: "P0M"), numberOfPeriods: 0, paymentMode: .payAsYouGo, type: .promotional))
        } else {
            r = try await Rovenue.shared.purchase(product)
        }
        return Self.dtoFromPurchaseResult(r)
    } catch let e as RovenueError { throw RovenueCodedError(e) }
}
```
(If constructing a full `Discount` is awkward, instead add a thin public Swift overload `purchase(_ product: StoreProduct, promotionalOfferId: String) async throws -> PurchaseResult` in Task 4's `Rovenue.swift` that the bridge calls directly — prefer this if the `Discount` initializer is not public/ergonomic. The overload simply sets `offerId` and reuses the same flow, skipping the introductory guard since the id is already chosen.)

Android `packages/sdk-rn/android/.../RovenueModule.kt` — accept the third arg and ignore it (no-op, documented):
```kotlin
AsyncFunction("purchase") Coroutine { productId: String, productType: String, promotionalOfferId: String? ->
    // Android: promotional-offer signing is iOS-only; promotionalOfferId is ignored (Play uses offerToken, out of scope).
    val activity = appContext.currentActivity ?: throw StoreProblemFallbackCodedException("No foreground Activity available for purchase")
    val product = StoreProduct(id = productId, type = productTypeFrom(productType), displayName = "")
    try { dtoFromPurchaseResult(Rovenue.shared.purchase(activity, product)) } catch (e: Throwable) { throw codedError(e) }
}
```

- [ ] **Step 6: Verify JS typecheck + native parity**

Run: `cd packages/sdk-rn && pnpm vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: tests pass; tsc clean. (Native bridges can't build standalone — Expo/RN host; correctness is the arg-threading contract. If you added the `promotionalOfferId` Swift overload, ensure Task 4's file has it.)

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-rn/src/specs/RovenueModule.types.ts packages/sdk-rn/src/api/purchases.ts packages/sdk-rn/ios/RovenueModule.swift packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt packages/sdk-rn/src/__tests__/purchase-offer.test.ts
git commit -m "feat(sdk-rn): forward promotionalOfferId to iOS purchase (Android no-op)"
```

---

## Task 6: Docs — promotional-offer purchase guide

**Files:**
- Modify: `apps/docs/content/docs/guides/processing-purchases.mdx` (and/or the platform pages); link from `reference/types.mdx` `Discount` section.

**Interfaces:** none (documentation).

- [ ] **Step 1: Document the feature**

Add a "Redeeming promotional offers (iOS)" section covering:
- Promotional offers come from `StoreProduct.discounts` (`type: 'promotional'` / `'winBack'`); introductory offers apply automatically and must NOT be passed.
- Swift: `try await rovenue.purchase(product, promotionalOffer: discount)`.
- React Native: `await purchase(product, { promotionalOfferId: discount.identifier })`.
- Android: not supported (Play uses a different offer model) — the param is ignored.
- Server prerequisite: the project's existing Apple In-App Purchase `.p8` (already configured for the App Store Server API) is reused to sign offers — **no extra setup**. If signing returns `apple_offer_signing_unavailable`, the project's Apple credentials are incomplete.
- One signature is valid 24h; the SDK requests a fresh one per purchase.

- [ ] **Step 2: Build docs**

Run: `pnpm --filter @rovenue/docs build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add apps/docs
git commit -m "docs(sdk): redeeming iOS promotional offers"
```

---

## Self-Review (completed)

**Spec coverage:** §4 server endpoint → Tasks 1+2; §5 core method → Task 3; §6 Swift purchase + introductory guard + same-token threading → Task 4; §7 Kotlin no-op + RN→iOS threading → Task 5; §8 error handling → Tasks 2 (typed `fail`) + 4 (Swift guards/malformed-signature → `.ineligible`); §9 testing → each task's tests (payload+round-trip, route 200/400, core mapping, Swift injection+guard, RN threading); §2 key reuse (no new credential field) → Task 2 uses `loadAppleCredentials` only; docs → Task 6. Out-of-scope items (§10) excluded (Android offerToken, dashboard, receipt-flow changes).

**Placeholder scan:** no TBD/TODO; every code step has literal code; tests included. Two spots intentionally instruct mirroring an existing file's exact import/struct (the `validate` import in Task 2, the receipts/offerings client request shape + `ReceiptResult` initializer in Tasks 3/4) — these are "match the real signature on disk" directives, not placeholders, because the surrounding helper names must equal what's already in the repo.

**Type consistency:** `AppleOfferSignature {key_identifier,nonce,signature,timestamp}` (Rust/UDL, Task 3) → Swift binding `AppleOfferSignature {keyIdentifier,nonce,signature,timestamp}` consumed in Task 4; `AppleSignedOffer {offerId,keyId,nonce,signatureBase64,timestamp}` defined + consumed within Task 4; route response keys `{keyIdentifier,nonce,signature,timestamp}` (Task 2) match the core's `OfferSignatureResponse` serde rename (Task 3); `promotionalOfferId` string flows JS→spec→bridge→façade consistently (Tasks 4 overload + 5).
