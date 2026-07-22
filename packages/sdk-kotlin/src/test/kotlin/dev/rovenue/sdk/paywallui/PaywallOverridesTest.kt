package dev.rovenue.sdk.paywallui

import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Package
import dev.rovenue.sdk.PackageType
import dev.rovenue.sdk.ProductCategory
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.StoreProduct
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * `applyOverrides` case table, ported verbatim from
 * packages/shared/src/paywall/validate.test.ts's `applyOverrides` describe
 * block (D-Task 1's shared cross-platform case table) — same cases as
 * packages/sdk-swift .../RovenueTests/PaywallOverridesTests.swift — plus
 * `activeOverrideConditions` (the cell-scoped/selected-scoped
 * condition-set helper backing NodeViewFactory's per-node override
 * application).
 */
class PaywallOverridesTest {

    // ---- applyOverrides(BuilderNode.Text, ...) — the shared case table ----

    private val baseText = BuilderNode.Text(
        id = "t1", key = "title_key", role = TextRole.TITLE,
        color = ThemePair("#000", null), align = HAlign.START,
    )

    @Test
    fun `returns unchanged when node has no overrides`() {
        val result = applyOverrides(baseText, OverrideActiveConditions(introEligible = false, selected = false))
        assertEquals(baseText.key, result.key)
        assertEquals(baseText.align, result.align)
        assertEquals(baseText.color, result.color)
    }

    @Test
    fun `returns unchanged when overrides exist but none are active`() {
        val overrides = listOf(NodeOverride(OverrideConditionKind.INTRO_ELIGIBLE, TextOverrideProps(align = HAlign.CENTER)))
        val node = baseText.copy(overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = false, selected = false))
        assertEquals(node.align, result.align)
        assertEquals(node.key, result.key)
    }

    @Test
    fun `merges matching introEligible override props`() {
        val overrides = listOf(
            NodeOverride(OverrideConditionKind.INTRO_ELIGIBLE, TextOverrideProps(key = "intro_key", align = HAlign.CENTER)),
        )
        val node = baseText.copy(overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = true, selected = false))
        assertEquals("intro_key", result.key)
        assertEquals(HAlign.CENTER, result.align)
        assertEquals(baseText.color, result.color)
    }

    @Test
    fun `merges matching selected override props`() {
        val overrides = listOf(NodeOverride(OverrideConditionKind.SELECTED, TextOverrideProps(align = HAlign.END)))
        val node = baseText.copy(overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = false, selected = true))
        assertEquals(HAlign.END, result.align)
    }

    @Test
    fun `applies overrides in array order, later wins on shared keys`() {
        val overrides = listOf(
            NodeOverride(OverrideConditionKind.INTRO_ELIGIBLE, TextOverrideProps(align = HAlign.CENTER)),
            NodeOverride(OverrideConditionKind.INTRO_ELIGIBLE, TextOverrideProps(align = HAlign.END)),
        )
        val node = baseText.copy(overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = true, selected = false))
        assertEquals(HAlign.END, result.align)
    }

    @Test
    fun `does not deep merge, later overrides color wholly replaces earlier`() {
        val overrides = listOf(
            NodeOverride(OverrideConditionKind.INTRO_ELIGIBLE, TextOverrideProps(color = ThemePair("#111", null))),
            NodeOverride(OverrideConditionKind.INTRO_ELIGIBLE, TextOverrideProps(color = ThemePair("#222", null))),
        )
        val node = baseText.copy(overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = true, selected = false))
        assertEquals(ThemePair("#222", null), result.color)
    }

    @Test
    fun `leaves untouched base props intact when only some props are overridden`() {
        val overrides = listOf(NodeOverride(OverrideConditionKind.INTRO_ELIGIBLE, TextOverrideProps(align = HAlign.END)))
        val node = baseText.copy(overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = true, selected = false))
        assertEquals(baseText.key, result.key)
        assertEquals(baseText.color, result.color)
    }

    @Test
    fun `skips override with unknown when kind without throwing`() {
        // `props` non-null here even though this only ever happens for
        // `.UNKNOWN` via a decode (where props is always null) —
        // programmatically constructing it this way asserts the skip is
        // driven by `whenKind` alone, not by `props` being absent.
        val overrides = listOf(NodeOverride(OverrideConditionKind.UNKNOWN, TextOverrideProps(align = HAlign.END)))
        val node = baseText.copy(overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = true, selected = true))
        assertEquals(node.align, result.align)
        assertEquals(node.key, result.key)
    }

    @Test
    fun `is generic over any node subtype, works on packageList too`() {
        val node = BuilderNode.PackageList(id = "p1", packageIds = emptyList(), cellLayout = CellLayout.ROW)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = false, selected = false))
        assertEquals(node.id, result.id)
        assertEquals(node.packageIds, result.packageIds)
    }

    // ---- applyOverrides(BuilderNode, ...) dispatch -------------------------

    @Test
    fun `builderNode dispatch applies to the wrapped node`() {
        val overrides = listOf(NodeOverride(OverrideConditionKind.INTRO_ELIGIBLE, TextOverrideProps(key = "intro_key")))
        val node: BuilderNode = BuilderNode.Text(id = "t", key = "base_key", role = TextRole.BODY, overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = true, selected = false))
        val text = result as? BuilderNode.Text ?: error("expected Text")
        assertEquals("intro_key", text.key)
    }

    @Test
    fun `builderNode dispatch unknown node passes through unchanged`() {
        val node: BuilderNode = BuilderNode.Unknown(id = "u1", fallback = null)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = true, selected = true))
        assertEquals("u1", result.id)
    }

    // ---- applyOverrides for the other 5 node payload types (spot checks) --

    @Test
    fun `stack node merges spacing align background cornerRadius`() {
        val overrides = listOf(
            NodeOverride(
                OverrideConditionKind.SELECTED,
                StackOverrideProps(spacing = 4.0, align = HAlign.START, background = ThemePair("#eee", null), cornerRadius = 2.0),
            ),
        )
        val node = BuilderNode.Stack(id = "s", axis = Axis.V, children = emptyList(), overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = false, selected = true))
        assertEquals(4.0, result.spacing)
        assertEquals(HAlign.START, result.align)
        assertEquals(ThemePair("#eee", null), result.background)
        assertEquals(2.0, result.cornerRadius)
    }

    @Test
    fun `image node merges cornerRadius only`() {
        val overrides = listOf(NodeOverride(OverrideConditionKind.INTRO_ELIGIBLE, ImageOverrideProps(cornerRadius = 24.0)))
        val node = BuilderNode.Image(id = "i", url = ThemePair("https://x", null), overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = true, selected = false))
        assertEquals(24.0, result.cornerRadius)
    }

    @Test
    fun `button node merges labelKey and style`() {
        val overrides = listOf(
            NodeOverride(OverrideConditionKind.SELECTED, ButtonOverrideProps(labelKey = "cta_selected", style = ButtonVisualStyle.SECONDARY)),
        )
        val node = BuilderNode.Button(
            id = "b", labelKey = "cta", style = ButtonVisualStyle.PRIMARY, action = ButtonAction.Close, overrides = overrides,
        )
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = false, selected = true))
        assertEquals("cta_selected", result.labelKey)
        assertEquals(ButtonVisualStyle.SECONDARY, result.style)
        assertEquals(ButtonAction.Close, result.action)
    }

    @Test
    fun `purchaseButton node merges labelKey`() {
        val overrides = listOf(NodeOverride(OverrideConditionKind.SELECTED, PurchaseButtonOverrideProps(labelKey = "buy_selected")))
        val node = BuilderNode.PurchaseButton(id = "pb", labelKey = "buy", overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = false, selected = true))
        assertEquals("buy_selected", result.labelKey)
    }

    @Test
    fun `spacer node is always a no-op`() {
        val overrides = listOf(NodeOverride(OverrideConditionKind.SELECTED, SpacerOverrideProps))
        val node = BuilderNode.Spacer(id = "sp", size = 8.0, overrides = overrides)
        val result = applyOverrides(node, OverrideActiveConditions(introEligible = false, selected = true))
        assertEquals(8.0, result.size)
    }

    // ---- activeOverrideConditions ------------------------------------------

    @Test
    fun `active conditions outside cellTemplate uses selected package`() {
        val offering = makeOffering(listOf("monthly" to true, "annual" to false))
        val active = activeOverrideConditions(cellPackageId = null, selectedPackageId = "monthly", offering = offering)
        assertTrue(active.introEligible)
        assertFalse(active.selected, "selected is only ever true inside a cellTemplate subtree")
    }

    @Test
    fun `active conditions outside cellTemplate no selection introEligible false`() {
        val offering = makeOffering(listOf("monthly" to true))
        val active = activeOverrideConditions(cellPackageId = null, selectedPackageId = null, offering = offering)
        assertFalse(active.introEligible)
        assertFalse(active.selected)
    }

    @Test
    fun `active conditions inside cellTemplate uses the cells own package`() {
        val offering = makeOffering(listOf("monthly" to false, "annual" to true))
        // Global selection is "monthly" (not eligible), but this cell is "annual" (eligible).
        val active = activeOverrideConditions(cellPackageId = "annual", selectedPackageId = "monthly", offering = offering)
        assertTrue(active.introEligible)
        assertFalse(active.selected, "this cell isn't the globally selected one")
    }

    @Test
    fun `active conditions inside cellTemplate selected true only for the selected cell`() {
        val offering = makeOffering(listOf("monthly" to false, "annual" to false))
        val selectedCell = activeOverrideConditions(cellPackageId = "annual", selectedPackageId = "annual", offering = offering)
        assertTrue(selectedCell.selected)
        val otherCell = activeOverrideConditions(cellPackageId = "monthly", selectedPackageId = "annual", offering = offering)
        assertFalse(otherCell.selected)
    }

    @Test
    fun `active conditions missing package in offering introEligible false`() {
        val active = activeOverrideConditions(cellPackageId = "ghost", selectedPackageId = null, offering = null)
        assertFalse(active.introEligible)
        assertFalse(active.selected)
    }
}

// ---- Test helpers -----------------------------------------------------

private fun makeOffering(products: List<Pair<String, Boolean>>): Offering {
    val packages = products.map { (id, eligible) ->
        Package(
            identifier = id,
            packageType = PackageType.CUSTOM,
            product = StoreProduct(
                id = id,
                type = ProductType.SUBSCRIPTION,
                productCategory = ProductCategory.SUBSCRIPTION,
                displayName = id,
                isEligibleForIntroOffer = eligible,
            ),
        )
    }
    return Offering(identifier = "default", isDefault = true, packages = packages)
}
