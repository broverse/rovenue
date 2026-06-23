# Changelog — Rovenue SDK (Kotlin / Android)

## 0.16.0 — 2026-06-23

### BREAKING: Unified exception surface

The standalone purchase exception classes (`PurchaseCancelledException`, `PurchasePendingException`, `ProductNotAvailableException`, `StoreProblemException`) are **removed**. Every SDK failure now throws `RovenueException` (sealed class) with a `kind: ErrorKind` discriminant and carried fields `serverCode`, `httpStatus`, `isRetryable`.

**Migration:**

```kotlin
// Before (0.15.x)
import dev.rovenue.sdk.PurchaseCancelledException
import dev.rovenue.sdk.PurchasePendingException

try {
    val result = Rovenue.shared.purchase(activity, pkg)
} catch (e: PurchaseCancelledException) {
    // user cancelled
} catch (e: PurchasePendingException) {
    showToast("Awaiting approval.")
}

// After (0.16.0)
import dev.rovenue.sdk.generated.RovenueException
import dev.rovenue.sdk.generated.ErrorKind

val outcome = Rovenue.shared.purchase(activity, pkg)
if (outcome.isDeferred) {
    showToast("Awaiting approval.")
    return
}
// No throw path for PurchaseCanceled — catch block:
try {
    Rovenue.shared.purchase(activity, pkg)
} catch (e: RovenueException) {
    when (e.kind) {
        ErrorKind.PURCHASE_CANCELED -> { /* user cancelled — no action */ }
        ErrorKind.NETWORK_UNAVAILABLE -> showToast("No internet connection.")
        ErrorKind.INSUFFICIENT_CREDITS -> showToast("Not enough credits.")
        else -> throw e
    }
}
```

**Key changes:**

- `RovenueException` sealed class replaces all purchase-specific exception types.
- `.pending` purchase state is `StorePurchaseOutcome.isDeferred = true` (non-throwing).
- New `ErrorKind` values: `FORBIDDEN`, `NOT_FOUND`, `INVALID_REQUEST`, `CONFLICT`, `ALREADY_OWNED`, `PAYMENT_DECLINED`, `STORE_SERVICE_UNAVAILABLE`, `INELIGIBLE`.

## 0.15.0

Initial release of the shared Rust-core error transport.
