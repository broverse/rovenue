package dev.rovenue.sdk.paywallui

import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Package
import dev.rovenue.sdk.PackageType
import dev.rovenue.sdk.Period
import dev.rovenue.sdk.PeriodUnit
import dev.rovenue.sdk.ProductCategory
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.StoreProduct
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure-logic tests for the Android Views renderer's style/layout/action
 * computation, extracted out of [NodeViewFactory] and [RovenuePaywallView]
 * specifically so they're testable WITHOUT an Android runtime (Robolectric
 * is declared as a testImplementation dependency but is not actually wired
 * for use in this module: JUnit4's `org.junit.Test`/`@RunWith` aren't on
 * the compile classpath — only reachable via the runtime classpath — and
 * there's no junit-vintage-engine for the JUnit5-platform `Test` tasks
 * (`useJUnitPlatform()`) to discover JUnit4-style Robolectric tests; wiring
 * it up would mean adding `junit:junit` + `junit-vintage-engine`, which is
 * out of scope ("NO new dependencies"). View construction itself is
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
}
