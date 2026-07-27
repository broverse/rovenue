package dev.rovenue.sdk.paywallui

import android.content.Context
import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Package
import dev.rovenue.sdk.PackageType
import dev.rovenue.sdk.Period
import dev.rovenue.sdk.PeriodUnit
import dev.rovenue.sdk.ProductCategory
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.StoreProduct
import io.mockk.mockk
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure-logic tests for the Android Views renderer's style/layout/action
 * computation, extracted out of [NodeViewFactory] and [RovenuePaywallView]
 * specifically so they're testable WITHOUT an Android runtime (the module deliberately has no
 * Android-runtime test framework; the once-declared-but-unusable
 * Robolectric dependency has been removed). View construction itself is
 * manually smoked instead — see RovenuePaywallView.kt's class doc.
 */
class NodeViewFactoryTest {

    // ---- parseHexColor -------------------------------------------------

    @Test
    fun `parseHexColor parses 6-digit hex with full opacity`() {
        val rgba = parseHexColor("#FF8800")
        assertEquals(RgbaColor(red = 1.0, green = 0x88 / 255.0, blue = 0.0, alpha = 1.0), rgba)
    }

    @Test
    fun `parseHexColor parses 8-digit hex with alpha`() {
        val rgba = parseHexColor("#11223344")
        assertEquals(
            RgbaColor(
                red = 0x11 / 255.0,
                green = 0x22 / 255.0,
                blue = 0x33 / 255.0,
                alpha = 0x44 / 255.0,
            ),
            rgba,
        )
    }

    @Test
    fun `parseHexColor accepts missing leading hash`() {
        assertEquals(parseHexColor("#00FF00"), parseHexColor("00FF00"))
    }

    @Test
    fun `parseHexColor is case-insensitive`() {
        assertEquals(parseHexColor("#AABBCC"), parseHexColor("#aabbcc"))
    }

    @Test
    fun `parseHexColor rejects wrong lengths`() {
        assertNull(parseHexColor("#FFF"))
        assertNull(parseHexColor("#FF00"))
        assertNull(parseHexColor("#FF00FF0"))
    }

    @Test
    fun `parseHexColor rejects non-hex characters`() {
        assertNull(parseHexColor("#GGGGGG"))
    }

    @Test
    fun `parseHexColor rejects blank string`() {
        assertNull(parseHexColor(""))
        assertNull(parseHexColor("#"))
    }

    @Test
    fun `toColorInt packs ARGB matching manual bit shifting`() {
        val rgba = RgbaColor(red = 1.0, green = 0.0, blue = 0.0, alpha = 1.0)
        assertEquals(-65536, rgba.toColorInt()) // 0xFFFF0000 as a signed Int
    }

    // ---- themeValue ------------------------------------------------------

    @Test
    fun `themeValue picks dark when dark mode and a dark value exists`() {
        val pair = ThemePair(light = "#FFFFFF", dark = "#000000")
        assertEquals("#000000", themeValue(pair, dark = true))
    }

    @Test
    fun `themeValue falls back to light when dark mode has no dark value`() {
        val pair = ThemePair(light = "#FFFFFF", dark = null)
        assertEquals("#FFFFFF", themeValue(pair, dark = true))
    }

    @Test
    fun `themeValue picks light when not dark mode`() {
        val pair = ThemePair(light = "#FFFFFF", dark = "#000000")
        assertEquals("#FFFFFF", themeValue(pair, dark = false))
    }

    // ---- computeDarkMode ---------------------------------------------------

    @Test
    fun `computeDarkMode prefers the explicit override`() {
        assertTrue(computeDarkMode(optionsDarkMode = true, isSystemNight = false))
        assertFalse(computeDarkMode(optionsDarkMode = false, isSystemNight = true))
    }

    @Test
    fun `computeDarkMode falls back to system night mode when unset`() {
        assertTrue(computeDarkMode(optionsDarkMode = null, isSystemNight = true))
        assertFalse(computeDarkMode(optionsDarkMode = null, isSystemNight = false))
    }

