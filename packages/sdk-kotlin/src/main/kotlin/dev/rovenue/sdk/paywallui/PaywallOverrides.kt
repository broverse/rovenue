package dev.rovenue.sdk.paywallui

import dev.rovenue.sdk.Offering

// =============================================================
// PaywallOverrides.kt — Kotlin port of
// packages/shared/src/paywall/validate.ts's `applyOverrides`: same
// semantics (array order, later wins, shallow per-field overlay, identity
// when nothing matches, unknown `when.kind` never active). Mirrors
// packages/sdk-swift .../PaywallUI/PaywallOverrides.swift, adapted to the
// Kotlin model where each `BuilderNode` subtype directly carries its own
// fields (no separate `*Props` wrapper the way the Swift enum does).
//
// Test cases in PaywallOverridesTest.kt mirror validate.test.ts's
// `applyOverrides` describe block (D-Task 1's shared case table) verbatim.
// =============================================================

/** The `{ introEligible, selected }` condition set active for a node's
 *  position in the tree. Mirrors nodes.tsx's `activeOverrideConditions`
 *  return shape. */
data class OverrideActiveConditions(val introEligible: Boolean, val selected: Boolean)

/** The active props patches for `overrides`, in array order — matches
 *  `active.kind` evaluation in validate.ts's `applyOverrides` (an unknown
 *  kind is simply never active, no special-casing needed). */
private fun <T> activePropPatches(
    overrides: List<NodeOverride<T>>?,
    active: OverrideActiveConditions,
): List<T> {
    if (overrides == null) return emptyList()
    return overrides.mapNotNull { override ->
        val isActive = when (override.whenKind) {
            OverrideConditionKind.INTRO_ELIGIBLE -> active.introEligible
            OverrideConditionKind.SELECTED -> active.selected
            OverrideConditionKind.UNKNOWN -> false
        }
        if (isActive) override.props else null
    }
}

fun applyOverrides(node: BuilderNode.Stack, active: OverrideActiveConditions): BuilderNode.Stack {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(
            spacing = patch.spacing ?: result.spacing,
            align = patch.align ?: result.align,
            background = patch.background ?: result.background,
            cornerRadius = patch.cornerRadius ?: result.cornerRadius,
        )
    }
    return result
}

fun applyOverrides(node: BuilderNode.Text, active: OverrideActiveConditions): BuilderNode.Text {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(
            key = patch.key ?: result.key,
            color = patch.color ?: result.color,
            align = patch.align ?: result.align,
        )
    }
    return result
}

fun applyOverrides(node: BuilderNode.Image, active: OverrideActiveConditions): BuilderNode.Image {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(cornerRadius = patch.cornerRadius ?: result.cornerRadius)
    }
    return result
}

fun applyOverrides(node: BuilderNode.Button, active: OverrideActiveConditions): BuilderNode.Button {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(
            labelKey = patch.labelKey ?: result.labelKey,
            style = patch.style ?: result.style,
        )
    }
    return result
}

/** Empty whitelist (`OVERRIDABLE_PROP_KEYS.packageList == []`) — no fields
 *  to merge; an `overrides` array on this type can only ever carry
 *  `props: {}`, so this is always a no-op. `active` is unused (kept so the
 *  signature matches every other overload for the generic dispatcher). */
@Suppress("UNUSED_PARAMETER")
fun applyOverrides(node: BuilderNode.PackageList, active: OverrideActiveConditions): BuilderNode.PackageList = node

fun applyOverrides(node: BuilderNode.PurchaseButton, active: OverrideActiveConditions): BuilderNode.PurchaseButton {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(
            labelKey = patch.labelKey ?: result.labelKey,
            trialLabelKey = patch.trialLabelKey ?: result.trialLabelKey,
        )
    }
    return result
}

/** Empty whitelist (`OVERRIDABLE_PROP_KEYS.spacer == []`) — same as
 *  [BuilderNode.PackageList], always a no-op. */
@Suppress("UNUSED_PARAMETER")
fun applyOverrides(node: BuilderNode.Spacer, active: OverrideActiveConditions): BuilderNode.Spacer = node

