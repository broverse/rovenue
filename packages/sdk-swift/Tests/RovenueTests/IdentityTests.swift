import XCTest
@testable import Rovenue

final class IdentityTests: XCTestCase {

    override func setUp() {
        super.setUp()
        isolateRovenueHome(self)
        Rovenue.resetForTesting()
    }

    // MARK: - currentUser

    func test_currentUser_afterConfigure_hasRovenueIdPrefixAndNilAppUserId() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://127.0.0.1:0")
        let user = await Rovenue.shared.currentUser()
        XCTAssertTrue(
            user.rovenueId.hasPrefix("rov_"),
            "Expected rovenueId to start with 'rov_', got '\(user.rovenueId)'"
        )
        XCTAssertNil(user.appUserId, "Expected appUserId to be nil for a fresh anonymous user")
    }

    // MARK: - logOut

    @available(iOS 15.0, macOS 12.0, *)
    func test_logOut_resetsToNewAnonymousUser() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://127.0.0.1:0")

        let beforeId = await Rovenue.shared.currentUser().rovenueId
        XCTAssertTrue(beforeId.hasPrefix("rov_"), "Pre-logOut rovenueId should start with 'rov_'")

        // logOut must not throw
        try await Rovenue.shared.logOut()

        let afterUser = await Rovenue.shared.currentUser()
        XCTAssertTrue(
            afterUser.rovenueId.hasPrefix("rov_"),
            "Post-logOut rovenueId should start with 'rov_', got '\(afterUser.rovenueId)'"
        )
        XCTAssertNotEqual(
            afterUser.rovenueId,
            beforeId,
            "After logOut the rovenueId should change (new anonymous session)"
        )
        XCTAssertNil(afterUser.appUserId, "After logOut appUserId should be nil")
    }
}
