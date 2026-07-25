# React Native Native Paywall Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the React Native JS paywall renderer with an Expo view that hosts the existing Swift and Kotlin `RovenuePaywallView`, without changing a single public prop.

**Architecture:** Each Expo module gains a `View` definition backed by a new `RovenuePaywallExpoView`. That view receives a `placementIdentifier`, re-resolves the paywall through the native SDK's own `getPaywall` (which already holds it in cache, offline fallback included), and hosts the platform's real paywall view — a `UIHostingController` around the SwiftUI view on iOS, the `RovenuePaywallView` `FrameLayout` on Android. The JS `RovenuePaywallView` becomes a thin wrapper that marshals props down and maps five native events back onto its existing callbacks.

**Tech Stack:** Expo Modules API (`expo-modules-core` 2.5.0), SwiftUI + `UIHostingController`, Android Views, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-25-rn-native-paywall-bridge-design.md`

## Global Constraints

- `RovenuePaywallViewProps` is preserved **byte-for-byte**. Do not add `style`, `onError`, `testID`, or any other prop. The public type is: `paywall: Paywall; locale?: string; colorScheme?: "light" | "dark"; onPurchaseCompleted?: (result: PurchaseResult) => void; onPurchaseFailed?: (error: unknown) => void; onClose?: () => void; onRestore?: () => void; onUrl?: (url: string) => void`.
- **No magic values.** Every style literal, event name, timeout and dimension is a named constant. Structured data tables (an events list, a props map) are not magic values and stay as tables.
- **Never create or switch branches, and never use a worktree.** Commit on whatever HEAD is checked out.
- **`git add` only the files your task touches.** Never `git add -A`, never `git commit -a` — other work is in flight in this tree.
- **Native code is NOT runnable in this environment.** There is no React Native native toolchain here. For Tasks 1 and 2, state plainly in your report that the code was not compiled or run locally. Do not claim a pass, do not invent a test command, and do not mark a native task "verified".
- `onRestore` absent must **hide** restore affordances entirely; `onUrl` absent must leave url-action buttons **inert but rendered**. Both native views already implement this from a `null` handler — the bridge must therefore forward the *presence* of the JS callback, not just the callback.
- Errors crossing to `onPurchaseFailed` ride the existing `@rovenue/err1:` envelope and are unpacked with `mapNativeError` (`packages/sdk-rn/src/errors.ts:117-119`). The Expo JSI bridge forwards only `code` and `message`.
- **The deletion in Task 5 must not be started until Task 4's device smoke session has passed.** Deleting earlier produces a commit range where React Native has no paywall at all.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/sdk-rn/ios/RovenuePaywallExpoView.swift` | iOS `ExpoView` — resolves the paywall, hosts the SwiftUI view, emits five events |
| `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenuePaywallExpoView.kt` | Android `ExpoView` — same responsibility, opting into `shouldUseAndroidLayout` |
| `packages/sdk-rn/src/paywall-view/native-view.ts` | The single `requireNativeViewManager` call and the native-side props type |
| `packages/sdk-rn/src/paywall-view/RovenuePaywallView.tsx` | Public component: props → native props, native events → callbacks |
| `packages/sdk-rn/src/paywall-view/index.ts` | Barrel |
| `packages/sdk-rn/src/paywall-view/__tests__/bridge.test.tsx` | Marshalling and event-mapping tests |

**Modified:** `ios/RovenueModule.swift` and `android/.../RovenueModule.kt` (add the `View` definition and widen one helper); `src/index.ts` (export from the new path); `src/__tests__/_stubExpoModules.ts` (add `requireNativeViewManager`).

**Deleted in Task 5:** `packages/sdk-rn/src/paywall-ui/` entirely.

The new directory is deliberately `paywall-view/`, not `paywall-ui/`, so both can exist while the bridge is proven.

---

### Task 1: iOS Expo view

**Files:**
- Create: `packages/sdk-rn/ios/RovenuePaywallExpoView.swift`
- Modify: `packages/sdk-rn/ios/RovenueModule.swift` — add a `View(...)` definition inside `definition()`, and widen `dtoFromPurchaseResult` if it is declared `private`

**Interfaces:**
- Consumes: `Rovenue.shared.getPaywall(placementId:locale:) async throws -> Paywall?` (`sdk-swift/Sources/Rovenue/Rovenue.swift:691`); `RovenuePaywallView(paywall:locale:colorSchemeOverride:onPurchaseCompleted:onPurchaseFailed:onClose:onRestore:onUrl:)` (`sdk-swift/Sources/Rovenue/PaywallUI/RovenuePaywallView.swift:29`)
- Produces: an Expo view named `RovenuePaywallView` on the `Rovenue` module, with props `placementIdentifier: String`, `locale: String?`, `colorSchemeOverride: String?`, `hasRestoreHandler: Bool`, `hasUrlHandler: Bool`, and events `onPurchaseCompleted`, `onPurchaseFailed`, `onCloseRequested`, `onRestoreRequested`, `onUrlRequested`

> **This task cannot be compiled or run in this environment.** Write it carefully, then say so in your report.

- [ ] **Step 1: Create the view**

Create `packages/sdk-rn/ios/RovenuePaywallExpoView.swift`:

