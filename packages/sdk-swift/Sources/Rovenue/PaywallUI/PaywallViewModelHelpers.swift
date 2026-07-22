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
public struct PackageView: Equatable, Sendable {
    public let packageName, price, pricePerPeriod, period: String

    public init(packageName: String, price: String, pricePerPeriod: String, period: String) {
        self.packageName = packageName
        self.price = price
        self.pricePerPeriod = pricePerPeriod
        self.period = period
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

private func variableValue(named name: String, in pkg: PackageView) -> String? {
    switch name {
    case "packageName": return pkg.packageName
    case "price": return pkg.price
    case "pricePerPeriod": return pkg.pricePerPeriod
    case "period": return pkg.period
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
