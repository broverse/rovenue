import XCTest
@testable import Rovenue

final class AttributesTests: XCTestCase {

    override func setUp() {
        super.setUp()
        isolateRovenueHome(self)
        Rovenue.resetForTesting()
    }

    func test_setAttributes_doesNotThrow_whenConfigured() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://127.0.0.1:0")
        try await Rovenue.shared.setAttributes(["$email": "a@b.com", "country": nil])
    }

    func test_setEmail_routesToEmailReservedKey() async throws {
        try Rovenue.configure(apiKey: "pk_test_xyz", baseUrl: "https://127.0.0.1:0")
        try await Rovenue.shared.setEmail("a@b.com")
        // (Behavioural: no throw. Deeper assertion requires a mock transport;
        //  match how IdentityTests verifies offline-safe calls.)
    }
}