```swift
import ExpoModulesCore
import SwiftUI
import Rovenue

/// Code sent for an error that is not a `RovenueError`; `mapNativeError`
/// normalises an unrecognised kind on the JS side.
private let UNMAPPED_ERROR_CODE = "Unknown"

/// Hosts the SwiftUI `RovenuePaywallView` inside a React Native view tree.
///
/// Props arrive one at a time, so the reload is deferred to
/// `onViewDidUpdateProps()` — otherwise setting five props would start five
/// paywall fetches for one mount.
///
/// The hosted controller is created once per resolved paywall and reused for
/// cosmetic prop changes and for window detach/reattach, because React Native
/// recycles views and the SwiftUI view's impression flag lives in `@State`.
final class RovenuePaywallExpoView: ExpoView {
    // Native event names are deliberately NOT the JS callback names
    // (`onClose` etc.). The JS wrapper owns those; keeping the wire names
    // distinct makes it impossible to accidentally pass a consumer
    // callback straight through as a native prop.
    let onPurchaseCompleted = EventDispatcher()
    let onPurchaseFailed = EventDispatcher()
    let onCloseRequested = EventDispatcher()
    let onRestoreRequested = EventDispatcher()
    let onUrlRequested = EventDispatcher()

    var placementIdentifier: String?
    var locale: String?
    var colorSchemeOverride: String?
    var hasRestoreHandler: Bool = false
    var hasUrlHandler: Bool = false

    private var host: UIHostingController<AnyView>?
    /// The `resolvedKey` the current `host` was built for. When this still
    /// matches, the controller is reused and only its `rootView` is updated.
    private var hostKey: String?
    private var loadTask: Task<Void, Never>?
    private var cachedPaywall: Paywall?
    /// The (placement, locale) pair `cachedPaywall` was fetched for. Only a
    /// change to THIS re-fetches; cosmetic props rebuild the content from
    /// the cached paywall.
    private var resolvedKey: String?

    required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        clipsToBounds = true
    }

    /// Called from `OnViewDidUpdateProps` — the architecture-agnostic hook.
    /// Do NOT override `didSetProps`: it is declared only on React Native's
    /// old-architecture `RCTComponent` protocol, so under Fabric (this SDK's
    /// floor is React Native 0.76+, and the repo vendors 0.86) it matches no
    /// superclass member and fails to compile.
    func onViewDidUpdateProps() {
        reload()
    }

    deinit {
        loadTask?.cancel()
    }

    private func reload() {
        guard let placementIdentifier, !placementIdentifier.isEmpty else {
            loadTask?.cancel()
            cachedPaywall = nil
            resolvedKey = nil
            mount(nil)
            return
        }
        let key = placementIdentifier + KEY_SEPARATOR + (locale ?? "")
        // Toggling colorSchemeOverride or a handler flag must not re-fetch:
        // a re-fetch rebuilds the SwiftUI view, whose `didLogShow` is @State,
        // which would re-fire logPaywallShown and inflate paywall_view.
        //
        // This holds only while the last resolve SUCCEEDED. A failed resolve
        // clears the key deliberately, so the next prop update — cosmetic or
        // not — retries the fetch. That is the price of not being stuck
        // blank, and it stops as soon as a resolve succeeds.
        if key == resolvedKey {
            mount(cachedPaywall)
            return
        }
        loadTask?.cancel()
        resolvedKey = key
        let requestedLocale = locale
        loadTask = Task { [weak self] in
            // A resolution failure renders nothing, matching what the
            // SwiftUI view already does when its decoded config is nil.
            // Adding an error prop here would break the byte-for-byte
            // props contract, so the failure is swallowed rather than
            // surfaced — the SDK's own log channel already records it.
            let paywall = try? await Rovenue.shared.getPaywall(
                placementId: placementIdentifier,
                locale: requestedLocale
            )
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.resolvedKey == key else { return }
                // A failed resolve must NOT leave the key marked resolved.
                // The fast path above would then mount nil on every later
                // prop update, so the paywall would stay blank forever
                // unless the placement value itself changed.
                if paywall == nil { self.resolvedKey = nil }
                self.cachedPaywall = paywall
                self.mount(paywall)
            }
        }
    }

    private func scheme() -> ColorScheme? {
        switch colorSchemeOverride {
        case "light": return .light
        case "dark":  return .dark
        default:      return nil
        }
    }

    /// Containment has to wait for a window, because that is when
    /// `reactViewController()` can hand us a parent to attach to.
    ///
    /// On losing the window we detach from the parent controller but KEEP
    /// the controller object. React Native recycles views; destroying the
    /// controller here would reset the hosted SwiftUI tree's `@State` on
    /// every recycle, re-firing `logPaywallShown`.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            detachFromParent()
        } else {
            mount(cachedPaywall)
        }
    }

    /// Removes the hosted controller from the view/controller hierarchy but
    /// keeps the instance, so its SwiftUI state survives. Idempotent.
    private func detachFromParent() {
        guard let host, host.parent != nil else { return }
        host.willMove(toParent: nil)
        host.view.removeFromSuperview()
        host.removeFromParent()
    }

    /// Drops the controller entirely. Only correct when the paywall itself
    /// changes — a different paywall SHOULD start a fresh impression.
    private func destroyHost() {
        detachFromParent()
        host = nil
        hostKey = nil
    }

    /// Adds the controller to `parent` in the order Expo's own
    /// SwiftUIHostingView uses. Idempotent: already-attached is a no-op.
    private func attach(_ controller: UIHostingController<AnyView>, to parent: UIViewController) {
        guard controller.parent !== parent || controller.view.superview !== self else { return }
        controller.view.backgroundColor = .clear
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        parent.addChild(controller)
        addSubview(controller.view)
        NSLayoutConstraint.activate([
            controller.view.leadingAnchor.constraint(equalTo: leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: trailingAnchor),
            controller.view.topAnchor.constraint(equalTo: topAnchor),
            controller.view.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        controller.didMove(toParent: parent)
    }

    private func mount(_ paywall: Paywall?) {
        guard let paywall, window != nil, let parent = reactViewController() else {
            detachFromParent()
            return
        }

        let content = RovenuePaywallView(
            paywall: paywall,
            locale: locale,
            colorSchemeOverride: scheme(),
            onPurchaseCompleted: { [weak self] result in
                self?.onPurchaseCompleted(["result": RovenueModule.dtoFromPurchaseResult(result)])
            },
            onPurchaseFailed: { [weak self] error in
                // RovenueCodedError takes a RovenueError only, and exposes
                // the envelope as `reason` (Exception's property), not
                // `message`. Anything else crosses as a plain code+message,
                // which mapNativeError handles: it only unpacks a payload
                // when the "@rovenue/err1:" prefix is present.
                if let rovenueError = error as? RovenueError {
                    let coded = RovenueCodedError(rovenueError)
                    self?.onPurchaseFailed(["code": coded.code, "message": coded.reason])
                } else {
                    self?.onPurchaseFailed([
                        "code": UNMAPPED_ERROR_CODE,
                        "message": error.localizedDescription,
                    ])
                }
            },
            onClose: { [weak self] in self?.onCloseRequested([:]) },
            onRestore: hasRestoreHandler ? { [weak self] in self?.onRestoreRequested([:]) } : nil,
            onUrl: hasUrlHandler ? { [weak self] url in
                self?.onUrlRequested(["url": url.absoluteString])
            } : nil
        )

        // Same paywall, cosmetic change only: push the new content into the
        // EXISTING controller. Recreating it would reset the SwiftUI view's
        // @State — didLogShow and selectedPackageId — which re-fires
        // logPaywallShown and drops the user's package selection.
        if let host, hostKey == resolvedKey {
            host.rootView = AnyView(content)
            attach(host, to: parent)
            return
        }

        // A different paywall: a fresh impression is correct here.
        destroyHost()
        let controller = UIHostingController(rootView: AnyView(content))
        hostKey = resolvedKey
        attach(controller, to: parent)
        host = controller
    }
}
```

