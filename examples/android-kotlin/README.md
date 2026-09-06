# Rovenue Android (Jetpack Compose) Example

A native Jetpack Compose app that exercises `packages/sdk-kotlin` end-to-end.
It demonstrates the same flow the Flutter example
(`packages/sdk-flutter/example`), the React Native example
(`examples/sample-rn-expo`), and the iOS example (`examples/ios-swift`) all
show, so every example app teaches one flow rather than a dialect per
platform:

```
configure -> identify -> offerings -> paywall (RovenuePaywallView)
-> purchase -> entitlement reaction -> restore
```

plus an on-screen event log.

This app is **not** wired to a real Rovenue project out of the box — the API
key in `app/src/main/kotlin/dev/rovenue/example/android/ExampleConfig.kt` is
a placeholder. Every SDK call is wrapped in `try`/`catch` and its outcome
(success or failure) is appended to the log, so the app is useful to poke at
even without a live backend.

## Why this exists

This is the only native Android example in the repo
(`packages/sdk-flutter/example` has a real end-to-end Flutter demo including
its own Android runner, and `examples/sample-rn-expo` is a React Native
smoke test) — this project shows what integrating the Kotlin `Rovenue`
façade directly into a native Compose app looks like, with no bridge in
between.

## How the SDK is consumed: Gradle composite build, not a Maven artifact

`packages/sdk-kotlin` is **not** published anywhere this project resolves
it from. `settings.gradle.kts` wires it in as a Gradle *composite build*:

```kotlin
includeBuild("../../packages/sdk-kotlin") {
    dependencySubstitution {
        substitute(module("dev.rovenue:sdk")).using(project(":"))
    }
}
```

and `app/build.gradle.kts` depends on it by that same coordinate:

```kotlin
implementation("dev.rovenue:sdk:0.1.0")
```

This is exactly how a real consumer app gets wired up by the Expo config
plugin at `packages/sdk-rn/plugin/withRovenueAndroid.ts` — it patches a
consuming app's `settings.gradle.kts` with `includeBuild(kotlinPath)` and its
`app/build.gradle.kts` with the same `implementation("dev.rovenue:sdk:0.1.0")`
line.

