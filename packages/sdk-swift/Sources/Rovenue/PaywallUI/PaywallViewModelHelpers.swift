//  PaywallViewModelHelpers.swift — pure text/variable resolution helpers for
//  the builder-config paywall view model.
//
//  Ports of packages/shared/src/paywall/validate.ts's `resolveText` and
//  packages/shared/src/paywall/variables.ts's `resolveVariables`. Both are
//  pure functions (no SDK/network access) so they're exercised directly
//  against packages/shared/src/paywall/render-fixtures.json's `resolveText`
//  and `variables` vectors in BuilderConfigModelTests — this file must stay
//  byte-for-byte equivalent to those two TS functions.

import Foundation

/// A package's resolved display values, substituted into `{{variable}}`
/// placeholders in builder-config text. Mirrors
/// packages/shared/src/paywall/variables.ts's `PackageView`.
///
/// The seven trailing fields (Phase D3) are OPTIONAL because a platform may
/// not have a numeric price to derive them from — a KNOWN variable whose
/// backing field is absent is left VERBATIM (same signal as an
/// unconfigured/unknown variable), distinct from the four required fields
/// above, which always substitute.
public struct PackageView: Equatable, Sendable {
    public let packageName, price, pricePerPeriod, period: String
    public let pricePerDay: String?
    public let pricePerWeek: String?
    public let pricePerMonth: String?
    public let pricePerYear: String?
    public let introPrice: String?
    public let introPeriod: String?
    public let relativeDiscount: String?

    public init(
        packageName: String, price: String, pricePerPeriod: String, period: String,
        pricePerDay: String? = nil, pricePerWeek: String? = nil, pricePerMonth: String? = nil,
        pricePerYear: String? = nil, introPrice: String? = nil, introPeriod: String? = nil,
        relativeDiscount: String? = nil
    ) {
        self.packageName = packageName
        self.price = price
        self.pricePerPeriod = pricePerPeriod
        self.period = period
        self.pricePerDay = pricePerDay
        self.pricePerWeek = pricePerWeek
        self.pricePerMonth = pricePerMonth
        self.pricePerYear = pricePerYear
        self.introPrice = introPrice
        self.introPeriod = introPeriod
        self.relativeDiscount = relativeDiscount
    }
}

/// Resolves a localization `key`'s text: `locale` (when non-nil) first, then
/// `config.defaultLocale`, else `nil`. An empty-string value is a valid hit
/// at either step (it is NOT treated as "missing"). Mirrors validate.ts's
/// `resolveText(config, locale, key)`, generalized to accept `locale: nil`
/// (skip straight to `defaultLocale`) for callers that haven't resolved a
/// display locale yet.
public func resolveText(_ config: BuilderConfigModel, locale: String?, key: String) -> String? {
    if let locale, let direct = config.localizations[locale]?[key] {
        return direct
    }
    if let fallback = config.localizations[config.defaultLocale]?[key] {
        return fallback
    }
    return nil
}

private let variablePattern: NSRegularExpression = {
    // Mirrors variables.ts's VARIABLE_PATTERN = /\{\{\s*(\w+)\s*\}\}/g
    // swiftlint:disable:next force_try
    try! NSRegularExpression(pattern: "\\{\\{\\s*(\\w+)\\s*\\}\\}")
}()

/// Looks up `name`'s value on `pkg`. An unknown name and a known name whose
/// backing field is `nil` both resolve to `nil` here — `resolveVariables`
/// treats them identically (leaves the placeholder verbatim), so no
/// separate "is this a known variable name" table is needed on this side of
/// the port (contrast variables.ts's `KNOWN_VARIABLES`, needed there only to
/// distinguish the two cases for other callers).
private func variableValue(named name: String, in pkg: PackageView) -> String? {
    switch name {
    case "packageName": return pkg.packageName
    case "price": return pkg.price
    case "pricePerPeriod": return pkg.pricePerPeriod
    case "period": return pkg.period
    case "pricePerDay": return pkg.pricePerDay
    case "pricePerWeek": return pkg.pricePerWeek
    case "pricePerMonth": return pkg.pricePerMonth
    case "pricePerYear": return pkg.pricePerYear
    case "introPrice": return pkg.introPrice
    case "introPeriod": return pkg.introPeriod
    case "relativeDiscount": return pkg.relativeDiscount
    default: return nil
    }
}

/// Replaces `{{var}}` placeholders in `text` with values from `pkg`. Unknown
/// variable names are left verbatim. When `pkg` is `nil`, ALL placeholders
/// (known or not) are left verbatim. Mirrors variables.ts's
/// `resolveVariables(text, pkg)`.
public func resolveVariables(_ text: String, pkg: PackageView?) -> String {
    guard let pkg else { return text }

    let nsText = text as NSString
    let matches = variablePattern.matches(in: text, range: NSRange(location: 0, length: nsText.length))
    if matches.isEmpty { return text }

    var result = ""
    var cursor = 0
    for match in matches {
        let fullRange = match.range
        let nameRange = match.range(at: 1)
        result += nsText.substring(with: NSRange(location: cursor, length: fullRange.location - cursor))
        let name = nsText.substring(with: nameRange)
        result += variableValue(named: name, in: pkg) ?? nsText.substring(with: fullRange)
        cursor = fullRange.location + fullRange.length
    }
    result += nsText.substring(from: cursor)
    return result
}
