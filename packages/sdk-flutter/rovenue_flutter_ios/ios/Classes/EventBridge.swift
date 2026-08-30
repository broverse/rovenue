// EventBridge.swift — forwards the Swift façade's async event sources
// (`Rovenue.shared.changes`, `Rovenue.shared.funnelClaims`, and the log
// handler registered via `Rovenue.shared.setLogHandler`) onto the
// Pigeon-generated `RovenueFlutterApi` (Dart-bound `onChange` / `onLog` /
// `onFunnelClaim`).
//
// Subscribed exactly once, from `HostApiImpl.configure(...)` — mirrors
// `RovenueModule.swift`'s `OnStartObserving`/`OnStopObserving` pair, minus
// the Expo view-lifecycle hooks (Pigeon has no equivalent, so `start()` is
// driven by `configure()` directly; `stop()` guards against double
// subscription if `configure()` is ever called twice, matching the
// façade's own "configure-twice replaces the instance" contract).

import Foundation
#if os(iOS)
  import Flutter
#elseif os(macOS)
  import FlutterMacOS
#else
  #error("Unsupported platform.")
#endif
import Rovenue

final class EventBridge {
  private let flutterApi: RovenueFlutterApiProtocol
  private var changesTask: Task<Void, Never>?
  private var funnelClaimsTask: Task<Void, Never>?
  private var logUnsubscribe: (() -> Void)?

  init(flutterApi: RovenueFlutterApiProtocol) {
    self.flutterApi = flutterApi
  }

  /// Subscribes to `changes`/`funnelClaims`/log handler. Idempotent: a
  /// second call tears down the prior subscriptions first so events are
  /// never delivered twice after a repeat `configure()`.
  func start() {
    stop()

    changesTask = Task { [weak self] in
      for await event in Rovenue.shared.changes {
        guard let self else { break }
        let dto = mapChangeEvent(event)
        await MainActor.run {
          self.flutterApi.onChange(event: dto) { _ in }
        }
      }
    }

    funnelClaimsTask = Task { [weak self] in
      for await claim in Rovenue.shared.funnelClaims {
        guard let self else { break }
        let dto = mapFunnelClaim(claim)
        await MainActor.run {
          self.flutterApi.onFunnelClaim(claim: dto) { _ in }
        }
      }
    }

    // `setLogHandler`'s callback is synchronous (not `async`), so hop to
    // the main thread with a plain dispatch rather than `MainActor.run`.
    logUnsubscribe = Rovenue.shared.setLogHandler { [weak self] entry in
      guard let self else { return }
      let dto = mapLogRecord(entry)
      DispatchQueue.main.async {
        self.flutterApi.onLog(record: dto) { _ in }
      }
    }
  }

  func stop() {
    changesTask?.cancel()
    changesTask = nil
    funnelClaimsTask?.cancel()
    funnelClaimsTask = nil
    logUnsubscribe?()
    logUnsubscribe = nil
  }
}
