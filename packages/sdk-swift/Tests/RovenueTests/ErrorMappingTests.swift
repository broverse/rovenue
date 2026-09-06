//  ErrorMappingTests.swift — TDD tests for the new single-struct RovenueError.
//
//  These tests were written first (red), then the implementation in
//  Errors.swift was updated to make them green.

import XCTest
@testable import Rovenue

final class ErrorMappingTests: XCTestCase {

    // ------------------------------------------------------------------
    // isRetryable derivation
    // ------------------------------------------------------------------

    func testRetryableDerivation() {
        XCTAssertTrue(RovenueError(kind: .networkUnavailable, message: "").isRetryable)
        XCTAssertTrue(RovenueError(kind: .timeout, message: "").isRetryable)
        XCTAssertTrue(RovenueError(kind: .rateLimited, message: "").isRetryable)
        XCTAssertTrue(RovenueError(kind: .serverError, message: "").isRetryable)
        XCTAssertTrue(RovenueError(kind: .storeServiceUnavailable, message: "").isRetryable)
        XCTAssertFalse(RovenueError(kind: .forbidden, message: "").isRetryable)
        XCTAssertFalse(RovenueError(kind: .invalidApiKey, message: "").isRetryable)
        XCTAssertFalse(RovenueError(kind: .receiptInvalid, message: "").isRetryable)
        XCTAssertFalse(RovenueError(kind: .purchaseCanceled, message: "").isRetryable)
    }

    // ------------------------------------------------------------------
    // Carries serverCode / httpStatus / errorDescription
    // ------------------------------------------------------------------

    func testCarriesServerCode() {
        let e = RovenueError(kind: .forbidden, message: "no", serverCode: "FORBIDDEN", httpStatus: 403)
        XCTAssertEqual(e.serverCode, "FORBIDDEN")
        XCTAssertEqual(e.httpStatus, 403)
        XCTAssertEqual(e.errorDescription, "no")
    }

    func testErrorDescriptionEqualsMessage() {
        let e = RovenueError(kind: .timeout, message: "Request timed out", serverCode: nil, httpStatus: nil)
        XCTAssertEqual(e.errorDescription, "Request timed out")
    }

    func testNilOptionals() {
        let e = RovenueError(kind: .storage, message: "disk full")
        XCTAssertNil(e.serverCode)
        XCTAssertNil(e.httpStatus)
    }

    // ------------------------------------------------------------------
    // mapError reads .detail → .message, httpStatus UInt16? → Int?
    // ------------------------------------------------------------------

    func testMapError_readsDetail() {
        let ffi = RovenueErrorFfi.Generic(
            kind: .networkUnavailable,
            detail: "no network",
            serverCode: nil,
            httpStatus: nil,
            retryable: true
        )
        let mapped = mapError(ffi)
        XCTAssertEqual(mapped.kind, .networkUnavailable)
        XCTAssertEqual(mapped.message, "no network")
        XCTAssertNil(mapped.serverCode)
        XCTAssertNil(mapped.httpStatus)
        XCTAssertTrue(mapped.isRetryable)
    }

    func testMapError_convertsHttpStatus() {
        let ffi = RovenueErrorFfi.Generic(
            kind: .forbidden,
            detail: "forbidden",
            serverCode: "FORBIDDEN",
            httpStatus: UInt16(403),
            retryable: false
        )
        let mapped = mapError(ffi)
        XCTAssertEqual(mapped.httpStatus, 403)
        XCTAssertEqual(mapped.serverCode, "FORBIDDEN")
        XCTAssertFalse(mapped.isRetryable)
    }

    func testMapError_allKindsProduceRovenueError() {
        // Smoke: the single .Generic case maps to a RovenueError for every ErrorKind.
        let kinds: [ErrorKind] = [
            .networkUnavailable, .timeout, .rateLimited, .serverError,
            .invalidApiKey, .forbidden, .notFound, .invalidRequest,
            .conflict, .invalidArgument, .insufficientCredits,
            .funnelTokenNotFound, .funnelTokenExpired, .funnelTokenAlreadyClaimed,
            .purchaseCanceled, .productNotAvailable, .alreadyOwned,
            .paymentDeclined, .storeServiceUnavailable, .ineligible,
            .receiptInvalid, .storeProblem, .storage, .internal
        ]
        for kind in kinds {
            let e = mapError(RovenueErrorFfi.Generic(kind: kind, detail: "x", serverCode: nil, httpStatus: nil, retryable: false))
            XCTAssertEqual(e.kind, kind, "kind should be preserved for \(kind)")
        }
    }

    // ------------------------------------------------------------------
    // Unknown wire `code` tolerance
    //
    // `mapError` never switches on the wire `code` string — it only ever
    // lifts an already-typed, closed-set Rust `ErrorKind` (uniffi enums
    // cannot carry an out-of-range discriminant across the FFI boundary).
    // The one place a *string* error code participates in kind selection
    // is Rust core's `error_from_status` (packages/core-rs/src/transport/
    // http_client.rs), which keys purely off HTTP status and treats the
    // backend `code` as opaque metadata carried in `serverCode` — proven by
    // `preserves_backend_code_and_message` in
    // packages/core-rs/tests/error_mapping.rs. These tests pin the
    // consequence at this layer: an arbitrary/never-seen serverCode must
    // ride through `mapError` unchanged, never thrown or altered.
    // ------------------------------------------------------------------

    func testMapError_preservesUnrecognizedServerCode() {
        // BEARER_REQUIRED is one of the codes Task 5 is about to start
        // emitting for the first time; from this already-built package's
        // point of view it is indistinguishable from any other novel code.
        let ffi = RovenueErrorFfi.Generic(
            kind: .invalidApiKey,
            detail: "missing bearer token",
            serverCode: "BEARER_REQUIRED",
            httpStatus: UInt16(401),
            retryable: false
        )
        let mapped = mapError(ffi)
        XCTAssertEqual(mapped.kind, .invalidApiKey)
        XCTAssertEqual(mapped.serverCode, "BEARER_REQUIRED")
        XCTAssertEqual(mapped.httpStatus, 401)
    }

    func testMapError_preservesWhollyNovelServerCode() {
        let ffi = RovenueErrorFfi.Generic(
            kind: .forbidden,
            detail: "wrong key kind",
            serverCode: "SOME_CODE_THIS_RELEASE_HAS_NEVER_SEEN",
            httpStatus: UInt16(403),
            retryable: false
        )
        let mapped = mapError(ffi)
        XCTAssertEqual(mapped.kind, .forbidden)
        XCTAssertEqual(mapped.serverCode, "SOME_CODE_THIS_RELEASE_HAS_NEVER_SEEN")
    }
}
