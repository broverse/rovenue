# Rovenue iOS (SwiftUI) Example

A native SwiftUI app that exercises `packages/sdk-swift` end-to-end. It
demonstrates the same flow the Flutter example
(`packages/sdk-flutter/example`) and the React Native example
(`examples/sample-rn-expo`) show, so all three teach one flow rather than
three dialects:

```
configure -> identify -> offerings -> paywall (RovenuePaywallView)
-> purchase -> entitlement reaction -> restore
```

plus an on-screen event log.

This app is **not** wired to a real Rovenue project out of the box — the API
key in `RovenueExample/Config.swift` is a placeholder. Every SDK call is
wrapped in `do`/`catch` and its outcome (success or failure) is appended to
the log, so the app is useful to poke at even without a live backend.

## Why this exists

This is the only native iOS example in the repo (`packages/sdk-flutter/example`
has a real end-to-end Flutter demo including its own iOS runner, and
`examples/sample-rn-expo` is a React Native smoke test) — this project shows
what integrating `Rovenue` directly into a native SwiftUI app looks like,
with no bridge in between.

## Requirements

- Xcode 16+ (deployment target is iOS 16.0 — see "Why 16.0" below)
- The `RovenueFFI.xcframework` binary artifact, which is **not** checked into
  git (see `packages/sdk-swift/.gitignore`). Build it once before opening
  this project:

  ```sh
  ./packages/sdk-swift/scripts/build-xcframework.sh
  ```

  This cross-compiles `librovenue` (the Rust core) for device + simulator +
  macOS and packages it as `packages/sdk-swift/RovenueFFI.xcframework`.
  Requires `rustup`, `cargo`, `ruby`, and Xcode's command-line tools. The
  script also regenerates the UniFFI bindings first, so this one command is
  the whole prerequisite — no separate bindgen step. Without this step,
  SwiftPM cannot resolve the local `Rovenue` package dependency and the
  project will not build; both this Xcode project and a bare `swift build`
  in `packages/sdk-swift` fail with:

  ```
  error: local binary target 'RovenueFFI' at '<repo>/packages/sdk-swift/RovenueFFI.xcframework' does not contain a binary artifact.
  ```

  CI (`.github/workflows/sdk.yml`'s `swift` job) runs this script before
  building, which is why this only bites a fresh local clone.

## Running

Open `RovenueExample.xcodeproj` in Xcode and run the `RovenueExample`
scheme on any iOS 16+ simulator, or from the command line:

```sh
xcodebuild -scheme RovenueExample -destination 'generic/platform=iOS Simulator' build
```

The `Rovenue` package is consumed by **local SwiftPM path**
(`../../packages/sdk-swift`, see the project's `XCLocalSwiftPackageReference`)
— not a released version, not CocoaPods — so editing the SDK source and
rebuilding this app picks up your changes immediately.

## Why iOS 16.0

`packages/sdk-swift/release.config.json` sets `iosDeploymentTarget: "16.0"`
— that's the floor the `Rovenue` package's `Package.swift` declares
(`platforms: [.iOS(.v16), ...]`). A lower deployment target here fails to
resolve the package at all; this project intentionally matches that floor
rather than raising it.

## Configuration: base URL (simulator vs. device) and the ATS exception

Edit `RovenueExample/Config.swift` before pointing this at a real project —
it has the full explanation inline, summarized here:

- **`apiKey`** — a placeholder public key. Replace with a real project key
  from your Rovenue dashboard to see live offerings/entitlements.
- **`baseURL`** — where the app looks for the Rovenue API, and it depends on
  *where the app runs*:
  - **iOS Simulator**: the simulator shares the Mac's network stack, so
    `http://localhost:3000` reaches a `docker compose up` API running on the
    host directly. This is the default in `Config.swift`.
  - **Physical device**: on a device, `localhost` means the device itself,
    not your Mac. Point `baseURL` at your Mac's LAN IP instead, e.g.
    `http://192.168.1.23:3000`, with the device on the same network.
  - **A real deployment**: use `https://` (e.g. `https://edge.rovenue.io`).
    HTTPS needs no ATS exception at all — see below.

- **The ATS exception**: plain `http://` (no TLS) is blocked by App
  Transport Security by default on iOS. `RovenueExample/Info.plist` carries
  a narrow exception:

  ```xml
  <key>NSAppTransportSecurity</key>
  <dict>
      <key>NSExceptionDomains</key>
      <dict>
          <key>localhost</key>
          <dict>
              <key>NSExceptionAllowsInsecureHTTPLoads</key>
              <true/>
              <key>NSIncludesSubdomains</key>
              <false/>
          </dict>
      </dict>
  </dict>
  ```

  This allows insecure (`http://`) loads to the single host `localhost`
  only — it does not weaken ATS for any other host, and does not enable the
  blanket `NSAllowsArbitraryLoads` escape hatch. A build that only ever
  talks to a real `https://` deployment does not need this block at all —
  drop it entirely rather than keeping it "just in case".

  **Physical device + LAN IP needs its own exception entry.** The
  `localhost` exception above covers only that literal host. If you follow
  the "Physical device" instructions and point `baseURL` at your Mac's LAN
  IP (e.g. `http://192.168.1.23:3000`), that host is *not* covered by the
  `localhost` entry — ATS will block the request. Add a second entry under
  `NSExceptionDomains` for that exact IP (or hostname) before running on a
  device:

  ```xml
  <key>NSExceptionDomains</key>
  <dict>
      <key>localhost</key>
      <dict>
          <key>NSExceptionAllowsInsecureHTTPLoads</key>
          <true/>
          <key>NSIncludesSubdomains</key>
          <false/>
      </dict>
      <key>192.168.1.23</key>
      <dict>
          <key>NSExceptionAllowsInsecureHTTPLoads</key>
          <true/>
          <key>NSIncludesSubdomains</key>
          <false/>
      </dict>
  </dict>
  ```

  Replace `192.168.1.23` with your machine's actual LAN IP — and update it
  again if that IP changes (most home/office DHCP leases aren't static).

## The "don't re-fetch inside the change listener" footgun

The repo has a recorded bug class: calling a network-refresh method from
inside the SDK's own change-notification handler re-triggers that same
notification and loops forever (`refreshX()` inside an `XCHANGED` handler
re-emits `XCHANGED`).

`HomeViewModel.bootstrap()` subscribes to `Rovenue.shared.changes` for the
app's lifetime and, on every event, calls `Rovenue.shared.entitlementsAll()`
— **not** `Rovenue.shared.refreshEntitlements()`. The distinction matters:

- `refreshEntitlements()` hits the network and, on success, emits
  `.entitlementsChanged` again — calling it from the listener would recreate
  the loop.
- `entitlementsAll()` only reads the already-updated local cache. It never
  touches the network and never emits a change event, so it's safe to call
  from the listener.

This mirrors the Flutter example, which also calls the cache-only
`entitlementsAll()` (not a network refresh) from inside its own `changes`
listener — `rovenue_flutter`'s platform channel forwards that call straight
through to this same Swift method (see
`packages/sdk-flutter/rovenue_flutter_ios/ios/Classes/HostApiImpl.swift`), so
the Flutter example's "refresh on change" is safe for the identical reason
this one is. (The React Native example, `examples/sample-rn-expo`, takes the
more conservative route of logging the event only and relying on its
reactive hooks to pick up store updates — see the comment in its `App.tsx`.)

## Project layout

```
examples/ios-swift/
  RovenueExample.xcodeproj/        Xcode project (local SwiftPM dependency
                                    on ../../packages/sdk-swift)
  RovenueExample/
    RovenueExampleApp.swift        @main entry point
    Config.swift                   EDIT ME — API key, base URL
    HomeViewModel.swift            Drives configure/identify/offerings/
                                    entitlements/purchase/restore + the log
    ContentView.swift              Home screen UI
    PaywallSheet.swift             Hosts RovenuePaywallView + its callbacks
    Info.plist                     ATS exception for localhost
    Assets.xcassets
  README.md                        This file
```

Deliberately **no `package.json`** — `pnpm-workspace.yaml` globs
`examples/*`, and this is a native Xcode project, not a JS package. Adding
one would silently pull this app into the JS workspace's install/build
graph.
