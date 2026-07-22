//  PaywallViewModelHelpersTests.swift — PackageView mapping table +
//  package-selection semantics (`effectivePackageIds` / `initialSelection`),
//  mirroring packages/paywall-renderer/src/renderer.test.tsx's "selection"
//  describe block and nodes.tsx's `effectivePackageIds`.

import XCTest
@testable import Rovenue

final class PaywallViewModelHelpersTests: XCTestCase {
    // MARK: - packageView(from:displayName:) mapping table

    func testMonthlySubscription() {
        let product = makeStoreProduct(priceString: "$4.99", subscriptionPeriod: period(.month))
        let view = packageView(from: product, displayName: "Monthly")
        XCTAssertEqual(view, PackageView(packageName: "Monthly", price: "$4.99", pricePerPeriod: "$4.99/month", period: "month"))
    }

    func testYearlySubscription() {
        let product = makeStoreProduct(priceString: "$39.99", subscriptionPeriod: period(.year))
        let view = packageView(from: product, displayName: "Annual")
        XCTAssertEqual(view, PackageView(packageName: "Annual", price: "$39.99", pricePerPeriod: "$39.99/year", period: "year"))
    }

    func testWeeklySubscription() {
        let product = makeStoreProduct(priceString: "$1.99", subscriptionPeriod: period(.week))
        let view = packageView(from: product, displayName: "Weekly")
        XCTAssertEqual(view, PackageView(packageName: "Weekly", price: "$1.99", pricePerPeriod: "$1.99/week", period: "week"))
    }

    func testDailySubscription() {
        let product = makeStoreProduct(priceString: "$0.49", subscriptionPeriod: period(.day))
        let view = packageView(from: product, displayName: "Daily")
        XCTAssertEqual(view, PackageView(packageName: "Daily", price: "$0.49", pricePerPeriod: "$0.49/day", period: "day"))
    }

    func testNonSubscriptionProductHasEmptyPeriod() {
        let product = makeStoreProduct(priceString: "$9.99", subscriptionPeriod: nil, category: .nonSubscription, type: .nonConsumable)
        let view = packageView(from: product, displayName: "Lifetime")
        XCTAssertEqual(view, PackageView(packageName: "Lifetime", price: "$9.99", pricePerPeriod: "$9.99", period: ""))
    }

    func testNilProductYieldsEmptyPriceFieldsButKeepsDisplayName() {
        let view = packageView(from: nil, displayName: "Annual")
        XCTAssertEqual(view, PackageView(packageName: "Annual", price: "", pricePerPeriod: "", period: ""))
    }

    func testNilPriceStringWithSubscriptionPeriodStillYieldsPeriodLabel() {
        let product = makeStoreProduct(priceString: nil, subscriptionPeriod: period(.month))
        let view = packageView(from: product, displayName: "Monthly")
        XCTAssertEqual(view, PackageView(packageName: "Monthly", price: "", pricePerPeriod: "/month", period: "month"))
    }

    // MARK: - packageView(from:displayName:offering:) — Phase D3 optional fields

    func testPricePerWeekMonthYearPassThroughVerbatimFromProduct() {
        let product = makeStoreProduct(priceString: "$39.99", subscriptionPeriod: period(.year),
                                        pricePerWeekString: "$0.77", pricePerMonthString: "$3.33",
                                        pricePerYearString: "$39.99")
        let view = packageView(from: product, displayName: "Annual")
        XCTAssertEqual(view.pricePerWeek, "$0.77")
        XCTAssertEqual(view.pricePerMonth, "$3.33")
        XCTAssertEqual(view.pricePerYear, "$39.99")
    }

    func testPricePerDayDerivedFromNumericPricePerWeekAndCurrencyCode() {
        let product = makeStoreProduct(priceString: "$0.77", subscriptionPeriod: period(.week),
                                        currencyCode: "USD", pricePerWeek: Decimal(0.77))
        let view = packageView(from: product, displayName: "Weekly")
        XCTAssertEqual(view.pricePerDay, Decimal(0.77 / 7).formatted(.currency(code: "USD")))
    }

    func testPricePerDayNilWithoutNumericPricePerWeek() {
        let product = makeStoreProduct(priceString: "$0.77", subscriptionPeriod: period(.week),
                                        currencyCode: "USD", pricePerWeek: nil)
        let view = packageView(from: product, displayName: "Weekly")
        XCTAssertNil(view.pricePerDay)
    }

    func testPricePerDayNilWithoutCurrencyCode() {
        let product = makeStoreProduct(priceString: "$0.77", subscriptionPeriod: period(.week),
                                        currencyCode: nil, pricePerWeek: Decimal(0.77))
        let view = packageView(from: product, displayName: "Weekly")
        XCTAssertNil(view.pricePerDay)
    }

