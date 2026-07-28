# Rovenue React Native SDK

Open-source subscription management SDK for React Native. Integrates with the Rovenue API server to provide entitlement checks, receipt verification, and event tracking.

## Installation

```sh
npm install @rovenue/react-native-sdk
# or
yarn add @rovenue/react-native-sdk
```

## Quick Start

```ts
import { Rovenue } from '@rovenue/react-native-sdk';

Rovenue.configure({ apiKey: 'rov_pub_...', baseUrl: 'https://edge.rovenue.io' });

const pro = await Rovenue.entitlement('pro');
if (pro?.isActive) { /* unlock features */ }
```

## Paywalls and Lottie animations

`RovenuePaywallView` is an Expo view that **hosts the native SwiftUI /
Android paywall** — it is not a JavaScript renderer. Everything about a
builder paywall is drawn by the same native code an iOS or Android app runs.

That matters for one feature: builder paywalls can contain a `lottie` node,
and the SDK deliberately ships no Lottie runtime. You register whichever
player your app already uses — but a Lottie renderer is a **native view
factory** (it returns a SwiftUI `AnyView` or an Android `View`), so it
cannot be passed across the JS bridge. **There is no JavaScript API for it.**

Register it once, at launch, in your app's own native entry points:

- iOS — `ios/<YourApp>/AppDelegate.swift`
- Android — `android/app/src/main/java/.../MainApplication.kt`

Copy-pasteable snippets for both live in the guide:
**https://docs.rovenue.io/docs/guides/placements-and-paywalls#lottie-animations**

Until a player is registered, a `lottie` node renders its authored
`fallback` (or nothing) — nothing crashes, the animation is just absent.

## Documentation

Full guides, API reference, and the identity & consent policy live at
**https://docs.rovenue.io** — start with the
[Quick Start](https://docs.rovenue.io/docs/getting-started/quickstart).
