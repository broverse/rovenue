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
            appleProductId: "com.acme.monthly", googleProductId: nil,
            androidBasePlanId: nil, androidOfferId: nil)
        let intro = AppleOfferInput(id: nil, type: .introductory, paymentMode: .freeTrial,
            price: 0, displayPrice: "Free", periodValue: 1, periodUnit: .week, periodCount: 1)
        let promo = AppleOfferInput(id: "promo1", type: .promotional, paymentMode: .payAsYouGo,
            price: 4.99, displayPrice: "$4.99", periodValue: 1, periodUnit: .month, periodCount: 3)
        let p = mapAppleStoreProduct(core: core, period: makePeriod(value: 1, unit: .month),
            introOffer: intro, promoOffers: [promo], groupId: "grp", isFamilyShareable: true,
            description: "Pro", priceString: "$9.99", price: 9.99, currencyCode: "USD",
            isEligible: true, raw: nil, formatCurrency: { "$\($0)" })
        // StoreProduct.id must be the App Store SKU (used for the StoreKit
        // purchase lookup), not the Rovenue catalog identifier ("premium").
        XCTAssertEqual(p.id, "com.acme.monthly")
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

    func testMapAppleProductFallsBackToCatalogIdWhenNoAppleProductId() {
        let core = CoreOfferingProduct(packageIdentifier: "$rov_monthly", identifier: "premium",
            productType: "SUBSCRIPTION", displayName: "Premium",
            appleProductId: nil, googleProductId: nil,
            androidBasePlanId: nil, androidOfferId: nil)
        let p = mapAppleStoreProduct(core: core, period: nil, introOffer: nil, promoOffers: [],
            groupId: nil, isFamilyShareable: false, description: nil, priceString: nil, price: nil,
            currencyCode: nil, isEligible: nil, raw: nil, formatCurrency: { _ in nil })
        XCTAssertEqual(p.id, "premium")
    }
}

extension ProductMappingTests {
    func testPackageTypeFromSlot() {
        XCTAssertEqual(packageType(forSlot: "$rov_monthly"), .monthly)
        XCTAssertEqual(packageType(forSlot: "$rov_annual"), .annual)
        XCTAssertEqual(packageType(forSlot: "weird_slot"), .custom)
    }
    func testOfferingAccessors() {
        let prod = StoreProduct(id: "x", type: .subscription, productCategory: .subscription,
            displayName: "x", description: nil, priceString: nil, price: nil, currencyCode: nil,
            subscriptionPeriod: nil, subscriptionGroupIdentifier: nil, isFamilyShareable: false,
            introPrice: nil, discounts: [], isEligibleForIntroOffer: nil, subscriptionOptions: nil,
            defaultOption: nil, pricePerWeek: nil, pricePerMonth: nil, pricePerYear: nil,
            pricePerWeekString: nil, pricePerMonthString: nil, pricePerYearString: nil, rawStoreProduct: nil)
        let pkg = Package(identifier: "$rov_annual", packageType: .annual, product: prod)
        let off = Offering(identifier: "default", isDefault: true, packages: [pkg])
        XCTAssertEqual(off.annual?.identifier, "$rov_annual")
        XCTAssertNil(off.monthly)
        XCTAssertEqual(off.package(identifier: "$rov_annual")?.packageType, .annual)
    }
}
