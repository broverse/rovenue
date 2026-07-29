//  BuilderConfigModel.swift — Codable decoder for the Phase-B builder
//  paywall wire format (`configFormatVersion` 2, `Paywall.builderConfigJson`).
//
//  Cross-platform contract: packages/shared/src/paywall/schema.ts is the
//  strict authoring schema (Zod, used by the dashboard builder + API
//  validation). This decoder is the LENIENT platform counterpart per
//  packages/shared/src/paywall/render-fixtures.json's `_comment` — an
//  unrecognized node `type` decodes to `.unknown(id:visibility:fallback:)` instead of
//  throwing, so a paywall shipped with a node type added in a later SDK
//  release still renders (falling back, or rendering nothing for that node)
//  on older clients. Any other structural defect (bad enum value, missing
//  `id`, `formatVersion != 2`, a non-object localization table, a malformed
//  `fallback` subtree, or a root that isn't a `stack`) still fails the whole
//  decode — `decodeBuilderConfig` returns `nil` in that case.
//
//  Platform-neutral Foundation only (no UIKit) — this type is decoded on
//  whatever thread receives the placement response and consumed by both the
//  SwiftUI paywall view and headless callers.

import Foundation

// MARK: - Shared value types

public struct ThemePair: Decodable, Equatable, Sendable {
    public let light: String
    public let dark: String?

    public init(light: String, dark: String?) {
        self.light = light
        self.dark = dark
    }
}

public enum NodeSize: Decodable, Equatable, Sendable {
    case fit
    case fill
    case value(Double)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let raw = try? container.decode(String.self) {
            switch raw {
            case "fit": self = .fit
            case "fill": self = .fill
            default:
                throw DecodingError.dataCorruptedError(
                    in: container, debugDescription: "NodeSize string must be \"fit\" or \"fill\", got \"\(raw)\"")
            }
            return
        }
        if let number = try? container.decode(Double.self) {
            self = .value(number)
            return
        }
        throw DecodingError.dataCorruptedError(
            in: container, debugDescription: "NodeSize must be \"fit\", \"fill\", or a number")
    }
}

/// A drawn border, always resolved together — a width without a color (or
/// vice versa) renders nothing meaningful, so both fields are non-optional
/// inside the optional `border` prop. Drawn INSIDE the node's own corner
/// radius on every platform (web `border` + `borderRadius`; SwiftUI
/// `overlay(RoundedRectangle().strokeBorder)`; Android `GradientDrawable` stroke).
/// Mirrors packages/shared/src/paywall/schema.ts's `NodeBorder`.
public struct NodeBorder: Decodable, Equatable, Sendable {
    public let width: Double
    public let color: ThemePair

    public init(width: Double, color: ThemePair) {
        self.width = width
        self.color = color
    }
}

public struct Padding: Decodable, Equatable, Sendable {
    public let t: Double?
    public let r: Double?
    public let b: Double?
    public let l: Double?

    public init(t: Double?, r: Double?, b: Double?, l: Double?) {
        self.t = t; self.r = r; self.b = b; self.l = l
    }
}

public struct SizeSpec: Decodable, Equatable, Sendable {
    public let width: NodeSize?
    public let height: NodeSize?

    public init(width: NodeSize?, height: NodeSize?) {
        self.width = width
        self.height = height
    }
}

public enum Axis: String, Decodable, Equatable, Sendable {
    case v, h, z
}

public enum HAlign: String, Decodable, Equatable, Sendable {
    case start, center, end
}

public enum TextRole: String, Decodable, Equatable, Sendable {
    case title, subtitle, body, caption
}

public enum ButtonVisualStyle: String, Decodable, Equatable, Sendable {
    case primary, secondary, plain
}

public enum CellLayout: String, Decodable, Equatable, Sendable {
    case row, column
}

public enum ButtonAction: Decodable, Equatable, Sendable {
    case close
    case url(String)
    case restore

    private enum CodingKeys: String, CodingKey { case kind, url }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "close": self = .close
        case "restore": self = .restore
        case "url":
            self = .url(try container.decode(String.self, forKey: .url))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: container, debugDescription: "unknown button action kind \"\(kind)\"")
        }
    }
}

// MARK: - Visibility (node-level render gating)
//
// Cross-platform contract: packages/shared/src/paywall/visibility.ts's
// `NodeVisibility` type / the RN (model.ts) and Kotlin (BuilderConfigModel.kt)
// mirrors. Every KNOWN node type below carries an optional `visibility` —
// NOT `.unknown`, which never has one to parse (mirrors both siblings).
// Deliberately NOT overridable (absent from `OverridablePropKeys` on every
// node type) — see Visibility.swift for `isNodeVisible`/`compareVersions`.
//
// `visibility` decodes LENIENTLY, unlike the rest of this file: a
// malformed shape, an out-of-union platform string, or a non-string bound
// is dropped rather than failing the whole config decode — visibility is
// the one field on a known node type that behaves this way (mirrors the
// RN/Kotlin decoders' `parseVisibility` exactly).

/// Platforms recognized by node-level `visibility` — Swift mirror of
/// shared's `VisibilityPlatform` union / the RN decoder's
/// `VISIBILITY_PLATFORMS` / Kotlin's `VISIBILITY_PLATFORMS`.
private let visibilityPlatforms: Set<String> = ["ios", "android", "web"]

/// A JSON array element that may or may not decode as a `String` — used
/// to filter a `platform` list down to recognized strings without
/// failing the whole decode on a stray non-string entry (mirrors
/// Kotlin's `JsonPrimitive`-then-`isString` check). Never throws.
private enum LenientStringElement: Decodable {
    case string(String)
    case other

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self = .string(value)
        } else {
            self = .other
        }
    }
}

/// Platforms this node renders on. `nil`/absent OR EMPTY means all of
/// them. Bounds (`minAppVersion`/`maxAppVersion`) are inclusive.
public struct Visibility: Decodable, Equatable, Sendable {
    public let platform: [String]?
    public let minAppVersion: String?
    public let maxAppVersion: String?

    public init(platform: [String]? = nil, minAppVersion: String? = nil, maxAppVersion: String? = nil) {
        self.platform = platform
        self.minAppVersion = minAppVersion
        self.maxAppVersion = maxAppVersion
    }

    private enum CodingKeys: String, CodingKey { case platform, minAppVersion, maxAppVersion }

    /// `visibility.platform` decodes LENIENTLY: any entry outside the
    /// known set (or any non-string entry) is dropped rather than
    /// failing the whole config, and an empty-after-filtering array is
    /// treated the same as absent (`nil`) — both mean "no constraint" to
    /// `isNodeVisible`. `minAppVersion`/`maxAppVersion` similarly drop
    /// (rather than throw for) a present-but-non-string value.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        let rawPlatform = (try? container.decodeIfPresent([LenientStringElement].self, forKey: .platform)) ?? nil
        let kept = rawPlatform?.compactMap { element -> String? in
            guard case .string(let value) = element, visibilityPlatforms.contains(value) else { return nil }
            return value
        }
        self.platform = (kept?.isEmpty ?? true) ? nil : kept

        self.minAppVersion = (try? container.decodeIfPresent(String.self, forKey: .minAppVersion)) ?? nil
        self.maxAppVersion = (try? container.decodeIfPresent(String.self, forKey: .maxAppVersion)) ?? nil
    }
}

