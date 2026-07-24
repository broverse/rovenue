import XCTest
@testable import Rovenue

/// Verifies that the Swift façade auto-reads the host bundle's
/// `CFBundleShortVersionString` at configure() time and that an
/// explicit override wins.
final class AppVersionTests: XCTestCase {
    override func setUp() {
        super.setUp()
        isolateRovenueHome(self)
        Rovenue.resetForTesting()
    }

    func test_configure_readsBundleVersion_byDefault() throws {
        // Inject a fake bundle reader so this test is hermetic regardless
        // of what XCTest's Bundle.main actually returns on this host.
        Rovenue._appVersionReaderForTesting = { "9.9.9-fake" }
        defer { Rovenue._appVersionReaderForTesting = nil }

        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.io")
        XCTAssertEqual(Rovenue.shared.resolvedAppVersionForTesting, "9.9.9-fake")
    }

    func test_configure_explicitOverride_wins() throws {
        Rovenue._appVersionReaderForTesting = { "9.9.9-fake" }
        defer { Rovenue._appVersionReaderForTesting = nil }

        try Rovenue.configure(
            apiKey: "pk_test_xyz",
            baseUrl: "https://api.rovenue.io",
            appVersion: "1.2.3"
        )
        XCTAssertEqual(Rovenue.shared.resolvedAppVersionForTesting, "1.2.3")
    }

    func test_configure_nilWhenBundleHasNoVersion() throws {
        Rovenue._appVersionReaderForTesting = { nil }
        defer { Rovenue._appVersionReaderForTesting = nil }

        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.io")
        XCTAssertNil(Rovenue.shared.resolvedAppVersionForTesting)
    }

    /// `configuredAppVersion` is the production-facing accessor the
    /// builder paywall renderer's `visibility` gate reads (see
    /// RovenuePaywallView.swift) — it must agree with
    /// `resolvedAppVersionForTesting`, which exists only for the tests
    /// above.
    func test_configuredAppVersion_agreesWithResolvedAppVersionForTesting() throws {
        Rovenue._appVersionReaderForTesting = { "9.9.9-fake" }
        defer { Rovenue._appVersionReaderForTesting = nil }

        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.io")
        XCTAssertEqual(Rovenue.shared.configuredAppVersion, "9.9.9-fake")
        XCTAssertEqual(Rovenue.shared.configuredAppVersion, Rovenue.shared.resolvedAppVersionForTesting)
    }

    /// `sharedIfConfigured` is the non-trapping peek the paywall renderer
    /// uses so a render triggered before `configure()` fails open (nil
    /// appVersion) instead of hitting `.shared`'s `fatalError`.
    func test_sharedIfConfigured_nilBeforeConfigure_setAfterConfigure() throws {
        XCTAssertNil(Rovenue.sharedIfConfigured)
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://api.rovenue.io")
        XCTAssertNotNil(Rovenue.sharedIfConfigured)
    }
}