`KEY_SEPARATOR` is the separator for the resolve key. Declare it beside
`UNMAPPED_ERROR_CODE` at the top of the file:

```swift
/// Separates placement from locale in the resolve key. A character that
/// cannot occur in either, so two different pairs cannot collide.
private let KEY_SEPARATOR = "\u{0000}"
```

If `RovenueError` has no `.unknown(String)` case, use whichever case the existing `RovenueCodedError` initialiser accepts for an unmapped error — grep `RovenueCodedError` in `ios/RovenueModule.swift` and follow what `AsyncFunction("purchase")` already does at line 261.

- [ ] **Step 2: Register the view on the module**

In `packages/sdk-rn/ios/RovenueModule.swift`, inside `definition()`, immediately after the `Function("getAppVersion")` block, add:

```swift
        // The React Native paywall renders through the SwiftUI view rather
        // than a JS component tree — see the 2026-07-25 bridge design.
        View(RovenuePaywallExpoView.self) {
            Events(
                "onPurchaseCompleted",
                "onPurchaseFailed",
                "onCloseRequested",
                "onRestoreRequested",
                "onUrlRequested"
            )
            Prop("placementIdentifier") { (view: RovenuePaywallExpoView, value: String?) in
                view.placementIdentifier = value
            }
            Prop("locale") { (view: RovenuePaywallExpoView, value: String?) in
                view.locale = value
            }
            Prop("colorSchemeOverride") { (view: RovenuePaywallExpoView, value: String?) in
                view.colorSchemeOverride = value
            }
            Prop("hasRestoreHandler") { (view: RovenuePaywallExpoView, value: Bool) in
                view.hasRestoreHandler = value
            }
            Prop("hasUrlHandler") { (view: RovenuePaywallExpoView, value: Bool) in
                view.hasUrlHandler = value
            }
            // The architecture-agnostic "props batch settled" hook. Expo
            // wires it into both ComponentData (old architecture) and
            // ExpoFabricView.viewDidUpdateProps (Fabric), which is why the
            // view must NOT override didSetProps — that exists only on the
            // old architecture and would not compile under Fabric.
            OnViewDidUpdateProps { (view: RovenuePaywallExpoView) in
                view.onViewDidUpdateProps()
            }
        }
```

- [ ] **Step 3: Make the purchase-result conversion reachable**

`RovenuePaywallExpoView` calls `RovenueModule.dtoFromPurchaseResult(result)`. Find that declaration in `ios/RovenueModule.swift` (it is used at line 260). If it is declared `private static func`, change `private` to `internal` — no other edit. If it is already `internal` or `static` without an access modifier, change nothing.

- [ ] **Step 4: Verify what can be verified**

Run: `cd packages/sdk-rn && npx tsc --noEmit -p tsconfig.json`
Expected: clean — this task adds no TypeScript, so this only confirms nothing was broken by accident.

There is **no Swift build gate for this file** in this repo: `packages/sdk-rn/ios` is compiled only inside a host app's Xcode build. Do not run `swift test` in `packages/sdk-swift` and present it as coverage of this file — it does not compile `sdk-rn/ios` at all.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-rn/ios/RovenuePaywallExpoView.swift packages/sdk-rn/ios/RovenueModule.swift
git commit -m "feat(sdk-rn): host the SwiftUI paywall in an Expo view on iOS"
```

In the commit body and your report, state: *the Swift half was not compiled or run — this environment has no React Native native toolchain.*

---

### Task 2: Android Expo view

**Files:**
- Create: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenuePaywallExpoView.kt`
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt` — add the `View(...)` definition and widen `dtoFromPurchaseResult`

**Interfaces:**
- Consumes: `Rovenue.shared.getPaywall(placementId: String, locale: String?): Paywall?` — a **suspend** function (`sdk-kotlin/.../Rovenue.kt:582`); `RovenuePaywallView(context)` + `bind(paywall, PaywallViewOptions(...))` (`sdk-kotlin/.../paywallui/RovenuePaywallView.kt:58,91`); `PaywallViewOptions(locale, darkMode, onPurchaseCompleted, onPurchaseFailed, onClose, onRestore, onUrl)`
- Produces: the same five props and five events as Task 1, so the JS wrapper is written once for both platforms

> **This task cannot be compiled or run in this environment.** Write it carefully, then say so in your report.

- [ ] **Step 1: Create the view**

Create `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenuePaywallExpoView.kt`:

```kotlin
package dev.rovenue.sdkrn