// MARK: - Overrides (Phase D2)
//
// Cross-platform contract: packages/shared/src/paywall/schema.ts's
// `OverrideCondition`/`NodeOverride`/`OVERRIDABLE_PROP_KEYS`. Every node
// payload gains an optional `overrides: [NodeOverride<...>]`; conditions are
// evaluated at render time (see PaywallOverrides.swift's
// `activeOverrideConditions` + `applyOverrides`).
//
// Decode leniency, matching render-fixtures.json's `_comment`: an unknown
// `when.kind` string decodes to `.unknown` — retained but never matching,
// NOT a config failure (acceptLenient-pinned). Malformed/structural keys
// inside `props` of a KNOWN kind (introEligible/selected) fail the WHOLE
// config decode (reject-pinned) — that validation happens per node type in
// each `*OverrideProps` struct below via `validateOverridePropKeys`.

/// The `when.kind` of a single override entry. `.unknown` covers any string
/// outside the two known literals — decoding never throws for this field
/// alone; see `NodeOverride.init(from:)`.
public enum OverrideConditionKind: Equatable, Sendable {
    case introEligible
    case selected
    case unknown
}

/// A single node-type's whitelist of override-able prop keys — the node's
/// own OPTIONAL VISUAL fields only. This is the Swift mirror of
/// packages/shared/src/paywall/schema.ts's `OVERRIDABLE_PROP_KEYS`, the
/// single source of truth; keep the two tables in sync by hand.
enum OverridablePropKeys {
    static let stack: Set<String> = ["spacing", "align", "background", "cornerRadius", "border"]
    static let text: Set<String> = ["key", "color", "align", "background", "cornerRadius"]
    static let image: Set<String> = ["cornerRadius", "border"]
    static let button: Set<String> = ["labelKey", "style", "background", "labelColor", "border", "cornerRadius"]
    static let packageList: Set<String> = []
    static let purchaseButton: Set<String> = [
        "labelKey", "trialLabelKey", "background", "labelColor", "border", "cornerRadius",
    ]
    static let spacer: Set<String> = []
    static let divider: Set<String> = ["color", "thickness"]
    static let icon: Set<String> = ["name", "color"]
    static let featureList: Set<String> = ["iconColor"]
    static let timeline: Set<String> = ["connectorColor"]
    static let socialProof: Set<String> = ["rating", "starColor"]
    static let stickyFooter: Set<String> = ["background"]
    static let countdown: Set<String> = ["color"]
    static let carousel: Set<String> = ["indicatorColor"]
    /// Both media types whitelist their SOURCE rather than a colour: swapping
    /// the clip (or its poster) is the whole point of an
    /// `introEligible`/`selected` override on a video, and schema.ts's
    /// `OVERRIDABLE_PROP_KEYS` says exactly this.
    static let video: Set<String> = ["url", "posterUrl"]
    static let lottie: Set<String> = ["url"]
}

/// A `CodingKey` that accepts ANY string, used to enumerate every key
/// actually present in a JSON object (`container.allKeys`) — Swift's normal
/// `CodingKeys` enums only ever see keys they already know about, so this is
/// how `validateOverridePropKeys` can detect a stray/structural key that a
/// closed `CodingKeys` decode would otherwise silently ignore.
private struct DynamicCodingKey: CodingKey {
    let stringValue: String
    init?(stringValue: String) { self.stringValue = stringValue }
    var intValue: Int? { nil }
    init?(intValue: Int) { nil }
}

/// Throws when `decoder`'s keyed container carries any key outside
/// `allowed` — the defensive check that makes a structural key (e.g.
/// `"type"`) inside a KNOWN when.kind's `props` fail the whole config
/// decode, per render-fixtures.json's reject-pinned case.
private func validateOverridePropKeys(_ decoder: Decoder, allowed: Set<String>) throws {
    let container = try decoder.container(keyedBy: DynamicCodingKey.self)
    for key in container.allKeys where !allowed.contains(key.stringValue) {
        throw DecodingError.dataCorruptedError(
            forKey: key, in: container,
            debugDescription: "\"\(key.stringValue)\" is not an overridable prop for this node type.")
    }
}

public struct StackOverrideProps: Decodable, Equatable, Sendable {
    public let spacing: Double?
    public let align: HAlign?
    public let background: ThemePair?
    public let cornerRadius: Double?
    public let border: NodeBorder?

    public init(spacing: Double? = nil, align: HAlign? = nil, background: ThemePair? = nil, cornerRadius: Double? = nil,
                border: NodeBorder? = nil) {
        self.spacing = spacing; self.align = align; self.background = background; self.cornerRadius = cornerRadius
        self.border = border
    }

    private enum CodingKeys: String, CodingKey { case spacing, align, background, cornerRadius, border }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.stack)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        spacing = try container.decodeIfPresent(Double.self, forKey: .spacing)
        align = try container.decodeIfPresent(HAlign.self, forKey: .align)
        background = try container.decodeIfPresent(ThemePair.self, forKey: .background)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
        border = try container.decodeIfPresent(NodeBorder.self, forKey: .border)
    }
}

public struct TextOverrideProps: Decodable, Equatable, Sendable {
    public let key: String?
    public let color: ThemePair?
    public let align: HAlign?
    public let background: ThemePair?
    public let cornerRadius: Double?

    public init(key: String? = nil, color: ThemePair? = nil, align: HAlign? = nil, background: ThemePair? = nil,
                cornerRadius: Double? = nil) {
        self.key = key; self.color = color; self.align = align
        self.background = background; self.cornerRadius = cornerRadius
    }

    private enum CodingKeys: String, CodingKey { case key, color, align, background, cornerRadius }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.text)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decodeIfPresent(String.self, forKey: .key)
        color = try container.decodeIfPresent(ThemePair.self, forKey: .color)
        align = try container.decodeIfPresent(HAlign.self, forKey: .align)
        background = try container.decodeIfPresent(ThemePair.self, forKey: .background)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
    }
}

public struct ImageOverrideProps: Decodable, Equatable, Sendable {
    public let cornerRadius: Double?
    public let border: NodeBorder?

    public init(cornerRadius: Double? = nil, border: NodeBorder? = nil) {
        self.cornerRadius = cornerRadius
        self.border = border
    }

    private enum CodingKeys: String, CodingKey { case cornerRadius, border }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.image)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
        border = try container.decodeIfPresent(NodeBorder.self, forKey: .border)
    }
}

public struct ButtonOverrideProps: Decodable, Equatable, Sendable {
    public let labelKey: String?
    public let style: ButtonVisualStyle?
    public let background: ThemePair?
    public let labelColor: ThemePair?
    public let border: NodeBorder?
    public let cornerRadius: Double?

    public init(labelKey: String? = nil, style: ButtonVisualStyle? = nil, background: ThemePair? = nil,
                labelColor: ThemePair? = nil, border: NodeBorder? = nil, cornerRadius: Double? = nil) {
        self.labelKey = labelKey; self.style = style
        self.background = background; self.labelColor = labelColor; self.border = border; self.cornerRadius = cornerRadius
    }

