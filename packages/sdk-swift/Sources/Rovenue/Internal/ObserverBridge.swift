//  ObserverBridge.swift — multiplexer between the Rust observer callback and
//  multiple Swift AsyncStream subscribers.
//
//  Rust core's `register_observer(obs)` accepts exactly one Observer at a
//  time. To support multiple Swift consumers (each `for await event in
//  rovenue.changes` loop is its own subscriber), we register exactly one
//  ObserverBridge with the core and let the bridge fan-out emits into a
//  table of AsyncStream continuations.

import Foundation

internal final class ObserverBridge: Observer, @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [UUID: AsyncStream<ChangeEvent>.Continuation] = [:]

    /// Called by UniFFI on the Rust observer thread.
    func onChange(event: ChangeEvent) {
        lock.lock()
        let snapshot = continuations.values
        lock.unlock()
        for c in snapshot {
            c.yield(event)
        }
    }

    /// Create a fresh AsyncStream subscriber. Each call returns an independent
    /// stream; multiple subscribers may exist concurrently.
    func subscribe() -> AsyncStream<ChangeEvent> {
        AsyncStream { continuation in
            let id = UUID()
            lock.lock()
            continuations[id] = continuation
            lock.unlock()
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                self.lock.lock()
                self.continuations.removeValue(forKey: id)
                self.lock.unlock()
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
