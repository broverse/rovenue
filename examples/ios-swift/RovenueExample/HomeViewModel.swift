// HomeViewModel.swift — drives the demonstrated SDK flow for ContentView.
//
// Every SDK call is wrapped in do/catch and its outcome (success or
// failure) is appended to `log`, so the app is useful to poke at even
// without a live backend — exactly the same "always show something on
// screen" contract the Flutter and RN examples follow.
import Foundation
import Rovenue

@MainActor
final class HomeViewModel: ObservableObject {
    @Published private(set) var configuring = true
    @Published private(set) var currentUser: User?
    @Published private(set) var offerings: Offerings?
    @Published private(set) var entitlements: [Entitlement] = []
    @Published private(set) var log: [String] = []
    @Published var appUserIdInput: String = ""
    @Published var busyLabel: String?

    /// Products to show purchase buttons for — the `current` offering's
    /// packages when the server designates one, otherwise every package
    /// across every offering (mirrors the Flutter example's `_products`).
    var products: [StoreProduct] {
        guard let offerings else { return [] }
        if let current = offerings.current {
            return current.packages.map(\.product)
        }
        return offerings.all.values.flatMap { $0.packages.map(\.product) }
    }

    private var changesTask: Task<Void, Never>?
    private var unsubscribeLog: (() -> Void)?

    deinit {
        changesTask?.cancel()
        unsubscribeLog?()
    }

    func appendLog(_ line: String) {
        log.insert(line, at: 0)
        if log.count > 200 { log.removeLast(log.count - 200) }
    }

    // MARK: - configure

    func bootstrap() async {
        do {
            try Rovenue.configure(apiKey: ExampleConfig.apiKey, baseUrl: ExampleConfig.baseURL, logLevel: .info)
            appendLog("configure() succeeded")
        } catch let e as RovenueError {
            appendLog("configure() failed: RovenueError(\(e.kind)): \(e.message)")
            configuring = false
            return
        } catch {
            appendLog("configure() failed: \(error)")
            configuring = false
            return
        }

        // Now that configure() has run, install the real log handler and
        // start observing change events for the app's lifetime.
        unsubscribeLog = Rovenue.shared.setLogHandler { [weak self] entry in
            Task { @MainActor in self?.appendLog("[\(entry.level)] \(entry.message)") }
        }

        // The SDK's own "go re-fetch" signal (ENTITLEMENTS_CHANGED /
        // IDENTITY_CHANGED / ...), kept alive for the app's lifetime.
        //
        // IMPORTANT — do NOT call `refreshEntitlements()` from this
        // listener: that method hits the network and, on success, emits
        // `.entitlementsChanged` again, which would re-enter this very
        // listener and loop forever (the recorded RN/Kotlin footgun —
        // "refreshX() inside the XCHANGED handler re-emits the event").
        //
        // `entitlementsAll()` below is a *local cache read* — it never
        // touches the network and never emits a change event, so calling
        // it here is safe. This mirrors the Flutter example, which also
        // calls `entitlementsAll()` (not `refreshEntitlements()`) inside its
        // `changes` listener: rovenue_flutter's platform channel forwards
        // that call straight through to this same cache-only Swift method
        // (see rovenue_flutter_ios/ios/Classes/HostApiImpl.swift), so the
        // Flutter example's "refresh on change" is safe for the identical
        // reason this one is.
        changesTask = Task { [weak self] in
            guard let self else { return }
            for await event in Rovenue.shared.changes {
                self.appendLog("onChange: \(event)")
                await self.refreshEntitlementsFromCache()
                if case .identityChanged = event {
                    await self.refreshCurrentUser()
                }
            }
        }

        await refreshCurrentUser()
        await refreshEntitlementsFromCache()
        await loadOfferings()
        configuring = false
    }

    // MARK: - identify

    func identify() async {
        let appUserId = appUserIdInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !appUserId.isEmpty else { return }
        busyLabel = "identify"
        defer { busyLabel = nil }
        do {
            try await Rovenue.shared.identify(appUserId)
            appendLog("identify(\(appUserId)) succeeded")
            await refreshCurrentUser()
        } catch let e as RovenueError {
            appendLog("identify() failed: RovenueError(\(e.kind)): \(e.message)")
        } catch {
            appendLog("identify() failed: \(error)")
        }
    }

