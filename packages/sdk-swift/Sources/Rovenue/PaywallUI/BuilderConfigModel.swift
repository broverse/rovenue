//  BuilderConfigModel.swift — Codable decoder for the Phase-B builder
//  paywall wire format (`configFormatVersion` 2, `Paywall.builderConfigJson`).
//
//  Cross-platform contract: packages/shared/src/paywall/schema.ts is the
//  strict authoring schema (Zod, used by the dashboard builder + API
//  validation). This decoder is the LENIENT platform counterpart per
//  packages/shared/src/paywall/render-fixtures.json's `_comment` — an
//  unrecognized node `type` decodes to `.unknown(id:fallback:)` instead of
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
    static let stack: Set<String> = ["spacing", "align", "background", "cornerRadius"]
    static let text: Set<String> = ["key", "color", "align"]
    static let image: Set<String> = ["cornerRadius"]
    static let button: Set<String> = ["labelKey", "style"]
    static let packageList: Set<String> = []
    static let purchaseButton: Set<String> = ["labelKey"]
    static let spacer: Set<String> = []
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

    public init(spacing: Double? = nil, align: HAlign? = nil, background: ThemePair? = nil, cornerRadius: Double? = nil) {
        self.spacing = spacing; self.align = align; self.background = background; self.cornerRadius = cornerRadius
    }

    private enum CodingKeys: String, CodingKey { case spacing, align, background, cornerRadius }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.stack)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        spacing = try container.decodeIfPresent(Double.self, forKey: .spacing)
        align = try container.decodeIfPresent(HAlign.self, forKey: .align)
        background = try container.decodeIfPresent(ThemePair.self, forKey: .background)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
    }
}

public struct TextOverrideProps: Decodable, Equatable, Sendable {
    public let key: String?
    public let color: ThemePair?
    public let align: HAlign?

    public init(key: String? = nil, color: ThemePair? = nil, align: HAlign? = nil) {
        self.key = key; self.color = color; self.align = align
    }

    private enum CodingKeys: String, CodingKey { case key, color, align }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.text)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decodeIfPresent(String.self, forKey: .key)
        color = try container.decodeIfPresent(ThemePair.self, forKey: .color)
        align = try container.decodeIfPresent(HAlign.self, forKey: .align)
    }
}

public struct ImageOverrideProps: Decodable, Equatable, Sendable {
    public let cornerRadius: Double?

    public init(cornerRadius: Double? = nil) {
        self.cornerRadius = cornerRadius
    }

    private enum CodingKeys: String, CodingKey { case cornerRadius }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.image)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        cornerRadius = try container.decodeIfPresent(Double.self, forKey: .cornerRadius)
    }
}

public struct ButtonOverrideProps: Decodable, Equatable, Sendable {
    public let labelKey: String?
    public let style: ButtonVisualStyle?

    public init(labelKey: String? = nil, style: ButtonVisualStyle? = nil) {
        self.labelKey = labelKey; self.style = style
    }

    private enum CodingKeys: String, CodingKey { case labelKey, style }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.button)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        labelKey = try container.decodeIfPresent(String.self, forKey: .labelKey)
        style = try container.decodeIfPresent(ButtonVisualStyle.self, forKey: .style)
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

    public init(labelKey: String? = nil) {
        self.labelKey = labelKey
    }

    private enum CodingKeys: String, CodingKey { case labelKey }

    public init(from decoder: Decoder) throws {
        try validateOverridePropKeys(decoder, allowed: OverridablePropKeys.purchaseButton)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        labelKey = try container.decodeIfPresent(String.self, forKey: .labelKey)
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
    public let overrides: [NodeOverride<StackOverrideProps>]?
    public let fallback: BuilderNodeBox?

    // Explicit memberwise init: conforming to `Decodable` alone suppresses
    // the compiler's free memberwise initializer, but callers (tests,
    // programmatically-built trees) still need to construct these directly.
    public init(id: String, axis: Axis, children: [BuilderNode], spacing: Double? = nil, align: HAlign? = nil,
                padding: Padding? = nil, size: SizeSpec? = nil, background: ThemePair? = nil,
                cornerRadius: Double? = nil, overrides: [NodeOverride<StackOverrideProps>]? = nil,
                fallback: BuilderNodeBox? = nil) {
        self.id = id; self.axis = axis; self.children = children; self.spacing = spacing; self.align = align
        self.padding = padding; self.size = size; self.background = background
        self.cornerRadius = cornerRadius; self.overrides = overrides; self.fallback = fallback
    }
}

