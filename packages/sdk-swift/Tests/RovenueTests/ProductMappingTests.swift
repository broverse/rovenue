import XCTest
@testable import Rovenue

final class ProductMappingTests: XCTestCase {
    func testIso8601() {
        XCTAssertEqual(iso8601(from: 1, unit: .month), "P1M")
        XCTAssertEqual(iso8601(from: 3, unit: .day), "P3D")
        XCTAssertEqual(iso8601(from: 1, unit: .year), "P1Y")
        XCTAssertEqual(iso8601(from: 2, unit: .week), "P2W")
    }

    func testPerUnitPricesFromYearly() {
        let year = makePeriod(value: 1, unit: .year)
        let r = perUnitPrices(price: 120, period: year, formatCurrency: { "$\($0)" })
        XCTAssertEqual(r.month, Decimal(120) / Decimal(365) * Decimal(30))
        XCTAssertNotNil(r.monthStr)
    }

    func testPerUnitPricesNilWhenNoPeriod() {
        let r = perUnitPrices(price: 9.99, period: nil, formatCurrency: { _ in nil })
        XCTAssertNil(r.month); XCTAssertNil(r.year); XCTAssertNil(r.week)
    }
}
