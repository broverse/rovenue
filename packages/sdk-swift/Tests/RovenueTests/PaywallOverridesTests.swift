//  PaywallOverridesTests.swift — `applyOverrides` case table, ported
//  verbatim from packages/shared/src/paywall/validate.test.ts's
//  `applyOverrides` describe block (D-Task 1's shared cross-platform case
//  table), plus `activeOverrideConditions` (the cell-scoped/selected-scoped
//  condition-set helper backing RovenuePaywallView's per-node override
//  application).

import XCTest
@testable import Rovenue

final class PaywallOverridesTests: XCTestCase {
    // MARK: - applyOverrides(_: TextProps, ...) — the shared case table

    private let baseText = TextProps(
        id: "t1", key: "title_key", role: .title, color: ThemePair(light: "#000", dark: nil), align: .start)

    func test_returnsUnchanged_whenNodeHasNoOverrides() {
        let result = applyOverrides(baseText, active: OverrideActiveConditions(introEligible: false, selected: false))
        XCTAssertEqual(result.key, baseText.key)
        XCTAssertEqual(result.align, baseText.align)
        XCTAssertEqual(result.color, baseText.color)
    }

    func test_returnsUnchanged_whenOverridesExistButNoneAreActive() {
        let overrides = [NodeOverride(when: .introEligible, props: TextOverrideProps(align: .center))]
        let node = TextProps(id: baseText.id, key: baseText.key, role: baseText.role, color: baseText.color,
                              align: baseText.align, overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: false, selected: false))
        XCTAssertEqual(result.align, node.align)
        XCTAssertEqual(result.key, node.key)
    }

    func test_mergesMatchingIntroEligibleOverrideProps() {
        let overrides = [NodeOverride(when: .introEligible, props: TextOverrideProps(key: "intro_key", align: .center))]
        let node = TextProps(id: baseText.id, key: baseText.key, role: baseText.role, color: baseText.color,
                              align: baseText.align, overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: true, selected: false))
        XCTAssertEqual(result.key, "intro_key")
        XCTAssertEqual(result.align, .center)
        XCTAssertEqual(result.color, baseText.color)
    }

    func test_mergesMatchingSelectedOverrideProps() {
        let overrides = [NodeOverride(when: .selected, props: TextOverrideProps(align: .end))]
        let node = TextProps(id: baseText.id, key: baseText.key, role: baseText.role, color: baseText.color,
                              align: baseText.align, overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: false, selected: true))
        XCTAssertEqual(result.align, .end)
    }

    func test_appliesOverridesInArrayOrder_laterWinsOnSharedKeys() {
        let overrides = [
            NodeOverride(when: .introEligible, props: TextOverrideProps(align: .center)),
            NodeOverride(when: .introEligible, props: TextOverrideProps(align: .end)),
        ]
        let node = TextProps(id: baseText.id, key: baseText.key, role: baseText.role, color: baseText.color,
                              align: baseText.align, overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: true, selected: false))
        XCTAssertEqual(result.align, .end)
    }

    func test_doesNotDeepMerge_laterOverridesColorWhollyReplacesEarlier() {
        let overrides = [
            NodeOverride(when: .introEligible, props: TextOverrideProps(color: ThemePair(light: "#111", dark: nil))),
            NodeOverride(when: .introEligible, props: TextOverrideProps(color: ThemePair(light: "#222", dark: nil))),
        ]
        let node = TextProps(id: baseText.id, key: baseText.key, role: baseText.role, color: baseText.color,
                              align: baseText.align, overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: true, selected: false))
        XCTAssertEqual(result.color, ThemePair(light: "#222", dark: nil))
    }

    func test_leavesUntouchedBasePropsIntact_whenOnlySomePropsAreOverridden() {
        let overrides = [NodeOverride(when: .introEligible, props: TextOverrideProps(align: .end))]
        let node = TextProps(id: baseText.id, key: baseText.key, role: baseText.role, color: baseText.color,
                              align: baseText.align, overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: true, selected: false))
        XCTAssertEqual(result.key, baseText.key)
        XCTAssertEqual(result.color, baseText.color)
    }

    func test_skipsOverrideWithUnknownWhenKind_withoutThrowing() {
        // `props` non-nil here even though this only ever happens for `.unknown`
        // via a decode (where props is always nil) — programmatically
        // constructing it this way asserts the skip is driven by `when`
        // alone, not by `props` being absent.
        let overrides = [NodeOverride(when: .unknown, props: TextOverrideProps(align: .end))]
        let node = TextProps(id: baseText.id, key: baseText.key, role: baseText.role, color: baseText.color,
                              align: baseText.align, overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: true, selected: true))
        XCTAssertEqual(result.align, node.align)
        XCTAssertEqual(result.key, node.key)
    }

    func test_isGenericOverAnyNodeSubtype_worksOnPackageListToo() {
        let node = PackageListProps(id: "p1", packageIds: [], cellLayout: .row)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: false, selected: false))
        XCTAssertEqual(result.id, node.id)
        XCTAssertEqual(result.packageIds, node.packageIds)
    }

    // MARK: - applyOverrides(_: BuilderNode, ...) dispatch

    func test_builderNodeDispatch_appliesToTheWrappedProps() {
        let overrides = [NodeOverride(when: .introEligible, props: TextOverrideProps(key: "intro_key"))]
        let node = BuilderNode.text(TextProps(id: "t", key: "base_key", role: .body, overrides: overrides))
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: true, selected: false))
        guard case .text(let p) = result else { return XCTFail("expected .text") }
        XCTAssertEqual(p.key, "intro_key")
    }

    func test_builderNodeDispatch_unknownNodePassesThroughUnchanged() {
        let node = BuilderNode.unknown(id: "u1", fallback: nil)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: true, selected: true))
        XCTAssertEqual(result.id, "u1")
    }

    // MARK: - applyOverrides for the other 5 node payload types (spot checks)

    func test_stackProps_mergesSpacingAlignBackgroundCornerRadius() {
        let overrides = [NodeOverride(when: .selected, props: StackOverrideProps(
            spacing: 4, align: .start, background: ThemePair(light: "#eee", dark: nil), cornerRadius: 2))]
        let node = StackProps(id: "s", axis: .v, children: [], overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: false, selected: true))
        XCTAssertEqual(result.spacing, 4)
        XCTAssertEqual(result.align, .start)
        XCTAssertEqual(result.background, ThemePair(light: "#eee", dark: nil))
        XCTAssertEqual(result.cornerRadius, 2)
    }

    func test_imageProps_mergesCornerRadiusOnly() {
        let overrides = [NodeOverride(when: .introEligible, props: ImageOverrideProps(cornerRadius: 24))]
        let node = ImageProps(id: "i", url: ThemePair(light: "https://x", dark: nil), overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: true, selected: false))
        XCTAssertEqual(result.cornerRadius, 24)
    }

    func test_buttonProps_mergesLabelKeyAndStyle() {
        let overrides = [NodeOverride(when: .selected, props: ButtonOverrideProps(labelKey: "cta_selected", style: .secondary))]
        let node = ButtonProps(id: "b", labelKey: "cta", style: .primary, action: .close, overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: false, selected: true))
        XCTAssertEqual(result.labelKey, "cta_selected")
        XCTAssertEqual(result.style, .secondary)
        XCTAssertEqual(result.action, .close)
    }

    func test_purchaseButtonProps_mergesLabelKey() {
        let overrides = [NodeOverride(when: .selected, props: PurchaseButtonOverrideProps(labelKey: "buy_selected"))]
        let node = PurchaseButtonProps(id: "pb", labelKey: "buy", overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: false, selected: true))
        XCTAssertEqual(result.labelKey, "buy_selected")
    }

    func test_spacerProps_isAlwaysANoOp() {
        let overrides = [NodeOverride(when: .selected, props: SpacerOverrideProps())]
        let node = SpacerProps(id: "sp", size: 8, overrides: overrides)
        let result = applyOverrides(node, active: OverrideActiveConditions(introEligible: false, selected: true))
        XCTAssertEqual(result.size, 8)
    }

    // MARK: - activeOverrideConditions

    func test_activeConditions_outsideCellTemplate_usesSelectedPackage() {
        let offering = makeOffering(products: [("monthly", true), ("annual", false)])
        let active = activeOverrideConditions(cellPackageId: nil, selectedPackageId: "monthly", offering: offering)
        XCTAssertTrue(active.introEligible)
        XCTAssertFalse(active.selected, "selected is only ever true inside a cellTemplate subtree")
    }

    func test_activeConditions_outsideCellTemplate_noSelection_introEligibleFalse() {
        let offering = makeOffering(products: [("monthly", true)])
        let active = activeOverrideConditions(cellPackageId: nil, selectedPackageId: nil, offering: offering)
        XCTAssertFalse(active.introEligible)
        XCTAssertFalse(active.selected)
    }

    func test_activeConditions_insideCellTemplate_usesTheCellsOwnPackage() {
        let offering = makeOffering(products: [("monthly", false), ("annual", true)])
        // Global selection is "monthly" (not eligible), but this cell is "annual" (eligible).
        let active = activeOverrideConditions(cellPackageId: "annual", selectedPackageId: "monthly", offering: offering)
        XCTAssertTrue(active.introEligible)
        XCTAssertFalse(active.selected, "this cell isn't the globally selected one")
    }

    func test_activeConditions_insideCellTemplate_selectedTrueOnlyForTheSelectedCell() {
        let offering = makeOffering(products: [("monthly", false), ("annual", false)])
        let selectedCell = activeOverrideConditions(cellPackageId: "annual", selectedPackageId: "annual", offering: offering)
        XCTAssertTrue(selectedCell.selected)
        let otherCell = activeOverrideConditions(cellPackageId: "monthly", selectedPackageId: "annual", offering: offering)
        XCTAssertFalse(otherCell.selected)
    }

    func test_activeConditions_missingPackageInOffering_introEligibleFalse() {
        let active = activeOverrideConditions(cellPackageId: "ghost", selectedPackageId: nil, offering: nil)
        XCTAssertFalse(active.introEligible)
        XCTAssertFalse(active.selected)
    }
}

// MARK: - Test helpers

private func makeOffering(products: [(id: String, eligible: Bool)]) -> Offering {
    let packages = products.map { entry in
        Package(identifier: entry.id, packageType: .custom, product: StoreProduct(
            id: entry.id, type: .subscription, productCategory: .subscription, displayName: entry.id,
            description: nil, priceString: nil, price: nil, currencyCode: nil, subscriptionPeriod: nil,
            subscriptionGroupIdentifier: nil, isFamilyShareable: false, introPrice: nil, discounts: [],
            isEligibleForIntroOffer: entry.eligible, subscriptionOptions: nil, defaultOption: nil,
            pricePerWeek: nil, pricePerMonth: nil, pricePerYear: nil, pricePerWeekString: nil,
            pricePerMonthString: nil, pricePerYearString: nil, rawStoreProduct: nil))
    }
    return Offering(identifier: "default", isDefault: true, packages: packages)
}
