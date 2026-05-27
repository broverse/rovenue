import XCTest
@testable import Rovenue

final class ErrorMappingTests: XCTestCase {
    func test_mapError_NotConfigured() {
        XCTAssertEqual(mapError(.NotConfigured(message: "x")), .notConfigured)
    }

    func test_mapError_InvalidApiKey() {
        XCTAssertEqual(mapError(.InvalidApiKey(message: "x")), .invalidApiKey)
    }

    func test_mapError_ServerError() {
        XCTAssertEqual(mapError(.ServerError(message: "x")), .serverError)
    }

    func test_mapError_NetworkUnavailable() {
        XCTAssertEqual(mapError(.NetworkUnavailable(message: "x")), .networkUnavailable)
    }

    func test_mapError_Timeout() {
        XCTAssertEqual(mapError(.Timeout(message: "x")), .timeout)
    }

    func test_mapError_RateLimited() {
        XCTAssertEqual(mapError(.RateLimited(message: "x")), .rateLimited)
    }

    func test_mapError_Storage() {
        XCTAssertEqual(mapError(.Storage(message: "x")), .storage)
    }

    func test_mapError_UserNotFound() {
        XCTAssertEqual(mapError(.UserNotFound(message: "x")), .userNotFound)
    }

    func test_mapError_InsufficientCredits() {
        XCTAssertEqual(mapError(.InsufficientCredits(message: "x")), .insufficientCredits)
    }

    func test_mapError_EntitlementInactive() {
        XCTAssertEqual(mapError(.EntitlementInactive(message: "x")), .entitlementInactive)
    }

    func test_mapError_DuplicatePurchase() {
        XCTAssertEqual(mapError(.DuplicatePurchase(message: "x")), .duplicatePurchase)
    }

    func test_mapError_ReceiptInvalid() {
        XCTAssertEqual(mapError(.ReceiptInvalid(message: "x")), .receiptInvalid)
    }

    func test_mapError_Internal() {
        XCTAssertEqual(mapError(.Internal(message: "x")), .internalError)
    }

    func test_errorDescription_isHumanReadable() {
        // Every case has a non-empty description for debugging.
        let cases: [Rovenue.Error] = [
            .notConfigured, .invalidApiKey, .serverError, .networkUnavailable,
            .timeout, .rateLimited, .storage, .userNotFound, .insufficientCredits,
            .entitlementInactive, .duplicatePurchase, .receiptInvalid, .internalError,
        ]
        for c in cases {
            XCTAssertFalse(c.errorDescription?.isEmpty ?? true, "\(c) has empty description")
        }
    }
}