import android.content.Context
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import dev.rovenue.sdk.Paywall
import dev.rovenue.sdk.Rovenue
import dev.rovenue.sdk.paywallui.PaywallViewOptions
import dev.rovenue.sdk.paywallui.RovenuePaywallView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Hosts the Android [RovenuePaywallView] inside a React Native view tree.
 *
 * Three things here are load-bearing and easy to lose in a refactor:
 *
 *  1. React Native does not lay out a view outside its own shadow tree.
 *     [shouldUseAndroidLayout] is ExpoView's supported answer: it makes
 *     `requestLayout` force a measure+layout pass. Do NOT hand-roll that
 *     — ExpoView.requestLayout already posts its own measureAndLayout(),
 *     and duplicating it would be dead weight that drifts.
 *  2. [ExpoView] extends `LinearLayout`, so a child added without explicit
 *     LayoutParams gets `wrap_content` and the paywall sizes to its content
 *     instead of filling. Hence MATCH_PARENT below.
 *  3. Props arrive one at a time; the reload is deferred to
 *     [onViewDidUpdateProps] so one mount triggers one paywall fetch.
 *
 * Note the asymmetry with the iOS bridge: that one has to work hard to
 * preserve the hosted view's state, because SwiftUI `@State` is scoped to
 * the UIHostingController instance. Here [RovenuePaywallView.bind] is
 * already idempotent by content key — it resets `didLogShow` and
 * `selectedPackageId` only when the content actually changes — so keeping
 * ONE long-lived [inner] instance is all that is required.
 */
