# Changelog — Rovenue SDK (Swift / iOS)

## 0.16.0 — 2026-06-23

### BREAKING: Unified error surface

The `Rovenue.Error` enum cases are **removed**. Every SDK failure now throws `RovenueError` (a Swift struct conforming to `LocalizedError`) with a `kind: ErrorKind` discriminant and carried fields `serverCode`, `httpStatus`, `isRetryable`.

**Migration:**

```swift
// Before (0.15.x)
do {
    let result = try await Rovenue.shared.purchase(pkg)
} catch Rovenue.Error.purchaseCancelled {
    // user cancelled
} catch Rovenue.Error.purchasePending {
    showToast("Awaiting approval.")
} catch Rovenue.Error.insufficientCredits {
    showToast("Not enough credits.")
}

// After (0.16.0)
do {
    let result = try await Rovenue.shared.purchase(pkg)
    if result.isDeferred {
        showToast("Awaiting approval.")
        return
    }
    // success
} catch let e as RovenueError {
    switch e.kind {
    case .purchaseCanceled:
        break // user cancelled — no action needed
    case .insufficientCredits:
        showToast("Not enough credits.")
    case .networkUnavailable:
        showToast("No internet connection.")
    default:
        throw e
    }
}
```

**Key changes:**

- `RovenueError` struct replaces the `Rovenue.Error` enum; fields: `kind: ErrorKind`, `message: String`, `serverCode: String?`, `httpStatus: UInt16?`, `isRetryable: Bool`.
- `.pending` purchase state is `StorePurchaseOutcome.isDeferred` (non-throwing `Bool`).
- New `ErrorKind` cases: `.forbidden`, `.notFound`, `.invalidRequest`, `.conflict`, `.alreadyOwned`, `.paymentDeclined`, `.storeServiceUnavailable`, `.ineligible`.

## 0.15.0

Initial release of the shared Rust-core error transport.