    // ---- purchaseEnabled / actionButtonVisible ----------------------------

    @Test
    fun `purchaseEnabled requires a selection and no in-flight purchase`() {
        assertTrue(purchaseEnabled(selectedPackageId = "pkg_a", isPurchasing = false))
        assertFalse(purchaseEnabled(selectedPackageId = null, isPurchasing = false))
        assertFalse(purchaseEnabled(selectedPackageId = "pkg_a", isPurchasing = true))
        assertFalse(purchaseEnabled(selectedPackageId = null, isPurchasing = true))
    }

    @Test
    fun `actionButtonVisible hides restore without a handler`() {
        assertFalse(actionButtonVisible(ButtonAction.Restore, hasRestoreHandler = false))
        assertTrue(actionButtonVisible(ButtonAction.Restore, hasRestoreHandler = true))
    }

    @Test
    fun `actionButtonVisible keeps close and url visible regardless of restore handler`() {
        assertTrue(actionButtonVisible(ButtonAction.Close, hasRestoreHandler = false))
        assertTrue(actionButtonVisible(ButtonAction.Url("https://rovenue.app"), hasRestoreHandler = false))
    }

    // ---- relevantPackageView ------------------------------------------

    private fun product(priceString: String = "$9.99", period: Period? = Period(1, PeriodUnit.MONTH, "P1M")) =
        StoreProduct(
            id = "prod_a",
            type = ProductType.SUBSCRIPTION,
            productCategory = ProductCategory.SUBSCRIPTION,
            displayName = "Pro Monthly",
            priceString = priceString,
            subscriptionPeriod = period,
        )

    private fun offering() = Offering(
        identifier = "default",
        isDefault = true,
        packages = listOf(Package(identifier = "pkg_a", packageType = PackageType.MONTHLY, product = product())),
    )

    @Test
    fun `relevantPackageView returns the cell package when inside a cell`() {
        val cell = PackageView("Cell", "$1", "$1/mo", "month")
        assertEquals(cell, relevantPackageView(cell = cell, selectedPackageId = "pkg_a", offering = offering()))
    }

    @Test
    fun `relevantPackageView falls back to the selected package outside a cell`() {
        val result = relevantPackageView(cell = null, selectedPackageId = "pkg_a", offering = offering())
        assertEquals(PackageView("Pro Monthly", "$9.99", "$9.99/month", "month"), result)
    }

    @Test
    fun `relevantPackageView is null with no selection and no cell`() {
        assertNull(relevantPackageView(cell = null, selectedPackageId = null, offering = offering()))
    }

    @Test
    fun `relevantPackageView is null when the selected id is not in the offering`() {
        assertNull(relevantPackageView(cell = null, selectedPackageId = "missing", offering = offering()))
    }

    // ---- textStyleFor ---------------------------------------------------

    @Test
    fun `textStyleFor follows the documented size-weight scale`() {
        assertEquals(TextStyleSpec(sizeSp = 24f, bold = true), textStyleFor(TextRole.TITLE))
        assertEquals(TextStyleSpec(sizeSp = 18f, bold = false), textStyleFor(TextRole.SUBTITLE))
        assertEquals(TextStyleSpec(sizeSp = 15f, bold = false), textStyleFor(TextRole.BODY))
        assertEquals(TextStyleSpec(sizeSp = 12f, bold = false), textStyleFor(TextRole.CAPTION))
    }

    // ---- childLayoutFor (stack sizing / spacer flex) ----------------------

    private fun stackNode(size: SizeSpec? = null) = BuilderNode.Stack(
        id = "s",
        axis = Axis.V,
        children = emptyList(),
        size = size,
    )

    private fun spacerNode(size: Double? = null) = BuilderNode.Spacer(id = "sp", size = size)

    private fun textNode() = BuilderNode.Text(id = "t", key = "k", role = TextRole.BODY)

