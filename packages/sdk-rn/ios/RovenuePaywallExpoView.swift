import ExpoModulesCore
import SwiftUI
import Rovenue

/// Code sent for an error that is not a `RovenueError`; `mapNativeError`
/// normalises an unrecognised kind on the JS side.
private let UNMAPPED_ERROR_CODE = "Unknown"

/// Separates the two halves of both the resolve key (placement + locale) and
/// the content key (paywall identifier + builder config JSON). A character
/// that cannot occur in either half of either pair, so two different pairs
/// cannot collide — which is why this is NOT the `"|"` the SwiftUI
/// renderer's own `paywallStateKey` uses. The two strings are built from the
/// same fields but are not interchangeable, and neither is ever compared
/// against the other.
private let KEY_SEPARATOR = "\u{0000}"

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
    /// The paywall CONTENT key (`contentKey(for:)`) the current `host` was
    /// built for — the same key the SwiftUI renderer itself keys impressions
    /// on. When this still matches the paywall about to be mounted, the
    /// controller is reused and only its `rootView` is updated: no fresh
    /// impression, no reset of the SwiftUI view's `@State`.
    private var hostKey: String?
    private var loadTask: Task<Void, Never>?
    private var cachedPaywall: Paywall?
    /// The resolve key (placement + locale) `cachedPaywall` was fetched for.
    private var resolvedKey: String?
    /// The resolve key `cachedPaywall` actually BELONGS to, set only once the
    /// fetch for that key has landed. `resolvedKey` is assigned up front, so
    /// while a fetch for a new key is in flight `resolvedKey == key` can be
    /// true before `cachedPaywall` has been updated to match — this field is
    /// what distinguishes "cache is for this key" from "a fetch for this key
    /// just started."
    private var cachedKey: String?

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
            cachedKey = nil
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
            // `resolvedKey` is assigned before the fetch for it lands (below),
            // so `key == resolvedKey` is also true for the SECOND prop batch
            // that arrives while that fetch is still in flight. Without also
            // checking `cachedKey`, that batch would take this fast path and
            // mount whatever `cachedPaywall` STILL holds — the previous
            // key's content — producing a spurious extra impression of it.
            // A fetch is already running for this key; do nothing and let it
            // land.
            guard cachedKey == key else { return }
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
                // A failed resolve must NOT leave the key marked resolved. The fast
                // path above would then mount nil on every later prop update, so the
                // paywall would stay blank forever unless the placement value itself
                // changed.
                if paywall == nil { self.resolvedKey = nil }
                self.cachedPaywall = paywall
                self.cachedKey = paywall == nil ? nil : key
                self.mount(paywall)
            }
        }
    }

    /// Identity of "which paywall is this" — content, not resolve parameters.
    /// Built from the same two fields as the SwiftUI renderer's own
    /// `paywallStateKey`, though with a different separator; the two are
    /// never compared against each other. Two different (placement, locale) resolves
    /// that land on the byte-identical builder config must NOT be treated as
    /// a different paywall: Android already compares on content, and a
    /// locale-only change re-mounting here would re-fire `logPaywallShown`
    /// for content the user has already seen.
    private func contentKey(for paywall: Paywall) -> String {
        (paywall.paywallIdentifier ?? "") + KEY_SEPARATOR + (paywall.builderConfigJson ?? "")
    }

    private func scheme() -> ColorScheme? {
        switch colorSchemeOverride {
        case "light": return .light
        case "dark":  return .dark
        default:      return nil
        }
    }

    /// Containment has to wait for a window, because that is when
    /// `hostViewController()` can hand us a parent to attach to.
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

    /// Walks the responder chain for the view controller managing this view.
    ///
    /// This replaces React Native's `reactViewController()`, a UIView category
    /// that `ExpoModulesCore` no longer transitively exposes to Swift on
    /// RN 0.86 — the file failed to compile with "cannot find
    /// 'reactViewController' in scope", the single iOS error blocking the first
    /// native build this SDK has ever had. The responder-chain walk is what that
    /// category does, and it depends on nothing but UIKit, so it cannot break
    /// again when React reorganises its headers.
    private func hostViewController() -> UIViewController? {
        var responder: UIResponder? = self
        while let current = responder {
            if let controller = current as? UIViewController { return controller }
            responder = current.next
        }
        return nil
    }

    private func mount(_ paywall: Paywall?) {
        guard let paywall, window != nil, let parent = hostViewController() else {
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

        // Same paywall CONTENT, cosmetic or resolve-parameter change only:
        // push the new content into the EXISTING controller. Recreating it
        // would reset the SwiftUI view's @State — didLogShow and
        // selectedPackageId — which re-fires logPaywallShown and drops the
        // user's package selection. Keying on content (not `resolvedKey`)
        // means a locale-only change that resolves to the byte-identical
        // builder config is also treated as the same paywall here, matching
        // `RovenuePaywallView`'s own `.onChange(of: paywallStateKey)` — that
        // onChange only resets/re-logs when `rootView` is actually swapped
        // to different content, so reusing the controller here is what
        // keeps this view's behavior aligned with it.
        let key = contentKey(for: paywall)
        if let host, hostKey == key {
            host.rootView = AnyView(content)
            attach(host, to: parent)
            return
        }

        // Different paywall content: a fresh impression is correct here.
        destroyHost()
        let controller = UIHostingController(rootView: AnyView(content))
        hostKey = key
        attach(controller, to: parent)
        host = controller
    }
}
