//  PaywallOverrides.swift — Swift port of
//  packages/shared/src/paywall/validate.ts's `applyOverrides`: same
//  semantics (array order, later wins, shallow per-field overlay, identity
//  when nothing matches, unknown `when.kind` never active). Each node
//  payload type (`StackProps`, `TextProps`, …) gets its own concrete
//  `applyOverrides` overload; `BuilderNode`'s overload dispatches to the
//  right one and re-wraps the result in the same enum case — mirroring
//  nodes.tsx's `renderNode` calling `applyOverrides(node, ...)` before any
//  per-type rendering.
//
//  Test cases in PaywallOverridesTests.swift mirror validate.test.ts's
//  `applyOverrides` describe block (D-Task 1's shared case table) verbatim.

import Foundation

/// The `{ introEligible, selected }` condition set active for a node's
/// position in the tree. Mirrors nodes.tsx's `activeOverrideConditions`
/// return shape.
public struct OverrideActiveConditions: Equatable, Sendable {
    public let introEligible: Bool
    public let selected: Bool

    public init(introEligible: Bool, selected: Bool) {
        self.introEligible = introEligible
        self.selected = selected
    }
}

/// The active props patches for `overrides`, in array order — matches
/// `active.kind` evaluation in validate.ts's `applyOverrides` (an unknown
/// kind is simply never active, no special-casing needed).
private func activePropPatches<Props>(
    _ overrides: [NodeOverride<Props>]?,
    active: OverrideActiveConditions
) -> [Props] {
    guard let overrides else { return [] }
    return overrides.compactMap { override in
        let isActive: Bool
        switch override.when {
        case .introEligible: isActive = active.introEligible
        case .selected: isActive = active.selected
        case .unknown: isActive = false
        }
        return isActive ? override.props : nil
    }
}

public func applyOverrides(_ props: StackProps, active: OverrideActiveConditions) -> StackProps {
    let patches = activePropPatches(props.overrides, active: active)
    guard !patches.isEmpty else { return props }
    var result = props
    for patch in patches {
        result = StackProps(
            id: result.id, axis: result.axis, children: result.children,
            spacing: patch.spacing ?? result.spacing,
            align: patch.align ?? result.align,
            padding: result.padding, size: result.size,
            background: patch.background ?? result.background,
            cornerRadius: patch.cornerRadius ?? result.cornerRadius,
            overrides: result.overrides, fallback: result.fallback)
    }
    return result
}

public func applyOverrides(_ props: TextProps, active: OverrideActiveConditions) -> TextProps {
    let patches = activePropPatches(props.overrides, active: active)
    guard !patches.isEmpty else { return props }
    var result = props
    for patch in patches {
        result = TextProps(
            id: result.id, key: patch.key ?? result.key, role: result.role,
            color: patch.color ?? result.color, align: patch.align ?? result.align,
            overrides: result.overrides, fallback: result.fallback)
    }
    return result
}

public func applyOverrides(_ props: ImageProps, active: OverrideActiveConditions) -> ImageProps {
    let patches = activePropPatches(props.overrides, active: active)
    guard !patches.isEmpty else { return props }
    var result = props
    for patch in patches {
        result = ImageProps(
            id: result.id, url: result.url, height: result.height,
            cornerRadius: patch.cornerRadius ?? result.cornerRadius,
            alt: result.alt, overrides: result.overrides, fallback: result.fallback)
    }
    return result
}

public func applyOverrides(_ props: ButtonProps, active: OverrideActiveConditions) -> ButtonProps {
    let patches = activePropPatches(props.overrides, active: active)
    guard !patches.isEmpty else { return props }
    var result = props
    for patch in patches {
        result = ButtonProps(
            id: result.id, labelKey: patch.labelKey ?? result.labelKey,
            style: patch.style ?? result.style, action: result.action,
            overrides: result.overrides, fallback: result.fallback)
    }
    return result
}

/// Empty whitelist (`OVERRIDABLE_PROP_KEYS.packageList == []`) — no fields
/// to merge; an `overrides` array on this type can only ever carry
/// `props: {}`, so this is always a no-op.
public func applyOverrides(_ props: PackageListProps, active: OverrideActiveConditions) -> PackageListProps {
    props
}

public func applyOverrides(_ props: PurchaseButtonProps, active: OverrideActiveConditions) -> PurchaseButtonProps {
    let patches = activePropPatches(props.overrides, active: active)
    guard !patches.isEmpty else { return props }
    var result = props
    for patch in patches {
        result = PurchaseButtonProps(
            id: result.id, labelKey: patch.labelKey ?? result.labelKey,
            overrides: result.overrides, fallback: result.fallback)
    }
    return result
}

/// Empty whitelist (`OVERRIDABLE_PROP_KEYS.spacer == []`) — same as
/// `PackageListProps`, always a no-op.
public func applyOverrides(_ props: SpacerProps, active: OverrideActiveConditions) -> SpacerProps {
    props
}

/// Dispatches to the node's own `applyOverrides` overload and re-wraps the
/// result in the same `BuilderNode` case. `.unknown` nodes carry no
/// overrides field at all and pass through unchanged.
public func applyOverrides(_ node: BuilderNode, active: OverrideActiveConditions) -> BuilderNode {
    switch node {
    case .stack(let p): return .stack(applyOverrides(p, active: active))
    case .text(let p): return .text(applyOverrides(p, active: active))
    case .image(let p): return .image(applyOverrides(p, active: active))
    case .button(let p): return .button(applyOverrides(p, active: active))
    case .packageList(let p): return .packageList(applyOverrides(p, active: active))
    case .purchaseButton(let p): return .purchaseButton(applyOverrides(p, active: active))
    case .spacer(let p): return .spacer(applyOverrides(p, active: active))
    case .unknown: return node
    }
}

/// The `{ introEligible, selected }` condition set active for a node's
/// position in the tree, given the cell it's scoped to (if any — `nil`
/// outside any `cellTemplate` subtree). Relevance follows the same rule as
/// `{{variable}}` resolution: cell-scoped inside a `cellTemplate` subtree
/// (the cell's own package), selected-scoped everywhere else (the globally
/// selected package). `selected` is only ever true inside a `cellTemplate`
/// subtree, for the cell whose package is the current global selection.
/// Mirrors nodes.tsx's `activeOverrideConditions`.
public func activeOverrideConditions(
    cellPackageId: String?,
    selectedPackageId: String?,
    offering: Offering?
) -> OverrideActiveConditions {
    let relevantPackageId = cellPackageId ?? selectedPackageId
    let introEligible = relevantPackageId.flatMap { id in
        offering?.packages.first(where: { $0.identifier == id })?.product.isEligibleForIntroOffer
    } ?? false
    let selected = cellPackageId != nil && cellPackageId == selectedPackageId
    return OverrideActiveConditions(introEligible: introEligible, selected: selected)
}