    private enum CodingKeys: String, CodingKey { case labelKey, style, background, labelColor, border, cornerRadius }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.button)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        labelKey = try container.decodeIfPresent(String.self, forKey: .labelKey)
        style = try container.decodeIfPresent(ButtonVisualStyle.self, forKey: .style)
        background = try container.decodeIfPresent(ThemePair.self, forKey: .background)
        labelColor = try container.decodeIfPresent(ThemePair.self, forKey: .labelColor)
        border = try container.decodeIfPresent(NodeBorder.self, forKey: .border)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
    }
}

/// Empty whitelist (`OVERRIDABLE_PROP_KEYS.packageList == []`) — no fields
/// exist to override on this type; `props` can only ever be `{}`.
public struct PackageListOverrideProps: Decodable, Equatable, Sendable {
    public init() {}

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.packageList)
    }
}

public struct PurchaseButtonOverrideProps: Decodable, Equatable, Sendable {
    public let labelKey: String?
    /// Mirrors schema.ts's `OVERRIDABLE_PROP_KEYS.purchaseButton`, which
    /// whitelists `trialLabelKey` alongside `labelKey` — an active
    /// `introEligible`/`selected` override can swap either.
    public let trialLabelKey: String?
    public let background: ThemePair?
    public let labelColor: ThemePair?
    public let border: NodeBorder?
    public let cornerRadius: Double?

    public init(labelKey: String? = nil, trialLabelKey: String? = nil, background: ThemePair? = nil,
                labelColor: ThemePair? = nil, border: NodeBorder? = nil, cornerRadius: Double? = nil) {
        self.labelKey = labelKey
        self.trialLabelKey = trialLabelKey
        self.background = background; self.labelColor = labelColor; self.border = border; self.cornerRadius = cornerRadius
    }

    private enum CodingKeys: String, CodingKey {
        case labelKey, trialLabelKey, background, labelColor, border, cornerRadius
    }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.purchaseButton)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        labelKey = try container.decodeIfPresent(String.self, forKey: .labelKey)
        trialLabelKey = try container.decodeIfPresent(String.self, forKey: .trialLabelKey)
        background = try container.decodeIfPresent(ThemePair.self, forKey: .background)
        labelColor = try container.decodeIfPresent(ThemePair.self, forKey: .labelColor)
        border = try container.decodeIfPresent(NodeBorder.self, forKey: .border)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
    }
}

/// Empty whitelist (`OVERRIDABLE_PROP_KEYS.spacer == []`) — same shape as
/// `PackageListOverrideProps`; its only optional field (`size`) is
/// structural per spec, not overridable.
public struct SpacerOverrideProps: Decodable, Equatable, Sendable {
    public init() {}

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.spacer)
    }
}

public struct DividerOverrideProps: Decodable, Equatable, Sendable {
    public let color: ThemePair?
    public let thickness: Double?

    public init(color: ThemePair? = nil, thickness: Double? = nil) {
        self.color = color; self.thickness = thickness
    }

    private enum CodingKeys: String, CodingKey { case color, thickness }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.divider)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        color = try container.decodeIfPresent(ThemePair.self, forKey: .color)
        thickness = try container.decodeIfPresent(Double.self, forKey: .thickness)
    }
}

public struct IconOverrideProps: Decodable, Equatable, Sendable {
    public let name: String?
    public let color: ThemePair?

    public init(name: String? = nil, color: ThemePair? = nil) {
        self.name = name; self.color = color
    }

    private enum CodingKeys: String, CodingKey { case name, color }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.icon)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        color = try container.decodeIfPresent(ThemePair.self, forKey: .color)
    }
}

public struct FeatureListOverrideProps: Decodable, Equatable, Sendable {
    public let iconColor: ThemePair?

    public init(iconColor: ThemePair? = nil) {
        self.iconColor = iconColor
    }

    private enum CodingKeys: String, CodingKey { case iconColor }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.featureList)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        iconColor = try container.decodeIfPresent(ThemePair.self, forKey: .iconColor)
    }
}

public struct TimelineOverrideProps: Decodable, Equatable, Sendable {
    public let connectorColor: ThemePair?

    public init(connectorColor: ThemePair? = nil) {
        self.connectorColor = connectorColor
    }

    private enum CodingKeys: String, CodingKey { case connectorColor }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.timeline)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        connectorColor = try container.decodeIfPresent(ThemePair.self, forKey: .connectorColor)
    }
}

public struct SocialProofOverrideProps: Decodable, Equatable, Sendable {
    public let rating: Double?
    public let starColor: ThemePair?

    public init(rating: Double? = nil, starColor: ThemePair? = nil) {
        self.rating = rating; self.starColor = starColor
    }

    private enum CodingKeys: String, CodingKey { case rating, starColor }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.socialProof)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        rating = try container.decodeIfPresent(Double.self, forKey: .rating)
        starColor = try container.decodeIfPresent(ThemePair.self, forKey: .starColor)
    }
}

public struct StickyFooterOverrideProps: Decodable, Equatable, Sendable {
    public let background: ThemePair?

    public init(background: ThemePair? = nil) {
        self.background = background
    }

    private enum CodingKeys: String, CodingKey { case background }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.stickyFooter)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        background = try container.decodeIfPresent(ThemePair.self, forKey: .background)
    }
}

public struct CountdownOverrideProps: Decodable, Equatable, Sendable {
    public let color: ThemePair?

    public init(color: ThemePair? = nil) {
        self.color = color
    }

    private enum CodingKeys: String, CodingKey { case color }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.countdown)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        color = try container.decodeIfPresent(ThemePair.self, forKey: .color)
    }
}

public struct CarouselOverrideProps: Decodable, Equatable, Sendable {
    public let indicatorColor: ThemePair?

    public init(indicatorColor: ThemePair? = nil) {
        self.indicatorColor = indicatorColor
    }

    private enum CodingKeys: String, CodingKey { case indicatorColor }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.carousel)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        indicatorColor = try container.decodeIfPresent(ThemePair.self, forKey: .indicatorColor)
    }
}

public struct VideoOverrideProps: Decodable, Equatable, Sendable {
    public let url: ThemePair?
    public let posterUrl: ThemePair?

    public init(url: ThemePair? = nil, posterUrl: ThemePair? = nil) {
        self.url = url; self.posterUrl = posterUrl
    }

    private enum CodingKeys: String, CodingKey { case url, posterUrl }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.video)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        url = try container.decodeIfPresent(ThemePair.self, forKey: .url)
        posterUrl = try container.decodeIfPresent(ThemePair.self, forKey: .posterUrl)
    }
}

public struct LottieOverrideProps: Decodable, Equatable, Sendable {
    public let url: ThemePair?

    public init(url: ThemePair? = nil) {
        self.url = url
    }

    private enum CodingKeys: String, CodingKey { case url }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.lottie)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        url = try container.decodeIfPresent(ThemePair.self, forKey: .url)
    }
}

/// A single conditional prop swap: `{ when: { kind }, props }`. `Props` is
/// the node type's own override-props struct (e.g. `StackOverrideProps`).
///
/// Decode rules (mirrors schema.ts's strict schema + the platform-lenient
/// counterpart per render-fixtures.json): an unknown `when.kind` decodes to
/// `.unknown` with `props` left `nil` — this entry is retained in the array
/// but can never become active (see `applyOverrides`), and its `props`
/// value is deliberately NOT validated/decoded (lenient — matches the
/// acceptLenient fixture, which pairs an unknown kind with otherwise-valid
/// props). A KNOWN kind's `props` IS decoded via `Props.init(from:)`, which
/// throws on any non-whitelisted key — that failure propagates up through
/// this initializer and fails the WHOLE config decode, per the reject fixture.
public struct NodeOverride<Props: Decodable & Equatable & Sendable>: Decodable, Equatable, Sendable {
    public let when: OverrideConditionKind
    public let props: Props?

