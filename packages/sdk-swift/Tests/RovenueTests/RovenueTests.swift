import XCTest
@testable import Rovenue

final class RovenueTests: XCTestCase {
    // -----------------------------------------------------------------
    // M0 smoke (generated bindings — preserved for parity)
    // -----------------------------------------------------------------

    func test_getVersion_matchesCargoPkgVersion() throws {
        let cfg = Config(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev", debug: false, appVersion: nil)
        let core = try RovenueCore(config: cfg)
        XCTAssertFalse(core.getVersion().isEmpty)
        XCTAssertEqual(core.getVersion(), "0.6.0")
    }

    func test_invalidApiKey_throws_atGeneratedLayer() {
        let cfg = Config(apiKey: "", baseUrl: "https://api.rovenue.dev", debug: false, appVersion: nil)
        XCTAssertThrowsError(try RovenueCore(config: cfg)) { err in
            guard case RovenueError.InvalidApiKey = err else {
                return XCTFail("expected InvalidApiKey, got \(err)")
            }
        }
    }

    func test_sdkVersionFreeFunction() {
        XCTAssertEqual(sdkVersion(), "0.6.0")
    }

    // -----------------------------------------------------------------
    // M3 façade smoke (public Rovenue.shared API)
    // -----------------------------------------------------------------

    override func setUp() {
        super.setUp()
        isolateRovenueHome(self)
        Rovenue.resetForTesting()
    }

    func test_facade_versionMatchesGenerated() throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        XCTAssertEqual(Rovenue.shared.version, sdkVersion())
    }

    func test_facade_currentUserHasAnonId() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        let user = await Rovenue.shared.currentUser()
        XCTAssertTrue(user.anonId.hasPrefix("anon_"))
        XCTAssertNil(user.knownUserId)
    }

    func test_facade_entitlementsEmpty() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        let pro = await Rovenue.shared.entitlement("pro")
        XCTAssertNil(pro)
        let all = await Rovenue.shared.entitlementsAll()
        XCTAssertTrue(all.isEmpty)
    }

    func test_facade_creditBalanceZeroByDefault() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        let balance = await Rovenue.shared.creditBalance()
        XCTAssertEqual(balance, 0)
    }

    func test_facade_identifyEmitsChange() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        let stream = Rovenue.shared.changes
        var iterator = stream.makeAsyncIterator()
        try await Rovenue.shared.identify("user_42")
        let event = await iterator.next()
        XCTAssertEqual(event, .identityChanged)
        let user = await Rovenue.shared.currentUser()
        XCTAssertEqual(user.knownUserId, "user_42")
    }
}