**One addition beyond what that plugin patches in:** Gradle's *default*
included-build substitution matches by the included project's own Gradle
project name — sdk-kotlin's is `sdk-kotlin` (its `settings.gradle.kts`
`rootProject.name`), not the Maven coordinate its `build.gradle.kts`
registers for publishing (`dev.rovenue:sdk`, the artifactId the RN bridge
and this app both depend on). Left at the default, Gradle only
auto-substitutes `dev.rovenue:sdk-kotlin` — which nothing depends on — and
`implementation("dev.rovenue:sdk:0.1.0")` fails to resolve at all ("Could
not find dev.rovenue:sdk:0.1.0"). The explicit `dependencySubstitution`
block above maps the real coordinate onto the included project. This isn't
a guess: `packages/sdk-flutter/rovenue_flutter_android/android/settings.gradle`
already documents and needs the identical rule for the identical reason —
this project's `settings.gradle.kts` mirrors it.

Editing `packages/sdk-kotlin` source and rebuilding this app picks up your
changes immediately — no publish step, no version bump.

## Requirements

- **JDK 17** — the same floor `packages/sdk-kotlin` builds with. If your
  default JDK is different, point Gradle at one explicitly:
  ```sh
  export JAVA_HOME=/path/to/jdk-17
  ```
- **Android SDK** — via `ANDROID_HOME` (or `ANDROID_SDK_ROOT`; Gradle
  accepts either), or a `local.properties` file with `sdk.dir=...`
  (gitignored — create your own, it's a per-machine path).
- Gradle wrapper is checked in (`./gradlew`); no separate Gradle install
  needed.

## Running

```sh
export ANDROID_HOME=~/Library/Android/sdk   # if not already set
./gradlew assembleDebug
```

Output APK: `app/build/outputs/apk/debug/app-debug.apk`. Install it on a
running emulator or device with:

```sh
./gradlew installDebug
```

or open this directory in Android Studio and run the `app` configuration.

## Configuration: base URL (emulator vs. device) and the cleartext-traffic exception

Edit `ExampleConfig.kt` before pointing this at a real project — it has the
full explanation inline, summarized here:

- **`apiKey`** — a placeholder public key. Replace with a real project key
  from your Rovenue dashboard to see live offerings/entitlements.
- **`baseUrl`** — where the app looks for the Rovenue API, and it depends on
  *where the app runs*:
  - **Android Emulator**: unlike the iOS Simulator (which shares the Mac's
    network namespace), the Android emulator runs its own virtual network.
    `10.0.2.2` is the emulator's special alias for the *host machine's*
    loopback interface, so `http://10.0.2.2:3000` reaches a
    `docker compose up` API running on your dev machine. Using `localhost`
    here resolves to the emulator itself, not your machine — a classic
    Android footgun the iOS example doesn't have to warn about. This is the
    default in `ExampleConfig.kt`.
  - **Physical device**: `10.0.2.2` only exists inside the emulator. On a
    real device, point `baseUrl` at your machine's LAN IP instead, e.g.
    `http://192.168.1.23:3000`, with the device on the same network.
  - **A real deployment**: use `https://` (e.g. `https://edge.rovenue.io`).
    HTTPS needs no cleartext exception at all — see below.

- **The cleartext-traffic exception** — Android's analogue of iOS's App
  Transport Security exception. Plain `http://` (no TLS) is blocked by
  Android's cleartext-traffic policy by default (API 28+). Rather than the
  blanket `android:usesCleartextTraffic="true"` escape hatch,
  `app/src/main/res/xml/network_security_config.xml` carries a narrow
  exception, referenced from `AndroidManifest.xml` via
  `android:networkSecurityConfig="@xml/network_security_config"`:

  ```xml
  <network-security-config>
      <domain-config cleartextTrafficPermitted="true">
          <domain includeSubdomains="false">10.0.2.2</domain>
      </domain-config>
  </network-security-config>
  ```

  This allows insecure (`http://`) loads to the single host `10.0.2.2`
  only — it does not weaken the cleartext policy for any other host. A
  build that only ever talks to a real `https://` deployment does not need
  this file at all — drop it (and the manifest attribute) entirely rather
  than keeping it "just in case".

## The "don't re-fetch inside the change listener" footgun

The repo has a recorded bug class: calling a network-refresh method from
inside the SDK's own change-notification handler re-triggers that same
notification and loops forever (`refreshX()` inside an `XCHANGED` handler
re-emits `XCHANGED`).

`HomeViewModel.bootstrap()` collects `Rovenue.shared.changes`
(`SharedFlow<ChangeEvent>`) for the app's lifetime and, on every event,
calls `Rovenue.shared.entitlementsAll()` — **not**
`Rovenue.shared.refreshEntitlements()`. The distinction, read directly from
`packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt`'s doc
comments:

- `refreshEntitlements()` hits the network and, on success, emits
  `ChangeEvent.ENTITLEMENTS_CHANGED` again — calling it from the collector
  would recreate the loop.
- `entitlementsAll()` is documented "Does not hit the network" — it only
  reads the already-updated local cache, and never emits a change event, so
  it's safe to call from the collector.

This mirrors the iOS example's `HomeViewModel.bootstrap()`, which collects
the same `changes` stream and calls the same-shaped cache-only
`entitlementsAll()` (never `refreshEntitlements()`) from inside its own
listener.

## The paywall renderer's shape (and how it differs from the other SDKs)

`packages/sdk-kotlin`'s Android-Views paywall implementation lives under
`paywallui/`. Its entry point, `RovenuePaywallView`, is a plain `FrameLayout`
(100% Android Views — no Compose, no Coil) with a single method:

```kotlin
fun bind(paywall: Paywall, options: PaywallViewOptions = PaywallViewOptions())
```

It takes an **already-resolved** `Paywall` — the same shape as the iOS
SDK's SwiftUI `RovenuePaywallView`. This app resolves the placement first
via `Rovenue.shared.getPaywall(placementId)`, then hands the result to
`RovenuePaywallView.bind(...)`, hosted in Compose via `AndroidView` (see
`ui/PaywallScreen.kt`). The Flutter SDK's paywall widget instead takes a
*placement identifier* and resolves it internally — the platforms genuinely
differ here; this app follows what `RovenuePaywallView.kt`'s source actually
declares, not either of the other two shapes.

`RovenuePaywallView`'s purchase flow needs an `Activity` to launch Play
Billing — it finds one by walking up its hosting `View`'s `Context` chain
(`Context.findActivity()` in `RovenuePaywallView.kt`). Because Compose's
`AndroidView` inflates its child with the hosting `Activity` as the
`Context`, and `MainActivity` here is a plain (unwrapped) `ComponentActivity`,
that walk always succeeds without this app doing anything extra.

## Cache-only vs. network-emitting methods (what backs the footgun guard above)

Determined by reading `Rovenue.kt`'s doc comments and behavior directly,
not assumed:

| Method | Cache-only or emitting? | Evidence |
| --- | --- | --- |
| `entitlementsAll()` | Cache-only | Doc: "List all cached entitlements. **Does not hit the network.**" |
| `entitlement(id)` | Cache-only | Doc: "Returns null if it doesn't exist locally — **does not hit the network.**" |
| `currentUser()` | Cache-only | Doc: "Cache read — never hits the network." |
| `refreshEntitlements()` | Emitting | Doc: "Force a refresh... against the server. On success, **emits `ChangeEvent.ENTITLEMENTS_CHANGED`**." |
| `refreshVirtualCurrencies()` | Emitting | Doc: "On change, **emits `ChangeEvent.VIRTUAL_CURRENCIES_CHANGED`**." |
| `refreshRemoteConfig()` | Emitting | Doc: "On success (when values changed), **emits `ChangeEvent.REMOTE_CONFIG_CHANGED`**." |
| `identify(appUserId)` / `logOut()` | Emitting (identity) | Change to the current user; observed as `ChangeEvent.IDENTITY_CHANGED` on `changes`. |

The change collector in `HomeViewModel.bootstrap()` only ever calls the
left column's cache-only methods.

## Project layout

```
examples/android-kotlin/
  settings.gradle.kts              includeBuild + dependencySubstitution
                                    wiring to ../../packages/sdk-kotlin
  build.gradle.kts                 root — plugin version declarations only
  gradle.properties
  gradlew / gradlew.bat / gradle/  wrapper (Gradle 8.9, matches sdk-kotlin)
  app/
    build.gradle.kts               AGP 8.5.2, Kotlin 1.9.24, Compose
    src/main/
      AndroidManifest.xml          networkSecurityConfig reference
      res/xml/network_security_config.xml   10.0.2.2-only cleartext exception
      kotlin/dev/rovenue/example/android/
        MainActivity.kt            @main entry point (ComponentActivity)
        ExampleConfig.kt           EDIT ME — API key, base URL
        HomeViewModel.kt           Drives configure/identify/offerings/
                                    entitlements/purchase/restore + the log
        ui/
          HomeScreen.kt            Home screen UI (Compose)
          PaywallScreen.kt         Hosts RovenuePaywallView + its callbacks
          Theme.kt                 Minimal Material 3 theme
  README.md                        This file
```

Deliberately **no `package.json`** — `pnpm-workspace.yaml` globs
`examples/*`, and this is a native Gradle project, not a JS package. Adding
one would silently pull this app into the JS workspace's install/build
graph.

## Verification

```sh
export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
export ANDROID_HOME=~/Library/Android/sdk
cd examples/android-kotlin
./gradlew clean assembleDebug
```

```
BUILD SUCCESSFUL in 3s
58 actionable tasks: 38 executed, 20 up-to-date
```

producing `app/build/outputs/apk/debug/app-debug.apk`.