    private fun dividerNode(
        thickness: Double? = null,
        overrides: List<NodeOverride<DividerOverrideProps>>? = null,
    ) = BuilderNode.Divider(id = "d", thickness = thickness, overrides = overrides)

    private fun iconNode(size: Double? = null) = BuilderNode.Icon(id = "i", name = "check", size = size)

    private fun featureListNode() = BuilderNode.FeatureList(id = "fl", rows = listOf(FeatureRow(labelKey = "k")))

    private fun timelineNode() = BuilderNode.Timeline(id = "tl", rows = listOf(TimelineRow(labelKey = "k")))

    private fun socialProofNode() = BuilderNode.SocialProof(id = "sp", labelKey = "k")

    @Test
    fun `childLayoutFor gives non-stack non-spacer children wrap-content and no weight`() {
        val layout = childLayoutFor(Axis.V, textNode())
        assertEquals(DimenMode.WRAP_CONTENT, layout.width.mode)
        assertEquals(DimenMode.WRAP_CONTENT, layout.height.mode)
        assertEquals(0f, layout.weight)
    }

    @Test
    fun `childLayoutFor expands a fill-height stack on the main axis of a vertical parent`() {
        val layout = childLayoutFor(Axis.V, stackNode(SizeSpec(width = null, height = NodeSize.Fill)))
        assertEquals(DimenMode.WEIGHTED_ZERO, layout.height.mode)
        assertEquals(1f, layout.weight)
    }

    @Test
    fun `childLayoutFor treats fill-width as match-parent on the cross axis of a vertical parent`() {
        val layout = childLayoutFor(Axis.V, stackNode(SizeSpec(width = NodeSize.Fill, height = null)))
        assertEquals(DimenMode.MATCH_PARENT, layout.width.mode)
        assertEquals(0f, layout.weight)
    }

    @Test
    fun `childLayoutFor expands a fill-width stack on the main axis of a horizontal parent`() {
        val layout = childLayoutFor(Axis.H, stackNode(SizeSpec(width = NodeSize.Fill, height = null)))
        assertEquals(DimenMode.WEIGHTED_ZERO, layout.width.mode)
        assertEquals(1f, layout.weight)
    }

    @Test
    fun `childLayoutFor honors a fixed value size regardless of axis`() {
        val layout = childLayoutFor(Axis.H, stackNode(SizeSpec(width = NodeSize.Value(48.0), height = NodeSize.Value(24.0))))
        assertEquals(DimenMode.FIXED, layout.width.mode)
        assertEquals(48.0, layout.width.valueDp)
        assertEquals(DimenMode.FIXED, layout.height.mode)
        assertEquals(24.0, layout.height.valueDp)
    }

    @Test
    fun `childLayoutFor gives a sized spacer a fixed square box`() {
        val layout = childLayoutFor(Axis.V, spacerNode(16.0))
        assertEquals(DimenMode.FIXED, layout.width.mode)
        assertEquals(16.0, layout.width.valueDp)
        assertEquals(DimenMode.FIXED, layout.height.mode)
        assertEquals(16.0, layout.height.valueDp)
        assertEquals(0f, layout.weight)
    }

    @Test
    fun `childLayoutFor gives an unsized spacer flex-space on the parent's main axis`() {
        val vertical = childLayoutFor(Axis.V, spacerNode(null))
        assertEquals(DimenMode.WEIGHTED_ZERO, vertical.height.mode)
        assertEquals(DimenMode.WRAP_CONTENT, vertical.width.mode)
        assertEquals(1f, vertical.weight)

        val horizontal = childLayoutFor(Axis.H, spacerNode(null))
        assertEquals(DimenMode.WEIGHTED_ZERO, horizontal.width.mode)
        assertEquals(DimenMode.WRAP_CONTENT, horizontal.height.mode)
        assertEquals(1f, horizontal.weight)
    }

