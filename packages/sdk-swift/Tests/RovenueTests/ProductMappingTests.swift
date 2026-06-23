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

extension ProductMappingTests {
    func testMapAppleProductBuildsIntroAndDiscounts() {
        let core = CoreOfferingProduct(packageIdentifier: "$rov_monthly", identifier: "premium",
            productType: "SUBSCRIPTION", displayName: "Premium",
            appleProductId: "com.acme.monthly", googleProductId: nil)
        let intro = AppleOfferInput(id: nil, type: .introductory, paymentMode: .freeTrial,
            price: 0, displayPrice: "Free", periodValue: 1, periodUnit: .week, periodCount: 1)
        let promo = AppleOfferInput(id: "promo1", type: .promotional, paymentMode: .payAsYouGo,
            price: 4.99, displayPrice: "$4.99", periodValue: 1, periodUnit: .month, periodCount: 3)
        let p = mapAppleStoreProduct(core: core, period: makePeriod(value: 1, unit: .month),
            introOffer: intro, promoOffers: [promo], groupId: "grp", isFamilyShareable: true,
            description: "Pro", priceString: "$9.99", price: 9.99, currencyCode: "USD",
            isEligible: true, raw: nil, formatCurrency: { "$\($0)" })
        XCTAssertEqual(p.type, .subscription)
        XCTAssertEqual(p.introPrice?.paymentMode, .freeTrial)
        XCTAssertEqual(p.introPrice?.period.iso8601, "P1W")
        XCTAssertEqual(p.discounts.count, 1)
        XCTAssertEqual(p.discounts.first?.identifier, "promo1")
        XCTAssertEqual(p.discounts.first?.type, .promotional)
        XCTAssertEqual(p.subscriptionGroupIdentifier, "grp")
        XCTAssertEqual(p.isEligibleForIntroOffer, true)
        XCTAssertNotNil(p.pricePerMonth)
        XCTAssertNil(p.subscriptionOptions)
    }
}
