# Changelog — librovenue (Rust core crate)

## 0.16.0 — 2026-06-23

### Error taxonomy: 24 canonical ErrorKind variants

The `ErrorKind` enum in the UDL is the authoritative source for all SDK-facing error discriminants. Downstream façade tests now enforce parity at build time.

**New variants added in this cycle:**
- `Forbidden` — HTTP 403 (insufficient permission, not an auth failure)
- `NotFound` — HTTP 404
- `InvalidRequest` — HTTP 400 (server-rejected payload)
- `Conflict` — HTTP 409
- `AlreadyOwned` — product already purchased/owned
- `PaymentDeclined` — payment method declined by the store
- `StoreServiceUnavailable` — store backend temporarily unavailable
- `Ineligible` — subscriber not eligible for the offered product/promotion

**`RovenueError` interface fields (via UniFFI):**
- `kind: ErrorKind` — discriminant
- `detail: String` — human-readable message
- `server_code: String?` — machine-readable backend error code
- `http_status: u16?` — HTTP status if relevant
- `retryable: Boolean` — whether the caller should retry

## 0.15.0

Initial release of the shared Rust-core error transport with UniFFI bindings.
