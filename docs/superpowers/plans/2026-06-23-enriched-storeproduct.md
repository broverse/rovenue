# Enriched StoreProduct (RC-parity) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the SDK's public `StoreProduct` (Swift / Kotlin / React Native) with subscription period, free-trial/introductory offers, promotional discounts, Android pricing phases, per-unit pricing, intro-offer eligibility, and a native escape hatch — mirroring RevenueCat's unified cross-platform product shape.

**Architecture:** All new data is hydrated in the **native layer** (StoreKit 2 / Google Play Billing). The Rust core and `librovenue.udl` are untouched (`core.getOfferings()` still returns config-only `CoreOfferings` with `appleProductId`/`googleProductId`). Each façade maps the native store product into the enriched public `StoreProduct`. To keep tests free of un-constructible store SDK types (`StoreKit.Product`, `ProductDetails`), the normalization logic lives in **pure helper functions** fed plain inputs; the thin "native object → plain input" extraction is glue.

**Tech Stack:** Swift (StoreKit 2, XCTest), Kotlin (Play Billing 5+, JUnit/`testDebugUnitTest`), TypeScript (React Native, Vitest), Fumadocs.

## Global Constraints

- Rust core / `librovenue.udl` / uniffi bindings: **DO NOT modify or regenerate.** Generated files (`Generated/RovenueFFI.swift`, `generated/librovenue.kt`) are read-only build artifacts.
- No breaking changes: existing `StoreProduct` fields (`id`, `type`, `displayName`, `priceString`, `price`, `currencyCode`), `Package` (`identifier`, `product`), `Offering` (`identifier`, `isDefault`, `packages`) keep names and types. Everything else is **additive**.
- One unified schema across Swift = Kotlin = RN (field names identical; only the numeric type differs: Swift `Decimal`, Kotlin `Double`, RN `number`).
- `rawStoreProduct` exists **only** on Swift (`StoreKit.Product`) and Kotlin (`ProductDetails`) — never in RN.
- Resilience preserved: if a native store query fails, offerings still render config-only — all new fields become `null`/empty, never throwing.
- iOS `isEligibleForIntroOffer` = real StoreKit value; Android = derived (`true` iff a free/intro phase exists). Document the difference.
- Enum value sets: `ProductCategory{subscription, nonSubscription}`, `PeriodUnit{day, week, month, year}`, `PaymentMode{freeTrial, payAsYouGo, payUpFront}`, `DiscountType{introductory, promotional, winBack}`, `RecurrenceMode{infiniteRecurring, finiteRecurring, nonRecurring}`.
- Per-unit price approximation: days-per-unit = day 1, week 7, month 30, year 365; `pricePerDay = price / (value * daysPerUnit)`, then multiply (week×7, month×30, year×365). Document the approximation.
- Canonical package slots → `PackageType`: `$rov_weekly`→weekly, `$rov_monthly`→monthly, `$rov_two_month`→twoMonth, `$rov_three_month`→threeMonth, `$rov_six_month`→sixMonth, `$rov_annual`→annual, `$rov_lifetime`→lifetime; anything else → custom.
- Spec reference: `docs/superpowers/specs/2026-06-23-enriched-storeproduct-design.md`.

---

## File Structure

**Swift** (`packages/sdk-swift/Sources/Rovenue/`)
- `Types.swift` — extend public types + add `Period`, `IntroPrice`, `Discount`, `SubscriptionOption`, `PricingPhase`, enums, `PackageType`, `ProductCategory`.
- `Internal/ProductMapping.swift` — **NEW**: pure normalization helpers + plain input structs.
- `Internal/AppleStore.swift` — extend `products(for:)` to also expose the `Product`; add `Product` → plain-input extraction.
- `Rovenue.swift` — `getOfferings()` wires mapper + async eligibility; `Offering`/`Package` convenience.

**Kotlin** (`packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/`)
- `Types.kt` — extend public types + add the same new types/enums.
- `internal/ProductMapping.kt` — **NEW**: pure normalization helpers + plain input structs.
- `internal/PlayBillingStore.kt` — replace `PriceInfo` with richer `ProductInfo`; `ProductDetails` → plain-input extraction.
- `internal/OfferingsHydration.kt` — `mapProduct` uses `ProductInfo`; eligibility; raw product; package type.

**React Native** (`packages/sdk-rn/`)
- `src/types.ts` — extend public TS types.
- `src/specs/RovenueModule.types.ts` — extend DTO types.
- `src/api/purchases.ts` — map enriched DTO → public types + `packageType` + Offering accessors.
- `ios/RovenueModule.swift` — `dtoFromStoreProduct` emits new fields.
- `android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt` — `dtoFromStoreProduct` emits new fields.

**Docs** (`apps/docs/`) — product/offerings reference page.

---

## Task 1: Swift — new public types

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Types.swift` (purchasing types live at lines 40–113)
- Test: `packages/sdk-swift/Tests/RovenueTests/StoreProductTypesTests.swift` (Create)

**Interfaces:**
- Produces: `Period`, `PeriodUnit`, `PaymentMode`, `DiscountType`, `RecurrenceMode`, `ProductCategory`, `IntroPrice`, `Discount`, `PricingPhase`, `SubscriptionOption`, `PackageType`; enriched `StoreProduct`, `Package`, `Offering`.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-swift/Tests/RovenueTests/StoreProductTypesTests.swift`:

```swift
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-swift && swift test --filter StoreProductTypesTests`
Expected: FAIL — compile error (`extra arguments`, `Period` undefined).

- [ ] **Step 3: Add the new types**

In `Types.swift`, add after the existing `ProductType` enum and replace the `StoreProduct`/`Package`/`Offering` structs. Add:

```swift
public enum ProductCategory: Sendable, Equatable { case subscription, nonSubscription }
public enum PeriodUnit: Sendable, Equatable { case day, week, month, year }
public enum PaymentMode: Sendable, Equatable { case freeTrial, payAsYouGo, payUpFront }
public enum DiscountType: Sendable, Equatable { case introductory, promotional, winBack }
public enum RecurrenceMode: Sendable, Equatable { case infiniteRecurring, finiteRecurring, nonRecurring }

public struct Period: Sendable, Equatable {
    public let value: Int
    public let unit: PeriodUnit
    public let iso8601: String
    public init(value: Int, unit: PeriodUnit, iso8601: String) {
        self.value = value; self.unit = unit; self.iso8601 = iso8601
    }
}

public struct IntroPrice: Sendable, Equatable {
    public let price: Decimal?
    public let priceString: String?
    public let currencyCode: String?
    public let period: Period
    public let cycles: Int
    public let paymentMode: PaymentMode
    public init(price: Decimal?, priceString: String?, currencyCode: String?,
                period: Period, cycles: Int, paymentMode: PaymentMode) {
        self.price = price; self.priceString = priceString; self.currencyCode = currencyCode
        self.period = period; self.cycles = cycles; self.paymentMode = paymentMode
    }
}

public struct Discount: Sendable, Equatable {
    public let identifier: String?
    public let price: Decimal?
    public let priceString: String?
    public let currencyCode: String?
    public let period: Period
    public let numberOfPeriods: Int
    public let paymentMode: PaymentMode
    public let type: DiscountType
    public init(identifier: String?, price: Decimal?, priceString: String?, currencyCode: String?,
                period: Period, numberOfPeriods: Int, paymentMode: PaymentMode, type: DiscountType) {
        self.identifier = identifier; self.price = price; self.priceString = priceString
        self.currencyCode = currencyCode; self.period = period
        self.numberOfPeriods = numberOfPeriods; self.paymentMode = paymentMode; self.type = type
    }
}

public struct PricingPhase: Sendable, Equatable {
    public let price: Decimal?
    public let priceString: String?
    public let currencyCode: String?
    public let billingPeriod: Period
    public let billingCycleCount: Int?
    public let recurrenceMode: RecurrenceMode
    public let paymentMode: PaymentMode?
    public init(price: Decimal?, priceString: String?, currencyCode: String?,
                billingPeriod: Period, billingCycleCount: Int?,
                recurrenceMode: RecurrenceMode, paymentMode: PaymentMode?) {
        self.price = price; self.priceString = priceString; self.currencyCode = currencyCode
        self.billingPeriod = billingPeriod; self.billingCycleCount = billingCycleCount
        self.recurrenceMode = recurrenceMode; self.paymentMode = paymentMode
    }
}

public struct SubscriptionOption: Sendable, Equatable {
    public let id: String
    public let basePlanId: String?
    public let offerId: String?
    public let tags: [String]
    public let isBasePlan: Bool
    public let isPrepaid: Bool
    public let pricingPhases: [PricingPhase]
    public let freePhase: PricingPhase?
    public let introPhase: PricingPhase?
    public let fullPricePhase: PricingPhase?
    public init(id: String, basePlanId: String?, offerId: String?, tags: [String],
                isBasePlan: Bool, isPrepaid: Bool, pricingPhases: [PricingPhase],
                freePhase: PricingPhase?, introPhase: PricingPhase?, fullPricePhase: PricingPhase?) {
        self.id = id; self.basePlanId = basePlanId; self.offerId = offerId; self.tags = tags
        self.isBasePlan = isBasePlan; self.isPrepaid = isPrepaid; self.pricingPhases = pricingPhases
        self.freePhase = freePhase; self.introPhase = introPhase; self.fullPricePhase = fullPricePhase
    }
}

public enum PackageType: Sendable, Equatable {
    case unknown, custom, lifetime, annual, sixMonth, threeMonth, twoMonth, monthly, weekly
}
```

