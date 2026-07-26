# Changelog — @rovenue/react-native-sdk

## 0.16.0 — 2026-06-23

### `RovenuePaywallView` now renders natively

`RovenuePaywallView` no longer renders a JavaScript component tree. It now
hosts the platform's own native paywall renderer — SwiftUI's
`RovenuePaywallView` on iOS, the Android Views renderer on Android — behind
an Expo view, for pixel parity with the Swift and Kotlin SDKs. The public
props are **unchanged**: same `RovenuePaywallViewProps` shape, same
`paywall`/`locale`/`colorScheme`/callback props, same behavior for omitted
`onRestore`/`onUrl` handlers.

**Behavior change to be aware of:** the view only sends
`paywall.placementIdentifier` across the bridge — the native side
re-resolves the paywall itself using the separate `locale` prop, rather than
trusting the `paywall` object you pass in as authoritative (which the old
JS renderer did). If you called `getPaywall('home', 'fr')` and render the
result, **pass `locale="fr"` to the view too** — omitting it now resolves
the default-locale paywall instead of the French one you already fetched.
Always pass the same `locale` to `RovenuePaywallView` that you passed to
`getPaywall`.

```tsx
const paywall = await getPaywall('home', 'fr');
// Before: the object's own config was authoritative — locale prop optional.
// Now: the native side re-resolves by placement + locale — pass it through.
<RovenuePaywallView paywall={paywall} locale="fr" />
```

The old JS renderer (`paywall-ui`) remains in the package and exported for
now; it will be removed in a later release once device smoke-testing of the
native path is complete.

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