    func testIntroPriceAndPeriodFromStoreProductIntroPrice() {
        let intro = IntroPrice(price: Decimal(0.99), priceString: "$0.99", currencyCode: "USD",
                                period: period(.week), cycles: 1, paymentMode: .freeTrial)
        let product = makeStoreProduct(priceString: "$39.99", subscriptionPeriod: period(.year), introPrice: intro)
        let view = packageView(from: product, displayName: "Annual")
        XCTAssertEqual(view.introPrice, "$0.99")
        XCTAssertEqual(view.introPeriod, "week")
    }

    func testIntroPriceAndPeriodNilWithoutIntroOffer() {
        let product = makeStoreProduct(priceString: "$39.99", subscriptionPeriod: period(.year))
        let view = packageView(from: product, displayName: "Annual")
        XCTAssertNil(view.introPrice)
        XCTAssertNil(view.introPeriod)
    }

    func testRelativeDiscountNilWithoutOffering() {
        let product = makeStoreProduct(priceString: "$39.99", subscriptionPeriod: period(.year), pricePerYear: Decimal(39.99))
        let view = packageView(from: product, displayName: "Annual", offering: nil)
        XCTAssertNil(view.relativeDiscount)
    }

    func testRelativeDiscountNilWithFewerThanTwoComparablePackages() {
        let annual = makeStoreProduct(priceString: "$39.99", subscriptionPeriod: period(.year), pricePerYear: Decimal(39.99))
        let monthlyNoNumericPrice = makeStoreProduct(priceString: "$4.99", subscriptionPeriod: period(.month))
        let offering = Offering(identifier: "default", isDefault: true, packages: [
            Package(identifier: "annual", packageType: .annual, product: annual),
            Package(identifier: "monthly", packageType: .monthly, product: monthlyNoNumericPrice),
        ])
        let view = packageView(from: annual, displayName: "Annual", offering: offering)
        XCTAssertNil(view.relativeDiscount, "only 1 package has a numeric pricePerYear")
    }

    func testRelativeDiscountComputedAcrossComparableOfferingPackages() {
        // Annual is the cheapest per-year; monthly ($4.99*12=$59.88/yr equivalent)
        // is the most expensive -> annual's discount vs. the max.
        let annual = makeStoreProduct(priceString: "$39.99", subscriptionPeriod: period(.year), pricePerYear: Decimal(39.99))
        let monthly = makeStoreProduct(priceString: "$4.99", subscriptionPeriod: period(.month), pricePerYear: Decimal(59.88))
        let offering = Offering(identifier: "default", isDefault: true, packages: [
            Package(identifier: "annual", packageType: .annual, product: annual),
            Package(identifier: "monthly", packageType: .monthly, product: monthly),
        ])
        let annualView = packageView(from: annual, displayName: "Annual", offering: offering)
        // round((1 - 39.99/59.88) * 100) = round(33.22...) = 33
        XCTAssertEqual(annualView.relativeDiscount, "33%")

        let monthlyView = packageView(from: monthly, displayName: "Monthly", offering: offering)
        // The max-priced package has 0% discount relative to itself.
        XCTAssertEqual(monthlyView.relativeDiscount, "0%")
    }

    func testRelativeDiscountNilForProductWithNoNumericPricePerYear() {
        let annual = makeStoreProduct(priceString: "$39.99", subscriptionPeriod: period(.year), pricePerYear: Decimal(39.99))
        let monthly = makeStoreProduct(priceString: "$4.99", subscriptionPeriod: period(.month), pricePerYear: Decimal(59.88))
        let lifetime = makeStoreProduct(priceString: "$99.99", subscriptionPeriod: nil, category: .nonSubscription, type: .nonConsumable)
        let offering = Offering(identifier: "default", isDefault: true, packages: [
            Package(identifier: "annual", packageType: .annual, product: annual),
            Package(identifier: "monthly", packageType: .monthly, product: monthly),
            Package(identifier: "lifetime", packageType: .lifetime, product: lifetime),
        ])
        let view = packageView(from: lifetime, displayName: "Lifetime", offering: offering)
        XCTAssertNil(view.relativeDiscount)
    }

    // MARK: - effectivePackageIds

    func testEffectivePackageIdsReturnsExplicitIdsWhenNonEmpty() {
        let node = PackageListProps(id: "pl", packageIds: ["monthly", "annual"], cellLayout: .row)
        XCTAssertEqual(effectivePackageIds(node, offering: offering(ids: ["monthly", "annual", "lifetime"])), ["monthly", "annual"])
    }

    func testEffectivePackageIdsReturnsExplicitIdsEvenWithoutOffering() {
        let node = PackageListProps(id: "pl", packageIds: ["monthly"], cellLayout: .row)
        XCTAssertEqual(effectivePackageIds(node, offering: nil), ["monthly"])
    }

    func testEffectivePackageIdsFallsBackToOfferingWhenEmpty() {
        let node = PackageListProps(id: "pl", packageIds: [], cellLayout: .column)
        XCTAssertEqual(effectivePackageIds(node, offering: offering(ids: ["monthly", "annual"])), ["monthly", "annual"])
    }

