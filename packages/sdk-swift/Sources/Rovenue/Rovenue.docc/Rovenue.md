# ``Rovenue``

Subscription, entitlement, and paywall client for the open-source Rovenue
backend — a Swift façade over the shared `librovenue` Rust core.

## Overview

``Rovenue`` is the SDK's single entry point: identify subscribers, read
entitlements, fetch offerings and paywalls, submit App Store / Play receipts
for validation, and log paywall impressions — all routed through the same
Rust core that backs the Kotlin, React Native, and Flutter façades, so
behavior (bucketing, caching, retry) is identical across platforms.

This reference is generated from the doc comments on the public API; see the
[README](https://github.com/rovenue/rovenue/tree/main/packages/sdk-swift) for
a quickstart and installation instructions.

## Topics

### Essentials

- ``Rovenue``

### Entitlements & Offerings

- ``Entitlement``
- ``Offering``
- ``StoreProduct``

### Paywalls

- ``Paywall``
- ``RovenuePaywallView``
