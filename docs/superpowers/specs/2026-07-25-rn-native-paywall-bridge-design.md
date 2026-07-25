# React Native paywall: bridge to the native views, retire the JS renderer

**Date:** 2026-07-25
**Status:** Approved, ready for planning
**Supersedes:** the React Native half of the Phase C native-renderer design
(`2026-07-22-native-paywall-renderers-phase-c-design.md`)
**Blocks:** P4b (node types wave 1) — see §10

---

## 1. Why this exists

P4b's first node type, `icon`, needed a glyph source on four renderers. Web, iOS and Android
all had a native answer (inline SVG, SF Symbols, VectorDrawable). React Native had none: the
SDK ships no vector capability and no asset pipeline, so the choice was between a new consumer
dependency (`react-native-svg`) and a build-time font toolchain (`react-native-nano-icons`).

Researching how RevenueCat and Adapty solve it produced a different answer than expected:
**neither of them renders a paywall in JavaScript on React Native.** RevenueCat's
`react-native-purchases-ui` is a thin bridge — `PaywallViewWrapper.m` hosts the SwiftUI
`PaywallView` on iOS, `PaywallFooterViewManager.kt` hosts the native `PaywallView` /
`PaywallFooterView` on Android. Adapty's React Native SDK likewise presents a natively
rendered paywall. RevenueCat argues the choice publicly: no WebView/engine start-up cost,
and Dynamic Type, VoiceOver/TalkBack, contrast settings and platform typography inherited
for free.

So there is no industry precedent for "which RN vector library should a JS paywall renderer
use", because no competitor is in that position. The icon question was a symptom. The root
cause is that Rovenue renders the paywall node tree in React Native JS, and that decision
means every visual capability is written a fourth time. `icon` is the first wall; the sticky
footer's safe-area handling (P4b wave C) and per-platform font embedding (P10, already marked
"High risk" in the gap analysis) are the next two.

**Decision: bridge React Native to the existing native paywall views and retire the JS
renderer.**

---

## 2. Current state (measured, 2026-07-25)

| Fact | Value |
|---|---|
| `packages/sdk-rn/src/paywall-ui/` | 12 files — **1,337 lines production**, 1,159 lines test |
| Native view module in the Expo modules | **None** — this bridge would be the first |
| iOS host candidate | `public struct RovenuePaywallView: View` (`sdk-swift/Sources/Rovenue/PaywallUI/RovenuePaywallView.swift:13`) |
| Android host candidate | `class RovenuePaywallView` (`sdk-kotlin/.../paywallui/RovenuePaywallView.kt:58`) |
| `react-native-web` | Not a target — absent from `sdk-rn/package.json` |
| Expo Go | **Already unsupported.** `expo-module.config.json` declares custom native modules (`RovenueModule`, iOS + Android); Expo Go cannot load those. The docs already require the config plugin plus `npx expo prebuild`. |

The Expo Go row matters: it removes an argument that was raised for keeping the JS renderer
(and one that was raised against `react-native-nano-icons`). Neither holds — nothing in this
SDK runs in Expo Go today.

### 2.1 The three props contracts already match

| React Native (`RovenuePaywallViewProps`) | Swift (`RovenuePaywallView.init`) |
|---|---|
| `paywall: Paywall` | `paywall: Paywall` |
| `locale?: string` | `locale: String?` |
| `colorScheme?: "light" \| "dark"` | `colorSchemeOverride: ColorScheme?` |
| `onPurchaseCompleted?: (result) => void` | `onPurchaseCompleted: ((PurchaseResult) -> Void)?` |
| `onPurchaseFailed?: (error) => void` | `onPurchaseFailed: ((Error) -> Void)?` |
| `onClose?: () => void` | `onClose: (() -> Void)?` |
| `onRestore?: () => void` | `onRestore: (() -> Void)?` |
| `onUrl?: (url: string) => void` | `onUrl: ((URL) -> Void)?` |

Android carries the same set via `PaywallViewOptions`.

This is the load-bearing fact of the whole design: **`RovenuePaywallViewProps` is preserved
byte-for-byte.** Consumers of `<RovenuePaywallView />` change nothing. Only the component's
implementation changes, from a React tree to a hosted native view.

---

## 3. Architecture

