//  FunnelClaimBridge.swift — multiplexer between the Rust funnel-claim
//  callback and multiple Swift AsyncStream subscribers.
//
//  Rust core's `registerFunnelClaimListener(listener:)` accepts exactly one
//  FunnelClaimListener at a time. To support multiple Swift consumers, we
//  register exactly one FunnelClaimBridge with the core and let the bridge
//  fan-out results into a table of AsyncStream continuations.
//
//  Mirrors ObserverBridge exactly, with payload type FunnelClaimResult.

import Foundation

/// Single registered `FunnelClaimListener` that fans resolved claims out to
/// AsyncStream subscribers — mirrors ObserverBridge.
internal final class FunnelClaimBridge: FunnelClaimListener, @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [UUID: AsyncStream<FunnelClaimResult>.Continuation] = [:]

    func onFunnelClaimResolved(result: FunnelClaimResult) {
        lock.lock()
        let snapshot = continuations.values
        lock.unlock()
        for c in snapshot { c.yield(result) }
    }

    func subscribe() -> AsyncStream<FunnelClaimResult> {
        AsyncStream { continuation in
            let id = UUID()
            lock.lock(); continuations[id] = continuation; lock.unlock()
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock(); self.continuations.removeValue(forKey: id); self.lock.unlock()
            }
        }
    }

    /// Testing hook — count of live continuations.
    func liveCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return continuations.count
    }

    /// Testing hook — finish all streams and clear the table.
    func finishAll() {
        lock.lock()
        let toFinish = Array(continuations.values)
        continuations.removeAll()
        lock.unlock()
        for c in toFinish { c.finish() }
    }
}
