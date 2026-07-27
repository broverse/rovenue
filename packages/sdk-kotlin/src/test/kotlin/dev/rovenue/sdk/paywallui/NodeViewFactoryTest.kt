package dev.rovenue.sdk.paywallui

import android.content.Context
import android.content.res.ColorStateList
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import dev.rovenue.sdk.Offering
import dev.rovenue.sdk.Package
import dev.rovenue.sdk.PackageType
import dev.rovenue.sdk.Period
import dev.rovenue.sdk.PeriodUnit
import dev.rovenue.sdk.ProductCategory
import dev.rovenue.sdk.ProductType
import dev.rovenue.sdk.StoreProduct
import io.mockk.Runs
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.mockkConstructor
import io.mockk.mockkStatic
import io.mockk.unmockkConstructor
import io.mockk.unmockkStatic
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
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
 *
 * The bottom section ("real View-tree assertions") is a narrow, deliberate
 * exception to that: `mockkConstructor(LinearLayout::class)` /
 * `mockkConstructor(ImageView::class)` intercept every instance of those
 * classes `NodeViewFactory.build` constructs, so calls like `addView`/
 * `setImageTintList` are directly verifiable — real row/star/connector
 * counts and tint wiring, not just "a View came back non-null". This module's
 * android.jar stub still reports `getChildCount()`/etc. as always-empty (see
 * the visibility-gate tests' doc below), so those remain off-limits; this
 * works because it verifies the MOCKED METHOD CALLS themselves, not state
 * read back off the constructed object afterward.
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

    // ---- resolvedInkTintColorInt / socialProofStarFilled (pure) -----------
    // BLOCKING fix (item 1): an absent iconColor/color used to leave
    // imageTintList unset entirely, so Android drew the vendored drawable's
    // own baked-in white fill (see res/drawable/README.md) instead of
    // inheriting anything — invisible on a light background, and for
    // timeline rows (no configurable color field at all) NO authorable
    // config could fix it. These pin the fallback ink directly, without
    // needing an Android view tree.

    @Test
    fun `resolvedInkTintColorInt falls back to the resolved text ink, not white`() {
        val fallback = resolvedInkTintColorInt(explicit = null, dark = false)
        assertEquals(parseHexColor("#0F172A")!!.toColorInt(), fallback)
        assertTrue(fallback != 0xFFFFFFFF.toInt(), "must not fall back to white")
    }

    @Test
    fun `resolvedInkTintColorInt uses the dark variant in dark mode`() {
        assertEquals(parseHexColor("#F8FAFC")!!.toColorInt(), resolvedInkTintColorInt(explicit = null, dark = true))
    }

    @Test
    fun `resolvedInkTintColorInt prefers an explicit color over the ink default`() {
        val explicit = ThemePair(light = "#112233")
        assertEquals(parseHexColor("#112233")!!.toColorInt(), resolvedInkTintColorInt(explicit, dark = false))
    }

    @Test
    fun `socialProofStarFilled fills only floor(rating) stars for a fractional rating`() {
        // 4.5 -> indices 0..3 filled (4 stars), index 4 NOT filled. No test
        // anywhere exercised a fractional rating before this fix.
        assertTrue(socialProofStarFilled(index = 0, rating = 4.5))
        assertTrue(socialProofStarFilled(index = 3, rating = 4.5))
        assertFalse(socialProofStarFilled(index = 4, rating = 4.5))
    }

    @Test
    fun `socialProofStarFilled fills every index up to a whole rating`() {
        assertTrue(socialProofStarFilled(index = 3, rating = 4.0))
        assertFalse(socialProofStarFilled(index = 4, rating = 4.0))
    }

    // ---- countdown (pure) --------------------------------------------------

    @Test
    fun formatsRemainingTime() {
        assertEquals("01:00", countdownText(60))
        assertEquals("01:01:01", countdownText(3661))
        assertEquals("00:00", countdownText(0))
        assertEquals("00:00", countdownText(-5))
    }

    /**
     * The spec requires `durationSeconds` anchored to a PERSISTED first-show
     * instant — a timer restarting on every open is not a deadline. This is
     * the test that pins it: a SECOND render for the SAME paywall identifier
     * must reuse the FIRST call's stamp, not re-stamp with the current
     * clock. [FakeSharedPreferences] stands in for real device storage
     * (mirrors the Swift renderer's injectable `UserDefaults` test double)
     * so this never touches, or depends on, real device state.
     *
     * Mutation-checked (see task report): making the write unconditional
     * (always `prefs.edit().putLong(key, now()).apply()`, never reading the
     * existing value back first) makes the second assertion below fail —
     * `second` becomes `2_000L` instead of reusing `1_000L`.
     */
    @Test
    fun `countdownFirstShownAtMillis stamps on first call and reuses the anchor on the second`() {
        val prefs = FakeSharedPreferences()
        val first = countdownFirstShownAtMillis("pw_1", prefs, now = { 1_000L })
        val second = countdownFirstShownAtMillis("pw_1", prefs, now = { 2_000L })
        assertEquals(1_000L, first)
        assertEquals(1_000L, second, "second call must reuse the persisted first-show anchor, not re-stamp it")
    }

    @Test
    fun `countdownFirstShownAtMillis keys the anchor per paywall identifier`() {
        // Two countdown nodes on DIFFERENT paywalls must NOT share an
        // anchor — "first show" is scoped to one paywall's identifier, not
        // global to the SDK.
        val prefs = FakeSharedPreferences()
        val a = countdownFirstShownAtMillis("pw_a", prefs, now = { 111L })
        val b = countdownFirstShownAtMillis("pw_b", prefs, now = { 222L })
        assertEquals(111L, a)
        assertEquals(222L, b)
    }

    @Test
    fun `countdownDeadlineMillis prefers endsAt over durationSeconds, never touching the anchor`() {
        val node = BuilderNode.Countdown(id = "cd", endsAt = "2027-01-01T00:00:00Z", durationSeconds = 900.0)
        assertEquals(
            java.time.Instant.parse("2027-01-01T00:00:00Z").toEpochMilli(),
            countdownDeadlineMillis(node) { error("must not read the anchor when endsAt is present") },
        )
    }

    @Test
    fun `countdownDeadlineMillis anchors durationSeconds to the supplied anchor, not a fresh mount time`() {
        val node = BuilderNode.Countdown(id = "cd", durationSeconds = 30.0)
        assertEquals(1_030_000L, countdownDeadlineMillis(node) { 1_000_000L })
    }

    @Test
    fun `countdownDeadlineMillis is null with neither endsAt nor durationSeconds`() {
        assertNull(countdownDeadlineMillis(BuilderNode.Countdown(id = "cd")) { 0L })
    }

    @Test
    fun `countdownRemainingSeconds rounds up and never goes negative`() {
        assertEquals(1L, countdownRemainingSeconds(deadlineMillis = 1500, nowMillis = 1000))
        assertEquals(0L, countdownRemainingSeconds(deadlineMillis = 1000, nowMillis = 1000))
        assertEquals(0L, countdownRemainingSeconds(deadlineMillis = 500, nowMillis = 1000))
    }

    /**
     * Minimal in-memory [android.content.SharedPreferences] test double —
     * only `getLong`/`edit().putLong(...).apply()` are ever exercised by
     * [countdownFirstShownAtMillis], but the interface must be implemented
     * in full. Stands in for real device storage so
     * `countdownFirstShownAtMillis`'s tests never touch, or depend on, real
     * device state (mirrors the Swift renderer's injectable `UserDefaults`).
     */
    private class FakeSharedPreferences : android.content.SharedPreferences {
        private val values = mutableMapOf<String, Any?>()

        override fun getAll(): MutableMap<String, *> = values
        override fun getString(key: String?, defValue: String?): String? = values[key] as? String ?: defValue

        @Suppress("UNCHECKED_CAST")
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
            values[key] as? MutableSet<String> ?: defValues
        override fun getInt(key: String?, defValue: Int): Int = values[key] as? Int ?: defValue
        override fun getLong(key: String?, defValue: Long): Long = values[key] as? Long ?: defValue
        override fun getFloat(key: String?, defValue: Float): Float = values[key] as? Float ?: defValue
        override fun getBoolean(key: String?, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
        override fun contains(key: String?): Boolean = values.containsKey(key)
        override fun edit(): android.content.SharedPreferences.Editor = FakeEditor()
        override fun registerOnSharedPreferenceChangeListener(
            listener: android.content.SharedPreferences.OnSharedPreferenceChangeListener?,
        ) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(
            listener: android.content.SharedPreferences.OnSharedPreferenceChangeListener?,
        ) = Unit

        private inner class FakeEditor : android.content.SharedPreferences.Editor {
            private val pending = mutableMapOf<String, Any?>()
            private val removals = mutableSetOf<String>()
            private var clearAll = false

            override fun putString(key: String?, value: String?): android.content.SharedPreferences.Editor {
                pending[key!!] = value
                return this
            }
            override fun putStringSet(key: String?, valueSet: MutableSet<String>?): android.content.SharedPreferences.Editor {
                pending[key!!] = valueSet
                return this
            }
            override fun putInt(key: String?, value: Int): android.content.SharedPreferences.Editor {
                pending[key!!] = value
                return this
            }
            override fun putLong(key: String?, value: Long): android.content.SharedPreferences.Editor {
                pending[key!!] = value
                return this
            }
            override fun putFloat(key: String?, value: Float): android.content.SharedPreferences.Editor {
                pending[key!!] = value
                return this
            }
            override fun putBoolean(key: String?, value: Boolean): android.content.SharedPreferences.Editor {
                pending[key!!] = value
                return this
            }
            override fun remove(key: String?): android.content.SharedPreferences.Editor {
                removals.add(key!!)
                return this
            }
            override fun clear(): android.content.SharedPreferences.Editor {
                clearAll = true
                return this
            }
            override fun commit(): Boolean {
                applyChanges()
                return true
            }
            override fun apply() = applyChanges()

            private fun applyChanges() {
                if (clearAll) values.clear()
                removals.forEach { values.remove(it) }
                values.putAll(pending)
            }
        }
    }

    // ---- real View-tree assertions (mockkConstructor) ---------------------
    // See the class doc for why this technique works despite the stub
    // android.jar's always-empty ViewGroup bookkeeping: it verifies the
    // MOCKED addView/setImageTintList CALLS the real `build()` makes, not
    // state read back off the constructed object afterward.
    //
    // `ColorStateList.valueOf` is mocked class-wide (BeforeEach/AfterEach,
    // not per-test) because it is now called UNCONDITIONALLY by buildIcon/
    // buildFeatureRow/buildTimelineRow as of this fix wave's item 1 (an
    // always-non-null tint, never left unset) — under this module's stub
    // android.jar (`isReturnDefaultValues = true`), the REAL
    // `ColorStateList.valueOf(Int)` returns null despite being declared
    // `@NonNull`, which Kotlin's platform-type null-assertion turns into an
    // NPE. That's a JVM-unit-test-environment artifact, not a real-device
    // bug (a real Android runtime's `valueOf` never returns null) — but
    // every test below that reaches an icon/mark tint needs the stub
    // bypassed to run at all.

    @BeforeEach
    fun mockColorStateListValueOf() {
        mockkStatic(ColorStateList::class)
        every { ColorStateList.valueOf(any()) } returns mockk(relaxed = true)
    }

    @AfterEach
    fun tearDownConstructorMocks() {
        unmockkConstructor(LinearLayout::class)
        unmockkConstructor(ImageView::class)
        unmockkStatic(ColorStateList::class)
    }

    private fun mockLinearLayoutConstruction() {
        mockkConstructor(LinearLayout::class)
        every { anyConstructed<LinearLayout>().addView(any<View>()) } just Runs
        every { anyConstructed<LinearLayout>().addView(any<View>(), any<ViewGroup.LayoutParams>()) } just Runs
    }

    private fun mockImageViewConstruction() {
        mockkConstructor(ImageView::class)
        every { anyConstructed<ImageView>().setImageResource(any()) } just Runs
        every { anyConstructed<ImageView>().setImageTintList(any()) } just Runs
    }

    /**
     * The hollow assertion this replaces (`build(...) != null`) passes even
     * with zero stars drawn, rows silently dropped, or a connector rendered
     * after the timeline's last row — every one of those still returns a
     * non-null container. Asserts real row/mark/connector counts instead,
     * the same shape mistake already caught once on web (see
     * renderer.test.tsx's featureList/timeline/socialProof section).
     */
    @Test
    fun `build renders one row per featureList row, each with its resolved mark`() {
        mockLinearLayoutConstruction()
        val node = BuilderNode.FeatureList(
            id = "fl",
            rows = listOf(
                FeatureRow(labelKey = "a", included = true),
                FeatureRow(labelKey = "b", included = false),
                FeatureRow(labelKey = "c"),
            ),
        )
        NodeViewFactory.build(mockContext(), node, renderContext(), cell = null)

        verify(exactly = 3) { anyConstructed<LinearLayout>().addView(match<View> { it is TextView }) }
        verify(exactly = 3) {
            anyConstructed<LinearLayout>().addView(match<View> { it is ImageView }, any<ViewGroup.LayoutParams>())
        }
    }

    @Test
    fun `build renders exactly SOCIAL_PROOF_MAX_RATING stars, not zero`() {
        mockLinearLayoutConstruction()
        val node = BuilderNode.SocialProof(id = "sp", labelKey = "s", rating = 4.5)
        NodeViewFactory.build(mockContext(), node, renderContext(), cell = null)

        verify(exactly = SOCIAL_PROOF_MAX_RATING) {
            anyConstructed<LinearLayout>().addView(match<View> { it is ImageView }, any<ViewGroup.LayoutParams>())
        }
    }

    @Test
    fun `build renders no connector after a timeline's final row`() {
        mockLinearLayoutConstruction()
        val node = BuilderNode.Timeline(
            id = "tl",
            rows = listOf(TimelineRow(labelKey = "a"), TimelineRow(labelKey = "b"), TimelineRow(labelKey = "c")),
        )
        NodeViewFactory.build(mockContext(), node, renderContext(), cell = null)

        // The connector is a plain `View` (not an ImageView/TextView),
        // added via the 2-arg overload with a weighted LayoutParams — one
        // per row except the last. 3 rows -> exactly 2 connectors; if a
        // connector followed the last row too (the bug this test guards
        // against), the count would be 3.
        verify(exactly = 2) {
            anyConstructed<LinearLayout>().addView(match<View> { it::class == View::class }, any<ViewGroup.LayoutParams>())
        }
    }

    @Test
    fun `build tints an uncoloured featureList row icon with the resolved ink, not left untinted`() {
        mockImageViewConstruction()
        val node = BuilderNode.FeatureList(id = "fl", rows = listOf(FeatureRow(labelKey = "a")))
        NodeViewFactory.build(mockContext(), node, renderContext(), cell = null)
        verify(atLeast = 1) { anyConstructed<ImageView>().setImageTintList(any<ColorStateList>()) }
    }

    @Test
    fun `build tints an uncoloured timeline row mark with the resolved ink -- no field can configure it otherwise`() {
        mockImageViewConstruction()
        val node = BuilderNode.Timeline(id = "tl", rows = listOf(TimelineRow(labelKey = "a")))
        NodeViewFactory.build(mockContext(), node, renderContext(), cell = null)
        verify(atLeast = 1) { anyConstructed<ImageView>().setImageTintList(any<ColorStateList>()) }
    }

    @Test
    fun `build tints an uncoloured standalone icon node with the resolved ink`() {
        mockImageViewConstruction()
        NodeViewFactory.build(mockContext(), iconNode(), renderContext(), cell = null)
        verify(atLeast = 1) { anyConstructed<ImageView>().setImageTintList(any<ColorStateList>()) }
    }
}
