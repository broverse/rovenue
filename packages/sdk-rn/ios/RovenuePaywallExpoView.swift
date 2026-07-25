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
/// `didSetProps` — otherwise setting five props would start five paywall
/// fetches for one mount.
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
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            detachHost()
        } else {
            mount(cachedPaywall)
        }
    }

    private func detachHost() {
        guard let host else { return }
        host.willMove(toParent: nil)
        host.view.removeFromSuperview()
        host.removeFromParent()
        self.host = nil
    }

    private func mount(_ paywall: Paywall?) {
        detachHost()
        guard let paywall, window != nil, let parent = reactViewController() else { return }

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

        // The full containment dance, in the order Expo's own
        // SwiftUIHostingView uses. Without addChild/didMove the hosted
        // SwiftUI tree loses appearance callbacks and, critically here,
        // safe-area and trait propagation — the paywall would draw under
        // the notch and the home indicator.
        let controller = UIHostingController(rootView: AnyView(content))
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
        host = controller
    }
}
