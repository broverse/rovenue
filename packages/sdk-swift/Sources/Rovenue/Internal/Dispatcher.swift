//  Dispatcher.swift — bridges blocking Rust-core calls into Swift async/await.
//
//  Every public async method on `Rovenue` that hits the Rust core flows through
//  this dispatcher. The Rust core's methods are synchronous (per the UniFFI
//  spec we picked in M1), so calling them on @MainActor would block the UI.
//  The dispatcher serializes them on a single user-initiated queue and
//  resumes the calling task via withCheckedThrowingContinuation.

import Foundation

internal final class Dispatcher: @unchecked Sendable {
    private let queue: DispatchQueue

    init(label: String = "dev.rovenue.sdk") {
        self.queue = DispatchQueue(label: label, qos: .userInitiated)
    }

    /// Run a throwing block on the dispatcher's serial queue and await its result.
    func run<T>(_ block: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Swift.Error>) in
            queue.async {
                do {
                    continuation.resume(returning: try block())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// Run a non-throwing block on the dispatcher's serial queue and await its result.
    func runNonThrowing<T>(_ block: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { (continuation: CheckedContinuation<T, Never>) in
            queue.async {
                continuation.resume(returning: block())
            }
        }
    }
}