fun applyOverrides(node: BuilderNode.Divider, active: OverrideActiveConditions): BuilderNode.Divider {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(
            color = patch.color ?: result.color,
            thickness = patch.thickness ?: result.thickness,
        )
    }
    return result
}

fun applyOverrides(node: BuilderNode.Icon, active: OverrideActiveConditions): BuilderNode.Icon {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(
            name = patch.name ?: result.name,
            color = patch.color ?: result.color,
        )
    }
    return result
}

fun applyOverrides(node: BuilderNode.FeatureList, active: OverrideActiveConditions): BuilderNode.FeatureList {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(iconColor = patch.iconColor ?: result.iconColor)
    }
    return result
}

fun applyOverrides(node: BuilderNode.Timeline, active: OverrideActiveConditions): BuilderNode.Timeline {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(connectorColor = patch.connectorColor ?: result.connectorColor)
    }
    return result
}

fun applyOverrides(node: BuilderNode.SocialProof, active: OverrideActiveConditions): BuilderNode.SocialProof {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(
            rating = patch.rating ?: result.rating,
            starColor = patch.starColor ?: result.starColor,
        )
    }
    return result
}

fun applyOverrides(node: BuilderNode.StickyFooter, active: OverrideActiveConditions): BuilderNode.StickyFooter {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(background = patch.background ?: result.background)
    }
    return result
}

fun applyOverrides(node: BuilderNode.Countdown, active: OverrideActiveConditions): BuilderNode.Countdown {
    val patches = activePropPatches(node.overrides, active)
    if (patches.isEmpty()) return node
    var result = node
    for (patch in patches) {
        result = result.copy(color = patch.color ?: result.color)
    }
    return result
}

/** Dispatches to the node's own `applyOverrides` overload. `.Unknown` nodes
 *  carry no overrides field at all and pass through unchanged. */
fun applyOverrides(node: BuilderNode, active: OverrideActiveConditions): BuilderNode = when (node) {
    is BuilderNode.Stack -> applyOverrides(node, active)
    is BuilderNode.Text -> applyOverrides(node, active)
    is BuilderNode.Image -> applyOverrides(node, active)
    is BuilderNode.Button -> applyOverrides(node, active)
    is BuilderNode.PackageList -> applyOverrides(node, active)
    is BuilderNode.PurchaseButton -> applyOverrides(node, active)
    is BuilderNode.Spacer -> applyOverrides(node, active)
    is BuilderNode.Divider -> applyOverrides(node, active)
    is BuilderNode.Icon -> applyOverrides(node, active)
    is BuilderNode.FeatureList -> applyOverrides(node, active)
    is BuilderNode.Timeline -> applyOverrides(node, active)
    is BuilderNode.SocialProof -> applyOverrides(node, active)
    is BuilderNode.StickyFooter -> applyOverrides(node, active)
    is BuilderNode.Countdown -> applyOverrides(node, active)
    is BuilderNode.Unknown -> node
}

/**
 * The `{ introEligible, selected }` condition set active for a node's
 * position in the tree, given the cell it's scoped to (if any — `null`
 * outside any `cellTemplate` subtree). Relevance follows the same rule as
 * `{{variable}}` resolution: cell-scoped inside a `cellTemplate` subtree
 * (the cell's own package), selected-scoped everywhere else (the globally
 * selected package). `selected` is only ever true inside a `cellTemplate`
 * subtree, for the cell whose package is the current global selection.
 * Mirrors nodes.tsx's `activeOverrideConditions`.
 */
fun activeOverrideConditions(
    cellPackageId: String?,
    selectedPackageId: String?,
    offering: Offering?,
): OverrideActiveConditions {
    val relevantPackageId = cellPackageId ?: selectedPackageId
    val introEligible = relevantPackageId?.let { id ->
        offering?.packages?.firstOrNull { it.identifier == id }?.product?.isEligibleForIntroOffer
    } ?: false
    val selected = cellPackageId != null && cellPackageId == selectedPackageId
    return OverrideActiveConditions(introEligible = introEligible, selected = selected)
}
