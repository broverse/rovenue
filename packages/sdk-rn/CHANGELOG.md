# Changelog — @rovenue/react-native-sdk

## 0.16.0 — 2026-06-23

### BREAKING: Unified error surface

The 22 typed error subclasses (`NotConfiguredError`, `InvalidApiKeyError`, `NetworkUnavailableError`, etc.) are **removed**. Every SDK failure now throws a single `RovenueError` with a `kind` discriminant.

**Migration:**

```ts
// Before (0.15.x)
import { Rovenue, InsufficientCreditsError, NetworkUnavailableError } from '@rovenue/react-native-sdk';

try {
  const result = await Rovenue.purchase(pkg);
} catch (e) {
  if (e instanceof InsufficientCreditsError) {
    showToast('Not enough credits.');
  } else if (e instanceof NetworkUnavailableError) {
    showToast('No internet connection.');
  }
}

// After (0.16.0)
import { Rovenue, RovenueError } from '@rovenue/react-native-sdk';

try {
  const result = await Rovenue.purchase(pkg);
  // Handle deferred (Ask-to-Buy / parental controls)
  if (result.isDeferred) {
    showToast('Your purchase is awaiting approval.');
    return;
  }
  // success
} catch (e) {
  if (e instanceof RovenueError) {
    if (e.kind === 'InsufficientCredits') {
      showToast('Not enough credits.');
    } else if (e.kind === 'NetworkUnavailable') {
      showToast('No internet connection.');
    } else if (e.kind === 'PurchaseCanceled') {
      // User dismissed — no action needed
    }
  }
}
```

**Key changes:**

- `RovenueError` carries `kind: ErrorKind`, `message`, `serverCode?`, `httpStatus?`, `isRetryable`, `data?`.
- `.pending` purchase result is no longer a thrown `PurchasePendingError`; `purchase()` returns a `StorePurchaseOutcome` with `isDeferred: true` for Ask-to-Buy / parental-control holds.
- New `kind` values: `Forbidden`, `NotFound`, `InvalidRequest`, `Conflict`, `AlreadyOwned`, `PaymentDeclined`, `StoreServiceUnavailable`, `Ineligible`.
- `ERROR_KINDS` constant (24 PascalCase strings) exported; matches UDL exactly (verified by the new parity test).

## 0.15.0

Initial release of the unified error-kind normalizer (multi-casing iOS/Android bridge support).