    @Test
    fun `childLayoutFor gives a z-axis stack no weight even when filling`() {
        val layout = childLayoutFor(Axis.Z, stackNode(SizeSpec(width = NodeSize.Fill, height = NodeSize.Fill)))
        assertEquals(DimenMode.MATCH_PARENT, layout.width.mode)
        assertEquals(DimenMode.MATCH_PARENT, layout.height.mode)
        assertEquals(0f, layout.weight)
    }

    // ---- childLayoutFor (divider / icon) ----------------------------------
    // Mirrors the stack/spacer coverage above — the only two arms of
    // childLayoutFor without a dedicated case before this fix wave.

    @Test
    fun `childLayoutFor gives a divider match-parent width and its default thickness height`() {
        val layout = childLayoutFor(Axis.V, dividerNode())
        assertEquals(DimenMode.MATCH_PARENT, layout.width.mode)
        assertEquals(DimenMode.FIXED, layout.height.mode)
        assertEquals(1.0, layout.height.valueDp) // DIVIDER_DEFAULT_THICKNESS_DP (private to NodeViewFactory.kt)
        assertEquals(0f, layout.weight)
    }

    @Test
    fun `childLayoutFor gives a divider match-parent width regardless of the parent axis`() {
        val layout = childLayoutFor(Axis.H, dividerNode(thickness = 4.0))
        assertEquals(DimenMode.MATCH_PARENT, layout.width.mode)
        assertEquals(DimenMode.FIXED, layout.height.mode)
        assertEquals(4.0, layout.height.valueDp)
    }

    @Test
    fun `childLayoutFor honors an explicit divider thickness`() {
        val layout = childLayoutFor(Axis.V, dividerNode(thickness = 2.0))
        assertEquals(2.0, layout.height.valueDp)
    }

    @Test
    fun `childLayoutFor gives an icon a fixed square at the default size`() {
        val layout = childLayoutFor(Axis.V, iconNode())
        assertEquals(DimenMode.FIXED, layout.width.mode)
        assertEquals(24.0, layout.width.valueDp) // ICON_DEFAULT_SIZE_DP (private to NodeViewFactory.kt)
        assertEquals(DimenMode.FIXED, layout.height.mode)
        assertEquals(24.0, layout.height.valueDp)
        assertEquals(0f, layout.weight)
    }

    @Test
    fun `childLayoutFor gives an icon a fixed square at its explicit size`() {
        val layout = childLayoutFor(Axis.H, iconNode(size = 40.0))
        assertEquals(DimenMode.FIXED, layout.width.mode)
        assertEquals(40.0, layout.width.valueDp)
        assertEquals(DimenMode.FIXED, layout.height.mode)
        assertEquals(40.0, layout.height.valueDp)
    }

    // ---- childLayoutFor (featureList / timeline / socialProof) -----------
    // These three fall through to the generic WRAP_CONTENT/no-weight arm
    // (none of them carry a schema-level `size`, unlike stack) — a case per
    // type here is what would have caught a dropped/misrouted arm, mirroring
    // the divider/icon coverage above.

    @Test
    fun `childLayoutFor gives a featureList wrap-content and no weight`() {
        val layout = childLayoutFor(Axis.V, featureListNode())
        assertEquals(DimenMode.WRAP_CONTENT, layout.width.mode)
        assertEquals(DimenMode.WRAP_CONTENT, layout.height.mode)
        assertEquals(0f, layout.weight)
    }

    @Test
    fun `childLayoutFor gives a timeline wrap-content and no weight`() {
        val layout = childLayoutFor(Axis.V, timelineNode())
        assertEquals(DimenMode.WRAP_CONTENT, layout.width.mode)
        assertEquals(DimenMode.WRAP_CONTENT, layout.height.mode)
        assertEquals(0f, layout.weight)
    }

    @Test
    fun `childLayoutFor gives a socialProof wrap-content and no weight`() {
        val layout = childLayoutFor(Axis.V, socialProofNode())
        assertEquals(DimenMode.WRAP_CONTENT, layout.width.mode)
        assertEquals(DimenMode.WRAP_CONTENT, layout.height.mode)
        assertEquals(0f, layout.weight)
    }

