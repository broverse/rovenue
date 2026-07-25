import ExpoModulesCore
import SwiftUI
import Rovenue

/// Code sent for an error that is not a `RovenueError`; `mapNativeError`
/// normalises an unrecognised kind on the JS side.
private let UNMAPPED_ERROR_CODE = "Unknown"

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

    required init(appContext: AppContext? = nil) {
        super.init(appContext: appContext)
        clipsToBounds = true
    }

    override func didSetProps(_ changedProps: [String]) {
        reload()
    }

    deinit {
        loadTask?.cancel()
    }

    private func reload() {
        loadTask?.cancel()
        guard let placementIdentifier, !placementIdentifier.isEmpty else {
            mount(nil)
            return
        }
        let requestedLocale = locale
        loadTask = Task { [weak self] in
            // A resolution failure renders nothing, matching what the
            // SwiftUI view already does when its decoded config is nil.
            // Adding an error prop here would break the byte-for-byte
            // props contract, so the failure is logged, not surfaced.
            let paywall = try? await Rovenue.shared.getPaywall(
                placementId: placementIdentifier,
                locale: requestedLocale
            )
            guard !Task.isCancelled else { return }
            await MainActor.run { self?.mount(paywall) }
        }
    }

    private func scheme() -> ColorScheme? {
        switch colorSchemeOverride {
        case "light": return .light
        case "dark":  return .dark
        default:      return nil
        }
    }

    private func mount(_ paywall: Paywall?) {
        host?.view.removeFromSuperview()
        host?.removeFromParent()
        host = nil
        guard let paywall else { return }

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

        let controller = UIHostingController(rootView: AnyView(content))
        controller.view.backgroundColor = .clear
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(controller.view)
        NSLayoutConstraint.activate([
            controller.view.leadingAnchor.constraint(equalTo: leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: trailingAnchor),
            controller.view.topAnchor.constraint(equalTo: topAnchor),
            controller.view.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        host = controller
    }
}
