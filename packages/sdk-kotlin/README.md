# Rovenue Kotlin SDK

Open-source subscription management SDK for Android. Integrates with the Rovenue API server to provide entitlement checks, receipt verification, and event tracking.

## Installation

Add to your `build.gradle.kts`:

```kotlin
dependencies {
    implementation("dev.rovenue:sdk:0.6.0")
}
```

## Quick Start

```kotlin
import dev.rovenue.sdk.Rovenue

Rovenue.configure(apiKey = "rov_pub_...", baseUrl = "https://edge.rovenue.io")

val pro = Rovenue.shared.entitlement("pro")
if (pro?.isActive == true) { /* unlock features */ }
```

## Documentation

Full guides, API reference, and the identity & consent policy live at
**https://docs.rovenue.io** — start with the
[Quick Start](https://docs.rovenue.io/docs/getting-started/quickstart).
