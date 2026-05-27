# SDK M6 — Distribution Design

## Overview

M6 wires the RN façade into a buildable, distributable shape end-to-end. The single biggest move is a **pivot from Nitro Modules to Expo Modules** for the native binding layer. The motivation is the iOS distribution gap M5 left open: M3 is SPM-only (per its own spec), but Nitro + React Native autolinking pushes consumers through CocoaPods. Expo Modules' `app.plugin.js` config-plugin pattern lets us inject the M3 SPM package (and the M4 Gradle composite build) into a consumer app at `expo prebuild` time, with no `pod install` heroics and no Swift source re-vendoring.

The TS public surface from M5 — `Rovenue.X(...)`, `useEntitlement(...)`, `RovenueError + 13 subclasses`, `ReactiveStore`, `eventBridge` — stays intact. The 48 vitest tests stay green because they mock at the `getNative()` boundary (the test seam Task 5 added in M5). Only the native binding layer changes.

The npm package is renamed from `@rovenue/sdk-rn` → `@rovenue/react-native-sdk` and bumped to `v0.1.0`. The directory `packages/sdk-rn/` is kept (no directory rename) to avoid churning the M5 plan archive, the parity script, and workspace paths beyond what M6 already touches.

This spec is the direct successor of the [M5 RN Façade design](./2026-05-27-sdk-rn-facade-design.md). It assumes M3, M4, M5 have shipped (which they have, as of 2026-05-27).

## Goals

- **Buildable end-to-end.** A consumer running `expo prebuild && pnpm ios` (or `expo prebuild && pnpm android`) gets a working sample app that compiles, links the Rust core + M3 Swift + M4 Kotlin + sdk-rn JS, launches, and renders the SDK version + anonymous user ID.
- **Replace Nitro with Expo Modules.** Lighter native bridge code (declarative DSL, no Nitrogen codegen step), config-plugin-friendly distribution.
- **Config plugin handles SPM + Gradle composite build.** Consumer's iOS Xcode project gets the M3 SPM package via Podfile `:path`; consumer's Android Gradle project gets `includeBuild("../../packages/sdk-kotlin")`.
- **Minimal smoke sample app** under `examples/sample-rn-expo/`. One screen: `configure`, `Rovenue.getVersion()`, `useCurrentUser()`. Inside the monorepo, links via `workspace:*`.
- **TS dual format** (`ESM + CJS`) via `tsup`. M5 shipped TS-only.
- **`Rovenue.setLogHandler(fn)` JS log seam.** New native method on M3 + M4 that lets the bridge forward bridge-level events (configure / identify / refresh / receipt) to a JS handler. Rust tracing-layer forwarding stays deferred to M7.
- **Parity gate native compile.** `scripts/sdk-parity.sh` runs `xcodebuild` + `gradle assembleDebug` against the sample app when the toolchain is present; skips with a one-line note otherwise.
- **Rename** `@rovenue/sdk-rn` → `@rovenue/react-native-sdk`, version `0.1.0`.

## Non-Goals

