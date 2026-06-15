# Rovenue Kotlin SDK

Open-source subscription management SDK for Android. Integrates with the Rovenue API server to provide entitlement checks, receipt verification, and event tracking.

## Installation

Add to your `build.gradle.kts`:

```kotlin
dependencies {
    implementation("io.rovenue:sdk-kotlin:0.1.0")
}
```

## Quick Start

```kotlin
import io.rovenue.Rovenue

Rovenue.configure(publicApiKey = "rov_pub_...")

val pro = Rovenue.entitlement("pro")
if (pro.isActive) { /* unlock features */ }
```

## Documentation

Full guides, API reference, and the identity & consent policy live at
**https://docs.rovenue.app** — start with the
[Quick Start](https://docs.rovenue.app/docs/getting-started/quickstart).