    public init(when: OverrideConditionKind, props: Props?) {
        self.when = when
        self.props = props
    }

    private enum CodingKeys: String, CodingKey { case when, props }
    private enum WhenCodingKeys: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let whenContainer = try container.nestedContainer(keyedBy: WhenCodingKeys.self, forKey: .when)
        let kindRaw = try whenContainer.decode(String.self, forKey: .kind)
        switch kindRaw {
        case "introEligible":
            self.when = .introEligible
            self.props = try container.decode(Props.self, forKey: .props)
        case "selected":
            self.when = .selected
            self.props = try container.decode(Props.self, forKey: .props)
        default:
            self.when = .unknown
            self.props = nil
        }
    }
}

// MARK: - Node payloads
//
// Each mirrors the field set of its schema.ts counterpart. `fallback` is
// boxed (`BuilderNodeBox`) because `BuilderNode` recurses through these
// structs by value — an unboxed `BuilderNode?` field would make the type
// infinitely sized.

public struct StackProps: Decodable {
    public let id: String
    public let axis: Axis
    public let children: [BuilderNode]
    public let spacing: Double?
    public let align: HAlign?
    public let padding: Padding?
    public let size: SizeSpec?
    public let background: ThemePair?
    public let cornerRadius: Double?
    /// Drawn INSIDE `cornerRadius`. Absent = no border, today's output.
    public let border: NodeBorder?
    public let overrides: [NodeOverride<StackOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    // Explicit memberwise init: conforming to `Decodable` alone suppresses
    // the compiler's free memberwise initializer, but callers (tests,
    // programmatically-built trees) still need to construct these directly.
    public init(id: String, axis: Axis, children: [BuilderNode], spacing: Double? = nil, align: HAlign? = nil,
                padding: Padding? = nil, size: SizeSpec? = nil, background: ThemePair? = nil,
                cornerRadius: Double? = nil, border: NodeBorder? = nil,
                overrides: [NodeOverride<StackOverrideProps>]? = nil,
                visibility: Visibility? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.axis = axis; self.children = children; self.spacing = spacing; self.align = align
        self.padding = padding; self.size = size; self.background = background
        self.cornerRadius = cornerRadius; self.border = border; self.overrides = overrides
        self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey {
        case id, axis, children, spacing, align, padding, size, background, cornerRadius, border, overrides,
             visibility, fallback
    }

    // A custom decoder (rather than relying on Codable synthesis, as this
    // type did before visibility existed) is required because `visibility`
    // is the one field here that must decode LENIENTLY — see Visibility's
    // doc comment above.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        axis = try container.decode(Axis.self, forKey: .axis)
        children = try container.decode([BuilderNode].self, forKey: .children)
        spacing = try container.decodeIfPresent(Double.self, forKey: .spacing)
        align = try container.decodeIfPresent(HAlign.self, forKey: .align)
        padding = try container.decodeIfPresent(Padding.self, forKey: .padding)
        size = try container.decodeIfPresent(SizeSpec.self, forKey: .size)
        background = try container.decodeIfPresent(ThemePair.self, forKey: .background)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
        border = try container.decodeIfPresent(NodeBorder.self, forKey: .border)
        overrides = try container.decodeIfPresent([NodeOverride<StackOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct TextProps: Decodable {
    public let id: String
    public let key: String
    public let role: TextRole
    public let color: ThemePair?
    public let align: HAlign?
    /// Badge/chip fill. Absent = no background, today's output. Only
    /// meaningful together with `cornerRadius` (or standalone as a
    /// square-cornered fill) — mirrors the shared schema's own doc comment.
    public let background: ThemePair?
    public let cornerRadius: Double?
    public let overrides: [NodeOverride<TextOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, key: String, role: TextRole, color: ThemePair? = nil, align: HAlign? = nil,
                background: ThemePair? = nil, cornerRadius: Double? = nil,
                overrides: [NodeOverride<TextOverrideProps>]? = nil, visibility: Visibility? = nil,
                fallback: BuilderNodeBox? = nil) {
        self.id = id; self.key = key; self.role = role; self.color = color; self.align = align
        self.background = background; self.cornerRadius = cornerRadius
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey {
        case id, key, role, color, align, background, cornerRadius, overrides, visibility, fallback
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        key = try container.decode(String.self, forKey: .key)
        role = try container.decode(TextRole.self, forKey: .role)
        color = try container.decodeIfPresent(ThemePair.self, forKey: .color)
        align = try container.decodeIfPresent(HAlign.self, forKey: .align)
        background = try container.decodeIfPresent(ThemePair.self, forKey: .background)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
        overrides = try container.decodeIfPresent([NodeOverride<TextOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct ImageProps: Decodable {
    public let id: String
    public let url: ThemePair
    public let height: Double?
    public let cornerRadius: Double?
    /// Drawn INSIDE `cornerRadius`. Absent = no border, today's output.
    public let border: NodeBorder?
    public let alt: String?
    public let overrides: [NodeOverride<ImageOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, url: ThemePair, height: Double? = nil, cornerRadius: Double? = nil,
                border: NodeBorder? = nil, alt: String? = nil,
                overrides: [NodeOverride<ImageOverrideProps>]? = nil,
                visibility: Visibility? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.url = url; self.height = height; self.cornerRadius = cornerRadius
        self.border = border
        self.alt = alt; self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey {
        case id, url, height, cornerRadius, border, alt, overrides, visibility, fallback
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        url = try container.decode(ThemePair.self, forKey: .url)
        height = try container.decodeIfPresent(Double.self, forKey: .height)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
        border = try container.decodeIfPresent(NodeBorder.self, forKey: .border)
        alt = try container.decodeIfPresent(String.self, forKey: .alt)
        overrides = try container.decodeIfPresent([NodeOverride<ImageOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct ButtonProps: Decodable {
    public let id: String
    public let labelKey: String
    public let style: ButtonVisualStyle
    public let action: ButtonAction
    /// Custom style props (spec 2026-07-29): all override the `style`
    /// variant's own visual; absent = the variant's current look, today's
    /// output. See `resolveButtonVisual` for the merge rule.
    public let background: ThemePair?
    public let labelColor: ThemePair?
    /// Drawn INSIDE `cornerRadius`. Absent = no border, today's output.
    public let border: NodeBorder?
    public let cornerRadius: Double?
    public let overrides: [NodeOverride<ButtonOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, labelKey: String, style: ButtonVisualStyle, action: ButtonAction,
                background: ThemePair? = nil, labelColor: ThemePair? = nil, border: NodeBorder? = nil,
                cornerRadius: Double? = nil, overrides: [NodeOverride<ButtonOverrideProps>]? = nil,
                visibility: Visibility? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.labelKey = labelKey; self.style = style; self.action = action
        self.background = background; self.labelColor = labelColor; self.border = border
        self.cornerRadius = cornerRadius
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey {
        case id, labelKey, style, action, background, labelColor, border, cornerRadius, overrides, visibility, fallback
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        labelKey = try container.decode(String.self, forKey: .labelKey)
        style = try container.decode(ButtonVisualStyle.self, forKey: .style)
        action = try container.decode(ButtonAction.self, forKey: .action)
        background = try container.decodeIfPresent(ThemePair.self, forKey: .background)
        labelColor = try container.decodeIfPresent(ThemePair.self, forKey: .labelColor)
        border = try container.decodeIfPresent(NodeBorder.self, forKey: .border)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
        overrides = try container.decodeIfPresent([NodeOverride<ButtonOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct PackageListProps: Decodable {
    public let id: String
    public let packageIds: [String]
    public let defaultSelected: String?
    public let cellLayout: CellLayout
    /// Optional subtree rendered once per effective package, with
    /// cell-scoped variables, replacing the built-in (name + price) cell.
    /// Absent -> current built-in cell (backward compatible). Recursive via
    /// `BuilderNodeBox`, exactly like `fallback`.
    public let cellTemplate: BuilderNodeBox?
    public let overrides: [NodeOverride<PackageListOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, packageIds: [String], defaultSelected: String? = nil, cellLayout: CellLayout,
                cellTemplate: BuilderNodeBox? = nil, overrides: [NodeOverride<PackageListOverrideProps>]? = nil,
                visibility: Visibility? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.packageIds = packageIds; self.defaultSelected = defaultSelected
        self.cellLayout = cellLayout; self.cellTemplate = cellTemplate
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey {
        case id, packageIds, defaultSelected, cellLayout, cellTemplate, overrides, visibility, fallback
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        packageIds = try container.decode([String].self, forKey: .packageIds)
        defaultSelected = try container.decodeIfPresent(String.self, forKey: .defaultSelected)
        cellLayout = try container.decode(CellLayout.self, forKey: .cellLayout)
        cellTemplate = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .cellTemplate)
        overrides = try container.decodeIfPresent([NodeOverride<PackageListOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct PurchaseButtonProps: Decodable {
    public let id: String
    public let labelKey: String
    /// Shown instead of `labelKey` when the selected package's trial/intro
    /// period is active (see `ctaLabelKey` in PaywallViewModelHelpers.swift,
    /// the Swift port of variables.ts's `resolveCtaLabelKey`). Absent =
    /// always `labelKey`. Mirrors schema.ts's `PurchaseButtonNode.trialLabelKey`.
    public let trialLabelKey: String?
    /// Custom style props (spec 2026-07-29): all override the button's own
    /// base visual; absent = today's output. See `resolveButtonVisual`.
    public let background: ThemePair?
    public let labelColor: ThemePair?
    /// Drawn INSIDE `cornerRadius`. Absent = no border, today's output.
    public let border: NodeBorder?
    public let cornerRadius: Double?
    public let overrides: [NodeOverride<PurchaseButtonOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, labelKey: String, trialLabelKey: String? = nil, background: ThemePair? = nil,
                labelColor: ThemePair? = nil, border: NodeBorder? = nil, cornerRadius: Double? = nil,
                overrides: [NodeOverride<PurchaseButtonOverrideProps>]? = nil,
                visibility: Visibility? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.labelKey = labelKey; self.trialLabelKey = trialLabelKey
        self.background = background; self.labelColor = labelColor; self.border = border
        self.cornerRadius = cornerRadius
        self.overrides = overrides
        self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey {
        case id, labelKey, trialLabelKey, background, labelColor, border, cornerRadius, overrides, visibility, fallback
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        labelKey = try container.decode(String.self, forKey: .labelKey)
        trialLabelKey = try container.decodeIfPresent(String.self, forKey: .trialLabelKey)
        background = try container.decodeIfPresent(ThemePair.self, forKey: .background)
        labelColor = try container.decodeIfPresent(ThemePair.self, forKey: .labelColor)
        border = try container.decodeIfPresent(NodeBorder.self, forKey: .border)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
        overrides = try container.decodeIfPresent([NodeOverride<PurchaseButtonOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct SpacerProps: Decodable {
    public let id: String
    public let size: Double?
    public let overrides: [NodeOverride<SpacerOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, size: Double? = nil, overrides: [NodeOverride<SpacerOverrideProps>]? = nil,
                visibility: Visibility? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.size = size; self.overrides = overrides
        self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey { case id, size, overrides, visibility, fallback }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        size = try container.decodeIfPresent(Double.self, forKey: .size)
        overrides = try container.decodeIfPresent([NodeOverride<SpacerOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct DividerProps: Decodable {
    public let id: String
    public let color: ThemePair?
    public let thickness: Double?
    public let inset: Double?
    public let overrides: [NodeOverride<DividerOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, color: ThemePair? = nil, thickness: Double? = nil, inset: Double? = nil,
                overrides: [NodeOverride<DividerOverrideProps>]? = nil, visibility: Visibility? = nil,
                fallback: BuilderNodeBox? = nil) {
        self.id = id; self.color = color; self.thickness = thickness; self.inset = inset
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey { case id, color, thickness, inset, overrides, visibility, fallback }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        color = try container.decodeIfPresent(ThemePair.self, forKey: .color)
        thickness = try container.decodeIfPresent(Double.self, forKey: .thickness)
        inset = try container.decodeIfPresent(Double.self, forKey: .inset)
        overrides = try container.decodeIfPresent([NodeOverride<DividerOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct IconProps: Decodable {
    public let id: String
    public let name: String
    public let size: Double?
    public let color: ThemePair?
    public let overrides: [NodeOverride<IconOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, name: String, size: Double? = nil, color: ThemePair? = nil,
                overrides: [NodeOverride<IconOverrideProps>]? = nil, visibility: Visibility? = nil,
                fallback: BuilderNodeBox? = nil) {
        self.id = id; self.name = name; self.size = size; self.color = color
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey { case id, name, size, color, overrides, visibility, fallback }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        size = try container.decodeIfPresent(Double.self, forKey: .size)
        color = try container.decodeIfPresent(ThemePair.self, forKey: .color)
        overrides = try container.decodeIfPresent([NodeOverride<IconOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

/// One row of a `featureList` node — not a node itself, so it carries none of
/// `visibility`/`overrides`/`fallback`. Codable synthesis is sufficient here:
/// unlike the node payloads above, none of these fields need lenient decode.
public struct FeatureRowProps: Decodable, Equatable, Sendable {
    public let labelKey: String
    public let icon: String?
    public let included: Bool?

    public init(labelKey: String, icon: String? = nil, included: Bool? = nil) {
        self.labelKey = labelKey; self.icon = icon; self.included = included
    }
}

/// One row of a `timeline` node — same non-node shape as `FeatureRowProps`.
public struct TimelineRowProps: Decodable, Equatable, Sendable {
    public let labelKey: String
    public let captionKey: String?
    public let icon: String?

    public init(labelKey: String, captionKey: String? = nil, icon: String? = nil) {
        self.labelKey = labelKey; self.captionKey = captionKey; self.icon = icon
    }
}

public struct FeatureListProps: Decodable {
    public let id: String
    public let rows: [FeatureRowProps]
    /// Applied to each row's icon that does not carry its own. Absent means
    /// inherit (see RovenuePaywallView.swift), NOT a default color.
    public let iconColor: ThemePair?
    public let overrides: [NodeOverride<FeatureListOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, rows: [FeatureRowProps], iconColor: ThemePair? = nil,
                overrides: [NodeOverride<FeatureListOverrideProps>]? = nil, visibility: Visibility? = nil,
                fallback: BuilderNodeBox? = nil) {
        self.id = id; self.rows = rows; self.iconColor = iconColor
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey { case id, rows, iconColor, overrides, visibility, fallback }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        rows = try container.decode([FeatureRowProps].self, forKey: .rows)
        iconColor = try container.decodeIfPresent(ThemePair.self, forKey: .iconColor)
        overrides = try container.decodeIfPresent([NodeOverride<FeatureListOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct TimelineProps: Decodable {
    public let id: String
    public let rows: [TimelineRowProps]
    /// Absent = `TIMELINE_CONNECTOR_DEFAULT_COLOR` (see RovenuePaywallView.swift).
    public let connectorColor: ThemePair?
    public let overrides: [NodeOverride<TimelineOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, rows: [TimelineRowProps], connectorColor: ThemePair? = nil,
                overrides: [NodeOverride<TimelineOverrideProps>]? = nil, visibility: Visibility? = nil,
                fallback: BuilderNodeBox? = nil) {
        self.id = id; self.rows = rows; self.connectorColor = connectorColor
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey { case id, rows, connectorColor, overrides, visibility, fallback }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        rows = try container.decode([TimelineRowProps].self, forKey: .rows)
        connectorColor = try container.decodeIfPresent(ThemePair.self, forKey: .connectorColor)
        overrides = try container.decodeIfPresent([NodeOverride<TimelineOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct SocialProofProps: Decodable {
    public let id: String
    /// 0…`SOCIAL_PROOF_MAX_RATING`. Absent renders no stars at all — not zero
    /// filled ones (see RovenuePaywallView.swift).
    public let rating: Double?
    public let labelKey: String
    /// Absent = `SOCIAL_PROOF_STAR_DEFAULT_COLOR`.
    public let starColor: ThemePair?
    public let overrides: [NodeOverride<SocialProofOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, rating: Double? = nil, labelKey: String, starColor: ThemePair? = nil,
                overrides: [NodeOverride<SocialProofOverrideProps>]? = nil, visibility: Visibility? = nil,
                fallback: BuilderNodeBox? = nil) {
        self.id = id; self.rating = rating; self.labelKey = labelKey; self.starColor = starColor
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey { case id, rating, labelKey, starColor, overrides, visibility, fallback }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        rating = try container.decodeIfPresent(Double.self, forKey: .rating)
        labelKey = try container.decode(String.self, forKey: .labelKey)
        starColor = try container.decodeIfPresent(ThemePair.self, forKey: .starColor)
        overrides = try container.decodeIfPresent([NodeOverride<SocialProofOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct StickyFooterProps: Decodable {
    public let id: String
    public let children: [BuilderNode]
    /// Absent = `stickyFooterDefaultBackground` (see RovenuePaywallView.swift)
    /// — a pinned bar needs an opaque background or the content scrolls
    /// visibly beneath it, so unlike a plain node's colour this is never
    /// left to inherit.
    public let background: ThemePair?
    public let overrides: [NodeOverride<StickyFooterOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, children: [BuilderNode], background: ThemePair? = nil,
                overrides: [NodeOverride<StickyFooterOverrideProps>]? = nil,
                visibility: Visibility? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.children = children; self.background = background
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey { case id, children, background, overrides, visibility, fallback }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        children = try container.decode([BuilderNode].self, forKey: .children)
        background = try container.decodeIfPresent(ThemePair.self, forKey: .background)
        overrides = try container.decodeIfPresent([NodeOverride<StickyFooterOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

/// Mirrors schema.ts's `CountdownNode.onExpiry` union.
public enum CountdownOnExpiry: String, Decodable, Equatable, Sendable {
    case freeze
    case hide
}

public struct CountdownProps: Decodable {
    public let id: String
    /// ISO-8601 absolute deadline. Mutually exclusive with `durationSeconds`
    /// (the strict authoring schema refuses to save both; a lenient decode
    /// here does not re-validate that — `endsAt` simply wins when both are
    /// somehow present, mirroring `useCountdownDeadline`'s check order).
    public let endsAt: String?
    /// Seconds from this paywall's first show to THIS user, persisted —
    /// see `countdownFirstShownAt` in RovenuePaywallView.swift.
    public let durationSeconds: Double?
    /// Absent = `countdownDefaultOnExpiry`.
    public let onExpiry: CountdownOnExpiry?
    public let labelKey: String?
    /// Absent = inherit the ambient text colour (NOT a substituted default —
    /// unlike `StickyFooterProps.background`, this is ordinary text).
    public let color: ThemePair?
    public let overrides: [NodeOverride<CountdownOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, endsAt: String? = nil, durationSeconds: Double? = nil,
                onExpiry: CountdownOnExpiry? = nil, labelKey: String? = nil, color: ThemePair? = nil,
                overrides: [NodeOverride<CountdownOverrideProps>]? = nil,
                visibility: Visibility? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.endsAt = endsAt; self.durationSeconds = durationSeconds; self.onExpiry = onExpiry
        self.labelKey = labelKey; self.color = color
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey {
        case id, endsAt, durationSeconds, onExpiry, labelKey, color, overrides, visibility, fallback
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        endsAt = try container.decodeIfPresent(String.self, forKey: .endsAt)
        durationSeconds = try container.decodeIfPresent(Double.self, forKey: .durationSeconds)
        onExpiry = try container.decodeIfPresent(CountdownOnExpiry.self, forKey: .onExpiry)
        labelKey = try container.decodeIfPresent(String.self, forKey: .labelKey)
        color = try container.decodeIfPresent(ThemePair.self, forKey: .color)
        overrides = try container.decodeIfPresent([NodeOverride<CountdownOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct CarouselProps: Decodable {
    public let id: String
    /// Pages. Any node, not only images — the same freedom `stack` gives
    /// (mirrors schema.ts's `CarouselNode.children`).
    public let children: [BuilderNode]
    /// Absent = `carouselDefaultShowsIndicator` (see RovenuePaywallView.swift).
    public let showsIndicator: Bool?
    /// Seconds between automatic advances. Absent = no auto-advance at all,
    /// deliberately not a default interval — a paywall that starts moving on
    /// its own without the author asking is a surprise (mirrors schema.ts's
    /// own doc comment on `CarouselNode.autoAdvanceSeconds`).
    public let autoAdvanceSeconds: Double?
    /// Absent = `carouselDefaultLoop`.
    public let loop: Bool?
    /// Absent = inherit the ambient tint — NOT a substituted default (see
    /// `CarouselView`'s own doc comment for why this departs from
    /// `StickyFooterProps.background`'s always-opaque rule).
    public let indicatorColor: ThemePair?
    public let overrides: [NodeOverride<CarouselOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, children: [BuilderNode], showsIndicator: Bool? = nil,
                autoAdvanceSeconds: Double? = nil, loop: Bool? = nil, indicatorColor: ThemePair? = nil,
                overrides: [NodeOverride<CarouselOverrideProps>]? = nil,
                visibility: Visibility? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.children = children; self.showsIndicator = showsIndicator
        self.autoAdvanceSeconds = autoAdvanceSeconds; self.loop = loop; self.indicatorColor = indicatorColor
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey {
        case id, children, showsIndicator, autoAdvanceSeconds, loop, indicatorColor, overrides, visibility, fallback
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        children = try container.decode([BuilderNode].self, forKey: .children)
        showsIndicator = try container.decodeIfPresent(Bool.self, forKey: .showsIndicator)
        autoAdvanceSeconds = try container.decodeIfPresent(Double.self, forKey: .autoAdvanceSeconds)
        loop = try container.decodeIfPresent(Bool.self, forKey: .loop)
        indicatorColor = try container.decodeIfPresent(ThemePair.self, forKey: .indicatorColor)
        overrides = try container.decodeIfPresent([NodeOverride<CarouselOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

/// Defaults mirroring packages/shared/src/paywall/schema.ts's
/// `VIDEO_DEFAULT_AUTOPLAY` / `VIDEO_DEFAULT_LOOP` / `VIDEO_DEFAULT_MUTED` /
/// `VIDEO_DEFAULT_SHOWS_CONTROLS` / `LOTTIE_DEFAULT_LOOP` /
/// `LOTTIE_DEFAULT_AUTOPLAY` / `LOTTIE_DEFAULT_SPEED` / `LOTTIE_MIN_SPEED` /
/// `LOTTIE_MAX_SPEED`. Kept in sync with schema.ts BY HAND — there is no
/// codegen step sharing constants across the three platforms; what catches
/// drift is `PaywallRenderSupportTests`' by-value comparison against
/// render-fixtures.json's generated `defaults` object, which is also why none
/// of these may be `private` (Swift's `private` is file-scoped and even
/// `@testable import` cannot cross it). Same rule and same reason as the
/// divider/carousel/countdown default blocks in RovenuePaywallView.swift.
let videoDefaultAutoplay = true
let videoDefaultLoop = true
/// Autoplay with sound is refused outright by browsers, so muted is the only
/// default under which autoplay works on all three platforms — iOS honours it
/// for parity, not because AVFoundation forces it.
let videoDefaultMuted = true
let videoDefaultShowsControls = false
let lottieDefaultLoop = true
let lottieDefaultAutoplay = true
let lottieDefaultSpeed = 1.0
/// Authoring-time advice, NOT a clamp: outside this range playback reads as
/// broken rather than stylised, and the dashboard raises a `warning`. The
/// renderer honours whatever `speed` it is handed, exactly as
/// `carouselMinAutoAdvanceSeconds` is advice rather than a floor.
let lottieMinSpeed = 0.1
let lottieMaxSpeed = 4.0

public struct VideoProps: Decodable {
    public let id: String
    /// Theme-paired source URL, same shape as `ImageProps.url`.
    public let url: ThemePair
    /// Still frame shown until the first video frame is ready. Absent = no
    /// poster at all.
    public let posterUrl: ThemePair?
    /// Absent = `videoDefaultAutoplay`.
    public let autoplay: Bool?
    /// Absent = `videoDefaultLoop`.
    public let loop: Bool?
    /// Absent = `videoDefaultMuted`.
    public let muted: Bool?
    /// Absent = `videoDefaultShowsControls`.
    public let showsControls: Bool?
    /// Width ÷ height. Absent = NO ratio is applied at all and the source's
    /// own dimensions govern — deliberately not a substituted number, and the
    /// web renderer says the same thing by emitting `aspectRatio: undefined`.
    public let aspectRatio: Double?
    public let overrides: [NodeOverride<VideoOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, url: ThemePair, posterUrl: ThemePair? = nil, autoplay: Bool? = nil,
                loop: Bool? = nil, muted: Bool? = nil, showsControls: Bool? = nil,
                aspectRatio: Double? = nil, overrides: [NodeOverride<VideoOverrideProps>]? = nil,
                visibility: Visibility? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.url = url; self.posterUrl = posterUrl; self.autoplay = autoplay
        self.loop = loop; self.muted = muted; self.showsControls = showsControls
        self.aspectRatio = aspectRatio
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey {
        case id, url, posterUrl, autoplay, loop, muted, showsControls, aspectRatio, overrides, visibility, fallback
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        url = try container.decode(ThemePair.self, forKey: .url)
        posterUrl = try container.decodeIfPresent(ThemePair.self, forKey: .posterUrl)
        autoplay = try container.decodeIfPresent(Bool.self, forKey: .autoplay)
        loop = try container.decodeIfPresent(Bool.self, forKey: .loop)
        muted = try container.decodeIfPresent(Bool.self, forKey: .muted)
        showsControls = try container.decodeIfPresent(Bool.self, forKey: .showsControls)
        aspectRatio = try container.decodeIfPresent(Double.self, forKey: .aspectRatio)
        overrides = try container.decodeIfPresent([NodeOverride<VideoOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

public struct LottieProps: Decodable {
    public let id: String
    /// Theme-paired animation-JSON URL.
    public let url: ThemePair
    /// Absent = `lottieDefaultLoop`.
    public let loop: Bool?
    /// Absent = `lottieDefaultAutoplay`.
    public let autoplay: Bool?
    /// Absent = `lottieDefaultSpeed`. Never clamped here — see
    /// `lottieMinSpeed`/`lottieMaxSpeed`.
    public let speed: Double?
    public let overrides: [NodeOverride<LottieOverrideProps>]?
    public let visibility: Visibility?
    public let fallback: BuilderNodeBox?

    public init(id: String, url: ThemePair, loop: Bool? = nil, autoplay: Bool? = nil,
                speed: Double? = nil, overrides: [NodeOverride<LottieOverrideProps>]? = nil,
                visibility: Visibility? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.url = url; self.loop = loop; self.autoplay = autoplay; self.speed = speed
        self.overrides = overrides; self.visibility = visibility; self.fallback = fallback
    }

    private enum CodingKeys: String, CodingKey {
        case id, url, loop, autoplay, speed, overrides, visibility, fallback
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        url = try container.decode(ThemePair.self, forKey: .url)
        loop = try container.decodeIfPresent(Bool.self, forKey: .loop)
        autoplay = try container.decodeIfPresent(Bool.self, forKey: .autoplay)
        speed = try container.decodeIfPresent(Double.self, forKey: .speed)
        overrides = try container.decodeIfPresent([NodeOverride<LottieOverrideProps>].self, forKey: .overrides)
        visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
        fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
    }
}

/// Registry name -> SF Symbol. Unknown names return nil and render nothing:
/// leniency is deliberate so a newer paywall does not break an older app.
func sfSymbolName(for name: String) -> String? {
    switch name {
    case "check": return "checkmark"
    case "x": return "xmark"
    case "star": return "star.fill"
    case "lock": return "lock.fill"
    case "shield": return "checkmark.shield.fill"
    case "sparkle": return "sparkles"
    case "bolt": return "bolt.fill"
    case "gift": return "gift.fill"
    case "clock": return "clock.fill"
    case "infinity": return "infinity"
    case "cloud": return "cloud.fill"
    case "arrow-right": return "arrow.right"
    default: return nil
    }
}

// MARK: - BuilderNode

/// A single node in the builder-config tree. Decoding switches on the JSON
/// `type` discriminator; any `type` outside the known set decodes to
/// `.unknown`, retaining `id` and `fallback` so a caller can still render the
/// fallback subtree (or nothing) — this branch never throws. Decoding a
/// *known* type with structurally invalid fields (bad enum value, missing
/// `id`, etc.) still throws normally and propagates, so `decodeBuilderConfig`
/// can fail the whole config.
public enum BuilderNode: Decodable {
    case stack(StackProps)
    case text(TextProps)
    case image(ImageProps)
    case button(ButtonProps)
    case packageList(PackageListProps)
    case purchaseButton(PurchaseButtonProps)
    case spacer(SpacerProps)
    case divider(DividerProps)
    case icon(IconProps)
    case featureList(FeatureListProps)
    case timeline(TimelineProps)
    case socialProof(SocialProofProps)
    case stickyFooter(StickyFooterProps)
    case countdown(CountdownProps)
    case carousel(CarouselProps)
    case video(VideoProps)
    case lottie(LottieProps)
    case unknown(id: String, visibility: Visibility?, fallback: BuilderNodeBox?)

    private enum TypeKey: String, CodingKey { case type }
    private enum UnknownKeys: String, CodingKey { case id, visibility, fallback }

    public init(from decoder: Decoder) throws {
        let typeContainer = try decoder.container(keyedBy: TypeKey.self)
        let type = try typeContainer.decode(String.self, forKey: .type)
        switch type {
        case "stack": self = .stack(try StackProps(from: decoder))
        case "text": self = .text(try TextProps(from: decoder))
        case "image": self = .image(try ImageProps(from: decoder))
        case "button": self = .button(try ButtonProps(from: decoder))
        case "packageList": self = .packageList(try PackageListProps(from: decoder))
        case "purchaseButton": self = .purchaseButton(try PurchaseButtonProps(from: decoder))
        case "spacer": self = .spacer(try SpacerProps(from: decoder))
        case "divider": self = .divider(try DividerProps(from: decoder))
        case "icon": self = .icon(try IconProps(from: decoder))
        case "featureList": self = .featureList(try FeatureListProps(from: decoder))
        case "timeline": self = .timeline(try TimelineProps(from: decoder))
        case "socialProof": self = .socialProof(try SocialProofProps(from: decoder))
        case "stickyFooter": self = .stickyFooter(try StickyFooterProps(from: decoder))
        case "countdown": self = .countdown(try CountdownProps(from: decoder))
        case "carousel": self = .carousel(try CarouselProps(from: decoder))
        case "video": self = .video(try VideoProps(from: decoder))
        case "lottie": self = .lottie(try LottieProps(from: decoder))
        default:
            let container = try decoder.container(keyedBy: UnknownKeys.self)
            let id = try container.decode(String.self, forKey: .id)
            let fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
            // `visibility` IS retained here: it is the author's "don't show
            // this here", and an unknown type is exactly the forward-compat
            // case where a platform restriction matters most — dropping it
            // would render the fallback on a platform the author excluded,
            // which the web renderer already refuses to do.
            let visibility = (try? container.decodeIfPresent(Visibility.self, forKey: .visibility)) ?? nil
            self = .unknown(id: id, visibility: visibility, fallback: fallback)
        }
    }

    /// This node's own `id`, regardless of case.
    public var id: String {
        switch self {
        case .stack(let p): return p.id
        case .text(let p): return p.id
        case .image(let p): return p.id
        case .button(let p): return p.id
        case .packageList(let p): return p.id
        case .purchaseButton(let p): return p.id
        case .spacer(let p): return p.id
        case .divider(let p): return p.id
        case .icon(let p): return p.id
        case .featureList(let p): return p.id
        case .timeline(let p): return p.id
        case .socialProof(let p): return p.id
        case .stickyFooter(let p): return p.id
        case .countdown(let p): return p.id
        case .carousel(let p): return p.id
        case .video(let p): return p.id
        case .lottie(let p): return p.id
        case .unknown(let id, _, _): return id
        }
    }

    /// This node's own `visibility`, regardless of case. `.unknown` never
    /// carries one — an unrecognized node `type` has none to parse (see
    /// `Visibility`'s decode contract above) — so it's always visible as
    /// far as this gate is concerned. Deliberately NOT overridable; see
    /// `OverridablePropKeys`.
    public var visibility: Visibility? {
        switch self {
        case .stack(let p): return p.visibility
        case .text(let p): return p.visibility
        case .image(let p): return p.visibility
        case .button(let p): return p.visibility
        case .packageList(let p): return p.visibility
        case .purchaseButton(let p): return p.visibility
        case .spacer(let p): return p.visibility
        case .divider(let p): return p.visibility
        case .icon(let p): return p.visibility
        case .featureList(let p): return p.visibility
        case .timeline(let p): return p.visibility
        case .socialProof(let p): return p.visibility
        case .stickyFooter(let p): return p.visibility
        case .countdown(let p): return p.visibility
        case .carousel(let p): return p.visibility
        case .video(let p): return p.visibility
        case .lottie(let p): return p.visibility
        case .unknown(_, let v, _): return v
        }
    }
}

/// Reference-type box breaking `BuilderNode`'s value-type recursion through
/// `fallback` fields. Decodes transparently — `BuilderNodeBox` itself has no
/// wrapper shape in JSON, it just re-enters `BuilderNode.init(from:)`.
public final class BuilderNodeBox: Decodable {
    public let node: BuilderNode

    public init(node: BuilderNode) {
        self.node = node
    }

    public init(from decoder: Decoder) throws {
        self.node = try BuilderNode(from: decoder)
    }
}

// MARK: - BuilderConfigModel

public struct BuilderConfigModel: Decodable {
    public let formatVersion: Int
    public let defaultLocale: String
    public let localizations: [String: [String: String]]
    public let background: ThemePair?
    public let root: BuilderNode

    private enum CodingKeys: String, CodingKey {
        case formatVersion, defaultLocale, localizations, background, root
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        let formatVersion = try container.decode(Int.self, forKey: .formatVersion)
        guard formatVersion == 2 else {
            throw DecodingError.dataCorruptedError(
                forKey: .formatVersion, in: container, debugDescription: "formatVersion must be the literal 2")
        }
        self.formatVersion = formatVersion

        let defaultLocale = try container.decode(String.self, forKey: .defaultLocale)
        guard !defaultLocale.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .defaultLocale, in: container, debugDescription: "defaultLocale must be non-empty")
        }
        self.defaultLocale = defaultLocale

        self.localizations = try container.decode([String: [String: String]].self, forKey: .localizations)
        self.background = try container.decodeIfPresent(ThemePair.self, forKey: .background)

        let root = try container.decode(BuilderNode.self, forKey: .root)
        guard case .stack = root else {
            throw DecodingError.dataCorruptedError(
                forKey: .root, in: container, debugDescription: "root must be a stack node")
        }
        self.root = root
    }
}

/// Decodes a builder-config JSON string. Returns `nil` on ANY structural
/// defect (invalid JSON, bad enum values, a missing `id`, `formatVersion !=
/// 2`, a non-object localization table, a malformed `fallback` subtree, or a
/// non-`stack` root) — never throws. An unrecognized node `type` is NOT a
/// structural defect: it decodes leniently to `.unknown`.
public func decodeBuilderConfig(_ json: String) -> BuilderConfigModel? {
    guard let data = json.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(BuilderConfigModel.self, from: data)
}