- **Maven Central publish.** M4 deferred this to M7. The Gradle composite build covers monorepo consumers; external consumers wait for M7.
- **CocoaPods Trunk publish.** Same posture — external consumers wait for M7. M6 ships an `Rovenue.podspec` for M3 (so the consumer's Podfile can `:path =>` to it), but does NOT push to Trunk.
- **External-consumer (non-monorepo) plugin path.** The config plugin's M6 implementation hard-codes the monorepo-relative path (`../../../packages/sdk-swift`, etc.). External consumers will need an option-driven path or published-artifact mode in M7.
- **StoreKit 2 / BillingClient integration in the sample.** Sample is configure + version + anonId only. No purchase flow.
- **Expo Go support.** Native modules need a dev client. Documented in the sample README.
- **Rust tracing layer → JS forwarding.** `setLogHandler` in M6 receives bridge-level emit calls (one per public façade method entry/exit). Full Rust `tracing::Subscriber` plumbing is M7.
- **Directory rename.** `packages/sdk-rn/` stays; only the npm name moves to `@rovenue/react-native-sdk`.
- **Nitrogen automation.** Nitrogen is no longer part of the design once we pivot to Expo Modules.

## Architectural decisions

| Concern | Choice | Reason |
|---|---|---|
| Native binding framework | Expo Modules API (replaces Nitro Modules from M5) | First-class config-plugin support; declarative Module DSL; no codegen prerequisite; lets M3 stay SPM-only. |
| iOS link strategy | M5 sdk-rn podspec depends on `Rovenue` pod; config plugin adds `pod 'Rovenue', :path => '../../../packages/sdk-swift'` to consumer's Podfile. A thin `Rovenue.podspec` is added to `packages/sdk-swift/` (M3 stays SPM-primary). | Avoids Swift source re-vendoring AND avoids forcing M3 into a SPM/CocoaPods dual-publish. Path-based CocoaPods resolves the M3 sources for the consumer's Xcode build. |
| Android link strategy | Gradle composite build (`includeBuild`) | Consumer's `settings.gradle.kts` includes `packages/sdk-kotlin` directly; no Maven publish required for monorepo consumers. M4's `group/version` coordinates set in M6 so composite build resolves cleanly. |
| Config plugin entry | `app.plugin.js` at package root, loading compiled `plugin/build/index.js` | Expo convention — Expo loads `app.plugin.js` when the consumer's `app.json` references the package in `plugins`. |
| Sample app | Expo dev client in `examples/sample-rn-expo/`, linked via `workspace:*` | Dev client is required for native modules. Inside the monorepo for fast iteration + parity gate. |
| TS module format | `tsup` produces ESM + CJS + `.d.ts` to `dist/` | Modern bundlers prefer ESM; legacy Node/CJS environments still consume CJS. M5 shipped TS-only. |
| Test approach | Existing 48 tests stay green (mock at `getNative()` seam). Vitest config swaps `react-native-nitro-modules` alias → `expo-modules-core` stub. New `log.test.ts` (+2). Swift +2, Kotlin +2 for `setLogHandler`. | M5's test architecture is binding-framework-agnostic. Only stub identity changes. |
| Parity script integration | Best-effort iOS + Android sample build sections, identical skip pattern to M4 Kotlin section | CI runners without Xcode / JDK skip cleanly; local devs with toolchains get a real native build check. |
| `Rovenue.setLogHandler` scope (M6) | Bridge-level events only (façade method entry/exit) | Avoids touching the Rust core; M3 + M4 each add a small handler-set + emit calls. Rust tracing forwarding is M7. |
| Package name | `@rovenue/react-native-sdk` (rename from `@rovenue/sdk-rn`) | Aligns with "react-native-X" community convention; clearer for npm searchers. Directory stays `packages/sdk-rn/`. |
| Version | `0.1.0` (from `0.0.2`) | First publishable shape; minor bump captures the binding-framework pivot. |

## File Structure

### Deleted (M5 Nitro artifacts)

```
packages/sdk-rn/
├── nitro.json
├── src/specs/RovenueNitroSpec.nitro.ts
├── src/__tests__/_stubNitroModules.ts        (replaced by _stubExpoModules.ts)
├── ios/RovenueSdkRn.podspec                  (rewritten as Expo Module podspec)
├── ios/HybridRovenueNitroSpec.swift          (replaced by RovenueModule.swift)
├── android/build.gradle.kts                  (rewritten as Expo Module build.gradle)
└── android/src/main/java/dev/rovenue/sdkrn/
    └── HybridRovenueNitroSpec.kt             (replaced by RovenueModule.kt)
```

### Modified

```
packages/sdk-rn/
├── package.json                              # name → @rovenue/react-native-sdk; version → 0.1.0;
│                                             # peer: -nitro-modules, +expo, +expo-modules-core;
│                                             # devDep: +tsup, +@types/expo; "main"/"module"/"types"/"exports" dual
├── tsconfig.json                             # exclude plugin/, examples/; rootDirs adjusted for tsup
├── vitest.config.ts                          # alias swap nitro-modules → expo-modules-core stub
├── src/core/native.ts                        # requireNativeModule + EventEmitter
├── src/__tests__/_mockNative.ts              # type rename RovenueNitroSpec → RovenueModuleSpec
├── src/index.ts                              # add Rovenue.setLogHandler + type LogEntry export
└── android/src/main/AndroidManifest.xml      # unchanged content (package="dev.rovenue.sdkrn")

scripts/sdk-parity.sh                         # +RN sample iOS build section, +Android section (best-effort skip)
packages/sdk-swift/Sources/Rovenue/Rovenue.swift   # +setLogHandler + LogEntry struct + emit hooks
packages/sdk-swift/Tests/RovenueTests/LogHandlerTests.swift   (new)
packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Rovenue.kt    # +setLogHandler + LogEntry data class
packages/sdk-kotlin/src/test/kotlin/.../LogHandlerTest.kt   (new)
packages/sdk-kotlin/build.gradle.kts          # +group/version, +publication block (for composite build)

pnpm-workspace.yaml                            # +examples/* glob
turbo.json (if present)                        # @rovenue/sdk-rn → @rovenue/react-native-sdk references
```

### New

```
packages/sdk-rn/
├── expo-module.config.json                   # platforms, iosModule, androidModule
├── app.plugin.js                             # require("./plugin/build/index").default
├── tsup.config.ts                            # ESM+CJS+dts to dist/
├── src/
│   ├── specs/RovenueModule.types.ts          # TS module type definition (replaces nitro spec)
│   ├── api/log.ts                            # setLogHandler(fn) JS wiring
│   └── __tests__/
│       ├── _stubExpoModules.ts               # vitest alias target
│       └── log.test.ts                       # 2 tests for setLogHandler
├── plugin/
│   ├── index.ts                              # composer entry
│   ├── withRovenueIos.ts                     # Podfile :path mod
│   └── withRovenueAndroid.ts                 # settings.gradle + app/build.gradle mods
├── ios/
│   ├── RovenueSdkRn.podspec                  # Expo Module convention podspec
│   └── RovenueModule.swift                   # Module() definition DSL
└── android/
    ├── build.gradle                          # Expo Module convention build.gradle
    └── src/main/java/dev/rovenue/sdkrn/
        └── RovenueModule.kt                  # Module() definition DSL

packages/sdk-swift/
└── Rovenue.podspec                           # ~25 lines, M3 CocoaPods wrapper for path-based linking

examples/sample-rn-expo/
├── package.json                              # workspace:* dep on @rovenue/react-native-sdk
├── app.json                                  # plugins: ["@rovenue/react-native-sdk"]
├── tsconfig.json
├── metro.config.js                           # monorepo-aware watchFolders
├── App.tsx                                   # configure + getVersion + useCurrentUser smoke
└── README.md                                 # prebuild + xcodebuild + gradle commands
```

## Native Bridge Surface

### iOS — `packages/sdk-rn/ios/RovenueModule.swift`

```swift
import ExpoModulesCore
import Rovenue  // M3 SPM/CocoaPods symbol — injected by config plugin

public class RovenueModule: Module {
    private var changesTask: Task<Void, Never>?
    private var logUnsubscribe: (() -> Void)?

    public func definition() -> ModuleDefinition {
        Name("Rovenue")

        // ----- Sync (no Promise) -----
        Function("configure") { (apiKey: String, baseUrl: String, debug: Bool) in
            try Rovenue.configure(apiKey: apiKey, baseUrl: baseUrl, debug: debug)
        }
        Function("shutdown")      { Rovenue.shared.shutdown() }
        Function("setForeground") { (foreground: Bool) in Rovenue.shared.setForeground(foreground) }
        Function("getVersion")    { () -> String in Rovenue.shared.version }

        // ----- Async (returns JS Promise) -----
        AsyncFunction("currentUser") { () -> [String: Any?] in
            let u = await Rovenue.shared.currentUser()
            return ["anonId": u.anonId, "knownUserId": u.knownUserId as Any?]
        }
        AsyncFunction("identify") { (knownUserId: String) in
            try await Rovenue.shared.identify(knownUserId)
        }
        AsyncFunction("entitlement") { (id: String) -> [String: Any?]? in
            guard let e = await Rovenue.shared.entitlement(id) else { return nil }
            return Self.dtoFromEntitlement(e)
        }
        AsyncFunction("entitlementsAll") { () -> [[String: Any?]] in
            await Rovenue.shared.entitlementsAll().map(Self.dtoFromEntitlement)
        }
        AsyncFunction("refreshEntitlements") { try await Rovenue.shared.refreshEntitlements() }
        AsyncFunction("creditBalance")       { () -> Double in Double(await Rovenue.shared.creditBalance()) }
        AsyncFunction("refreshCredits")      { try await Rovenue.shared.refreshCredits() }
        AsyncFunction("consumeCredits") { (amount: Double, description: String?) -> Double in
            let b = try await Rovenue.shared.consumeCredits(Int64(amount), description: description)
            return Double(b)
        }
        AsyncFunction("postAppleReceipt") { (jws: String, productId: String) -> [String: Any?] in
            _ = try await Rovenue.shared.postAppleReceipt(jws, productId: productId)
            return ["ok": true, "entitlementsRefreshed": true, "creditsRefreshed": true]
        }
        AsyncFunction("postGoogleReceipt") { (receipt: String, productId: String) -> [String: Any?] in
            _ = try await Rovenue.shared.postGoogleReceipt(receipt, productId: productId)
            return ["ok": true, "entitlementsRefreshed": true, "creditsRefreshed": true]
        }

        // ----- Events -----
        Events("onChange", "onLog")

        OnStartObserving {
            self.changesTask = Task { [weak self] in
                for await event in Rovenue.shared.changes {
                    self?.sendEvent("onChange", ["event": Self.eventName(event)])
                }
            }
            self.logUnsubscribe = Rovenue.shared.setLogHandler { [weak self] entry in
                self?.sendEvent("onLog", [
                    "level": entry.level,
                    "message": entry.message,
                    "data": entry.data as Any?,
                ])
            }
        }
        OnStopObserving {
            self.changesTask?.cancel(); self.changesTask = nil
            self.logUnsubscribe?(); self.logUnsubscribe = nil
        }
    }

    private static func dtoFromEntitlement(_ e: Entitlement) -> [String: Any?] {
        ["id": e.id, "active": e.isActive, "expiresAt": e.expiresIso as Any?, "productId": e.productIdentifier]
    }
    private static func eventName(_ event: ChangeEvent) -> String {
        switch event {
        case .entitlementsChanged: return "ENTITLEMENTS_CHANGED"
        case .identityChanged:     return "IDENTITY_CHANGED"
        case .creditBalanceChanged: return "CREDIT_BALANCE_CHANGED"
        }
    }
}
```

### Android — `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`

```kotlin
package dev.rovenue.sdkrn

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.generated.ChangeEvent
import dev.rovenue.sdk.generated.Entitlement
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect

class RovenueModule : Module() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var changesJob: Job? = null
    private var logUnsub: (() -> Unit)? = null

    override fun definition() = ModuleDefinition {
        Name("Rovenue")

        Function("configure") { apiKey: String, baseUrl: String, debug: Boolean ->
            Rovenue.configure(apiKey, baseUrl, debug)
        }
        Function("shutdown")      { Rovenue.shared.shutdown() }
        Function("setForeground") { foreground: Boolean -> Rovenue.shared.setForeground(foreground) }
        Function("getVersion")    { Rovenue.shared.version }

        AsyncFunction("currentUser") Coroutine { ->
            val u = Rovenue.shared.currentUser()
            mapOf("anonId" to u.anonId, "knownUserId" to u.knownUserId)
        }
        AsyncFunction("identify") Coroutine { knownUserId: String ->
            Rovenue.shared.identify(knownUserId)
        }
        AsyncFunction("entitlement") Coroutine { id: String ->
            Rovenue.shared.entitlement(id)?.let(::dtoFromEntitlement)
        }
        AsyncFunction("entitlementsAll") Coroutine { ->
            Rovenue.shared.entitlementsAll().map(::dtoFromEntitlement)
        }
        AsyncFunction("refreshEntitlements") Coroutine { -> Rovenue.shared.refreshEntitlements() }
        AsyncFunction("creditBalance")       Coroutine { -> Rovenue.shared.creditBalance().toDouble() }
        AsyncFunction("refreshCredits")      Coroutine { -> Rovenue.shared.refreshCredits() }
        AsyncFunction("consumeCredits") Coroutine { amount: Double, description: String? ->
            Rovenue.shared.consumeCredits(amount.toLong(), description).toDouble()
        }
        AsyncFunction("postAppleReceipt") Coroutine { jws: String, productId: String ->
            Rovenue.shared.postAppleReceipt(jws, productId)
            mapOf("ok" to true, "entitlementsRefreshed" to true, "creditsRefreshed" to true)
        }
        AsyncFunction("postGoogleReceipt") Coroutine { receipt: String, productId: String ->
            Rovenue.shared.postGoogleReceipt(receipt, productId)
            mapOf("ok" to true, "entitlementsRefreshed" to true, "creditsRefreshed" to true)
        }

        Events("onChange", "onLog")

        OnStartObserving {
            changesJob = scope.launch {
                Rovenue.shared.changes.collect { event ->
                    sendEvent("onChange", mapOf("event" to event.name))
                }
            }
            logUnsub = Rovenue.shared.setLogHandler { entry ->
                sendEvent("onLog", mapOf(
                    "level" to entry.level,
                    "message" to entry.message,
                    "data" to entry.data,
                ))
            }
        }
        OnStopObserving {
            changesJob?.cancel(); changesJob = null
            logUnsub?.invoke();   logUnsub = null
        }
    }

    private fun dtoFromEntitlement(e: Entitlement): Map<String, Any?> = mapOf(
        "id"         to e.id,
        "active"     to e.isActive,
        "expiresAt"  to e.expiresIso,
        "productId"  to e.productIdentifier,
    )
}
```

### JS — `packages/sdk-rn/src/core/native.ts`

```ts
import { requireNativeModule, EventEmitter } from "expo-modules-core";
import type { RovenueModuleSpec } from "../specs/RovenueModule.types";

let instance: RovenueModuleSpec | null = null;

export function getNative(): RovenueModuleSpec {
  if (instance) return instance;
  instance = requireNativeModule<RovenueModuleSpec>("Rovenue");
  return instance;
}

// Lazy emitter — only constructed when first listener subscribes.
let _emitter: EventEmitter | null = null;
export function getEmitter(): EventEmitter {
  if (_emitter) return _emitter;
  _emitter = new EventEmitter(getNative() as any);
  return _emitter;
}

export function _setNativeForTesting(mock: RovenueModuleSpec | null): void {
  instance = mock;
  _emitter = null;  // force fresh emitter on next get
}
```

`src/core/eventBridge.ts` is updated to subscribe via `getEmitter().addListener("onChange", handler)` instead of `getNative().addChangeListener(handler)`. Public surface unchanged.

## Config Plugin Design

### iOS — `plugin/withRovenueIos.ts`

The plugin runs at `expo prebuild` time. Two responsibilities:
1. **Podfile mod** — add `pod 'Rovenue', :path => '<monorepo-relative path>'` to consumer's Podfile.
2. **Podfile mod** — add `pod 'RovenueSdkRn', :path => '../../node_modules/@rovenue/react-native-sdk'` (Expo Modules autolinking actually handles this; we verify and document).

Sketch:

```ts
import { ConfigPlugin, withDangerousMod } from "@expo/config-plugins";
import * as path from "node:path";
import * as fs from "node:fs";

export const withRovenueIos: ConfigPlugin<{ rovenueSwiftPath?: string } | void> = (config, opts) => {
  return withDangerousMod(config, ["ios", async (cfg) => {
    const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
    if (!fs.existsSync(podfile)) return cfg;
    const contents = fs.readFileSync(podfile, "utf8");

    // M6: monorepo-relative path. M7 will add option-driven external path.
    const rovenuePath = opts?.rovenueSwiftPath ?? "../../../packages/sdk-swift";
    const podLine = `  pod 'Rovenue', :path => '${rovenuePath}'`;

    if (!contents.includes("pod 'Rovenue'")) {
      const patched = contents.replace(
        /(target\s+['"][^'"]+['"]\s+do)/,
        `$1\n${podLine}`,
      );
      fs.writeFileSync(podfile, patched);
    }
    return cfg;
  }]);
};
```

### `packages/sdk-swift/Rovenue.podspec` (new M3 file)

```ruby
Pod::Spec.new do |s|
  s.name             = "Rovenue"
  s.version          = "0.1.0"
  s.summary          = "Rovenue Swift façade"
  s.homepage         = "https://rovenue.dev"
  s.license          = { :type => "AGPL-3.0" }
  s.authors          = "Rovenue"
  s.platforms        = { :ios => "13.0" }
  s.swift_version    = "5.9"
  s.source           = { :path => "." }
  s.source_files     = "Sources/Rovenue/**/*.swift"
  s.vendored_libraries = "Sources/Rovenue/librovenue.a"  # core-rs static lib (existing M0 build path)
end
```

> Note: `vendored_libraries` references the same `librovenue.a` produced by `packages/core-rs/scripts/build-bindings.sh`. M3's `Package.swift` already wires this via `binaryTarget`; the podspec mirrors that pointer. No new build steps.

### Android — `plugin/withRovenueAndroid.ts`

Two mods:
1. `settings.gradle.kts`: prepend `includeBuild("../../../packages/sdk-kotlin")`.
2. `app/build.gradle.kts`: add `implementation("dev.rovenue:sdk:0.1.0")` to the app's `dependencies` block.

```ts
import { ConfigPlugin, withSettingsGradle, withAppBuildGradle } from "@expo/config-plugins";

export const withRovenueAndroid: ConfigPlugin<{ rovenueKotlinPath?: string } | void> = (config, opts) => {
  const kotlinPath = opts?.rovenueKotlinPath ?? "../../../packages/sdk-kotlin";

  config = withSettingsGradle(config, (cfg) => {
    const line = `includeBuild("${kotlinPath}")`;
    if (!cfg.modResults.contents.includes(line)) {
      cfg.modResults.contents = `${line}\n${cfg.modResults.contents}`;
    }
    return cfg;
  });

  config = withAppBuildGradle(config, (cfg) => {
    const dep = `    implementation("dev.rovenue:sdk:0.1.0")`;
    if (!cfg.modResults.contents.includes("dev.rovenue:sdk")) {
      cfg.modResults.contents = cfg.modResults.contents.replace(
        /dependencies\s*\{/,
        `dependencies {\n${dep}`,
      );
    }
    return cfg;
  });

  return config;
};
```

### M4 Gradle coordinates (`packages/sdk-kotlin/build.gradle.kts` mod)

```kotlin
group = "dev.rovenue"
version = "0.1.0"

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            // artifactId defaults to project name; explicit:
            artifactId = "sdk"
            groupId = "dev.rovenue"
            version = "0.1.0"
        }
    }
}
```

> Maven Central upload is M7. M6 only declares the coordinates so the composite build resolves `dev.rovenue:sdk:0.1.0` locally.

### Plugin entry (`plugin/index.ts`)

```ts
import { ConfigPlugin } from "@expo/config-plugins";
import { withRovenueIos } from "./withRovenueIos";
import { withRovenueAndroid } from "./withRovenueAndroid";

export type RovenueConfigOptions = {
  rovenueSwiftPath?: string;
  rovenueKotlinPath?: string;
};

const withRovenue: ConfigPlugin<RovenueConfigOptions | void> = (config, opts) => {
  config = withRovenueIos(config, opts ?? undefined);
  config = withRovenueAndroid(config, opts ?? undefined);
  return config;
};

export default withRovenue;
```

### `app.plugin.js` (Expo loader convention)

```js
module.exports = require("./plugin/build/index").default;
```

> Compiled output lives at `plugin/build/`. The package's `build` script chains `tsup` (for `src/`) and `tsc` (for `plugin/`, since config plugins should be CJS).

## Sample App — `examples/sample-rn-expo/`

### Layout

- `package.json` — Expo dev client deps, `"@rovenue/react-native-sdk": "workspace:*"`.
- `app.json` — `"plugins": ["@rovenue/react-native-sdk"]`.
- `tsconfig.json` — extends repo `tsconfig.base.json`.
- `metro.config.js` — monorepo-aware (adds workspace root to `watchFolders`, sets `nodeModulesPaths` to include workspace root).
- `App.tsx` — minimal smoke screen.
- `README.md` — `pnpm install`, `pnpm prebuild`, `pnpm ios` / `pnpm android`.

### `App.tsx`

```tsx
import { useEffect, useState } from "react";
import { SafeAreaView, Text, View } from "react-native";
import { Rovenue, useCurrentUser } from "@rovenue/react-native-sdk";

export default function App() {
  const [version, setVersion] = useState<string | null>(null);
  const user = useCurrentUser();

  useEffect(() => {
    Rovenue.configure({
      apiKey: "pk_smoke_test",
      baseUrl: "https://api.rovenue.dev",
      debug: true,
    });
    setVersion(Rovenue.getVersion());
    Rovenue.setLogHandler((entry) => {
      console.log(`[rovenue:${entry.level}]`, entry.message, entry.data ?? "");
    });
  }, []);

  return (
    <SafeAreaView>
      <View style={{ padding: 24, gap: 8 }}>
        <Text>SDK version: {version ?? "—"}</Text>
        <Text>anonId: {user?.anonId ?? "loading…"}</Text>
        <Text>knownUserId: {user?.knownUserId ?? "(not identified)"}</Text>
      </View>
    </SafeAreaView>
  );
}
```

### `metro.config.js`

```js
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const workspaceRoot = path.resolve(__dirname, "../..");
const projectRoot = __dirname;

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.disableHierarchicalLookup = true;
module.exports = config;
```

## `Rovenue.setLogHandler(fn)`

### JS API — `packages/sdk-rn/src/api/log.ts`

```ts
import { getEmitter } from "../core/native";

export type LogEntry = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
};

let subscription: { remove(): void } | null = null;

export function setLogHandler(fn: ((entry: LogEntry) => void) | null): void {
  subscription?.remove();
  subscription = null;
  if (fn) subscription = getEmitter().addListener("onLog", fn);
}
```

`src/index.ts`'s `Rovenue` namespace gains `setLogHandler`. `LogEntry` is re-exported.

### M3 Swift — additions to `packages/sdk-swift/Sources/Rovenue/Rovenue.swift`

```swift
public struct LogEntry: Sendable {
    public let level: String   // "debug" | "info" | "warn" | "error"
    public let message: String
    public let data: [String: Any]?
}

extension Rovenue {
    private static var logHandlers: [UUID: (LogEntry) -> Void] = [:]
    private static let logLock = NSLock()

    public func setLogHandler(_ handler: @escaping (LogEntry) -> Void) -> () -> Void {
        let id = UUID()
        Self.logLock.lock(); Self.logHandlers[id] = handler; Self.logLock.unlock()
        return {
            Self.logLock.lock(); Self.logHandlers.removeValue(forKey: id); Self.logLock.unlock()
        }
    }

    internal static func emit(_ entry: LogEntry) {
        logLock.lock(); let snapshot = Array(logHandlers.values); logLock.unlock()
        snapshot.forEach { $0(entry) }
    }
}
```

Each public façade method gains an `emit` call at entry (and at exit, for async methods). Example:

```swift
public func identify(_ knownUserId: String) async throws {
    Self.emit(LogEntry(level: "info", message: "identify", data: nil))
    do {
        try await core.identify(knownUserId)
        Self.emit(LogEntry(level: "info", message: "identify ok", data: nil))
    } catch {
        // error.localizedDescription only — never raw exception detail that may include user input.
        Self.emit(LogEntry(level: "error", message: "identify failed: \(error.localizedDescription)", data: nil))
        throw error
    }
}
```

**Privacy contract:** the `message` field is a fixed string per emit site (no user input interpolation). The `data` field is `nil` for façade-level emits in M6 — if a future emit needs structured data (e.g., HTTP status, retry counts), it MUST exclude PII (no `apiKey`, no `knownUserId`, no JWS / purchase token, no email). The test suite includes negative assertions: handler captures during a test scenario MUST NOT contain the test API key string or the test known-user-id string.

**Handler lifetime:** `logHandlers` is a static dictionary on `Rovenue`, intentionally not cleared on `configure`-twice. Consumers install a handler once at app start; reconfiguring the SDK (e.g., to rotate API keys) does not silently drop their handler.

### M4 Kotlin — additions to `packages/sdk-kotlin/.../Rovenue.kt`

Symmetric: `data class LogEntry(val level: String, val message: String, val data: Map<String, Any?>?)`, thread-safe `logHandlers: MutableMap<UUID, (LogEntry) -> Unit>` guarded by a `ReentrantLock`, `setLogHandler(handler): () -> Unit`, internal `emit(entry)`, façade methods emit at entry/exit.

## TS Dual Format

### `tsup.config.ts`

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/version.ts"],
  format: ["esm", "cjs"],
  dts: true,
  outDir: "dist",
  clean: true,
  sourcemap: true,
  target: "es2020",
  external: ["react", "react-native", "expo", "expo-modules-core"],
});
```

### `package.json` exports

```json
{
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    },
    "./version": {
      "import": "./dist/version.js",
      "require": "./dist/version.cjs",
      "types": "./dist/version.d.ts"
    }
  },
  "scripts": {
    "build": "tsup && tsc -p tsconfig.plugin.json",
    "build:js": "tsup",
    "build:plugin": "tsc -p tsconfig.plugin.json",
    "test": "vitest run"
  }
}
```

`tsconfig.plugin.json` (new) is a thin tsconfig that builds `plugin/*.ts` → `plugin/build/*.js` (CJS, since Expo config plugins are loaded as CJS).

## Parity Script Integration

Append to `scripts/sdk-parity.sh` after the existing RN vitest section:

```bash
# ---- RN sample app native compile (best-effort) ----
echo "▶ RN sample app native compile"

# iOS
if command -v xcodebuild >/dev/null 2>&1 && [ -d "/Applications/Xcode.app" ]; then
  (set -e
   cd examples/sample-rn-expo
   pnpm install --frozen-lockfile >/dev/null 2>&1 || true
   pnpm expo prebuild --platform ios --no-install >/tmp/rovenue-sample-ios.log 2>&1
   (cd ios && pod install >>/tmp/rovenue-sample-ios.log 2>&1)
   xcodebuild -workspace ios/sampleRnExpo.xcworkspace -scheme sampleRnExpo \
     -sdk iphonesimulator -configuration Debug build >>/tmp/rovenue-sample-ios.log 2>&1
  )
  echo "  ✓ iOS sample build succeeded"
else
  echo "  ~ xcodebuild unavailable — iOS sample build skipped"
fi

# Android
if command -v java >/dev/null 2>&1 && [ -n "${ANDROID_HOME:-}" ]; then
  (set -e
   cd examples/sample-rn-expo
   pnpm expo prebuild --platform android --no-install >/tmp/rovenue-sample-android.log 2>&1
   (cd android && ./gradlew assembleDebug >>/tmp/rovenue-sample-android.log 2>&1)
  )
  echo "  ✓ Android sample build succeeded"
else
  echo "  ~ gradle/Android SDK unavailable — Android sample build skipped"
fi
```

The existing RN vitest section is also updated: `pnpm --filter @rovenue/sdk-rn …` → `pnpm --filter @rovenue/react-native-sdk …`.

## Testing Strategy

### Existing M5 tests (stay green)

All 48 vitest tests in `packages/sdk-rn/src/__tests__/` pass unchanged. They mock at the `getNative()` boundary, which is binding-framework-agnostic.

### New tests

| File | Tests | Coverage |
|---|---|---|
| `packages/sdk-rn/src/__tests__/log.test.ts` | 2 | `setLogHandler(fn)` subscribes to `onLog`; `setLogHandler(null)` unsubscribes. |
| `packages/sdk-swift/Tests/RovenueTests/LogHandlerTests.swift` | 2 | `setLogHandler` returns an unsubscribe that stops invocations. Multiple handlers all fire. |
| `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/LogHandlerTest.kt` | 2 | Symmetric to Swift. |
| `examples/sample-rn-expo` | 0 (smoke build) | Compiles + launches on iOS Sim + Android Emulator. Validated by parity script (best-effort). |

### Counts

| Suite | M5 | M6 | Δ |
|---|---|---|---|
| Rust (librovenue) | 36 | 36 | 0 |
| Swift (M3) | 30 | 32 | +2 |
| Kotlin (M4) | 16 | 18 | +2 |
| RN JS | 48 | 50 | +2 |
| **Sub-total (unit)** | **130** | **136** | **+6** |
| Sample iOS build | — | 1 | +1 |
| Sample Android build | — | 1 | +1 |

### Test mock updates

`packages/sdk-rn/src/__tests__/_mockNative.ts`:
- Type rename: `RovenueNitroSpec` → `RovenueModuleSpec`.
- Method shape unchanged (mock surface is JS-level, doesn't care about underlying framework).
- One addition: `addLogListener` mock + `__emitLog(entry)` helper, parallel to the existing `addChangeListener` + `__emit(event)`.

`packages/sdk-rn/vitest.config.ts`:
- Alias swap: `react-native-nitro-modules` → `expo-modules-core`. The stub at `_stubExpoModules.ts` exports a `requireNativeModule` that throws (forces test to use `_setNativeForTesting`) and an `EventEmitter` minimal class.

## Migration & Compatibility

### Package rename impact

| Touchpoint | Change |
|---|---|
| `packages/sdk-rn/package.json` `name` | `@rovenue/sdk-rn` → `@rovenue/react-native-sdk` |
| `packages/sdk-rn/package.json` `version` | `0.0.2` → `0.1.0` |
| `pnpm-workspace.yaml` | unchanged (path-based) |
| `scripts/sdk-parity.sh` | `--filter @rovenue/sdk-rn` → `--filter @rovenue/react-native-sdk` |
| `turbo.json` (if present) | rename entries |
| Existing M5 plan file | preserved as historical reference; no rewrite |
| Directory | `packages/sdk-rn/` stays (cosmetic — npm name doesn't have to match) |

### Breaking changes for downstream consumers

`@rovenue/sdk-rn@0.0.2` had zero published versions and was workspace-internal. The rename to `@rovenue/react-native-sdk@0.1.0` is therefore not a real breaking change — there are no external consumers to migrate.

### M3 / M4 source-incompatibility

The `setLogHandler` additions are pure additions. Existing M3 (30 tests) and M4 (16 tests) suites remain green; the new tests are additive.

The `Rovenue.podspec` added to `sdk-swift/` is a new file; M3's `Package.swift` is untouched.

The Gradle coordinates added to `sdk-kotlin/build.gradle.kts` (`group`, `version`, `publishing { … }`) are additive. Existing Gradle tasks (test, assemble) keep working.

## Open Questions / Deferred

1. **Maven Central + CocoaPods Trunk publish** — M7. Required for external (non-monorepo) consumers.
2. **External-consumer config-plugin path** — M7. Plugin currently hard-codes `../../../packages/sdk-{swift,kotlin}`; needs an option (or auto-detection of `node_modules/@rovenue/sdk-{swift,kotlin}/`) for npm consumers.
3. **Rust tracing → JS forwarding** — M7. M6's `setLogHandler` only sees bridge-level entry/exit events; the Rust core's `tracing::event!` macros remain logged via the Rust subscriber (stdout/logcat).
4. **Directory rename** (`packages/sdk-rn/` → `packages/react-native-sdk/`) — left for a future cleanup sweep. Low priority; npm name is what consumers care about.
5. **Expo SDK 52 / RN 0.75 compat** — M6 pins Expo 51 / RN 0.74. Bump when Expo Modules + Nitro/Expo-Module-Core APIs stabilize at the next version.
6. **Sample app test harness** — sample is build-only smoke. Integration tests (Detox / Maestro) are a separate plan.
7. **`Rovenue.shared.changes` mid-lifecycle subscription churn** — if `OnStartObserving` / `OnStopObserving` fire repeatedly (RN Fast Refresh, dev mode), the bridge tears down + reattaches. We need to verify in the sample that this doesn't drop events. If it does, switch to a single permanent subscription owned by `OnCreate` / `OnDestroy`.

---

*End of M6 design.*
