import XCTest
@testable import Rovenue

/// Verifies that the Swift façade auto-reads the host bundle's
/// `CFBundleShortVersionString` at configure() time and that an
/// explicit override wins.
final class AppVersionTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Rovenue.resetForTesting()
    }

    func test_configure_readsBundleVersion_byDefault() throws {
        // Inject a fake bundle reader so this test is hermetic regardless
        // of what XCTest's Bundle.main actually returns on this host.
        Rovenue._appVersionReaderForTesting = { "9.9.9-fake" }
        defer { Rovenue._appVersionReaderForTesting = nil }

        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        XCTAssertEqual(Rovenue.shared.resolvedAppVersionForTesting, "9.9.9-fake")
    }

    func test_configure_explicitOverride_wins() throws {
        Rovenue._appVersionReaderForTesting = { "9.9.9-fake" }
        defer { Rovenue._appVersionReaderForTesting = nil }

        try Rovenue.configure(
            apiKey: "pk_test_xyz",
            baseUrl: "https://api.rovenue.dev",
            appVersion: "1.2.3"
        )
        XCTAssertEqual(Rovenue.shared.resolvedAppVersionForTesting, "1.2.3")
    }

    func test_configure_nilWhenBundleHasNoVersion() throws {
        Rovenue._appVersionReaderForTesting = { nil }
        defer { Rovenue._appVersionReaderForTesting = nil }

        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.dev")
        XCTAssertNil(Rovenue.shared.resolvedAppVersionForTesting)
    }
}
