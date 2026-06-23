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
