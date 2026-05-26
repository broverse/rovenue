import XCTest
@testable import Rovenue

final class RovenueTests: XCTestCase {
    func test_getVersion_matchesCargoPkgVersion() throws {
        let cfg = Config(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev", debug: false)
        let core = try RovenueCore(config: cfg)
        XCTAssertFalse(core.getVersion().isEmpty)
        XCTAssertEqual(core.getVersion(), "0.0.1")
    }

    func test_invalidApiKey_throws() {
        let cfg = Config(apiKey: "", baseUrl: "https://api.rovenue.dev", debug: false)
        XCTAssertThrowsError(try RovenueCore(config: cfg)) { err in
            guard case RovenueError.InvalidApiKey = err else {
                return XCTFail("expected InvalidApiKey, got \(err)")
            }
        }
    }

    func test_sdkVersionFreeFunction() {
        XCTAssertEqual(sdkVersion(), "0.0.1")
    }
}