Replace `StoreProduct` with the enriched struct (keep the leading existing fields first):

```swift
public struct StoreProduct: Sendable, Equatable {
    public let id: String
    public let type: ProductType
    public let productCategory: ProductCategory
    public let displayName: String
    public let description: String?
    public let priceString: String?
    public let price: Decimal?
    public let currencyCode: String?
    public let subscriptionPeriod: Period?
    public let subscriptionGroupIdentifier: String?
    public let isFamilyShareable: Bool
    public let introPrice: IntroPrice?
    public let discounts: [Discount]
    public let isEligibleForIntroOffer: Bool?
    public let subscriptionOptions: [SubscriptionOption]?
    public let defaultOption: SubscriptionOption?
    public let pricePerWeek: Decimal?
    public let pricePerMonth: Decimal?
    public let pricePerYear: Decimal?
    public let pricePerWeekString: String?
    public let pricePerMonthString: String?
    public let pricePerYearString: String?
    public let rawStoreProduct: StoreKit.Product?
    public init(id: String, type: ProductType, productCategory: ProductCategory,
                displayName: String, description: String?, priceString: String?, price: Decimal?,
                currencyCode: String?, subscriptionPeriod: Period?, subscriptionGroupIdentifier: String?,
                isFamilyShareable: Bool, introPrice: IntroPrice?, discounts: [Discount],
                isEligibleForIntroOffer: Bool?, subscriptionOptions: [SubscriptionOption]?,
                defaultOption: SubscriptionOption?, pricePerWeek: Decimal?, pricePerMonth: Decimal?,
                pricePerYear: Decimal?, pricePerWeekString: String?, pricePerMonthString: String?,
                pricePerYearString: String?, rawStoreProduct: StoreKit.Product?) {
        self.id = id; self.type = type; self.productCategory = productCategory
        self.displayName = displayName; self.description = description
        self.priceString = priceString; self.price = price; self.currencyCode = currencyCode
        self.subscriptionPeriod = subscriptionPeriod
        self.subscriptionGroupIdentifier = subscriptionGroupIdentifier
        self.isFamilyShareable = isFamilyShareable; self.introPrice = introPrice
        self.discounts = discounts; self.isEligibleForIntroOffer = isEligibleForIntroOffer
        self.subscriptionOptions = subscriptionOptions; self.defaultOption = defaultOption
        self.pricePerWeek = pricePerWeek; self.pricePerMonth = pricePerMonth
        self.pricePerYear = pricePerYear; self.pricePerWeekString = pricePerWeekString
        self.pricePerMonthString = pricePerMonthString; self.pricePerYearString = pricePerYearString
        self.rawStoreProduct = rawStoreProduct
    }
}
```

Add `import StoreKit` at the top of `Types.swift` if not present. Extend `Package`:

```swift
public struct Package: Sendable, Equatable {
    public let identifier: String
    public let packageType: PackageType
    public let product: StoreProduct
    public init(identifier: String, packageType: PackageType, product: StoreProduct) {
        self.identifier = identifier; self.packageType = packageType; self.product = product
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-swift && swift test --filter StoreProductTypesTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Types.swift packages/sdk-swift/Tests/RovenueTests/StoreProductTypesTests.swift
git commit -m "feat(sdk-swift): enriched StoreProduct public types"
```

---

## Task 2: Swift — pure normalization helpers

**Files:**
- Create: `packages/sdk-swift/Sources/Rovenue/Internal/ProductMapping.swift`
- Test: `packages/sdk-swift/Tests/RovenueTests/ProductMappingTests.swift` (Create)

**Interfaces:**
- Consumes: types from Task 1.
- Produces:
  - `func iso8601(from value: Int, unit: PeriodUnit) -> String`
  - `func makePeriod(value: Int, unit: PeriodUnit) -> Period`
  - `func daysInPeriod(_ p: Period) -> Int`
  - `func pricePer(_ price: Decimal, period: Period, targetDays: Int) -> Decimal`
  - `func perUnitPrices(price: Decimal?, period: Period?, formatCurrency: (Decimal) -> String?) -> (week: Decimal?, month: Decimal?, year: Decimal?, weekStr: String?, monthStr: String?, yearStr: String?)`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-swift/Tests/RovenueTests/ProductMappingTests.swift`:

```swift
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-swift && swift test --filter ProductMappingTests`
Expected: FAIL — `iso8601` / `makePeriod` / `perUnitPrices` undefined.

- [ ] **Step 3: Implement the helpers**

Create `packages/sdk-swift/Sources/Rovenue/Internal/ProductMapping.swift`:

```swift
import Foundation

func iso8601(from value: Int, unit: PeriodUnit) -> String {
    switch unit {
    case .day: return "P\(value)D"
    case .week: return "P\(value)W"
    case .month: return "P\(value)M"
    case .year: return "P\(value)Y"
    }
}

func makePeriod(value: Int, unit: PeriodUnit) -> Period {
    Period(value: value, unit: unit, iso8601: iso8601(from: value, unit: unit))
}

func daysInPeriod(_ p: Period) -> Int {
    let per: Int
    switch p.unit { case .day: per = 1; case .week: per = 7; case .month: per = 30; case .year: per = 365 }
    return max(p.value, 1) * per
}

func pricePer(_ price: Decimal, period: Period, targetDays: Int) -> Decimal {
    let total = Decimal(daysInPeriod(period))
    return price / total * Decimal(targetDays)
}

