import Foundation
import StoreKit

// MARK: - AppleOfferInput

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

// MARK: - Pure mapper

func mapAppleStoreProduct(
    core: CoreOfferingProduct,
    period: Period?,
    introOffer: AppleOfferInput?,
    promoOffers: [AppleOfferInput],
    groupId: String?,
    isFamilyShareable: Bool,
    description: String?,
    priceString: String?,
    price: Decimal?,
    currencyCode: String?,
    isEligible: Bool?,
    raw: StoreKit.Product?,
    formatCurrency: (Decimal) -> String?
) -> StoreProduct {
    let type = ProductType.from(core.productType)
    let category: ProductCategory = type == .subscription ? .subscription : .nonSubscription
    let displayName = raw?.displayName ?? core.displayName

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
        displayName: displayName, description: description, priceString: priceString,
        price: price, currencyCode: currencyCode, subscriptionPeriod: period,
        subscriptionGroupIdentifier: groupId, isFamilyShareable: isFamilyShareable,
        introPrice: introPrice, discounts: discounts, isEligibleForIntroOffer: isEligible,
        subscriptionOptions: nil, defaultOption: nil,
        pricePerWeek: per.week, pricePerMonth: per.month, pricePerYear: per.year,
        pricePerWeekString: per.weekStr, pricePerMonthString: per.monthStr,
        pricePerYearString: per.yearStr, rawStoreProduct: raw)
}

// MARK: - StoreKit offer extractor

@available(iOS 15.0, macOS 12.0, *)
func appleOfferInputs(from product: StoreKit.Product)
    -> (period: Period?, intro: AppleOfferInput?, promos: [AppleOfferInput], groupId: String?) {
    guard let sub = product.subscription else { return (nil, nil, [], nil) }
    func unit(_ u: StoreKit.Product.SubscriptionPeriod.Unit) -> PeriodUnit {
        switch u {
        case .day: return .day
        case .week: return .week
        case .month: return .month
        case .year: return .year
        @unknown default: return .month
        }
    }
    func mode(_ m: StoreKit.Product.SubscriptionOffer.PaymentMode) -> PaymentMode {
        switch m {
        case .freeTrial: return .freeTrial
        case .payAsYouGo: return .payAsYouGo
        case .payUpFront: return .payUpFront
        default: return .payAsYouGo
        }
    }
    let period = makePeriod(value: sub.subscriptionPeriod.value,
                            unit: unit(sub.subscriptionPeriod.unit))
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

// MARK: - Period helpers

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

// MARK: - PackageType derivation

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
