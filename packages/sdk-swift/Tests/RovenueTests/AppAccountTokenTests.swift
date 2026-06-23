import XCTest
@testable import Rovenue

final class AppAccountTokenTests: XCTestCase {
    override func setUp() async throws {
        isolateRovenueHome(self)
        Rovenue.resetForTesting()
        try Rovenue.configure(apiKey: "test_pk", baseUrl: "http://localhost:0", logLevel: .debug)
    }

    override func tearDown() async throws {
        Rovenue.resetForTesting()
    }

    func test_returns_stable_uuid_across_calls() async throws {
        let t1 = try await Rovenue.shared.getAppAccountToken()
        let t2 = try await Rovenue.shared.getAppAccountToken()
        XCTAssertEqual(t1, t2)
        XCTAssertNotNil(UUID(uuidString: t1), "must be a valid UUID")
    }

    func test_token_changes_after_identify() async throws {
        let anonToken = try await Rovenue.shared.getAppAccountToken()
        try await Rovenue.shared.identify("user-123")
        let knownToken = try await Rovenue.shared.getAppAccountToken()
        // Tokens are scoped per current_user_scope; identify() changes the scope.
        XCTAssertNotEqual(anonToken, knownToken)
    }
}
