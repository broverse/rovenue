import XCTest
@testable import Rovenue

final class StoreProductTypesTests: XCTestCase {
    func testEnrichedStoreProductConstructs() {
        let period = Period(value: 1, unit: .month, iso8601: "P1M")
        let intro = IntroPrice(price: 0, priceString: "Free", currencyCode: "USD",
                               period: period, cycles: 1, paymentMode: .freeTrial)
        let product = StoreProduct(
            id: "p1", type: .subscription, productCategory: .subscription,
            displayName: "Premium", description: "Pro plan",
            priceString: "$9.99", price: 9.99, currencyCode: "USD",
            subscriptionPeriod: period, subscriptionGroupIdentifier: "grp",
            isFamilyShareable: false, introPrice: intro, discounts: [],
            isEligibleForIntroOffer: true, subscriptionOptions: nil, defaultOption: nil,
            pricePerWeek: nil, pricePerMonth: 9.99, pricePerYear: nil,
            pricePerWeekString: nil, pricePerMonthString: "$9.99", pricePerYearString: nil,
            rawStoreProduct: nil)
        XCTAssertEqual(product.introPrice?.paymentMode, .freeTrial)
        XCTAssertEqual(product.subscriptionPeriod?.iso8601, "P1M")
        XCTAssertEqual(product.productCategory, .subscription)
    }
}