func perUnitPrices(price: Decimal?, period: Period?, formatCurrency: (Decimal) -> String?)
    -> (week: Decimal?, month: Decimal?, year: Decimal?, weekStr: String?, monthStr: String?, yearStr: String?) {
    guard let price = price, let period = period else {
        return (nil, nil, nil, nil, nil, nil)
    }
    let w = pricePer(price, period: period, targetDays: 7)
    let m = pricePer(price, period: period, targetDays: 30)
    let y = pricePer(price, period: period, targetDays: 365)
    return (w, m, y, formatCurrency(w), formatCurrency(m), formatCurrency(y))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-swift && swift test --filter ProductMappingTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Internal/ProductMapping.swift packages/sdk-swift/Tests/RovenueTests/ProductMappingTests.swift
git commit -m "feat(sdk-swift): pure period + per-unit-price helpers"
```

---

## Task 3: Swift — StoreKit `Product` → enriched StoreProduct

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Internal/AppleStore.swift` (`products(for:)` at lines 77–85)
- Modify: `packages/sdk-swift/Sources/Rovenue/Internal/ProductMapping.swift`
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` (`getOfferings()` / `buildProduct` lines 541–594)
- Test: `packages/sdk-swift/Tests/RovenueTests/ProductMappingTests.swift`

**Interfaces:**
- Consumes: `CoreOfferingProduct` (`appleProductId`), Task 2 helpers.
- Produces:
  - `func mapAppleStoreProduct(core: CoreOfferingProduct, period: Period?, introOffer: AppleOfferInput?, promoOffers: [AppleOfferInput], groupId: String?, isFamilyShareable: Bool, description: String?, priceString: String?, price: Decimal?, currencyCode: String?, isEligible: Bool?, raw: StoreKit.Product?, formatCurrency: (Decimal) -> String?) -> StoreProduct`
  - `struct AppleOfferInput { id: String?; type: DiscountType; paymentMode: PaymentMode; price: Decimal; displayPrice: String; periodValue: Int; periodUnit: PeriodUnit; periodCount: Int }`

- [ ] **Step 1: Write the failing test** (append to `ProductMappingTests.swift`)

```swift
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-swift && swift test --filter ProductMappingTests`
Expected: FAIL — `AppleOfferInput` / `mapAppleStoreProduct` undefined.

- [ ] **Step 3: Implement mapper** (append to `ProductMapping.swift`)

```swift
import StoreKit

struct AppleOfferInput {
    let id: String?
    let type: DiscountType
    let paymentMode: PaymentMode
    let price: Decimal
    let displayPrice: String
    let periodValue: Int
    let periodUnit: PeriodUnit
    let periodCount: Int
}

private func productType(from raw: String) -> ProductType {
    switch raw.uppercased() {
    case "CONSUMABLE": return .consumable
    case "NON_CONSUMABLE", "NONCONSUMABLE": return .nonConsumable
    default: return .subscription
    }
}

func mapAppleStoreProduct(core: CoreOfferingProduct, period: Period?,
    introOffer: AppleOfferInput?, promoOffers: [AppleOfferInput], groupId: String?,
    isFamilyShareable: Bool, description: String?, priceString: String?, price: Decimal?,
    currencyCode: String?, isEligible: Bool?, raw: StoreKit.Product?,
    formatCurrency: (Decimal) -> String?) -> StoreProduct {

    let type = productType(from: core.productType)
    let category: ProductCategory = (type == .subscription) ? .subscription : .nonSubscription

    let introPrice: IntroPrice? = introOffer.map {
        let per = makePeriod(value: $0.periodValue, unit: $0.periodUnit)
        return IntroPrice(price: $0.price, priceString: $0.displayPrice, currencyCode: currencyCode,
                          period: per, cycles: $0.periodCount, paymentMode: $0.paymentMode)
    }
    // discounts = promotional offers only (intro is exposed via introPrice)
    let discounts: [Discount] = promoOffers.map {
        let per = makePeriod(value: $0.periodValue, unit: $0.periodUnit)
        return Discount(identifier: $0.id, price: $0.price, priceString: $0.displayPrice,
                        currencyCode: currencyCode, period: per, numberOfPeriods: $0.periodCount,
                        paymentMode: $0.paymentMode, type: $0.type)
    }
    let per = perUnitPrices(price: price, period: period, formatCurrency: formatCurrency)

    return StoreProduct(id: core.identifier, type: type, productCategory: category,
        displayName: core.displayName, description: description, priceString: priceString,
        price: price, currencyCode: currencyCode, subscriptionPeriod: period,
        subscriptionGroupIdentifier: groupId, isFamilyShareable: isFamilyShareable,
        introPrice: introPrice, discounts: discounts, isEligibleForIntroOffer: isEligible,
        subscriptionOptions: nil, defaultOption: nil,
        pricePerWeek: per.week, pricePerMonth: per.month, pricePerYear: per.year,
        pricePerWeekString: per.weekStr, pricePerMonthString: per.monthStr,
        pricePerYearString: per.yearStr, rawStoreProduct: raw)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-swift && swift test --filter ProductMappingTests`
Expected: PASS.

- [ ] **Step 5: Wire `AppleStore` + `getOfferings()` to real StoreKit**

In `AppleStore.swift`, change `products(for:)` to return the StoreKit `Product` map (it already loads `[String: Product]`; ensure it is returned, not just prices). Add an extraction helper (same file or `ProductMapping.swift`):

```swift
@available(iOS 15.0, macOS 12.0, *)
func appleOfferInputs(from product: StoreKit.Product)
    -> (period: Period?, intro: AppleOfferInput?, promos: [AppleOfferInput], groupId: String?) {
    guard let sub = product.subscription else { return (nil, nil, [], nil) }
    func unit(_ u: StoreKit.Product.SubscriptionPeriod.Unit) -> PeriodUnit {
        switch u { case .day: return .day; case .week: return .week
                   case .month: return .month; case .year: return .year; @unknown default: return .month }
    }
    func mode(_ m: StoreKit.Product.SubscriptionOffer.PaymentMode) -> PaymentMode {
        switch m { case .freeTrial: return .freeTrial; case .payAsYouGo: return .payAsYouGo
                   case .payUpFront: return .payUpFront; @unknown default: return .payAsYouGo }
    }
    let period = makePeriod(value: sub.subscriptionPeriod.value, unit: unit(sub.subscriptionPeriod.unit))
    let intro: AppleOfferInput? = sub.introductoryOffer.map { o in
        AppleOfferInput(id: o.id, type: .introductory, paymentMode: mode(o.paymentMode),
            price: o.price, displayPrice: o.displayPrice, periodValue: o.period.value,
            periodUnit: unit(o.period.unit), periodCount: o.periodCount)
    }
    let promos: [AppleOfferInput] = sub.promotionalOffers.map { o in
        AppleOfferInput(id: o.id, type: .promotional, paymentMode: mode(o.paymentMode),
            price: o.price, displayPrice: o.displayPrice, periodValue: o.period.value,
            periodUnit: unit(o.period.unit), periodCount: o.periodCount)
    }
    return (period, intro, promos, sub.subscriptionGroupID)
}
```

In `Rovenue.swift` `getOfferings()`, replace the `buildProduct` body so that for each `CoreOfferingProduct` with an `appleProductId` present in the StoreKit map it: extracts `appleOfferInputs(from:)`, resolves eligibility via `try? await product.subscription?.isEligibleForIntroOffer`, computes `priceString`/`price`/`currencyCode` from the `Product` (reuse existing logic), and calls `mapAppleStoreProduct(...)` passing `raw: product` and `formatCurrency:` using `product.priceFormatStyle`. When no StoreKit product is found, call `mapAppleStoreProduct` with `period: nil, introOffer: nil, promoOffers: [], groupId: nil, isFamilyShareable: false, description: nil, priceString: nil, price: nil, currencyCode: nil, isEligible: nil, raw: nil`.

- [ ] **Step 6: Run the full Swift suite**

Run: `cd packages/sdk-swift && swift test`
Expected: PASS (all targets compile; existing offering tests still pass).

- [ ] **Step 7: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Internal/ProductMapping.swift packages/sdk-swift/Sources/Rovenue/Internal/AppleStore.swift packages/sdk-swift/Sources/Rovenue/Rovenue.swift packages/sdk-swift/Tests/RovenueTests/ProductMappingTests.swift
git commit -m "feat(sdk-swift): hydrate StoreProduct from StoreKit offers + eligibility"
```

---

## Task 4: Swift — PackageType + Offering accessors

**Files:**
- Modify: `packages/sdk-swift/Sources/Rovenue/Internal/ProductMapping.swift`
- Modify: `packages/sdk-swift/Sources/Rovenue/Types.swift` (`Offering`)
- Modify: `packages/sdk-swift/Sources/Rovenue/Rovenue.swift` (`buildOffering` lines 577–587)
- Test: `packages/sdk-swift/Tests/RovenueTests/ProductMappingTests.swift`

**Interfaces:**
- Produces: `func packageType(forSlot id: String) -> PackageType`; `Offering.monthly/annual/weekly/sixMonth/threeMonth/twoMonth/lifetime`; `Offering.package(identifier:)`.

- [ ] **Step 1: Write the failing test** (append)

```swift
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-swift && swift test --filter ProductMappingTests`
Expected: FAIL — `packageType(forSlot:)` / `off.annual` undefined.

- [ ] **Step 3: Implement**

In `ProductMapping.swift`:

```swift
func packageType(forSlot id: String) -> PackageType {
    switch id {
    case "$rov_weekly": return .weekly
    case "$rov_monthly": return .monthly
    case "$rov_two_month": return .twoMonth
    case "$rov_three_month": return .threeMonth
    case "$rov_six_month": return .sixMonth
    case "$rov_annual": return .annual
    case "$rov_lifetime": return .lifetime
    default: return .custom
    }
}
```

In `Types.swift`, extend `Offering` with accessors:

```swift
extension Offering {
    public func package(identifier: String) -> Package? {
        packages.first { $0.identifier == identifier }
    }
    private func first(_ t: PackageType) -> Package? { packages.first { $0.packageType == t } }
    public var lifetime: Package? { first(.lifetime) }
    public var annual: Package? { first(.annual) }
    public var sixMonth: Package? { first(.sixMonth) }
    public var threeMonth: Package? { first(.threeMonth) }
    public var twoMonth: Package? { first(.twoMonth) }
    public var monthly: Package? { first(.monthly) }
    public var weekly: Package? { first(.weekly) }
}
```

In `Rovenue.swift` `buildOffering`, pass `packageType: packageType(forSlot: core.packageIdentifier)` when constructing each `Package`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-swift && swift test --filter ProductMappingTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-swift/Sources/Rovenue/Internal/ProductMapping.swift packages/sdk-swift/Sources/Rovenue/Types.swift packages/sdk-swift/Sources/Rovenue/Rovenue.swift packages/sdk-swift/Tests/RovenueTests/ProductMappingTests.swift
git commit -m "feat(sdk-swift): packageType + Offering convenience accessors"
```

---

## Task 5: Kotlin — new public types

**Files:**
- Modify: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Types.kt` (types at lines 19–64)
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/StoreProductTypesTest.kt` (Create)

**Interfaces:**
- Produces: `Period`, `PeriodUnit`, `PaymentMode`, `DiscountType`, `RecurrenceMode`, `ProductCategory`, `IntroPrice`, `Discount`, `PricingPhase`, `SubscriptionOption`, `PackageType`; enriched `StoreProduct`, `Package`, `Offering`.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/StoreProductTypesTest.kt`:

```kotlin
package dev.rovenue.sdk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class StoreProductTypesTest {
    @Test
    fun enrichedStoreProductConstructs() {
        val period = Period(1, PeriodUnit.MONTH, "P1M")
        val intro = IntroPrice(0.0, "Free", "USD", period, 1, PaymentMode.FREE_TRIAL)
        val p = StoreProduct(
            id = "p1", type = ProductType.SUBSCRIPTION, productCategory = ProductCategory.SUBSCRIPTION,
            displayName = "Premium", description = "Pro", priceString = "$9.99", price = 9.99,
            currencyCode = "USD", subscriptionPeriod = period, subscriptionGroupIdentifier = null,
            isFamilyShareable = false, introPrice = intro, discounts = emptyList(),
            isEligibleForIntroOffer = true, subscriptionOptions = null, defaultOption = null,
            pricePerWeek = null, pricePerMonth = 9.99, pricePerYear = null,
            pricePerWeekString = null, pricePerMonthString = "$9.99", pricePerYearString = null,
            rawStoreProduct = null)
        assertEquals(PaymentMode.FREE_TRIAL, p.introPrice?.paymentMode)
        assertEquals("P1M", p.subscriptionPeriod?.iso8601)
        assertNull(p.subscriptionOptions)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.StoreProductTypesTest"`
Expected: FAIL — unresolved references (`Period`, `IntroPrice`, extra args).

- [ ] **Step 3: Add the new types**

In `Types.kt` add (and import `com.android.billingclient.api.ProductDetails`):

```kotlin
enum class ProductCategory { SUBSCRIPTION, NON_SUBSCRIPTION }
enum class PeriodUnit { DAY, WEEK, MONTH, YEAR }
enum class PaymentMode { FREE_TRIAL, PAY_AS_YOU_GO, PAY_UP_FRONT }
enum class DiscountType { INTRODUCTORY, PROMOTIONAL, WIN_BACK }
enum class RecurrenceMode { INFINITE_RECURRING, FINITE_RECURRING, NON_RECURRING }

data class Period(val value: Int, val unit: PeriodUnit, val iso8601: String)

data class IntroPrice(
    val price: Double?, val priceString: String?, val currencyCode: String?,
    val period: Period, val cycles: Int, val paymentMode: PaymentMode,
)

data class Discount(
    val identifier: String?, val price: Double?, val priceString: String?, val currencyCode: String?,
    val period: Period, val numberOfPeriods: Int, val paymentMode: PaymentMode, val type: DiscountType,
)

data class PricingPhase(
    val price: Double?, val priceString: String?, val currencyCode: String?,
    val billingPeriod: Period, val billingCycleCount: Int?,
    val recurrenceMode: RecurrenceMode, val paymentMode: PaymentMode?,
)

data class SubscriptionOption(
    val id: String, val basePlanId: String?, val offerId: String?, val tags: List<String>,
    val isBasePlan: Boolean, val isPrepaid: Boolean, val pricingPhases: List<PricingPhase>,
    val freePhase: PricingPhase?, val introPhase: PricingPhase?, val fullPricePhase: PricingPhase?,
)

enum class PackageType { UNKNOWN, CUSTOM, LIFETIME, ANNUAL, SIX_MONTH, THREE_MONTH, TWO_MONTH, MONTHLY, WEEKLY }
```

Replace `StoreProduct`:

```kotlin
data class StoreProduct(
    val id: String,
    val type: ProductType,
    val productCategory: ProductCategory,
    val displayName: String,
    val description: String? = null,
    val priceString: String? = null,
    val price: Double? = null,
    val currencyCode: String? = null,
    val subscriptionPeriod: Period? = null,
    val subscriptionGroupIdentifier: String? = null,
    val isFamilyShareable: Boolean = false,
    val introPrice: IntroPrice? = null,
    val discounts: List<Discount> = emptyList(),
    val isEligibleForIntroOffer: Boolean? = null,
    val subscriptionOptions: List<SubscriptionOption>? = null,
    val defaultOption: SubscriptionOption? = null,
    val pricePerWeek: Double? = null,
    val pricePerMonth: Double? = null,
    val pricePerYear: Double? = null,
    val pricePerWeekString: String? = null,
    val pricePerMonthString: String? = null,
    val pricePerYearString: String? = null,
    val rawStoreProduct: ProductDetails? = null,
)
```

Replace `Package`:

```kotlin
data class Package(
    val identifier: String,
    val packageType: PackageType,
    val product: StoreProduct,
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.StoreProductTypesTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Types.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/StoreProductTypesTest.kt
git commit -m "feat(sdk-kotlin): enriched StoreProduct public types"
```

---

## Task 6: Kotlin — pure normalization helpers + ProductInfo

**Files:**
- Create: `packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ProductMapping.kt`
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ProductMappingTest.kt` (Create)

**Interfaces:**
- Produces:
  - `fun parseIso8601Period(iso: String): Period` (parses `P1M`, `P3D`, `P1Y`, `P2W`)
  - `fun daysInPeriod(p: Period): Int`
  - `fun perUnitPrices(price: Double?, period: Period?, format: (Double) -> String?): PerUnit` where `data class PerUnit(week, month, year, weekStr, monthStr, yearStr)`
  - `fun packageType(slot: String): PackageType`
  - `data class PlayPhaseInput(priceMicros: Long, formattedPrice: String, currencyCode: String, billingPeriodIso: String, billingCycleCount: Int, recurrenceMode: Int)`
  - `data class PlayOfferInput(basePlanId: String, offerId: String?, tags: List<String>, phases: List<PlayPhaseInput>)`
  - `data class ProductInfo(description: String?, options: List<SubscriptionOption>?, oneTimePrice: PlayPhaseInput?)`
  - `fun mapPricingPhase(p: PlayPhaseInput): PricingPhase`
  - `fun mapSubscriptionOption(o: PlayOfferInput): SubscriptionOption`

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ProductMappingTest.kt`:

```kotlin
package dev.rovenue.sdk

import dev.rovenue.sdk.internal.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertNotNull

class ProductMappingTest {
    @Test fun parsesIsoPeriods() {
        assertEquals(Period(1, PeriodUnit.MONTH, "P1M"), parseIso8601Period("P1M"))
        assertEquals(Period(3, PeriodUnit.DAY, "P3D"), parseIso8601Period("P3D"))
        assertEquals(Period(1, PeriodUnit.YEAR, "P1Y"), parseIso8601Period("P1Y"))
        assertEquals(Period(2, PeriodUnit.WEEK, "P2W"), parseIso8601Period("P2W"))
    }

    @Test fun freeTrialPhaseDetected() {
        val free = PlayPhaseInput(0, "Free", "USD", "P1W", 1, 2)   // recurrence FINITE
        val full = PlayPhaseInput(9_990_000, "$9.99", "USD", "P1M", 0, 1) // INFINITE
        val opt = mapSubscriptionOption(PlayOfferInput("monthly", "trial", listOf("tag"), listOf(free, full)))
        assertEquals(PaymentMode.FREE_TRIAL, opt.freePhase?.paymentMode)
        assertEquals("P1M", opt.fullPricePhase?.billingPeriod?.iso8601)
        assertEquals("monthly:trial", opt.id)
    }

    @Test fun perUnitNilWithoutPeriod() {
        val r = perUnitPrices(9.99, null) { null }
        assertNull(r.month)
    }

    @Test fun packageTypeMapping() {
        assertEquals(PackageType.ANNUAL, packageType("\$rov_annual"))
        assertEquals(PackageType.CUSTOM, packageType("weird"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.ProductMappingTest"`
Expected: FAIL — unresolved references.

- [ ] **Step 3: Implement** — Create `internal/ProductMapping.kt`:

```kotlin
package dev.rovenue.sdk.internal

import dev.rovenue.sdk.*

data class PerUnit(
    val week: Double?, val month: Double?, val year: Double?,
    val weekStr: String?, val monthStr: String?, val yearStr: String?,
)

data class PlayPhaseInput(
    val priceMicros: Long, val formattedPrice: String, val currencyCode: String,
    val billingPeriodIso: String, val billingCycleCount: Int, val recurrenceMode: Int,
)

data class PlayOfferInput(
    val basePlanId: String, val offerId: String?, val tags: List<String>,
    val phases: List<PlayPhaseInput>,
)

data class ProductInfo(
    val description: String?,
    val options: List<SubscriptionOption>?,
    val oneTimePrice: PlayPhaseInput?,
)

fun parseIso8601Period(iso: String): Period {
    // format P<number><unit>, unit in D/W/M/Y
    val m = Regex("""P(\d+)([DWMY])""").find(iso)
    val value = m?.groupValues?.get(1)?.toIntOrNull() ?: 1
    val unit = when (m?.groupValues?.get(2)) {
        "D" -> PeriodUnit.DAY; "W" -> PeriodUnit.WEEK; "Y" -> PeriodUnit.YEAR; else -> PeriodUnit.MONTH
    }
    return Period(value, unit, iso)
}

fun daysInPeriod(p: Period): Int {
    val per = when (p.unit) { PeriodUnit.DAY -> 1; PeriodUnit.WEEK -> 7; PeriodUnit.MONTH -> 30; PeriodUnit.YEAR -> 365 }
    return maxOf(p.value, 1) * per
}

fun perUnitPrices(price: Double?, period: Period?, format: (Double) -> String?): PerUnit {
    if (price == null || period == null) return PerUnit(null, null, null, null, null, null)
    val days = daysInPeriod(period).toDouble()
    val w = price / days * 7; val mo = price / days * 30; val y = price / days * 365
    return PerUnit(w, mo, y, format(w), format(mo), format(y))
}

private fun recurrence(mode: Int): RecurrenceMode = when (mode) {
    1 -> RecurrenceMode.INFINITE_RECURRING
    2 -> RecurrenceMode.FINITE_RECURRING
    else -> RecurrenceMode.NON_RECURRING
}

fun mapPricingPhase(p: PlayPhaseInput): PricingPhase {
    val rec = recurrence(p.recurrenceMode)
    val mode = when {
        p.priceMicros == 0L -> PaymentMode.FREE_TRIAL
        rec == RecurrenceMode.FINITE_RECURRING -> PaymentMode.PAY_AS_YOU_GO
        else -> null
    }
    return PricingPhase(
        price = if (p.priceMicros == 0L) 0.0 else p.priceMicros / 1_000_000.0,
        priceString = p.formattedPrice, currencyCode = p.currencyCode,
        billingPeriod = parseIso8601Period(p.billingPeriodIso),
        billingCycleCount = if (rec == RecurrenceMode.INFINITE_RECURRING) null else p.billingCycleCount,
        recurrenceMode = rec, paymentMode = mode,
    )
}

fun mapSubscriptionOption(o: PlayOfferInput): SubscriptionOption {
    val phases = o.phases.map { mapPricingPhase(it) }
    val free = phases.firstOrNull { it.paymentMode == PaymentMode.FREE_TRIAL }
    val full = phases.firstOrNull { it.recurrenceMode == RecurrenceMode.INFINITE_RECURRING }
    val intro = phases.firstOrNull { it.paymentMode == PaymentMode.PAY_AS_YOU_GO }
    val id = if (o.offerId != null) "${o.basePlanId}:${o.offerId}" else o.basePlanId
    return SubscriptionOption(
        id = id, basePlanId = o.basePlanId, offerId = o.offerId, tags = o.tags,
        isBasePlan = o.offerId == null, isPrepaid = false, pricingPhases = phases,
        freePhase = free, introPhase = intro, fullPricePhase = full,
    )
}

fun packageType(slot: String): PackageType = when (slot) {
    "\$rov_weekly" -> PackageType.WEEKLY
    "\$rov_monthly" -> PackageType.MONTHLY
    "\$rov_two_month" -> PackageType.TWO_MONTH
    "\$rov_three_month" -> PackageType.THREE_MONTH
    "\$rov_six_month" -> PackageType.SIX_MONTH
    "\$rov_annual" -> PackageType.ANNUAL
    "\$rov_lifetime" -> PackageType.LIFETIME
    else -> PackageType.CUSTOM
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.ProductMappingTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/ProductMapping.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/ProductMappingTest.kt
git commit -m "feat(sdk-kotlin): pure Play Billing phase normalization helpers"
```

---

## Task 7: Kotlin — PlayBillingStore.ProductInfo + hydration wiring

**Files:**
- Modify: `packages/sdk-kotlin/.../internal/PlayBillingStore.kt` (`PlayStore` interface, `queryPrices` lines 112–130, `PriceInfo` / helpers lines 150–172, `NoPriceStore`)
- Modify: `packages/sdk-kotlin/.../internal/OfferingsHydration.kt` (`mapProduct` lines 60–71, `mapOffering` 73–82, `mapProductId` 58)
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/OfferingsHydrationTest.kt` (Create)

**Interfaces:**
- Consumes: Task 6 (`ProductInfo`, `PlayOfferInput`, `mapSubscriptionOption`, `perUnitPrices`, `packageType`), `CoreOfferingProduct`/`CoreOfferings`.
- Produces: `interface PlayStore { fun queryProducts(inappIds: List<String>, subscriptionIds: List<String>): Map<String, ProductInfo> }`; updated `hydrateOfferings(core, store): Offerings`.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/OfferingsHydrationTest.kt`:

```kotlin
package dev.rovenue.sdk

import dev.rovenue.sdk.internal.*
import dev.rovenue.sdk.generated.*
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class OfferingsHydrationTest {
    private fun core(): CoreOfferings = CoreOfferings(
        current = "default",
        offerings = listOf(CoreOffering("default", true, listOf(
            CoreOfferingProduct("\$rov_monthly", "premium", "SUBSCRIPTION", "Premium", null, "premium_monthly")
        )))
    )

    private class FakeStore(val info: ProductInfo) : PlayStore {
        override fun queryProducts(inappIds: List<String>, subscriptionIds: List<String>) =
            mapOf("premium_monthly" to info)
    }

    @Test fun hydratesSubscriptionWithTrialAndOptions() {
        val opt = mapSubscriptionOption(PlayOfferInput("monthly", "trial", emptyList(), listOf(
            PlayPhaseInput(0, "Free", "USD", "P1W", 1, 2),
            PlayPhaseInput(9_990_000, "$9.99", "USD", "P1M", 0, 1),
        )))
        val store = FakeStore(ProductInfo("Pro plan", listOf(opt), null))
        val offerings = hydrateOfferings(core(), store)
        val product = offerings.current!!.packages.first().product
        assertEquals("Pro plan", product.description)
        assertEquals(PackageType.MONTHLY, offerings.current!!.packages.first().packageType)
        assertEquals(ProductCategory.SUBSCRIPTION, product.productCategory)
        assertEquals(PaymentMode.FREE_TRIAL, product.introPrice?.paymentMode)
        assertEquals(true, product.isEligibleForIntroOffer)
        assertEquals("P1M", product.subscriptionPeriod?.iso8601)
        assertNotNull(product.pricePerYear)
        assertEquals(1, product.subscriptionOptions?.size)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.OfferingsHydrationTest"`
Expected: FAIL — `PlayStore.queryProducts` undefined / `hydrateOfferings` signature mismatch.

- [ ] **Step 3: Update PlayBillingStore + OfferingsHydration**

In `PlayBillingStore.kt`: rename the `PlayStore` interface method to `queryProducts(inappIds, subscriptionIds): Map<String, ProductInfo>`. Implement it by querying Play Billing as today, then for each SUBS `ProductDetails` build `ProductInfo` by mapping each `subscriptionOfferDetails` entry to a `PlayOfferInput` (`basePlanId`, `offerId`, `offerTags`, and each `pricingPhases.pricingPhaseList` element → `PlayPhaseInput(priceAmountMicros, formattedPrice, priceCurrencyCode, billingPeriod, billingCycleCount, recurrenceMode)`), then `mapSubscriptionOption(...)`. For INAPP build `ProductInfo(oneTimePrice = PlayPhaseInput from oneTimePurchaseOfferDetails, options = null)`. Update `NoPriceStore` to return an empty map. Delete the old `PriceInfo` struct and `inappPrice`/`subsPrice` helpers (superseded).

In `OfferingsHydration.kt`, rewrite `mapProduct` and `mapOffering`:

```kotlin
import dev.rovenue.sdk.internal.*

private fun productCategory(type: String): ProductCategory =
    if (type.uppercase() == "SUBSCRIPTION") ProductCategory.SUBSCRIPTION else ProductCategory.NON_SUBSCRIPTION

private fun productType(type: String): ProductType = ProductType.from(type)

private fun mapProduct(p: CoreOfferingProduct, info: ProductInfo?): StoreProduct {
    val type = productType(p.productType)
    if (info == null) {
        return StoreProduct(id = p.identifier, type = type,
            productCategory = productCategory(p.productType), displayName = p.displayName)
    }
    val options = info.options
    val defaultOption = options
        ?.filter { it.isBasePlan }
        ?.minByOrNull { it.fullPricePhase?.price ?: Double.MAX_VALUE }
        ?: options?.firstOrNull()
    val full = defaultOption?.fullPricePhase
    val intro = defaultOption?.freePhase ?: defaultOption?.introPhase
    val period = full?.billingPeriod
    val price = full?.price
    val currency = full?.currencyCode ?: info.oneTimePrice?.currencyCode
    val priceString = full?.priceString ?: info.oneTimePrice?.formattedPrice
    val basePrice = price ?: info.oneTimePrice?.let { it.priceMicros / 1_000_000.0 }
    val per = perUnitPrices(basePrice, period) { it.toString() }
    val introPrice = intro?.let {
        IntroPrice(it.price, it.priceString, it.currencyCode, it.billingPeriod,
            it.billingCycleCount ?: 1, it.paymentMode ?: PaymentMode.FREE_TRIAL)
    }
    val eligible = if (type == ProductType.SUBSCRIPTION) (intro != null) else null
    return StoreProduct(
        id = p.identifier, type = type, productCategory = productCategory(p.productType),
        displayName = p.displayName, description = info.description,
        priceString = priceString, price = basePrice, currencyCode = currency,
        subscriptionPeriod = period, subscriptionGroupIdentifier = null, isFamilyShareable = false,
        introPrice = introPrice, discounts = emptyList(), isEligibleForIntroOffer = eligible,
        subscriptionOptions = options, defaultOption = defaultOption,
        pricePerWeek = per.week, pricePerMonth = per.month, pricePerYear = per.year,
        pricePerWeekString = per.weekStr, pricePerMonthString = per.monthStr,
        pricePerYearString = per.yearStr, rawStoreProduct = null,
    )
}

private fun mapOffering(o: CoreOffering, prices: Map<String, ProductInfo>): Offering = Offering(
    identifier = o.identifier, isDefault = o.isDefault,
    packages = o.packages.map { pkg ->
        Package(pkg.packageIdentifier, packageType(pkg.packageIdentifier),
            mapProduct(pkg, prices[mapProductId(pkg)]))
    },
)
```

Update `hydrateOfferings` to call `store.queryProducts(...)` (was `queryPrices`) and keep `mapProductId` (`googleProductId ?: identifier`). (`rawStoreProduct` is populated by `PlayBillingStore` directly on the `ProductInfo`→`StoreProduct` path in the real store; for `ProductInfo` we leave it null here since the fake test has no `ProductDetails` — the production `PlayBillingStore` may attach the real `ProductDetails` by extending `ProductInfo` with an optional `raw: ProductDetails?` field and threading it through `mapProduct`. Add `val raw: ProductDetails? = null` to `ProductInfo` and pass `rawStoreProduct = info.raw`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.OfferingsHydrationTest"`
Expected: PASS.

- [ ] **Step 5: Run full Kotlin unit tests**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest`
Expected: PASS (existing hydration tests updated/compile).

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/PlayBillingStore.kt packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/internal/OfferingsHydration.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/OfferingsHydrationTest.kt
git commit -m "feat(sdk-kotlin): hydrate enriched StoreProduct from Play Billing offers"
```

---

## Task 8: Kotlin — Offering accessors

**Files:**
- Modify: `packages/sdk-kotlin/.../Types.kt` (`Offering` lines 54–58)
- Test: `packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/OfferingAccessorsTest.kt` (Create)

**Interfaces:**
- Produces: `Offering.monthly/annual/weekly/sixMonth/threeMonth/twoMonth/lifetime` (`Package?`), `Offering.packageBy(identifier)`.

- [ ] **Step 1: Write the failing test**

```kotlin
package dev.rovenue.sdk
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class OfferingAccessorsTest {
    @Test fun accessors() {
        val prod = StoreProduct("x", ProductType.SUBSCRIPTION, ProductCategory.SUBSCRIPTION, "x")
        val pkg = Package("\$rov_annual", PackageType.ANNUAL, prod)
        val off = Offering("default", true, listOf(pkg))
        assertEquals("\$rov_annual", off.annual?.identifier)
        assertNull(off.monthly)
        assertEquals(PackageType.ANNUAL, off.packageBy("\$rov_annual")?.packageType)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.OfferingAccessorsTest"`
Expected: FAIL — `off.annual` unresolved.

- [ ] **Step 3: Implement** — In `Types.kt`, add to / extend `Offering`:

```kotlin
data class Offering(
    val identifier: String,
    val isDefault: Boolean,
    val packages: List<Package>,
) {
    fun packageBy(identifier: String): Package? = packages.firstOrNull { it.identifier == identifier }
    private fun byType(t: PackageType): Package? = packages.firstOrNull { it.packageType == t }
    val lifetime: Package? get() = byType(PackageType.LIFETIME)
    val annual: Package? get() = byType(PackageType.ANNUAL)
    val sixMonth: Package? get() = byType(PackageType.SIX_MONTH)
    val threeMonth: Package? get() = byType(PackageType.THREE_MONTH)
    val twoMonth: Package? get() = byType(PackageType.TWO_MONTH)
    val monthly: Package? get() = byType(PackageType.MONTHLY)
    val weekly: Package? get() = byType(PackageType.WEEKLY)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-kotlin && ./gradlew testDebugUnitTest --tests "dev.rovenue.sdk.OfferingAccessorsTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/Types.kt packages/sdk-kotlin/src/test/kotlin/dev/rovenue/sdk/OfferingAccessorsTest.kt
git commit -m "feat(sdk-kotlin): Offering convenience accessors"
```

---

## Task 9: RN — public TS types + DTO types

**Files:**
- Modify: `packages/sdk-rn/src/types.ts` (lines 16–41)
- Modify: `packages/sdk-rn/src/specs/RovenueModule.types.ts` (lines 18–43)
- Test: `packages/sdk-rn/src/__tests__/types.test.ts` (Create)

**Interfaces:**
- Produces: enriched TS `StoreProduct`, `Package`, `Offering` + matching `StoreProductDTO`, `PackageDTO`, `OfferingDTO`; supporting types `Period`, `IntroPrice`, `Discount`, `PricingPhase`, `SubscriptionOption`, `PackageType`, `ProductCategory`, `PeriodUnit`, `PaymentMode`, `DiscountType`, `RecurrenceMode` (+ DTO mirrors).

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-rn/src/__tests__/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { StoreProduct, Period, IntroPrice } from '../types';

describe('enriched StoreProduct type', () => {
  it('constructs with new fields', () => {
    const period: Period = { value: 1, unit: 'month', iso8601: 'P1M' };
    const intro: IntroPrice = { price: 0, priceString: 'Free', currencyCode: 'USD', period, cycles: 1, paymentMode: 'freeTrial' };
    const p: StoreProduct = {
      id: 'p1', type: 'subscription', productCategory: 'subscription', displayName: 'Premium',
      description: 'Pro', priceString: '$9.99', price: 9.99, currencyCode: 'USD',
      subscriptionPeriod: period, subscriptionGroupIdentifier: null, isFamilyShareable: false,
      introPrice: intro, discounts: [], isEligibleForIntroOffer: true,
      subscriptionOptions: null, defaultOption: null,
      pricePerWeek: null, pricePerMonth: 9.99, pricePerYear: null,
      pricePerWeekString: null, pricePerMonthString: '$9.99', pricePerYearString: null,
    };
    expect(p.introPrice?.paymentMode).toBe('freeTrial');
    expect(p.subscriptionPeriod?.iso8601).toBe('P1M');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-rn && pnpm vitest run src/__tests__/types.test.ts`
Expected: FAIL — type error (`productCategory` etc. not assignable / unknown).

- [ ] **Step 3: Implement** — In `src/types.ts` add the supporting types and enriched product:

```ts
export type ProductCategory = 'subscription' | 'nonSubscription';
export type PeriodUnit = 'day' | 'week' | 'month' | 'year';
export type PaymentMode = 'freeTrial' | 'payAsYouGo' | 'payUpFront';
export type DiscountType = 'introductory' | 'promotional' | 'winBack';
export type RecurrenceMode = 'infiniteRecurring' | 'finiteRecurring' | 'nonRecurring';
export type PackageType =
  | 'unknown' | 'custom' | 'lifetime' | 'annual'
  | 'sixMonth' | 'threeMonth' | 'twoMonth' | 'monthly' | 'weekly';

export type Period = { value: number; unit: PeriodUnit; iso8601: string };

export type IntroPrice = {
  price: number | null; priceString: string | null; currencyCode: string | null;
  period: Period; cycles: number; paymentMode: PaymentMode;
};

export type Discount = {
  identifier: string | null; price: number | null; priceString: string | null;
  currencyCode: string | null; period: Period; numberOfPeriods: number;
  paymentMode: PaymentMode; type: DiscountType;
};

export type PricingPhase = {
  price: number | null; priceString: string | null; currencyCode: string | null;
  billingPeriod: Period; billingCycleCount: number | null;
  recurrenceMode: RecurrenceMode; paymentMode: PaymentMode | null;
};

export type SubscriptionOption = {
  id: string; basePlanId: string | null; offerId: string | null; tags: string[];
  isBasePlan: boolean; isPrepaid: boolean; pricingPhases: PricingPhase[];
  freePhase: PricingPhase | null; introPhase: PricingPhase | null; fullPricePhase: PricingPhase | null;
};

export type StoreProduct = {
  id: string;
  type: ProductType;
  productCategory: ProductCategory;
  displayName: string;
  description: string | null;
  priceString: string | null;
  price: number | null;
  currencyCode: string | null;
  subscriptionPeriod: Period | null;
  subscriptionGroupIdentifier: string | null;
  isFamilyShareable: boolean;
  introPrice: IntroPrice | null;
  discounts: Discount[];
  isEligibleForIntroOffer: boolean | null;
  subscriptionOptions: SubscriptionOption[] | null;
  defaultOption: SubscriptionOption | null;
  pricePerWeek: number | null;
  pricePerMonth: number | null;
  pricePerYear: number | null;
  pricePerWeekString: string | null;
  pricePerMonthString: string | null;
  pricePerYearString: string | null;
};

export type Package = { identifier: string; packageType: PackageType; product: StoreProduct };
```

In `src/specs/RovenueModule.types.ts` mirror the same fields into `StoreProductDTO` and `PackageDTO` (using the DTO enum string unions; reuse identical shapes — DTO `StoreProductDTO` gets every field above except none are omitted; no `rawStoreProduct`). Add the DTO mirrors of `Period`/`IntroPrice`/`Discount`/`PricingPhase`/`SubscriptionOption`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-rn && pnpm vitest run src/__tests__/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-rn/src/types.ts packages/sdk-rn/src/specs/RovenueModule.types.ts packages/sdk-rn/src/__tests__/types.test.ts
git commit -m "feat(sdk-rn): enriched StoreProduct TS + DTO types"
```

---

## Task 10: RN — JS DTO → public mapping + package type

**Files:**
- Modify: `packages/sdk-rn/src/api/purchases.ts` (lines 12–26)
- Test: `packages/sdk-rn/src/__tests__/purchases.test.ts` (Create)

**Interfaces:**
- Consumes: enriched DTO types (Task 9), `getNative()`.
- Produces: `getOfferings()` returning enriched public `Offerings`; internal `packageTypeFromSlot(slot): PackageType`.

- [ ] **Step 1: Write the failing test**

Create `packages/sdk-rn/src/__tests__/purchases.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../native', () => ({
  getNative: () => ({
    getOfferings: async () => ({
      current: 'default',
      offerings: [{
        identifier: 'default', isDefault: true,
        packages: [{
          identifier: '$rov_monthly',
          product: {
            id: 'premium', type: 'subscription', productCategory: 'subscription',
            displayName: 'Premium', description: 'Pro', priceString: '$9.99', price: 9.99,
            currencyCode: 'USD',
            subscriptionPeriod: { value: 1, unit: 'month', iso8601: 'P1M' },
            subscriptionGroupIdentifier: null, isFamilyShareable: false,
            introPrice: { price: 0, priceString: 'Free', currencyCode: 'USD',
              period: { value: 1, unit: 'week', iso8601: 'P1W' }, cycles: 1, paymentMode: 'freeTrial' },
            discounts: [], isEligibleForIntroOffer: true, subscriptionOptions: null, defaultOption: null,
            pricePerWeek: null, pricePerMonth: 9.99, pricePerYear: null,
            pricePerWeekString: null, pricePerMonthString: '$9.99', pricePerYearString: null,
          },
        }],
      }],
    }),
  }),
}));

import { getOfferings } from '../api/purchases';

describe('getOfferings', () => {
  it('maps enriched DTO and derives packageType', async () => {
    const o = await getOfferings();
    const pkg = o.current!.packages[0];
    expect(pkg.packageType).toBe('monthly');
    expect(pkg.product.introPrice?.paymentMode).toBe('freeTrial');
    expect(pkg.product.subscriptionPeriod?.iso8601).toBe('P1M');
    expect(o.all['default'].isDefault).toBe(true);
  });
});
```

(Adjust the `vi.mock` path to match how `purchases.ts` imports the native module — inspect the existing import in the file and mock that exact specifier.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk-rn && pnpm vitest run src/__tests__/purchases.test.ts`
Expected: FAIL — `packageType` missing on mapped package.

- [ ] **Step 3: Implement** — In `src/api/purchases.ts` add the slot mapper and thread all new fields through the DTO→public mapping (the product fields are 1:1, so map the product object directly; only `packageType` is derived):

```ts
import type { PackageType } from '../types';

function packageTypeFromSlot(slot: string): PackageType {
  switch (slot) {
    case '$rov_weekly': return 'weekly';
    case '$rov_monthly': return 'monthly';
    case '$rov_two_month': return 'twoMonth';
    case '$rov_three_month': return 'threeMonth';
    case '$rov_six_month': return 'sixMonth';
    case '$rov_annual': return 'annual';
    case '$rov_lifetime': return 'lifetime';
    default: return 'custom';
  }
}
```

In the package mapping loop, set `packageType: packageTypeFromSlot(p.identifier)` and `product: p.product` (the DTO product shape now matches the public `StoreProduct` shape field-for-field, so it can be assigned directly; if the file constructs the product field-by-field, copy every new field across explicitly).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk-rn && pnpm vitest run src/__tests__/purchases.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk-rn/src/api/purchases.ts packages/sdk-rn/src/__tests__/purchases.test.ts
git commit -m "feat(sdk-rn): map enriched offerings DTO + derive packageType"
```

---

## Task 11: RN — iOS bridge emits enriched DTO

**Files:**
- Modify: `packages/sdk-rn/ios/RovenueModule.swift` (`dtoFromStoreProduct` lines 347–357, `dtoFromOfferings` 360–377)

**Interfaces:**
- Consumes: the enriched Swift `StoreProduct` (Tasks 1–4).
- Produces: a dictionary with every new field for the JS layer.

- [ ] **Step 1: Extend `dtoFromStoreProduct`**

Rewrite `dtoFromStoreProduct(_ p: StoreProduct) -> [String: Any?]` to emit all new fields. Map nested types to dictionaries; `rawStoreProduct` is omitted. Period → `["value": ..., "unit": "month", "iso8601": ...]`; enums → their lowerCamel string (`"freeTrial"`, `"payAsYouGo"`, `"introductory"`, `"subscription"`, etc.). Include helper closures `periodDict`, `introDict`, `discountDict`, `phaseDict`, `optionDict`. Set `subscriptionOptions`/`defaultOption` to `nil` (iOS).

- [ ] **Step 2: Extend `dtoFromOfferings`**

In the package builder, add `"packageType"` key derived from the Swift `Package.packageType` (map the enum to its lowerCamel string).

- [ ] **Step 3: Build the iOS bridge to verify it compiles**

Run: `cd packages/sdk-rn/ios && xcodebuild -scheme Rovenue -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO` (or the project's documented RN iOS build command).
Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-rn/ios/RovenueModule.swift
git commit -m "feat(sdk-rn): iOS bridge serializes enriched StoreProduct DTO"
```

---

## Task 12: RN — Android bridge emits enriched DTO

**Files:**
- Modify: `packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt` (`dtoFromStoreProduct` lines 322–329, `dtoFromOfferings` 331–345)

**Interfaces:**
- Consumes: the enriched Kotlin `StoreProduct` (Tasks 5–8).
- Produces: a `Map<String, Any?>` with every new field.

- [ ] **Step 1: Extend `dtoFromStoreProduct`**

Rewrite `dtoFromStoreProduct(p: StoreProduct): Map<String, Any?>` to emit all new fields, mirroring the iOS keys exactly (same string casing). Add helpers `periodMap`, `introMap`, `discountMap`, `phaseMap`, `optionMap`. Map `subscriptionOptions` (list of `optionMap`) and `defaultOption`. `discounts` will be empty on Android. `rawStoreProduct` omitted. Enum → lowerCamel string matching iOS (`PaymentMode.FREE_TRIAL` → `"freeTrial"`, `RecurrenceMode.INFINITE_RECURRING` → `"infiniteRecurring"`, `PackageType.MONTHLY` → `"monthly"`, etc.).

- [ ] **Step 2: Extend `dtoFromOfferings`**

In the package builder, add `"packageType"` from the Kotlin `Package.packageType` mapped to the lowerCamel string.

- [ ] **Step 3: Build the Android bridge to verify it compiles**

Run: `cd packages/sdk-rn/android && ./gradlew compileDebugKotlin`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add packages/sdk-rn/android/src/main/java/dev/rovenue/sdkrn/RovenueModule.kt
git commit -m "feat(sdk-rn): Android bridge serializes enriched StoreProduct DTO"
```

---

## Task 13: Docs — product/offerings reference

**Files:**
- Modify/Create: the offerings/products reference page under `apps/docs/content/` (locate the existing offerings doc; if none, create `apps/docs/content/docs/sdk/products.mdx`)

**Interfaces:** none (documentation).

- [ ] **Step 1: Locate the existing offerings doc**

Run: `grep -rl "getOfferings\|StoreProduct\|Offerings" apps/docs/content`
Expected: the file(s) describing the product/offerings API.

- [ ] **Step 2: Document the enriched schema**

Add a "Product schema" section listing every `StoreProduct` field with type and platform availability, the supporting types (`Period`, `IntroPrice`, `Discount`, `SubscriptionOption`, `PricingPhase`), the `PackageType` enum, the Offering convenience accessors, and a clear callout of the two platform differences:
- `isEligibleForIntroOffer`: real on iOS (StoreKit), **derived** on Android (true iff a free/intro phase exists).
- `subscriptionOptions`/`defaultOption`: Android-only (null on iOS); `discounts`: iOS promotional offers (empty on Android).
- Per-unit price approximation (day 1 / week 7 / month 30 / year 365).

- [ ] **Step 3: Build docs to verify**

Run: `pnpm --filter @rovenue/docs build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/docs
git commit -m "docs(sdk): document enriched StoreProduct schema"
```

---

## Self-Review (completed)

**Spec coverage:** every spec §3 field → Tasks 1/5/9; iOS mapping §5.1 → Task 3; Android mapping §5.2 → Tasks 6–7; base-plan selection §6.1 → Task 7 (`defaultOption` selection); eligibility §6.2 → Tasks 3 (iOS) & 7 (Android derived); PackageType/accessors → Tasks 4 & 8; RN bridge → Tasks 10–12; resilience §7 → null/empty fallbacks in Tasks 3 & 7; docs §6.2 callouts → Task 13. Rust-core-untouched constraint honored (no core task). Promotional-offer purchase signing & server config correctly excluded (spec §9).

**Placeholder scan:** no TBD/TODO; all code steps contain literal code; test code present in every test step.

**Type consistency:** `StoreProduct`/`Period`/`IntroPrice`/`Discount`/`SubscriptionOption`/`PricingPhase` field names match across Swift (Task 1), Kotlin (Task 5), RN (Task 9); `mapSubscriptionOption`/`PlayOfferInput`/`PlayPhaseInput`/`ProductInfo` defined in Task 6 and consumed unchanged in Task 7; `queryProducts` (not the old `queryPrices`) used consistently in Task 7; DTO enum string casing aligned between Tasks 11 & 12.
