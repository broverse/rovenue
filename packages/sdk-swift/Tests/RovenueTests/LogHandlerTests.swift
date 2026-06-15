import XCTest
@testable import Rovenue

final class LogHandlerTests: XCTestCase {

    override func setUp() async throws {
        try await super.setUp()
        isolateRovenueHome(self)
        Rovenue.resetForTesting()
        try Rovenue.configure(apiKey: "pk_test", baseUrl: "https://api.test", debug: true)
    }

    override func tearDown() async throws {
        Rovenue.resetForTesting()
        try await super.tearDown()
    }

    func testHandlerReceivesEntries() async throws {
        let captured = LockedBox<[LogEntry]>([])
        _ = Rovenue.shared.setLogHandler { entry in
            captured.with { $0.append(entry) }
        }
        // Trigger an emit via identify — entry + ok path.
        try? await Rovenue.shared.identify("user_log_test")
        let entries = captured.value
        XCTAssertGreaterThan(entries.count, 0)
        XCTAssertTrue(entries.contains { $0.message == "identify" && $0.level == "info" })
        // Privacy: handler MUST NOT receive the raw knownUserId string.
        XCTAssertFalse(entries.contains { $0.message.contains("user_log_test") })
    }

    func testUnsubscribeStopsCalls() async throws {
        let captured = LockedBox<[LogEntry]>([])
        let unsub = Rovenue.shared.setLogHandler { entry in
            captured.with { $0.append(entry) }
        }
        unsub()
        try? await Rovenue.shared.identify("user_unsub_test")
        XCTAssertEqual(captured.value.count, 0)
    }
}

// Tiny thread-safe box for test capture (avoids @Sendable closure warnings).
private final class LockedBox<T> {
    private var _value: T
    private let lock = NSLock()
    init(_ initial: T) { self._value = initial }
    var value: T { lock.lock(); defer { lock.unlock() }; return _value }
    func with(_ block: (inout T) -> Void) {
        lock.lock(); defer { lock.unlock() }; block(&_value)
    }
}
