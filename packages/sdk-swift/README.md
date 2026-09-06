# Rovenue Swift SDK

Open-source subscription management SDK for iOS and macOS. Integrates with the Rovenue API server to provide entitlement checks, receipt verification, and event tracking. Supported platforms: iOS 16.0+ (device and simulator) and macOS 12.0+. tvOS, watchOS, and visionOS are not yet supported.

## Building from a fresh clone

This package depends on `RovenueFFI.xcframework`, a `binaryTarget` that wraps
`librovenue` (the Rust core) for device, simulator, and macOS. It is a
**build artifact, not a checked-in binary** — it's excluded by
`packages/sdk-swift/.gitignore` (and repo-wide by `.gitignore`) because it's
large and reproducible from source. A fresh clone does not have it, so
`swift build` / `swift package resolve` in this directory fails with:

```
error: local binary target 'RovenueFFI' at '<repo>/packages/sdk-swift/RovenueFFI.xcframework' does not contain a binary artifact.
```

Build it first, from the repo root:

```sh
./packages/sdk-swift/scripts/build-xcframework.sh
```

This regenerates the UniFFI bindings, cross-compiles `librovenue` for
`aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios`,
`aarch64-apple-darwin`, and `x86_64-apple-darwin`, and packages the result as
`packages/sdk-swift/RovenueFFI.xcframework` — one command, no separate
bindgen step required. Requires `rustup`, `cargo`, `ruby`, and Xcode's
command-line tools. `swift build` (or opening `Package.swift` in Xcode)
works once it completes. CI (`.github/workflows/sdk.yml`'s `swift` job) runs
this same script before `swift test`, which is why the failure above is
invisible there.

## Installation

### Swift Package Manager

Add the following to your `Package.swift`:

```swift
.package(url: "https://github.com/broverse/rovenue-swift", from: "0.16.0")
```

## Quick Start

```swift
import Rovenue

Rovenue.configure(apiKey: "rov_pub_...", baseUrl: "https://edge.rovenue.io")

let pro = await Rovenue.shared.entitlement("pro")
if pro?.isActive == true { /* unlock features */ }
```

## Documentation

Full guides, API reference, and the identity & consent policy live at
**https://docs.rovenue.io** — start with the
[Quick Start](https://docs.rovenue.io/docs/getting-started/quickstart).
