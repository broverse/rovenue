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
            guard let e = err as? RovenueError else { return XCTFail("expected RovenueError, got \(err)") }
            XCTAssertEqual(e.kind, .invalidApiKey)
        }
    }

    func test_configure_rejectsWhitespaceApiKey() {
        XCTAssertThrowsError(try Rovenue.configure(apiKey: "   ", baseUrl: "https://api.rovenue.io")) { err in
            guard let e = err as? RovenueError else { return XCTFail("expected RovenueError, got \(err)") }
            XCTAssertEqual(e.kind, .invalidApiKey)
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

    func test_configure_succeedsWithoutBaseUrl() throws {
        // baseUrl omitted → core falls back to the hosted default.
        try Rovenue.configure(apiKey: "pk_test_default")
        XCTAssertEqual(Rovenue.shared.version, sdkVersion())
    }
}