    // ---- childLayoutFor + applyOverrides: the RESOLVED node drives layout -
    //
    // Regresses buildStack's pre-fix bug: `build()` resolves overrides
    // INTERNALLY before dispatching, so what actually drew reflected an
    // active override, but `childLayoutFor` was fed the RAW, pre-override
    // child — an active `thickness` override changed the rendered bar
    // without changing the box it was laid out in. This proves the fix
    // belongs at the `applyOverrides` + `childLayoutFor` pairing itself
    // (which is what buildStack's hoist now does), independent of any
    // Android view construction this module can't runtime-test.

    @Test
    fun `an active override's thickness is what childLayoutFor sees, not the raw pre-override value`() {
        val raw = dividerNode(
            thickness = 1.0,
            overrides = listOf(
                NodeOverride(OverrideConditionKind.SELECTED, DividerOverrideProps(thickness = 10.0)),
            ),
        )
        val inactive = childLayoutFor(Axis.V, applyOverrides(raw, OverrideActiveConditions(introEligible = false, selected = false)))
        assertEquals(1.0, inactive.height.valueDp)

        val active = childLayoutFor(Axis.V, applyOverrides(raw, OverrideActiveConditions(introEligible = false, selected = true)))
        assertEquals(10.0, active.height.valueDp)
    }

    // ---- gravity mapping -------------------------------------------------

    @Test
    fun `crossAxisGravity maps vertical-stack align to horizontal gravity`() {
        assertEquals(android.view.Gravity.START, crossAxisGravity(Axis.V, HAlign.START))
        assertEquals(android.view.Gravity.START, crossAxisGravity(Axis.V, null))
        assertEquals(android.view.Gravity.CENTER_HORIZONTAL, crossAxisGravity(Axis.V, HAlign.CENTER))
        assertEquals(android.view.Gravity.END, crossAxisGravity(Axis.V, HAlign.END))
    }

    @Test
    fun `crossAxisGravity maps horizontal-stack align to vertical gravity`() {
        assertEquals(android.view.Gravity.TOP, crossAxisGravity(Axis.H, HAlign.START))
        assertEquals(android.view.Gravity.CENTER_VERTICAL, crossAxisGravity(Axis.H, HAlign.CENTER))
        assertEquals(android.view.Gravity.BOTTOM, crossAxisGravity(Axis.H, HAlign.END))
    }

    @Test
    fun `zGravity maps start-end to corner gravity and center to center`() {
        assertEquals(android.view.Gravity.TOP or android.view.Gravity.START, zGravity(HAlign.START))
        assertEquals(android.view.Gravity.BOTTOM or android.view.Gravity.END, zGravity(HAlign.END))
        assertEquals(android.view.Gravity.CENTER, zGravity(HAlign.CENTER))
        assertEquals(android.view.Gravity.CENTER, zGravity(null))
    }

    @Test
    fun `textGravity mirrors HAlign directly`() {
        assertEquals(android.view.Gravity.START, textGravity(HAlign.START))
        assertEquals(android.view.Gravity.START, textGravity(null))
        assertEquals(android.view.Gravity.CENTER_HORIZONTAL, textGravity(HAlign.CENTER))
        assertEquals(android.view.Gravity.END, textGravity(HAlign.END))
    }

    // ---- action routing ---------------------------------------------------

    @Test
    fun `routeButtonAction invokes onClose for close actions`() {
        var closed = false
        routeButtonAction(ButtonAction.Close, onClose = { closed = true }, onRestore = null, onUrl = null)
        assertTrue(closed)
    }

    @Test
    fun `routeButtonAction invokes onRestore for restore actions`() {
        var restored = false
        routeButtonAction(ButtonAction.Restore, onClose = null, onRestore = { restored = true }, onUrl = null)
        assertTrue(restored)
    }