public struct TextProps: Decodable {
    public let id: String
    public let key: String
    public let role: TextRole
    public let color: ThemePair?
    public let align: HAlign?
    public let overrides: [NodeOverride<TextOverrideProps>]?
    public let fallback: BuilderNodeBox?

    public init(id: String, key: String, role: TextRole, color: ThemePair? = nil, align: HAlign? = nil,
                overrides: [NodeOverride<TextOverrideProps>]? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.key = key; self.role = role; self.color = color; self.align = align
        self.overrides = overrides; self.fallback = fallback
    }
}

public struct ImageProps: Decodable {
    public let id: String
    public let url: ThemePair
    public let height: Double?
    public let cornerRadius: Double?
    public let alt: String?
    public let overrides: [NodeOverride<ImageOverrideProps>]?
    public let fallback: BuilderNodeBox?

    public init(id: String, url: ThemePair, height: Double? = nil, cornerRadius: Double? = nil,
                alt: String? = nil, overrides: [NodeOverride<ImageOverrideProps>]? = nil,
                fallback: BuilderNodeBox? = nil) {
        self.id = id; self.url = url; self.height = height; self.cornerRadius = cornerRadius
        self.alt = alt; self.overrides = overrides; self.fallback = fallback
    }
}

public struct ButtonProps: Decodable {
    public let id: String
    public let labelKey: String
    public let style: ButtonVisualStyle
    public let action: ButtonAction
    public let overrides: [NodeOverride<ButtonOverrideProps>]?
    public let fallback: BuilderNodeBox?

    public init(id: String, labelKey: String, style: ButtonVisualStyle, action: ButtonAction,
                overrides: [NodeOverride<ButtonOverrideProps>]? = nil, fallback: BuilderNodeBox? = nil) {
        self.id = id; self.labelKey = labelKey; self.style = style; self.action = action
        self.overrides = overrides; self.fallback = fallback
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
    public let fallback: BuilderNodeBox?

    public init(id: String, packageIds: [String], defaultSelected: String? = nil, cellLayout: CellLayout,
                cellTemplate: BuilderNodeBox? = nil, overrides: [NodeOverride<PackageListOverrideProps>]? = nil,
                fallback: BuilderNodeBox? = nil) {
        self.id = id; self.packageIds = packageIds; self.defaultSelected = defaultSelected
        self.cellLayout = cellLayout; self.cellTemplate = cellTemplate
        self.overrides = overrides; self.fallback = fallback
    }
}

public struct PurchaseButtonProps: Decodable {
    public let id: String
    public let labelKey: String
    public let overrides: [NodeOverride<PurchaseButtonOverrideProps>]?
    public let fallback: BuilderNodeBox?

    public init(id: String, labelKey: String, overrides: [NodeOverride<PurchaseButtonOverrideProps>]? = nil,
                fallback: BuilderNodeBox? = nil) {
        self.id = id; self.labelKey = labelKey; self.overrides = overrides; self.fallback = fallback
    }
}

public struct SpacerProps: Decodable {
    public let id: String
    public let size: Double?
    public let overrides: [NodeOverride<SpacerOverrideProps>]?
    public let fallback: BuilderNodeBox?

    public init(id: String, size: Double? = nil, overrides: [NodeOverride<SpacerOverrideProps>]? = nil,
                fallback: BuilderNodeBox? = nil) {
        self.id = id; self.size = size; self.overrides = overrides; self.fallback = fallback
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
    case unknown(id: String, fallback: BuilderNodeBox?)

    private enum TypeKey: String, CodingKey { case type }
    private enum UnknownKeys: String, CodingKey { case id, fallback }

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
        default:
            let container = try decoder.container(keyedBy: UnknownKeys.self)
            let id = try container.decode(String.self, forKey: .id)
            let fallback = try container.decodeIfPresent(BuilderNodeBox.self, forKey: .fallback)
            self = .unknown(id: id, fallback: fallback)
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
        case .unknown(let id, _): return id
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
