//  Visibility.swift
//  Node-level visibility: which platforms and app versions a node renders
//  on. Evaluated CLIENT-SIDE by every renderer — the server ships the
//  published snapshot whole.
//
//  Swift port of packages/shared/src/paywall/visibility.ts (kept as a
//  near-exact copy, including comments, the same way the RN port at
//  packages/sdk-rn/src/paywall-ui/visibility.ts and the Kotlin port at
//  packages/sdk-kotlin/src/main/kotlin/dev/rovenue/sdk/paywallui/Visibility.kt
//  are): this module's decoder (BuilderConfigModel.swift) is a lenient,
//  independently-typed `BuilderNode` model (not the strict `PaywallNode`
//  union), so the evaluator is duplicated here rather than shared, and
//  must agree EXACTLY with the shared implementation and the RN/Kotlin
//  siblings against the same `visibility` vectors in render-fixtures.json.
//
//  The `Visibility` type itself lives in BuilderConfigModel.swift,
//  alongside the rest of the decoded node model.
//
//  The governing rule is FAIL OPEN. Every unknown resolves to visible: an
//  unknown platform, an unknown app version, a version we cannot parse, an
//  empty platform list. Hiding content because we could not tell would
//  silently break paywalls on any facade that has not supplied these
//  facts yet.

import Foundation

private let versionSeparator: Character = "."

/// True when every character of `s` is an ASCII decimal digit and `s` is
/// non-empty — the Swift mirror of the shared/Kotlin `^\d+$` regex,
/// spelled without regex so a component like `""` or `"1a"` is rejected
/// the same way, and so nothing here ever routes through `Int`/`Double`.
private func isNumericComponent(_ component: Substring) -> Bool {
    !component.isEmpty && component.allSatisfy { $0.isASCII && $0.isNumber }
}

/// Strips leading zeros, but never down to an empty string — mirrors the
/// TS `replace(/^0+(?=\d)/, "")` (a run of leading zeros is removed only
/// when at least one digit remains) and Kotlin's
/// `trimStart('0').ifEmpty { "0" }`. "0" stays "0"; "007" becomes "7".
private func stripLeadingZeros(_ component: Substring) -> Substring {
    var trimmed = component
    while trimmed.count > 1, trimmed.first == "0" {
        trimmed = trimmed.dropFirst()
    }
    return trimmed
}

/// Compare two digit components exactly, without going through `Int` or
/// `Double` — either would silently misbehave past its range (`Int`
/// traps/overflows, `Double` loses precision past 2^53) and report two
/// different versions as equal or crash the render. Comparing normalised
/// digit strings by length then lexically is exact for any length.
/// Mirrors the TS/Kotlin `compareComponent` byte-for-byte.
private func compareComponent(_ a: Substring, _ b: Substring) -> Int {
    let left = stripLeadingZeros(a)
    let right = stripLeadingZeros(b)
    if left.count != right.count { return left.count - right.count }
    if left == right { return 0 }
    return left < right ? -1 : 1
}

/// Component-wise numeric comparison. Missing components read as 0, so
/// "1.2" equals "1.2.0" and "1.10" beats "1.9". Taking the LONGER of the
/// two lengths is what makes "1.2.5" beat "1.2" — taking the shorter one
/// would never look at the extra component.
///
/// Returns `nil` — inconclusive — when either side has a component that
/// is not a run of digits (checked with `isNumericComponent`, NEVER
/// `Int(component)` — that would return `nil` for "beta" too, but ALSO
/// for a component beyond `Int.max`, which would wrongly make the
/// beyond-Int.max render-fixtures vector inconclusive instead of a
/// definite comparison; never routing a component through `Int` at all is
/// what makes it pass structurally). Deliberately NOT semver: a real
/// implementation would have to be written four times over and agree
/// exactly, and pre-release ordering is not a rule anyone authoring a
/// paywall bound is thinking about. Refusing to guess is the honest
/// answer, and an inconclusive comparison fails open at the call site.
func compareVersions(_ a: String, _ b: String) -> Int? {
    let left = a.split(separator: versionSeparator, omittingEmptySubsequences: false)
    let right = b.split(separator: versionSeparator, omittingEmptySubsequences: false)
    guard (left + right).allSatisfy(isNumericComponent) else { return nil }
    let length = max(left.count, right.count)
    for index in 0..<length {
        let l = index < left.count ? left[index] : Substring("0")
        let r = index < right.count ? right[index] : Substring("0")
        let cmp = compareComponent(l, r)
        if cmp != 0 { return cmp }
    }
    return 0
}

/// True when the node should render for `platform`/`appVersion`. Bounds
/// are inclusive. Fails open on every unknown: no `visibility` at all, an
/// empty/absent platform list, an unknown renderer `platform`, no known
/// `appVersion`, or an inconclusive `compareVersions` result all resolve
/// to visible.
func isNodeVisible(_ visibility: Visibility?, platform: String?, appVersion: String?) -> Bool {
    guard let visibility else { return true }

    let allowedPlatforms = visibility.platform
    // An empty array is what the builder produces the moment an author
    // unticks the last box. Reading it as "nowhere" would let a stray
    // click delete content from every device.
    if let allowedPlatforms, !allowedPlatforms.isEmpty, let platform, !allowedPlatforms.contains(platform) {
        return false
    }

    guard let version = appVersion else { return true }

    // An inconclusive `compareVersions` (`nil`) leaves `cmp` failing both
    // `< 0` and `> 0` below, so it never hides — spelled out explicitly
    // (Swift has no implicit nil-to-zero coercion in a relational
    // comparison, unlike JS) rather than relying on any coercion rule.
    if let min = visibility.minAppVersion, let cmp = compareVersions(version, min), cmp < 0 {
        return false
    }
    if let max = visibility.maxAppVersion, let cmp = compareVersions(version, max), cmp > 0 {
        return false
    }
    return true
}
