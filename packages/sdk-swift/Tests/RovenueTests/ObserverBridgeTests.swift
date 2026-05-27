import XCTest
@testable import Rovenue

final class ObserverBridgeTests: XCTestCase {
    func test_subscribe_receivesEmittedEvent() async {
        let bridge = ObserverBridge()
        let stream = bridge.subscribe()
        bridge.onChange(event: .entitlementsChanged)

        var iterator = stream.makeAsyncIterator()
        let received = await iterator.next()
        XCTAssertEqual(received, .entitlementsChanged)
    }

    func test_subscribe_receivesMultipleEvents() async {
        let bridge = ObserverBridge()
        let stream = bridge.subscribe()
        bridge.onChange(event: .entitlementsChanged)
        bridge.onChange(event: .creditBalanceChanged)
        bridge.onChange(event: .identityChanged)

        var iterator = stream.makeAsyncIterator()
        let first = await iterator.next()
        let second = await iterator.next()
        let third = await iterator.next()
        XCTAssertEqual(first, .entitlementsChanged)
        XCTAssertEqual(second, .creditBalanceChanged)
        XCTAssertEqual(third, .identityChanged)
    }

    func test_twoSubscribers_bothReceiveEachEvent() async {
        let bridge = ObserverBridge()
        let a = bridge.subscribe()
        let b = bridge.subscribe()
        bridge.onChange(event: .entitlementsChanged)

        var aIter = a.makeAsyncIterator()
        var bIter = b.makeAsyncIterator()
        let aGot = await aIter.next()
        let bGot = await bIter.next()
        XCTAssertEqual(aGot, .entitlementsChanged)
        XCTAssertEqual(bGot, .entitlementsChanged)
    }

    func test_liveCount_dropsAfterStreamFinishes() async {
        let bridge = ObserverBridge()
        do {
            let stream = bridge.subscribe()
            _ = stream
            XCTAssertEqual(bridge.liveCount(), 1)
        }
        // The stream's continuation isn't terminated automatically by going out
        // of scope (AsyncStream's lifecycle is tied to consumer iteration); to
        // actually deregister we must call `finish()` from the producer side.
        // We exercise that path explicitly:
        bridge.finishAll()
        XCTAssertEqual(bridge.liveCount(), 0)
    }
}