```
┌──────────────────────────── JS ────────────────────────────┐
│  <RovenuePaywallView paywall={…} onClose={…} />            │
│    · unchanged props                                       │
│    · derives { placementIdentifier, locale, colorScheme }  │
│    · maps 5 native events → the 5 callback props           │
└──────────────────────────┬─────────────────────────────────┘
                           │ Expo module View definition
┌──────────────────────────┴─────────────────────────────────┐
│ iOS: ExpoView → UIHostingController(RovenuePaywallView)    │
│ Android: ExpoView → RovenuePaywallView (Android View)      │
│    · re-resolves the paywall from the native cache         │
│    · already carries offline fallback + the durable        │
│      paywall_view / paywall_close queue                    │
└────────────────────────────────────────────────────────────┘
```

### 3.1 What crosses the bridge

`PaywallDTO` already carries `placementIdentifier` (`sdk-rn/src/specs/RovenueModule.types.ts:105`),
so the bridge does not serialise the paywall. Three props cross:

- `placementIdentifier: string`
- `locale: string | undefined`
- `colorScheme: "light" | "dark" | undefined`

The native side re-resolves through its own `getPaywall`. This is safe, and specifically not
a second network fetch, because **the paywall JS is holding was fetched by native in the first
place** — `getPaywall(placementId, locale)` is a JS→native call
(`RovenueModule.types.ts:193`). The object is already in the native cache, including the
bundled offline fallback path and the `servedFromFallback` flag. Variant selection is
client-side deterministic (the `bucketing-vectors.json` contract), so re-resolution draws the
same variant.

**Accepted caveat:** if the native cache refreshes between the JS `getPaywall()` call and the
view mounting, `placementRevision` can differ between what JS holds and what the view renders.
The window is small and the consequence is rendering a *fresher* paywall, so this is accepted
rather than engineered around.

### 3.2 What crosses back

Five events, mapped one-to-one onto the existing callback props: `onPurchaseCompleted`,
`onPurchaseFailed`, `onClose`, `onRestore`, `onUrl`.

`onPurchaseFailed` must carry its error through the existing `@rovenue/err1:` JSON envelope
inside `message`, decoded by `mapNativeError`. This is not optional: the Expo JSI bridge
forwards only `code` and `message`, which is why the envelope exists.

`onRestore` keeps its current semantics — **omitting it hides restore affordances entirely**
(the funnel-like case). The native views already implement this; the bridge must forward the
presence/absence of the prop, not merely the callback.

---

## 4. Presentation model

Inline view only. The component fills the frame React Native gives it; the consumer sizes it
with `flex`. No imperative `presentPaywall()` modal is added — RevenueCat has one, we have
never had one, and nothing in the current plan needs it (YAGNI).

Two platform-specific pieces of work, and they are the substance of this phase:

- **iOS** — the SwiftUI view must be hosted in a `UIHostingController` added as a child view
  controller of the Expo view, with constraints pinning it to the host's bounds.
- **Android** — React Native's Yoga layout does not measure a `View` that is outside its own
  shadow tree, so the bridge must forward measurement and `requestLayout` explicitly.
  RevenueCat's Android bridge carries a "custom implementation for handling view measurement
  and layout" for exactly this reason.

---

## 5. Error and edge handling

No new error channel. Behaviour is parity with Swift/Kotlin:

- **Unknown placement** — the resolution endpoint returns an empty envelope, never a 404. The
  view renders nothing, exactly as Swift does when its decoded `config` is nil.
- **Remote-config-only paywall** (`builderConfigJson` is null) — the view renders nothing.
  Consumers build their own UI from `getPaywall()` data; that is a data API and is untouched.
- **Not configured** — cannot occur mid-view: the consumer already holds a `Paywall`, which
  required a configured SDK to obtain.
- **`colorScheme` absent** — follow the system.
- **`locale` absent** — use native's own resolution.

---

## 6. What is deleted

- `packages/sdk-rn/src/paywall-ui/` in full: 12 files, 1,337 production + 1,159 test lines.
- Package-root exports `decodeBuilderConfig`, `BuilderConfigModel`, `BuilderNode`
  (`sdk-rn/src/index.ts:137-143`). These are a genuine breaking change and require a major
  version bump. `RovenuePaywallViewProps` and `RovenuePaywallView` are **not** removed.

### 6.1 The cost, stated plainly

`render-fixtures.json` stops being a four-platform decoder contract and becomes a
three-platform one. The RN visibility and decode tests written in P5b stage 2 — days before
this document — are deleted along with the Phase C RN renderer they covered.

That loss is real and is not minimised here. It is accepted because the alternative is writing
those same tests a fourth time for every future node type: seven in P4b, two more in P4c, plus
fonts in P10.

---

## 7. Testing

**Verifiable in this environment:**

