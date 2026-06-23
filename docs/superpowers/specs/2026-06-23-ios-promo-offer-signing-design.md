# iOS Promotional-Offer Purchase Signing

**Date:** 2026-06-23
**Status:** Approved design, pre-implementation
**Builds on:** the enriched StoreProduct feature (`discounts: [Discount]` already exposes promotional offers across Swift/Kotlin/RN). This feature makes those promotional offers **purchasable** on iOS by adding server-side signature generation.

## 1. Problem

The SDK now exposes iOS promotional offers via `StoreProduct.discounts` (`Discount` with `type: .promotional`), but they cannot be **redeemed**: StoreKit's `Product.PurchaseOption.promotionalOffer(offerID:keyID:nonce:signature:timestamp:)` requires a cryptographic signature that only the developer's server can produce (signing with an App Store Connect In-App Purchase key). Rovenue has no signing endpoint, so promotional offers are display-only.

**Goal:** add a server endpoint that signs a promotional-offer payload, a Rust-core method to fetch it, and a Swift purchase path that injects it — so an app can purchase a promotional offer end-to-end through the existing receipt-validation flow.

## 2. Key facts established (verified against Apple docs + our codebase)

- Promotional offers are signed with the **In-App Purchase key** (a.k.a. "subscription key"), NOT the App Store Connect API (Team) key. Per Apple, the In-App Purchase key is **dual-purpose**: it authenticates both the **App Store Server API** and **promotional-offer signing**.
- Rovenue already stores exactly this key per project in `appleCredentials` (`bundleId`, `keyId`, `issuerId`, `privateKey` — a PKCS#8 EC `.p8`), and uses it today to mint App Store Server API JWTs (`apps/api/src/services/apple/apple-auth.ts`, audience `appstoreconnect-v1`). The same `privateKey` + `keyId` therefore signs promotional offers — **no new credential field, no dashboard change**.
- Apple's offer-signature payload (verified quote): the UTF-8 concatenation, separated by **U+2063** (INVISIBLE SEPARATOR), in order:
  `appBundleId ⁣ keyIdentifier ⁣ productIdentifier ⁣ offerIdentifier ⁣ appAccountToken ⁣ nonce ⁣ timestamp`
  - `nonce`: a fresh lowercase UUID per signature.
  - `appAccountToken`: lowercase; MUST equal the value passed to StoreKit `purchase(options:)` `.appAccountToken(...)`, else Apple rejects. Empty string if none.
  - `timestamp`: UNIX time in **milliseconds**; signature valid 24h.
- Signing: **ECDSA P-256 with SHA-256** → **DER** binary → **Base64** string.
  - StoreKit 1 (`SKPaymentDiscount`): the Base64 string.
  - StoreKit 2 (`promotionalOffer(...signature: Data...)`): the raw DER bytes (Base64-decode the string into `Data`).
- Only `type == .promotional` (and `.winBack`) offers require a signature. `.introductory` offers are applied automatically by StoreKit and MUST NOT be signed/redeemed via this path.

## 3. Architecture

```
App picks a Discount (promotional) from product.discounts
  └─ SDK generates one appAccountToken (UUID)
       └─ core.get_apple_offer_signature(productId, offerId, appAccountToken)
            └─ POST /v1/purchases/apple-offer-signature   (public API key Bearer)
                 └─ load appleCredentials → sign payload → {keyIdentifier, nonce, signature, timestamp}
       └─ Swift: Product.purchase(options: [.appAccountToken(uuid),
                    .promotionalOffer(offerID, keyID, nonce, signature: Data, timestamp)])
            └─ JWS → existing core.post_apple_receipt(...)  (unchanged validation)
```

The signature is fetched from the core (HTTP); the StoreKit purchase + option injection is native Swift. The same `appAccountToken` is threaded into both the signature request and the purchase option.

## 4. Server: `POST /v1/purchases/apple-offer-signature`

**File:** new `apps/api/src/routes/v1/purchases.ts` (or extend the existing v1 purchases/receipts area), mounted under `/v1/purchases`.

- **Auth:** existing `apiKeyAuth()` middleware (public or secret API key) → resolves `projectId` (same as `/v1/receipts/apple`).
- **Request (Zod):**
  ```ts
  { productId: string (min 1), offerId: string (min 1), appAccountToken?: string }
  ```
- **Handler:**
  1. `loadAppleCredentials(projectId)`. If null, or missing `privateKey`/`keyId`/`bundleId` → `400` `{ error: { code: "apple_offer_signing_unavailable", message } }`.
  2. `nonce = crypto.randomUUID().toLowerCase()`; `timestamp = Date.now()`.
  3. `appAccountToken = (body.appAccountToken ?? "").toLowerCase()`.
  4. Build payload string with U+2063 separators in the exact order of §2.
  5. Sign with Node `crypto`: `createPrivateKey(privateKeyPem)` then `crypto.sign("sha256", Buffer.from(payload, "utf8"), { key, dsaEncoding: "der" })` → `signatureB64 = der.toString("base64")`.
  6. If signing throws (bad key / wrong key type) → `400` `{ error: { code: "apple_offer_signing_failed", message: <generic, no key material> } }` + a redacted `warn` log.
- **Response:** `{ data: { keyIdentifier: creds.keyId, nonce, signature: signatureB64, timestamp } }`.
- **Logging/audit:** info-level "offer signature issued" with `projectId`, `productId`, `offerId` (no key material, no signature bytes). Reuse the SDK logging/redaction conventions.

**Signing helper:** factor a pure function into `apps/api/src/services/apple/offer-signature.ts`:
`buildOfferSignaturePayload({ bundleId, keyId, productId, offerId, appAccountToken, nonce, timestamp }): string` and `signOfferPayload(payload: string, privateKeyPem: string): string` (returns Base64 DER). Pure + unit-testable.

## 5. Rust core

**`packages/core-rs`:**
- `librovenue.udl`: add
  ```
  dictionary AppleOfferSignature { string key_identifier; string nonce; string signature; i64 timestamp; };
  ```
  and on the RovenueCore interface:
  ```
  [Throws=RovenueError]
  AppleOfferSignature get_apple_offer_signature(string product_id, string offer_id, string? app_account_token);
  ```
- Implementation (mirror `receipts/client.rs::post_apple`): POST to `/v1/purchases/apple-offer-signature` with the user-scope Bearer, body `{ productId, offerId, appAccountToken? }`, map `{ data }` → `AppleOfferSignature`. Errors map through the existing `RovenueError` taxonomy (network/timeout/auth/server). Regenerate bindings via `npm run sdk:bindings` (generated files gitignored).

## 6. Swift façade

**`packages/sdk-swift`:**
- Public API: extend the existing purchase entry point with an optional offer:
  `func purchase(_ target: PurchasableTarget, promotionalOffer: Discount? = nil) async throws -> PurchaseResult`
  (matching the current `purchase` signature shape; `target` is the existing Package/StoreProduct param).
- `ApplePurchaseFlow`:
  1. If `promotionalOffer == nil` → unchanged current flow.
  2. If provided and `promotionalOffer.type == .introductory` → throw a clear SDK error (`introductory offers are applied automatically; do not pass them as a promotional offer`) — do NOT sign.
  3. For `.promotional`/`.winBack` with a non-nil `identifier`:
     - Determine `appAccountToken`: reuse the flow's existing token if the caller provides one, else generate `UUID()`. Use ONE value for both steps below.
     - `let sig = try await core.getAppleOfferSignature(productId: product.id, offerId: offer.identifier!, appAccountToken: token.uuidString.lowercased())`.
     - Build `StoreKit.Product.PurchaseOption`s: `.appAccountToken(token)` + `.promotionalOffer(offerID: offer.identifier!, keyID: sig.keyIdentifier, nonce: UUID(uuidString: sig.nonce)!, signature: Data(base64Encoded: sig.signature)!, timestamp: Int(sig.timestamp))`.
     - `product.purchase(options:)` → JWS → existing `core.postAppleReceipt(...)` (unchanged). On validation success, `transaction.finish()` (unchanged).
  4. If `offer.identifier == nil` → throw a clear error (cannot sign an offer without an identifier).
- `AppleStore.purchase(...)` gains an internal way to pass the extra `PurchaseOption`s (extend its parameter set; keep the existing `.appAccountToken`-only path for non-offer purchases).

## 7. Kotlin & React Native

- **Kotlin/Android:** the unified `purchase(...)` signature gains the optional `promotionalOffer: Discount? = null` parameter for API parity, but it is a **documented no-op on Android** — Play promotional offers use a different model (selecting a `subscriptionOption.offerToken` at purchase), which is **out of scope** here. If a non-null offer is passed on Android, ignore it (purchase proceeds normally) and document the limitation. (No Play signing exists.)
- **React Native:** the JS `purchase(target, options?)` accepts an optional `promotionalOffer` (or `offerId`); the RN→**iOS** bridge threads it to the native Swift purchase (so RN apps can redeem offers on iOS). The RN→**Android** bridge ignores it (parity no-op). The native bridges gain the optional offer argument; iOS wires it through to `ApplePurchaseFlow`, Android does not.

## 8. Error handling

- Server unavailable-credentials / signing failure → typed `{ error: { code } }`, surfaced through the core's `RovenueError` and the façades' existing purchase error mapping.
- Swift guards: introductory-offer misuse, missing offer identifier, malformed signature/nonce from server (Base64/UUID decode failure) → clear SDK errors, never a force-unwrap crash in production paths (the `!` in §6 are spec shorthand; implementation validates and throws).
- The appAccountToken mismatch class of failure surfaces as an Apple purchase failure through the existing flow (documented).

## 9. Testing

- **API (unit):** `buildOfferSignaturePayload` produces the exact U+2063-separated string in the documented order with lowercased nonce/appAccountToken; `signOfferPayload` round-trips — sign a known payload with a generated P-256 test key, then verify the Base64-DER signature with the corresponding public key (proves the signature is valid ECDSA/SHA-256 DER).
- **API (integration):** route returns `{ data: {keyIdentifier,nonce,signature,timestamp} }` for a project with Apple creds; returns `400 apple_offer_signing_unavailable` when creds absent; auth required.
- **Rust core:** `get_apple_offer_signature` maps a mocked `{ data }` HTTP response into `AppleOfferSignature`; error responses map to `RovenueError`.
- **Swift:** with a fake `AppleStore` capturing the `PurchaseOption`s and a fake core returning a canned signature: purchasing a `.promotional` Discount calls `getAppleOfferSignature` and injects `.promotionalOffer` + `.appAccountToken` with the SAME token; an `.introductory` Discount throws without calling the core; a nil-identifier offer throws.
- **RN:** the iOS bridge receives the offer argument and forwards it; the Android bridge ignores it (parity test on the DTO/argument threading).

## 10. Out of scope

- Android Play promotional-offer purchase (offerToken selection) — separate feature.
- Displaying promotional offers (already done — `StoreProduct.discounts`).
- Any new credential field or dashboard UI (existing In-App Purchase key is reused).
- Win-back-specific UX beyond signing (`.winBack` is signed identically to `.promotional`; no separate flow).
- App Store Server API / receipt-validation changes (the post-purchase path is unchanged).
