import XCTest
@testable import Rovenue

final class PostReceiptWithTokenTests: XCTestCase {
    override func setUp() async throws { Rovenue.resetForTesting() }
    override func tearDown() async throws { Rovenue.resetForTesting() }

    func test_postAppleReceipt_accepts_optional_token() async throws {
        try Rovenue.configure(apiKey: "test_pk", baseUrl: "http://127.0.0.1:0", debug: true)
        // No mock server here — we only verify the call compiles + the new
        // signature exists. End-to-end behavior is covered by Rust HttpClient
        // tests + integration suite.
        do {
            _ = try await Rovenue.shared.postAppleReceipt(
                "jws-blob",
                productId: "premium_monthly",
                appAccountToken: UUID().uuidString
            )
        } catch {
            // expected: network error since baseUrl is unreachable
        }
    }

    func test_postAppleReceipt_works_without_token() async throws {
        try Rovenue.configure(apiKey: "test_pk", baseUrl: "http://127.0.0.1:0", debug: true)
        do {
            _ = try await Rovenue.shared.postAppleReceipt("jws-blob", productId: "premium_monthly")
        } catch { /* expected network error */ }
    }

    func test_postGoogleReceipt_accepts_optional_obfuscated_ids() async throws {
        try Rovenue.configure(apiKey: "test_pk", baseUrl: "http://127.0.0.1:0", debug: true)
        do {
            _ = try await Rovenue.shared.postGoogleReceipt(
                "token-blob",
                productId: "premium_monthly",
                obfuscatedAccountId: UUID().uuidString,
                obfuscatedProfileId: "project-abc"
            )
        } catch { /* expected network error */ }
    }
}
