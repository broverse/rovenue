# Rovenue Swift SDK

Open-source subscription management SDK for iOS, macOS, tvOS, and watchOS. Integrates with the Rovenue API server to provide entitlement checks, receipt verification, and event tracking.

## Installation

### Swift Package Manager

Add the following to your `Package.swift`:

```swift
.package(url: "https://github.com/rovenue/sdk-swift", from: "0.1.0")
```

## Quick Start

```swift
import Rovenue

Rovenue.configure(publicApiKey: "rov_pub_...")

let pro = await Rovenue.entitlement("pro")
if pro.isActive { /* unlock features */ }
```

## Documentation

Full guides, API reference, and the identity & consent policy live at
**https://docs.rovenue.app** — start with the
[Quick Start](https://docs.rovenue.app/docs/getting-started/quickstart).