class RovenuePaywallExpoView(context: Context, appContext: AppContext) :
    ExpoView(context, appContext) {

    override val shouldUseAndroidLayout: Boolean = true

    // Native event names are deliberately NOT the JS callback names
    // (`onClose` etc.) — the JS wrapper owns those.
    // `EventDispatcher` is a View extension function with both a
    // reified-generic and a Map overload, so a bare `EventDispatcher()`
    // is ambiguous — the type argument is required.
    private val onPurchaseCompleted by EventDispatcher<Map<String, Any>>()
    private val onPurchaseFailed by EventDispatcher<Map<String, Any>>()
    private val onCloseRequested by EventDispatcher<Map<String, Any>>()
    private val onRestoreRequested by EventDispatcher<Map<String, Any>>()
    private val onUrlRequested by EventDispatcher<Map<String, Any>>()

    var placementIdentifier: String? = null
    var locale: String? = null
    var colorSchemeOverride: String? = null
    var hasRestoreHandler: Boolean = false
    var hasUrlHandler: Boolean = false

    // ONE instance for this view's lifetime. bind() is idempotent by
    // content key, so re-binding the same paywall neither re-logs the
    // impression nor drops the user's package selection.
    private val inner = RovenuePaywallView(context)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var loadJob: Job? = null
    private var cachedPaywall: Paywall? = null
    /** The (placement, locale) pair [cachedPaywall] was fetched for. Only a
     *  change to this re-fetches; cosmetic props re-bind from cache. */
    private var resolvedKey: String? = null

    init {
        // ExpoView is a LinearLayout: without explicit params the child
        // would be wrap_content and the paywall would not fill the frame.
        addView(inner, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    fun onViewDidUpdateProps() {
        reload()
    }

    private fun reload() {
        val placement = placementIdentifier
        if (placement.isNullOrEmpty()) {
            loadJob?.cancel()
            cachedPaywall = null
            resolvedKey = null
            // RovenuePaywallView has no unbind(), so hiding is how we match
            // the iOS bridge's mount(nil), which removes the hosted view.
            // Without this the last paywall stays on screen after the host
            // clears the placement.
            inner.visibility = View.GONE
            return
        }
        val key = placement + KEY_SEPARATOR + (locale ?: "")
        // Toggling colorSchemeOverride or a handler flag must not cost a
        // network round-trip. Re-binding from cache is safe: bind() is
        // idempotent by content key.
        //
        // This holds only while the last resolve SUCCEEDED. A failed resolve
        // clears the key deliberately, so the next prop update — cosmetic or
        // not — retries the fetch. That is the price of not being stuck
        // blank, and it stops as soon as a resolve succeeds.
        if (key == resolvedKey) {
            cachedPaywall?.let { inner.bind(it, options()) }
            return
        }
        loadJob?.cancel()
        resolvedKey = key
        loadJob = scope.launch {
            // A resolution failure renders nothing, matching what the
            // Android view already does with a null config. Surfacing it
            // would need a new prop, which the props contract forbids.
            val paywall = runCatching { Rovenue.shared.getPaywall(placement, locale) }
                .getOrNull()
            if (resolvedKey != key) return@launch
            if (paywall == null) {
                // Same reason as the iOS bridge: a failed resolve must not
                // stay marked resolved, or the cache-hit path returns
                // nothing forever and the view is permanently blank.
                resolvedKey = null
                // It must also not leave the PREVIOUS placement's paywall on
                // screen. Switch from a placement that resolved to one that
                // fails, and without these two lines the old paywall stays
                // up indefinitely. iOS mounts nil unconditionally here; this
                // is the equivalent.
                cachedPaywall = null
                inner.visibility = View.GONE
                return@launch
            }
            cachedPaywall = paywall
            inner.visibility = View.VISIBLE
            inner.bind(paywall, options())
        }
    }

    private fun options(): PaywallViewOptions = PaywallViewOptions(
        locale = locale,
        darkMode = when (colorSchemeOverride) {
            "light" -> false
            "dark" -> true
            else -> null
        },
        onPurchaseCompleted = { result ->
            onPurchaseCompleted(mapOf("result" to dtoFromPurchaseResult(result)))
        },
        onPurchaseFailed = { error ->
            val coded = codedError(error)
            onPurchaseFailed(mapOf("code" to coded.code, "message" to coded.message))
        },
        onClose = { onCloseRequested(emptyMap()) },
        // A null handler is what makes the native view HIDE restore
        // affordances / leave url buttons inert — so absence must survive
        // the crossing, not become a no-op lambda.
        onRestore = if (hasRestoreHandler) ({ onRestoreRequested(emptyMap()) }) else null,
        onUrl = if (hasUrlHandler) ({ url -> onUrlRequested(mapOf("url" to url)) }) else null,
    )

    /// Called from `OnViewDestroys`. Deliberately NOT `onDetachedFromWindow`:
    /// React Native recycles views, so a transient detach during a
    /// navigation transition would cancel an in-flight fetch and leave the
    /// paywall blank with nothing to retrigger it. The iOS bridge cancels
    /// only in `deinit` for the same reason.
    fun onViewDestroys() {
        scope.cancel()
    }
}
```

Declare the resolve-key separator as a top-level `private const` in the same
file — the same value and rationale as the iOS view:

```kotlin
/** Separates placement from locale in the resolve key. A character that
 *  cannot occur in either, so two different pairs cannot collide. */
private const val KEY_SEPARATOR = "\u0000"
```

There is deliberately **no** `onLayout`, `requestLayout` or `measureAndLayout`
override: `shouldUseAndroidLayout = true` makes `ExpoView.requestLayout`
post its own `measureAndLayout()`, so writing those here would duplicate
framework code verbatim.

`codedError(...)` and `dtoFromPurchaseResult(...)` currently live on `RovenueModule` — see Step 3.

- [ ] **Step 2: Register the view on the module**

In `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt`, inside `definition()`, immediately after the `Function("getAppVersion")` block, add:

```kotlin
        // The React Native paywall renders through the Android view rather
        // than a JS component tree — see the 2026-07-25 bridge design.
        View(RovenuePaywallExpoView::class) {
            Events(
                "onPurchaseCompleted",
                "onPurchaseFailed",
                "onCloseRequested",
                "onRestoreRequested",
                "onUrlRequested",
            )
            Prop("placementIdentifier") { view: RovenuePaywallExpoView, value: String? ->
                view.placementIdentifier = value
            }
            Prop("locale") { view: RovenuePaywallExpoView, value: String? ->
                view.locale = value
            }
            Prop("colorSchemeOverride") { view: RovenuePaywallExpoView, value: String? ->
                view.colorSchemeOverride = value
            }
            Prop("hasRestoreHandler") { view: RovenuePaywallExpoView, value: Boolean ->
                view.hasRestoreHandler = value
            }
            Prop("hasUrlHandler") { view: RovenuePaywallExpoView, value: Boolean ->
                view.hasUrlHandler = value
            }
            OnViewDidUpdateProps { view: RovenuePaywallExpoView ->
                view.onViewDidUpdateProps()
            }
            // "Really gone", as opposed to onDetachedFromWindow, which also
            // fires on the transient detaches React Native does when it
            // recycles a view.
            OnViewDestroys { view: RovenuePaywallExpoView ->
                view.onViewDestroys()
            }
        }
```

- [ ] **Step 3: Make the two helpers reachable from the view**

In the same file, `dtoFromPurchaseResult` is declared at line 557 as `private fun` and `codedError` is also private. Both are now needed by `RovenuePaywallExpoView`, which is a different class in the same package.

Move both out of the `RovenueModule` class body to **top-level `internal fun` declarations in the same file**, changing only the modifier and the indentation — no logic edits. Update `RovenueModule`'s own call sites if the compiler requires it (it should not: same package, same file).

- [ ] **Step 4: Verify what can be verified**

Run: `cd packages/sdk-rn && npx tsc --noEmit -p tsconfig.json`
Expected: clean — no TypeScript changed; this only confirms nothing broke.

There is **no Gradle build gate for this directory** in this repo: `packages/sdk-rn/android` compiles only inside a host app's Gradle build. `packages/sdk-kotlin`'s `testDebugUnitTest` does **not** compile it — do not present that suite as coverage of this file.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenuePaywallExpoView.kt packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt
git commit -m "feat(sdk-rn): host the Android paywall view in an Expo view"
```

In the commit body and your report, state: *the Kotlin half was not compiled or run — this environment has no React Native native toolchain.*

---

### Task 3: JS bridge — swap the component, keep the props

**Files:**
- Create: `packages/sdk-rn/src/paywall-view/native-view.ts`
- Create: `packages/sdk-rn/src/paywall-view/RovenuePaywallView.tsx`
- Create: `packages/sdk-rn/src/paywall-view/index.ts`
- Create: `packages/sdk-rn/src/paywall-view/__tests__/bridge.test.tsx`
- Modify: `packages/sdk-rn/src/__tests__/_stubExpoModules.ts` — add `requireNativeViewManager`
- Modify: `packages/sdk-rn/src/index.ts:137-143` — export `RovenuePaywallView` from the new path

**Interfaces:**
- Consumes: the five props and five events produced by Tasks 1 and 2; `mapNativeError(code, message, extras?)` from `../errors`; `Paywall` and `PurchaseResult` from `../types`
- Produces: `RovenuePaywallView` and `RovenuePaywallViewProps` at the same import path as today

> **This task IS verifiable here.** It must end with a green `npx vitest run`.

- [ ] **Step 1: Add `requireNativeViewManager` to the test stub**

In `packages/sdk-rn/src/__tests__/_stubExpoModules.ts`, append:

```ts
// Records what the native view was rendered with, so bridge tests can
// assert on prop marshalling without a native runtime. Each call returns
// a fresh component so tests cannot leak state into one another.
export const __nativeViewRenders: Array<Record<string, unknown>> = [];

export function requireNativeViewManager<P>(
  _moduleName: string,
  _viewName?: string,
): (props: P) => null {
  return (props: P) => {
    __nativeViewRenders.push(props as Record<string, unknown>);
    return null;
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/sdk-rn/src/paywall-view/__tests__/bridge.test.tsx`:

```tsx
// @vitest-environment happy-dom
//
// Same gate style as the renderer test this replaces: react-native is
// aliased to _stubReactNative and expo-modules-core to _stubExpoModules,
// so @testing-library/react drives the real wrapper and the stub records
// exactly what the native view was handed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { __nativeViewRenders } from "../../__tests__/_stubExpoModules";
import { RovenuePaywallView } from "../RovenuePaywallView";
import { NATIVE_ERROR_ENVELOPE_PREFIX } from "../../errors";
import type { Paywall } from "../../types";

const PAYWALL: Paywall = {
  placementIdentifier: "onboarding",
  placementRevision: 3,
  paywallIdentifier: "pw_1",
  paywallName: "Onboarding",
  configFormatVersion: 2,
  remoteConfig: null,
  remoteConfigLocale: null,
  builderConfig: { formatVersion: 2 },
  offering: null,
  presentedContext: null,
  servedFromFallback: false,
};

function lastProps(): Record<string, any> {
  return __nativeViewRenders[__nativeViewRenders.length - 1]!;
}

describe("RovenuePaywallView bridges to the native view", () => {
  beforeEach(() => {
    cleanup();
    __nativeViewRenders.length = 0;
  });

  it("sends the placement identifier, not the whole paywall", () => {
    render(<RovenuePaywallView paywall={PAYWALL} />);
    expect(lastProps().placementIdentifier).toBe("onboarding");
    expect(lastProps().paywall).toBeUndefined();
  });

  it("forwards locale and colour scheme under their native names", () => {
    render(<RovenuePaywallView paywall={PAYWALL} locale="tr" colorScheme="dark" />);
    expect(lastProps().locale).toBe("tr");
    expect(lastProps().colorSchemeOverride).toBe("dark");
  });

  // The native views HIDE restore affordances when their handler is null,
  // so absence has to survive the crossing as a value the bridge can read.
  it("reports whether restore and url handlers exist", () => {
    render(<RovenuePaywallView paywall={PAYWALL} />);
    expect(lastProps().hasRestoreHandler).toBe(false);
    expect(lastProps().hasUrlHandler).toBe(false);

    render(<RovenuePaywallView paywall={PAYWALL} onRestore={() => {}} onUrl={() => {}} />);
    expect(lastProps().hasRestoreHandler).toBe(true);
    expect(lastProps().hasUrlHandler).toBe(true);
  });

  it("maps the five native events onto the callback props", () => {
    const onPurchaseCompleted = vi.fn();
    const onClose = vi.fn();
    const onRestore = vi.fn();
    const onUrl = vi.fn();
    render(
      <RovenuePaywallView
        paywall={PAYWALL}
        onPurchaseCompleted={onPurchaseCompleted}
        onClose={onClose}
        onRestore={onRestore}
        onUrl={onUrl}
      />,
    );
    const p = lastProps();
    p.onPurchaseCompleted({ nativeEvent: { result: { productId: "pro" } } });
    p.onCloseRequested({ nativeEvent: {} });
    p.onRestoreRequested({ nativeEvent: {} });
    p.onUrlRequested({ nativeEvent: { url: "https://example.com/terms" } });

    expect(onPurchaseCompleted).toHaveBeenCalledWith({ productId: "pro" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onRestore).toHaveBeenCalledOnce();
    expect(onUrl).toHaveBeenCalledWith("https://example.com/terms");
  });

  // Only code+message survive the JSI crossing, so the structured extras
  // ride inside message as a JSON envelope and are unpacked here.
  it("unpacks the native error envelope for onPurchaseFailed", () => {
    const onPurchaseFailed = vi.fn();
    render(<RovenuePaywallView paywall={PAYWALL} onPurchaseFailed={onPurchaseFailed} />);
    lastProps().onPurchaseFailed({
      nativeEvent: {
        code: "NetworkError",
        message: NATIVE_ERROR_ENVELOPE_PREFIX + JSON.stringify({ message: "offline", retryable: true }),
      },
    });
    const err = onPurchaseFailed.mock.calls[0]![0] as { message: string; isRetryable: boolean };
    expect(err.message).toBe("offline");
    // The class field is `isRetryable`; `retryable` is the ENVELOPE key.
    // Asserting the envelope key here would pass vacuously against undefined.
    expect(err.isRetryable).toBe(true);
  });

  it("does not throw when optional callbacks are omitted", () => {
    render(<RovenuePaywallView paywall={PAYWALL} />);
    const p = lastProps();
    expect(() => p.onCloseRequested({ nativeEvent: {} })).not.toThrow();
    expect(() => p.onUrlRequested({ nativeEvent: { url: "https://x" } })).not.toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/sdk-rn && npx vitest run src/paywall-view`
Expected: FAIL — `Cannot find module '../RovenuePaywallView'`.

`@testing-library/react` is already a devDependency here and is what every other component test in this package uses. Do not add `react-test-renderer` — it is not installed.

- [ ] **Step 4: Write the native-view binding**

Create `packages/sdk-rn/src/paywall-view/native-view.ts`:

```ts
// `requireNativeViewManager` — NOT `requireNativeView`, which does not
// exist in expo-modules-core 2.5.0. This is the only view accessor the
// package exports (build/index.d.ts:11) and it is documented as a drop-in
// replacement for RN's `requireNativeComponent`, which is why events
// arrive wrapped in `nativeEvent`.
import { requireNativeViewManager } from "expo-modules-core";

/** Wire props for the native paywall view. Deliberately narrower than
 *  `RovenuePaywallViewProps`: the paywall itself does not cross the
 *  bridge, only the identifier the native side re-resolves it with. */
export type NativePaywallViewProps = {
  placementIdentifier: string;
  locale?: string;
  colorSchemeOverride?: "light" | "dark";
  hasRestoreHandler: boolean;
  hasUrlHandler: boolean;
  onPurchaseCompleted: (event: { nativeEvent: { result: unknown } }) => void;
  onPurchaseFailed: (event: { nativeEvent: { code: string; message: string } }) => void;
  onCloseRequested: (event: { nativeEvent: Record<string, never> }) => void;
  onRestoreRequested: (event: { nativeEvent: Record<string, never> }) => void;
  onUrlRequested: (event: { nativeEvent: { url: string } }) => void;
  style?: unknown;
};

const MODULE_NAME = "Rovenue";

// No view name: both native modules register the paywall as the module's
// single default view (`View(RovenuePaywallExpoView.self) { … }` with no
// name argument), so the manager is looked up by module name alone.
export const NativePaywallView =
  requireNativeViewManager<NativePaywallViewProps>(MODULE_NAME);
```

- [ ] **Step 5: Write the component**

Create `packages/sdk-rn/src/paywall-view/RovenuePaywallView.tsx`:

```tsx
import { StyleSheet } from "react-native";
import { mapNativeError } from "../errors";
import type { Paywall, PurchaseResult } from "../types";
import { NativePaywallView } from "./native-view";

// The paywall fills whatever frame the host gives it; hosts size it with
// their own flex container. There is deliberately no `style` prop — the
// public props contract is preserved byte-for-byte from the JS renderer
// this replaced.
const styles = StyleSheet.create({ fill: { flex: 1 } });

export type RovenuePaywallViewProps = {
  paywall: Paywall;
  locale?: string;
  colorScheme?: "light" | "dark";
  onPurchaseCompleted?: (result: PurchaseResult) => void;
  onPurchaseFailed?: (error: unknown) => void;
  onClose?: () => void;
  /** Omit to HIDE restore buttons entirely (e.g. funnel-like contexts). */
  onRestore?: () => void;
  /** The renderer never navigates itself — scheme-check before opening. */
  onUrl?: (url: string) => void;
};

export function RovenuePaywallView(props: RovenuePaywallViewProps) {
  const { paywall, locale, colorScheme, onPurchaseCompleted, onPurchaseFailed, onClose, onRestore, onUrl } = props;
  return (
    <NativePaywallView
      style={styles.fill}
      placementIdentifier={paywall.placementIdentifier}
      locale={locale}
      colorSchemeOverride={colorScheme}
      // The native views branch on whether a handler EXISTS, so this is a
      // value, not a convenience flag.
      hasRestoreHandler={onRestore !== undefined}
      hasUrlHandler={onUrl !== undefined}
      onPurchaseCompleted={(e) => onPurchaseCompleted?.(e.nativeEvent.result as PurchaseResult)}
      onPurchaseFailed={(e) => onPurchaseFailed?.(mapNativeError(e.nativeEvent.code, e.nativeEvent.message))}
      onCloseRequested={() => onClose?.()}
      onRestoreRequested={() => onRestore?.()}
      onUrlRequested={(e) => onUrl?.(e.nativeEvent.url)}
    />
  );
}
```

Create `packages/sdk-rn/src/paywall-view/index.ts`:

```ts
export { RovenuePaywallView, type RovenuePaywallViewProps } from "./RovenuePaywallView";
```

- [ ] **Step 6: Point the package export at the new path**

In `packages/sdk-rn/src/index.ts`, replace the export block at lines 137-143 with:

```ts
export {
  RovenuePaywallView,
  type RovenuePaywallViewProps,
  decodeBuilderConfig,
  type BuilderConfigModel,
  type BuilderNode,
} from "./paywall-ui";
```
→
```ts
// The paywall renders through the platform's native view, not a JS
// component tree — see the 2026-07-25 bridge design. `decodeBuilderConfig`
// and friends stay exported from ./paywall-ui until that directory is
// retired, so this commit changes rendering only.
export { RovenuePaywallView, type RovenuePaywallViewProps } from "./paywall-view";
export { decodeBuilderConfig, type BuilderConfigModel, type BuilderNode } from "./paywall-ui";
```

This keeps Task 3 a rendering-only change: no public export disappears here. Removal happens in Task 5, after the smoke session.

- [ ] **Step 7: Run the tests**

Run: `cd packages/sdk-rn && npx vitest run`
Expected: PASS — the six new tests plus every pre-existing test. The old `paywall-ui` tests still pass; that directory is still present.

Then run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 8: Prove the tests are not self-confirming**

Temporarily change `hasRestoreHandler={onRestore !== undefined}` to `hasRestoreHandler={true}` and re-run `npx vitest run src/paywall-view`.
Expected: the "reports whether restore and url handlers exist" test FAILS.

Then temporarily change `onUrlRequested={(e) => onUrl?.(e.nativeEvent.url)}` to `onUrlRequested={() => onUrl?.("")}` and re-run.
Expected: the event-mapping test FAILS.

Restore both, re-run, confirm green. Report both mutation results.

- [ ] **Step 9: Commit**

```bash
git add packages/sdk-rn/src/paywall-view packages/sdk-rn/src/index.ts packages/sdk-rn/src/__tests__/_stubExpoModules.ts
git commit -m "feat(sdk-rn): render the paywall through the native view"
```

---

### Task 4: Device smoke session

**Files:** none — this task produces a written result, not code.

**Interfaces:**
- Consumes: everything from Tasks 1–3
- Produces: a pass/fail record that Task 5 depends on

> **This task cannot be performed by an agent in this environment.** It requires a physical device or simulator running a host app built from this SDK. If you are an agent executing this plan, **stop here** and hand back to the human with the checklist below. Do not skip to Task 5.

- [ ] **Step 1: Build a host app against the local SDK**

Use the existing Expo config-plugin path documented in `apps/docs/content/docs/getting-started/installation.mdx`: add the plugin, then `npx expo prebuild`, then run on each platform. Expo Go will not work — this SDK declares custom native modules.

- [ ] **Step 2: Run the checklist on iOS and again on Android**

Record pass/fail for each, on each platform:

1. The paywall appears and fills its container (not zero-height, not clipped).
2. Scrolling works through the full content.
3. Rotating the device re-lays-out the paywall correctly — **this is the single most likely failure on Android**, where React Native does not measure views it did not create.
4. Content respects the safe area: nothing is hidden under the notch, the status bar, or the home indicator. `UIHostingController` inside a React Native hierarchy is the risk the spec names in §9, and the containment wiring in Task 1 is what makes trait and safe-area propagation work at all.
   Also check, on iOS, the two triggers that reset hosted SwiftUI state — both are reasoned from source but neither can be confirmed without a device:
   - Changing only `colorScheme` (not the placement) must NOT re-fire `paywall_view` and must NOT reset the selected package. The view reuses its `UIHostingController` and updates `rootView` in place for exactly this.
   - Navigating away and back, so the React Native view is recycled, must also NOT re-fire `paywall_view`. The view detaches from its parent controller without destroying it for exactly this.
   - By contrast, pointing the view at a **different placement** SHOULD produce a fresh `paywall_view`. Confirm that still happens.
5. Tapping a purchase button reaches the store sheet, and completing it fires `onPurchaseCompleted` with a result object.
6. A failed or cancelled purchase fires `onPurchaseFailed` with a readable `message` — not the raw `@rovenue/err1:` string.
7. The close affordance fires `onClose`.
8. With `onRestore` supplied, a restore button is visible and fires it; **with `onRestore` omitted, no restore button is rendered at all**.
9. With `onUrl` supplied, a url-action button fires it with the right URL; with `onUrl` omitted, the button renders but does nothing.
10. `colorScheme="dark"` and `colorScheme="light"` both take effect; omitting it follows the system.
11. Backgrounding and returning does not blank the paywall or double-fire `paywall_view`.

- [ ] **Step 3: Record the outcome**

Append the results to `.superpowers/sdd/progress.md` under a `RN BRIDGE SMOKE` heading, one line per checklist item per platform. If any item fails, fix it and re-run the whole checklist — do not proceed to Task 5 on a partial pass.

---

### Task 5: Retire the JS renderer

**Files:**
- Delete: `packages/sdk-rn/src/paywall-ui/` (all 12 files)
- Modify: `packages/sdk-rn/src/index.ts` — drop the three remaining `paywall-ui` exports
- Modify: `packages/shared/src/paywall/render-fixtures.json` — update `_comment` to say three platforms
- Modify: `packages/sdk-rn/package.json` — major version bump
- Modify: `apps/docs/content/docs/platforms/react-native.mdx` — note that the paywall renders natively

**Interfaces:**
- Consumes: a passing Task 4
- Produces: nothing new — this task only removes

> **Do not start this task until Task 4 has recorded a pass on both platforms.**

- [ ] **Step 1: Confirm the gate**

Run: `grep -n "RN BRIDGE SMOKE" -A 30 .superpowers/sdd/progress.md`
Expected: a recorded pass for both iOS and Android. If it is absent or shows a failure, **stop and report BLOCKED** — do not delete.

- [ ] **Step 2: Delete the directory and the exports**

```bash
git rm -r packages/sdk-rn/src/paywall-ui
```

In `packages/sdk-rn/src/index.ts`, remove the line added in Task 3 Step 6:

```ts
export { decodeBuilderConfig, type BuilderConfigModel, type BuilderNode } from "./paywall-ui";
```

Leave the `./paywall-view` export untouched.

- [ ] **Step 3: Reduce the fixtures contract to three platforms**

In `packages/shared/src/paywall/render-fixtures.json`, edit the `_comment` field: replace every mention of four platforms / React Native as a decoder with three (web, Swift, Kotlin), and add: `"React Native renders through the native views as of 2026-07-25 and is no longer an independent decoder."`

Change nothing else in that file — the vectors themselves still bind the three remaining renderers.

- [ ] **Step 4: Run everything that touches the removal**

```bash
cd packages/sdk-rn && npx vitest run && npx tsc --noEmit -p tsconfig.json
cd ../shared && npx vitest run
cd ../paywall-renderer && npx vitest run
```

Expected: all green. The RN suite drops by the six deleted test files; the shared and renderer suites are unchanged in count — if `shared` changes count, you edited more than `_comment`.

- [ ] **Step 5: Bump and document**

In `packages/sdk-rn/package.json`, bump the major version (removing three public exports is breaking).

In `apps/docs/content/docs/platforms/react-native.mdx`, add a short section stating that `RovenuePaywallView` renders through the platform's native paywall view, that its props are unchanged, and that `decodeBuilderConfig` / `BuilderConfigModel` / `BuilderNode` are no longer exported.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-rn/src packages/sdk-rn/package.json packages/shared/src/paywall/render-fixtures.json apps/docs/content/docs/platforms/react-native.mdx
git commit -m "refactor(sdk-rn)!: retire the JS paywall renderer"
```

State in the commit body which exports were removed and that the device smoke session passed on both platforms before the deletion.

---

## Notes for the executor

- Tasks 1 and 2 are independent of each other. Task 3 depends on both only for its *runtime* behaviour, not its tests — its tests run against the stub, so it can be implemented and verified regardless.
- If a reviewer asks for a test gate on Tasks 1 or 2, the honest answer is that this repo has none: `packages/sdk-rn/ios` and `packages/sdk-rn/android` are compiled only inside a host app. That is a real gap, and Task 4 is the mitigation.
- P4b (paywall node types wave 1) resumes after this plan lands. Its settled decisions are recorded in §10 of the spec.
