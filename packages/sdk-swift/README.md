# Rovenue Swift SDK

Open-source subscription management SDK for iOS and macOS. Integrates with the Rovenue API server to provide entitlement checks, receipt verification, and event tracking. Supported platforms: iOS 16.0+ (device and simulator) and macOS 12.0+. tvOS, watchOS, and visionOS are not yet supported.

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
