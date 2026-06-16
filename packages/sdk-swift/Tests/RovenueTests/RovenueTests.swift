import XCTest
@testable import Rovenue

final class RovenueTests: XCTestCase {
    // -----------------------------------------------------------------
    // M0 smoke (generated bindings — preserved for parity)
    // -----------------------------------------------------------------

    func test_getVersion_matchesCargoPkgVersion() throws {
        let cfg = Config(apiKey: "pk_test_xyz", debug: false, appVersion: nil, baseUrl: "https://api.rovenue.io")
        let core = try RovenueCore(config: cfg)
        XCTAssertFalse(core.getVersion().isEmpty)
        // Both derive from the librovenue crate (workspace) version; asserting
        // their equality tracks the source of truth without hardcoding a literal
        // that drifts on every version bump.
        XCTAssertEqual(sdkVersion(), core.getVersion())
    }

    func test_invalidApiKey_throws_atGeneratedLayer() {
        let cfg = Config(apiKey: "", debug: false, appVersion: nil, baseUrl: "https://api.rovenue.io")
        XCTAssertThrowsError(try RovenueCore(config: cfg)) { err in
            guard case RovenueError.InvalidApiKey = err else {
                return XCTFail("expected InvalidApiKey, got \(err)")
            }
        }
    }

    func test_sdkVersionFreeFunction() {
        XCTAssertFalse(sdkVersion().isEmpty)
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
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.io")
        XCTAssertEqual(Rovenue.shared.version, sdkVersion())
    }

    func test_facade_currentUserHasRovenueId() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.io")
        let user = await Rovenue.shared.currentUser()
        XCTAssertTrue(user.rovenueId.hasPrefix("rov_"))
        XCTAssertNil(user.appUserId)
    }

    func test_facade_entitlementsEmpty() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.io")
        let pro = await Rovenue.shared.entitlement("pro")
        XCTAssertNil(pro)
        let all = await Rovenue.shared.entitlementsAll()
        XCTAssertTrue(all.isEmpty)
    }

    func test_facade_creditBalanceZeroByDefault() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.io")
        let balance = await Rovenue.shared.creditBalance()
        XCTAssertEqual(balance, 0)
    }

    func test_facade_identifyEmitsChange() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.io")
        let stream = Rovenue.shared.changes
        var iterator = stream.makeAsyncIterator()
        try await Rovenue.shared.identify("user_42")
        let event = await iterator.next()
        XCTAssertEqual(event, .identityChanged)
        let user = await Rovenue.shared.currentUser()
        XCTAssertEqual(user.appUserId, "user_42")
    }
}
