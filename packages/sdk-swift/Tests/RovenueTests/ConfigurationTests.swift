import XCTest
@testable import Rovenue

final class ConfigurationTests: XCTestCase {
    override func setUp() {
        super.setUp()
        isolateRovenueHome(self)
        // Tests in this file must not assume any prior shared instance state.
        Rovenue.resetForTesting()
    }

    func test_configure_rejectsEmptyApiKey() {
        XCTAssertThrowsError(try Rovenue.configure(apiKey: "", baseUrl: "https://api.rovenue.dev")) { err in
            guard let e = err as? Rovenue.Error else { return XCTFail("expected Rovenue.Error, got \(err)") }
            XCTAssertEqual(e, .invalidApiKey)
        }
    }

    func test_configure_rejectsWhitespaceApiKey() {
        XCTAssertThrowsError(try Rovenue.configure(apiKey: "   ", baseUrl: "https://api.rovenue.dev")) { err in
            XCTAssertEqual(err as? Rovenue.Error, .invalidApiKey)
        }
    }

    func test_configure_succeedsWithValidConfig() throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        XCTAssertEqual(Rovenue.shared.version, "0.7.0")
    }

    func test_configureTwice_lastWriteWins() throws {
        try Rovenue.configure(apiKey: "pk_first", baseUrl: "https://api.rovenue.dev")
        let firstInstance = Rovenue.shared
        try Rovenue.configure(apiKey: "pk_second", baseUrl: "https://api.rovenue.dev")
        let secondInstance = Rovenue.shared
        XCTAssertFalse(firstInstance === secondInstance, "configure() should replace the shared instance")
    }
}