    func logOut() async {
        busyLabel = "logOut"
        defer { busyLabel = nil }
        do {
            try await Rovenue.shared.logOut()
            appendLog("logOut() succeeded")
            await refreshCurrentUser()
        } catch let e as RovenueError {
            appendLog("logOut() failed: RovenueError(\(e.kind)): \(e.message)")
        } catch {
            appendLog("logOut() failed: \(error)")
        }
    }

    private func refreshCurrentUser() async {
        currentUser = await Rovenue.shared.currentUser()
    }

    // MARK: - entitlements

    /// Cache-only read — see the long comment in `bootstrap()` on why this
    /// (and not `refreshEntitlements()`) is what the change listener calls.
    private func refreshEntitlementsFromCache() async {
        entitlements = await Rovenue.shared.entitlementsAll()
    }

    /// Explicit, user-initiated network refresh (the "Refresh" button) —
    /// safe to call from a button tap; only the *listener* must avoid it.
    func refreshEntitlementsFromNetwork() async {
        busyLabel = "refreshEntitlements"
        defer { busyLabel = nil }
        do {
            try await Rovenue.shared.refreshEntitlements()
            appendLog("refreshEntitlements() succeeded")
            // The refresh above already triggered `.entitlementsChanged`,
            // which the listener installed in bootstrap() will pick up and
            // re-read from cache — no need to duplicate that here.
        } catch let e as RovenueError {
            appendLog("refreshEntitlements() failed: RovenueError(\(e.kind)): \(e.message)")
        } catch {
            appendLog("refreshEntitlements() failed: \(error)")
        }
    }

    // MARK: - offerings

    func loadOfferings() async {
        busyLabel = "getOfferings"
        defer { busyLabel = nil }
        do {
            let result = try await Rovenue.shared.getOfferings()
            offerings = result
            appendLog("getOfferings() succeeded: \(result.all.count) offering(s)")
        } catch let e as RovenueError {
            appendLog("getOfferings() failed: RovenueError(\(e.kind)): \(e.message)")
        } catch {
            appendLog("getOfferings() failed: \(error)")
        }
    }

    // MARK: - purchase

    func purchase(_ product: StoreProduct) async {
        busyLabel = "purchase \(product.id)"
        defer { busyLabel = nil }
        do {
            let result = try await Rovenue.shared.purchase(product)
            appendLog("purchase(\(product.id)) succeeded: txn \(result.storeTransactionId)")
            entitlements = result.entitlements
        } catch let e as RovenueError {
            appendLog("purchase(\(product.id)) failed: RovenueError(\(e.kind)): \(e.message)")
        } catch {
            appendLog("purchase(\(product.id)) failed: \(error)")
        }
    }

    // MARK: - restore

    func restore() async {
        busyLabel = "restorePurchases"
        defer { busyLabel = nil }
        do {
            let result = try await Rovenue.shared.restorePurchases()
            appendLog("restorePurchases() succeeded: \(result.entitlements.count) entitlement(s)")
            entitlements = result.entitlements
        } catch let e as RovenueError {
            appendLog("restorePurchases() failed: RovenueError(\(e.kind)): \(e.message)")
        } catch {
            appendLog("restorePurchases() failed: \(error)")
        }
    }

    // MARK: - paywall

    func resolvePaywall() async -> Paywall? {
        busyLabel = "getPaywall"
        defer { busyLabel = nil }
        do {
            guard let paywall = try await Rovenue.shared.getPaywall(placementId: ExampleConfig.placementIdentifier) else {
                appendLog("getPaywall(\(ExampleConfig.placementIdentifier)) resolved to nothing (no assignment for this placement)")
                return nil
            }
            appendLog("getPaywall(\(ExampleConfig.placementIdentifier)) succeeded: paywall \(paywall.paywallIdentifier ?? "(remote-config only)")")
            return paywall
        } catch let e as RovenueError {
            appendLog("getPaywall() failed: RovenueError(\(e.kind)): \(e.message)")
            return nil
        } catch {
            appendLog("getPaywall() failed: \(error)")
            return nil
        }
    }
}