- The JS half of the bridge — props marshalling and event→callback mapping — against the
  existing mock-native harness (`_setNativeForTesting`, `makeMockNative`).
- That deleting `paywall-ui/` leaves the rest of the RN suite green.
- The Swift and Kotlin paywall views themselves, which already have real, running coverage
  (`swift test`, `testDebugUnitTest`).

**Not verifiable in this environment, and must be reported as such rather than claimed:**

- Everything native in the bridge. There is no React Native native toolchain here; this was
  demonstrated twice on 2026-07-25 while closing the `getAppVersion` bridge.

The untested surface is narrower than it first appears: the rendering logic being bridged is
already the most thoroughly tested renderer in the repo (Swift 187 tests, Kotlin 224 tests
across 29 classes — both re-run on 2026-07-25 for this document, 0 failures). What is untested is the hosting glue — the Expo view definition, the
`UIHostingController` wiring, and the Android measure/layout forwarding.

**A device smoke session is therefore an explicit deliverable of this phase, not a follow-up
item.** It must cover, on both platforms: the view appears and fills its frame; each of the
five callbacks fires; the paywall scrolls; and rotation/resize re-lays-out correctly.

This is a different risk profile from every prior phase in this project, where the
implementation could be proven locally before review.

---

## 8. Sequencing

The order is load-bearing. Deleting before verifying would produce a commit range in which
React Native has no paywall at all.

1. Build the native view module on both platforms **alongside** the existing JS renderer.
2. Switch `RovenuePaywallView`'s implementation to the native view; props unchanged.
3. Device smoke session on iOS and Android.
4. Only then delete `paywall-ui/`, drop the three package-root exports, and reduce
   `render-fixtures.json` to a three-platform contract.
5. Major version bump, changelog, and update `apps/docs/content/docs/platforms/react-native.mdx`.

---

## 9. Open risks

- **The Android measure/layout forwarding is the single most likely thing to be wrong**, and it
  is invisible to every test we can run here. It surfaces as a zero-height or clipped paywall.
  The smoke session must check it deliberately, not incidentally.
- **`UIHostingController` inside a React Native view hierarchy** interacts with safe areas and
  keyboard avoidance in ways that are hard to predict from source. Also a smoke-session item.
- **A consumer relying on the removed `decodeBuilderConfig` export** would break. It was an
  internal leaked through the package barrel and has no documented use case, but the major
  bump and changelog entry are the mitigation.

---

## 10. Relationship to P4b

P4b (node types wave 1) is paused behind this phase. Decisions already taken there stand:

1. **Three waves, split by the new capability each introduces** — (A) `divider` + `icon` plus
   the localization-key collector refactor; (B) `featureList`, `socialProof`, `timeline`, which
   reuse A's repeated-row primitive; (C) `countdown` + `stickyFooter`, which introduce new
   runtime behaviour and layout.
2. **`icon` uses a small curated set** — roughly 12 semantic names, generated from the
   already-installed, ISC-licensed `lucide-react` package rather than reproduced by hand, with
   each platform using its own native mechanism. Geometry is stroked, not filled:
   `viewBox 0 0 24 24`, `fill: none`, `stroke-width: 2`, round caps and joins. The generator
   converts `circle`/`rect`/`polyline` primitives to paths so every renderer implements exactly
   one primitive.
3. **Localization-key collection becomes a per-type collector table** —
   `Record<PaywallNode["type"], (node) => string[]>`, mirroring `OVERRIDABLE_PROP_KEYS` in the
   same file and exhaustive by construction. The current hardcoded list
   (`validate.ts:231-234`, repeated at `331-332`) cannot express wave B's
   `rows: [{ labelKey }]` arrays.
4. **Divergence guard for the icon set** — a shared `icon-registry.json`, with a per-platform
   test asserting its table covers every registered name, mirroring how `render-fixtures.json`
   and `bucketing-vectors.json` already work.

Landing this bridge first means every P4b node type is implemented on three renderers (web,
Swift, Kotlin) instead of four, and P4b's React Native icon question disappears entirely.

---

## 11. Sources

- [RevenueCat — Why we chose native paywalls](https://www.revenuecat.com/blog/engineering/why-we-chose-native-paywalls/)
- [RevenueCat `react-native-purchases` paywall architecture (DeepWiki)](https://deepwiki.com/RevenueCat/react-native-purchases/5.1-paywalls)
- [Adapty — Paywalls, React Native SDK](https://adapty.io/docs/react-native-paywalls)
- [react-native-nano-icons](https://github.com/software-mansion-labs/react-native-nano-icons) — evaluated and not adopted; see §1
