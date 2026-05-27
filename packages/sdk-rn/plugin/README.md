# @rovenue/react-native-sdk — Expo config plugin

This plugin patches your Expo app's generated native projects at
`expo prebuild` time so the Rovenue native bridges link correctly.

## iOS

Adds the `Rovenue` pod to your `ios/Podfile`:

| Mode             | Trigger                                   | Podfile line                                  |
|------------------|-------------------------------------------|-----------------------------------------------|
| Trunk (default)  | `["@rovenue/react-native-sdk"]`           | `pod 'Rovenue', '~> 0.1'`                     |
| Local `:path =>` | `["@rovenue/react-native-sdk", { rovenueSwiftPath: "../../packages/sdk-swift" }]` | `pod 'Rovenue', :path => '<value>'` |

The `rovenueSwiftPath` is relative to the generated `ios/Podfile`, NOT
to your repo root.

**Trunk note (M7.1):** the `Rovenue` pod has not yet been pushed to
Trunk. Until the first push, you MUST use the `:path =>` mode or your
build will fail with "Unable to find a specification for `Rovenue`".

## Android

Adds the `dev.rovenue:sdk` dependency to your `android/app/build.gradle`
and (optionally) an `includeBuild` to `android/settings.gradle`.

| Mode               | Trigger                                                                | What ships                                                                |
|--------------------|------------------------------------------------------------------------|---------------------------------------------------------------------------|
| Maven (default)    | `["@rovenue/react-native-sdk"]`                                        | `implementation("dev.rovenue:sdk:0.1.0")` only                            |
| Composite build    | `["@rovenue/react-native-sdk", { rovenueKotlinPath: "../../packages/sdk-kotlin" }]` | `includeBuild("<value>")` + the implementation line                       |

**Maven note (M7.1):** `dev.rovenue:sdk` is NOT yet on Maven Central
(M7.2 milestone). Until then, external Android consumers cannot use the
default mode. Use the composite-build mode or stay in the monorepo.

## Example: monorepo consumer

```json
{
  "expo": {
    "plugins": [
      ["@rovenue/react-native-sdk", {
        "rovenueSwiftPath":  "../../../packages/sdk-swift",
        "rovenueKotlinPath": "../../../packages/sdk-kotlin"
      }]
    ]
  }
}
```

## Example: external consumer (post-M7.1 + M7.2)

```json
{
  "expo": {
    "plugins": ["@rovenue/react-native-sdk"]
  }
}
```

## Source

Plugin entry: `plugin/index.ts`. iOS mod: `plugin/withRovenueIos.ts`.
Android mod: `plugin/withRovenueAndroid.ts`. Built by
`tsc -p tsconfig.plugin.json` → `plugin/build/`; loaded by Expo via
`app.plugin.js` at the package root.