    func testEffectivePackageIdsEmptyWithNoOfferingReturnsEmpty() {
        let node = PackageListProps(id: "pl", packageIds: [], cellLayout: .column)
        XCTAssertEqual(effectivePackageIds(node, offering: nil), [])
    }

    // MARK: - initialSelection

    func testInitialSelectionPrefersDefaultSelected() {
        let root = stackRoot(children: [
            .packageList(PackageListProps(id: "pl", packageIds: ["monthly", "annual"], defaultSelected: "annual", cellLayout: .row)),
        ])
        XCTAssertEqual(initialSelection(root, offering: offering(ids: ["monthly", "annual"])), "annual")
    }

    func testInitialSelectionEmptyStringDefaultSelectedIsTreatedAsAbsent() {
        let root = stackRoot(children: [
            .packageList(PackageListProps(id: "pl", packageIds: ["monthly", "annual"], defaultSelected: "", cellLayout: .row)),
        ])
        XCTAssertEqual(initialSelection(root, offering: offering(ids: ["monthly", "annual"])), "monthly")
    }

    func testInitialSelectionFallsBackToFirstPackageIdWhenDefaultSelectedAbsent() {
        let root = stackRoot(children: [
            .packageList(PackageListProps(id: "pl", packageIds: ["monthly", "annual"], cellLayout: .row)),
        ])
        XCTAssertEqual(initialSelection(root, offering: offering(ids: ["monthly", "annual"])), "monthly")
    }

    func testInitialSelectionFallsBackToOfferingFirstPackageWhenNoPackageListAtAll() {
        let root = stackRoot(children: [
            .purchaseButton(PurchaseButtonProps(id: "purchase", labelKey: "buy")),
        ])
        XCTAssertEqual(initialSelection(root, offering: offering(ids: ["monthly", "annual"])), "monthly")
    }

    func testInitialSelectionFallsBackToOfferingFirstPackageWhenPackageIdsEmpty() {
        let root = stackRoot(children: [
            .packageList(PackageListProps(id: "pl", packageIds: [], cellLayout: .row)),
        ])
        XCTAssertEqual(initialSelection(root, offering: offering(ids: ["monthly", "annual"])), "monthly")
    }

    func testInitialSelectionResolvesToNilWithNoPackageListAndNoOffering() {
        let root = stackRoot(children: [
            .purchaseButton(PurchaseButtonProps(id: "purchase", labelKey: "buy")),
        ])
        XCTAssertNil(initialSelection(root, offering: nil))
    }

    func testInitialSelectionFindsPackageListNestedInsideChildStacks() {
        let nested = stackRoot(children: [
            .stack(StackProps(id: "inner", axis: .z, children: [
                .packageList(PackageListProps(id: "pl", packageIds: ["annual"], cellLayout: .row)),
            ])),
        ])
        XCTAssertEqual(initialSelection(nested, offering: offering(ids: ["monthly", "annual"])), "annual")
    }
}

// MARK: - Test helpers

private func period(_ unit: PeriodUnit) -> Period {
    Period(value: 1, unit: unit, iso8601: "P1\(unit)")
}

private func makeStoreProduct(
    priceString: String?,
    subscriptionPeriod: Period?,
    category: ProductCategory = .subscription,
    type: ProductType = .subscription,
    currencyCode: String? = nil,
    introPrice: IntroPrice? = nil,
    pricePerWeek: Decimal? = nil,
    pricePerMonth: Decimal? = nil,
    pricePerYear: Decimal? = nil,
    pricePerWeekString: String? = nil,
    pricePerMonthString: String? = nil,
    pricePerYearString: String? = nil
) -> StoreProduct {
    StoreProduct(
        id: "product", type: type, productCategory: category, displayName: "unused", description: nil,
        priceString: priceString, price: nil, currencyCode: currencyCode, subscriptionPeriod: subscriptionPeriod,
        subscriptionGroupIdentifier: nil, isFamilyShareable: false, introPrice: introPrice, discounts: [],
        isEligibleForIntroOffer: nil, subscriptionOptions: nil, defaultOption: nil, pricePerWeek: pricePerWeek,
        pricePerMonth: pricePerMonth, pricePerYear: pricePerYear, pricePerWeekString: pricePerWeekString,
        pricePerMonthString: pricePerMonthString, pricePerYearString: pricePerYearString, rawStoreProduct: nil)
}

private func offering(ids: [String]) -> Offering {
    let packages = ids.map { id in
        Package(identifier: id, packageType: .custom, product: makeStoreProduct(priceString: nil, subscriptionPeriod: nil))
    }
    return Offering(identifier: "default", isDefault: true, packages: packages)
}

private func stackRoot(children: [BuilderNode]) -> BuilderNode {
    .stack(StackProps(id: "root", axis: .v, children: children))
}
