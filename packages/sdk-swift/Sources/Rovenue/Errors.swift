//  Errors.swift — public Swift error surface for the Rovenue façade.
//
//  Single concrete struct `RovenueError` wraps every failure the SDK can
//  produce — both FFI-originated errors (mapped from `RovenueErrorFfi`) and
//  Swift-origin purchase-flow outcomes (constructed directly from StoreKit
//  results). Consumers check `.kind` for programmatic branching and read
//  `.message` / `.errorDescription` for user-facing text.
//
//  Name collision note: the UniFFI-generated error enum is `RovenueErrorFfi`
//  (not `RovenueError`), so there is no shadowing issue.

import Foundation

/// The single public error type thrown by every Rovenue SDK method.
public struct RovenueError: Error, LocalizedError, Equatable, Sendable {
    /// Programmatic discriminant — mirrors the Rust `ErrorKind` enum.
    public let kind: ErrorKind
    /// Human-readable detail (maps from the generated `.detail` field).
    public let message: String
    /// Server-supplied error code, if any (e.g. `"SUBSCRIPTION_NOT_FOUND"`).
    public let serverCode: String?
    /// HTTP status code that accompanied the error, if any.
    public let httpStatus: Int?

    public init(
        kind: ErrorKind,
        message: String,
        serverCode: String? = nil,
        httpStatus: Int? = nil
    ) {
        self.kind = kind
        self.message = message
        self.serverCode = serverCode
        self.httpStatus = httpStatus
    }

    /// True when the operation is worth retrying after a short back-off.
    public var isRetryable: Bool {
        switch kind {
        case .networkUnavailable, .timeout, .rateLimited, .serverError, .storeServiceUnavailable:
            return true
        default:
            return false
        }
    }

    /// `LocalizedError` conformance — forwards `message` so the error surfaces
    /// correctly in `catch { error.localizedDescription }` call sites.
    public var errorDescription: String? { message }
}

// MARK: - FFI mapper

/// Maps the UniFFI-generated `RovenueErrorFfi` into the public `RovenueError`.
/// The single `.Generic` case carries all fields; `detail` becomes `message`,
/// `httpStatus: UInt16?` is widened to `Int?`.
internal func mapError(_ e: RovenueErrorFfi) -> RovenueError {
    switch e {
    case let .Generic(kind, detail, serverCode, httpStatus, _):
        return RovenueError(
            kind: kind,
            message: detail,
            serverCode: serverCode,
            httpStatus: httpStatus.map(Int.init)
        )
    }
}
