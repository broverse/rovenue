import ExpoModulesCore
import SwiftUI
import Rovenue

/// Code sent for an error that is not a `RovenueError`; `mapNativeError`
/// normalises an unrecognised kind on the JS side.
private let UNMAPPED_ERROR_CODE = "Unknown"

/// Separates placement from locale in the resolve key. A character that
/// cannot occur in either, so two different pairs cannot collide.
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
                // A failed resolve must NOT leave the key marked resolved. The fast
                // path above would then mount nil on every later prop update, so the
                // paywall would stay blank forever unless the placement value itself
                // changed.
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
