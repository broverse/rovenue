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
    type: ProductType = .subscription
) -> StoreProduct {
    StoreProduct(
        id: "product", type: type, productCategory: category, displayName: "unused", description: nil,
        priceString: priceString, price: nil, currencyCode: nil, subscriptionPeriod: subscriptionPeriod,
        subscriptionGroupIdentifier: nil, isFamilyShareable: false, introPrice: nil, discounts: [],
        isEligibleForIntroOffer: nil, subscriptionOptions: nil, defaultOption: nil, pricePerWeek: nil,
        pricePerMonth: nil, pricePerYear: nil, pricePerWeekString: nil, pricePerMonthString: nil,
        pricePerYearString: nil, rawStoreProduct: nil)
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
