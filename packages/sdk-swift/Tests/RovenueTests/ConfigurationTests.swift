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
        XCTAssertThrowsError(try Rovenue.configure(apiKey: "", baseUrl: "https://api.rovenue.io")) { err in
            guard let e = err as? Rovenue.Error else { return XCTFail("expected Rovenue.Error, got \(err)") }
            XCTAssertEqual(e, .invalidApiKey)
        }
    }

    func test_configure_rejectsWhitespaceApiKey() {
        XCTAssertThrowsError(try Rovenue.configure(apiKey: "   ", baseUrl: "https://api.rovenue.io")) { err in
            XCTAssertEqual(err as? Rovenue.Error, .invalidApiKey)
        }
    }

    func test_configure_succeedsWithValidConfig() throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.io")
        XCTAssertEqual(Rovenue.shared.version, sdkVersion())
    }

    func test_configureTwice_lastWriteWins() throws {
        try Rovenue.configure(apiKey: "pk_first", baseUrl: "https://api.rovenue.io")
        let firstInstance = Rovenue.shared
        try Rovenue.configure(apiKey: "pk_second", baseUrl: "https://api.rovenue.io")
        let secondInstance = Rovenue.shared
        XCTAssertFalse(firstInstance === secondInstance, "configure() should replace the shared instance")
    }
}