    @Test
    fun `routeButtonAction invokes onUrl with the raw url string`() {
        var received: String? = null
        routeButtonAction(ButtonAction.Url("https://rovenue.app"), onClose = null, onRestore = null, onUrl = { received = it })
        assertEquals("https://rovenue.app", received)
    }

    @Test
    fun `routeButtonAction is a no-op when the matching handler is null`() {
        // Must not throw.
        routeButtonAction(ButtonAction.Close, onClose = null, onRestore = null, onUrl = null)
        routeButtonAction(ButtonAction.Restore, onClose = null, onRestore = null, onUrl = null)
        routeButtonAction(ButtonAction.Url("x"), onClose = null, onRestore = null, onUrl = null)
    }

    // ---- NodeViewFactory.build: visibility gate ---------------------------
    //
    // These exercise the actual `build()` entry point (not just the pure
    // `isNodeVisible` predicate covered by VisibilityTest/
    // BuilderConfigModelTest) — a real android.content.Context is needed
    // to construct it, but every case here is hidden (or gated before any
    // view work happens), so the mocked Context is never actually
    // exercised. Verifying a hidden result is the reliable part of this
    // module's Android surface: it's a plain reference-equality check,
    // unlike a ViewGroup's own bookkeeping (`childCount` etc.), which this
    // module's stub Android jar always reports as empty regardless of
    // what was actually added (`isReturnDefaultValues = true` — see
    // build.gradle.kts) — that's exactly why this module has no
    // Android-runtime test framework and construction is manually smoked
    // instead (see RovenuePaywallView.kt's class doc). `build()` returning
    // `null`, however, IS a faithful, directly observable contract.

    private fun mockContext(): Context = mockk(relaxed = true)

    private fun renderContext(appVersion: String? = "2.0.0") = PaywallRenderContext(
        config = BuilderConfigModel(
            formatVersion = 2,
            defaultLocale = "en",
            localizations = emptyMap(),
            background = null,
            root = BuilderNode.Stack(id = "root", axis = Axis.V, children = emptyList()),
        ),
        locale = null,
        dark = false,
        offering = null,
        selectedPackageId = null,
        isPurchasing = false,
        select = {},
        purchase = {},
        onClose = null,
        onRestore = null,
        onUrl = null,
        loadImage = { _, _ -> },
        appVersion = appVersion,
    )

    @Test
    fun `build returns null for a node hidden by platform`() {
        val node = textNode().copy(visibility = Visibility(platform = listOf("ios")))
        assertNull(NodeViewFactory.build(mockContext(), node, renderContext(), cell = null))
    }

    @Test
    fun `build returns null for a hidden stack -- none of its children are built`() {
        val stack = stackNode().copy(
            visibility = Visibility(platform = listOf("ios")),
            children = listOf(textNode(), spacerNode()),
        )
        assertNull(NodeViewFactory.build(mockContext(), stack, renderContext(), cell = null))
    }

    @Test
    fun `build returns null for a hidden node even when it carries a fallback`() {
        val node = textNode().copy(
            visibility = Visibility(minAppVersion = "99.0.0"),
            fallback = textNode(),
        )
        assertNull(NodeViewFactory.build(mockContext(), node, renderContext(appVersion = "1.0.0"), cell = null))
    }

    @Test
    fun `build renders a node with no visibility rules`() {
        assertTrue(NodeViewFactory.build(mockContext(), textNode(), renderContext(), cell = null) != null)
    }

    @Test
    fun `build dispatches featureList, timeline and socialProof nodes`() {
        assertTrue(NodeViewFactory.build(mockContext(), featureListNode(), renderContext(), cell = null) != null)
        assertTrue(NodeViewFactory.build(mockContext(), timelineNode(), renderContext(), cell = null) != null)
        assertTrue(NodeViewFactory.build(mockContext(), socialProofNode(), renderContext(), cell = null) != null)
    }
}
