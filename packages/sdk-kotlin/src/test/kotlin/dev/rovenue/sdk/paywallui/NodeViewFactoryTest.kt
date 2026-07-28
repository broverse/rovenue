package dev.rovenue.sdk.paywallui

import android.content.Context
import android.content.res.ColorStateList
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
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
import io.mockk.slot
import io.mockk.unmockkConstructor
import io.mockk.unmockkStatic
import io.mockk.verify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
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

    /**
     * `onExpiry: "hide"` collapses an expired countdown, and the SAME
     * predicate is what stops its ticker: a `GONE` row that keeps a
     * `Handler` firing once a second for the rest of the session redraws
     * nothing and costs battery. `freeze` never hides — it holds the
     * display at `00:00`, so it keeps ticking (harmlessly, on a view that
     * is still on screen).
     */
    @Test
    fun `countdownHidesNow only for an expired hide countdown`() {
        assertTrue(countdownHidesNow(remainingSeconds = 0, onExpiry = CountdownOnExpiry.HIDE))
        assertTrue(countdownHidesNow(remainingSeconds = -3, onExpiry = CountdownOnExpiry.HIDE))
        assertFalse(countdownHidesNow(remainingSeconds = 1, onExpiry = CountdownOnExpiry.HIDE))
        assertFalse(countdownHidesNow(remainingSeconds = 0, onExpiry = CountdownOnExpiry.FREEZE))
        assertFalse(countdownHidesNow(remainingSeconds = 0, onExpiry = COUNTDOWN_DEFAULT_ON_EXPIRY))
    }

    @Test
    fun `countdownRemainingSeconds rounds up and never goes negative`() {
        assertEquals(1L, countdownRemainingSeconds(deadlineMillis = 1500, nowMillis = 1000))
        assertEquals(0L, countdownRemainingSeconds(deadlineMillis = 1000, nowMillis = 1000))
        assertEquals(0L, countdownRemainingSeconds(deadlineMillis = 500, nowMillis = 1000))
    }

    // ---- nextCarouselPage ----------------------------------------------

    @Test
    fun `the next page index wraps only when loop is true`() {
        assertEquals(0, nextCarouselPage(current = 2, pageCount = 3, loop = true))
        assertEquals(2, nextCarouselPage(current = 2, pageCount = 3, loop = false))
    }

    @Test
    fun `nextCarouselPage simply advances when not yet at the last page`() {
        assertEquals(1, nextCarouselPage(current = 0, pageCount = 3, loop = false))
        assertEquals(1, nextCarouselPage(current = 0, pageCount = 3, loop = true))
    }

    @Test
    fun `nextCarouselPage is a defensive no-op with a non-positive pageCount`() {
        assertEquals(0, nextCarouselPage(current = 0, pageCount = 0, loop = true))
        assertEquals(5, nextCarouselPage(current = 5, pageCount = -1, loop = false))
    }

    // ---- carousel page layout params (C1) -------------------------------
    //
    // ViewPager2's enforceChildFillListener throws
    // IllegalStateException("Pages must fill the whole ViewPager2 (use
    // match_parent)") from onChildViewAttachedToWindow unless BOTH
    // dimensions of an attaching page are MATCH_PARENT. That listener is
    // library code we cannot run here (no Robolectric, and this module
    // compiles against the stub android.jar), so instead of attaching a
    // real ViewPager2 these pin the exact integers that listener compares
    // against. The raw -1 is deliberate: it is what the library checks, so
    // this fails if the value is ever swapped for WRAP_CONTENT (-2) again.

    @Test
    fun `a carousel page fills the pager in BOTH dimensions -- ViewPager2 throws otherwise`() {
        val size = carouselPageLayoutSize()
        assertEquals(MATCH_PARENT_LAYOUT_DIMENSION, size.width, "page width must be MATCH_PARENT")
        assertEquals(MATCH_PARENT_LAYOUT_DIMENSION, size.height, "page height must be MATCH_PARENT")
    }

    @Test
    fun `a carousel page is never WRAP_CONTENT in either dimension`() {
        val size = carouselPageLayoutSize()
        assertTrue(size.width != WRAP_CONTENT_LAYOUT_DIMENSION, "WRAP_CONTENT width crashes ViewPager2")
        assertTrue(size.height != WRAP_CONTENT_LAYOUT_DIMENSION, "WRAP_CONTENT height crashes ViewPager2")
    }

    // ---- carousel height model (C1, second half) ------------------------

    @Test
    fun `the pager takes the height of its TALLEST page, not the first or the sum`() {
        assertEquals(300, tallestPageHeight(listOf(100, 300, 200)))
        assertEquals(300, tallestPageHeight(listOf(300, 100, 200)))
    }

    @Test
    fun `an unmeasured or empty page set reports the unmeasured height, never a negative`() {
        assertEquals(CAROUSEL_UNMEASURED_HEIGHT_PX, tallestPageHeight(emptyList()))
        assertEquals(CAROUSEL_UNMEASURED_HEIGHT_PX, tallestPageHeight(listOf(0, 0)))
        assertEquals(CAROUSEL_UNMEASURED_HEIGHT_PX, tallestPageHeight(listOf(-5)))
    }

    // ---- the width the max-of-pages pass measures at ---------------------
    //
    // The pass used MeasureSpec.getSize(widthMeasureSpec) directly, which is
    // the carousel's OUTER width: pages were measured wider than the box
    // they lay out in, so text wrapped at the wrong point and the tallest
    // height came out short by however much padding was ignored. And under
    // an UNSPECIFIED parent getSize() is 0, so EXACTLY-0 measured every page
    // as zero-wide and the carousel collapsed entirely.

    @Test
    fun `a carousel page is measured inside the carousel's padding, not at its outer width`() {
        assertEquals(
            CAROUSEL_OUTER_WIDTH_PX - CAROUSEL_HORIZONTAL_PADDING_PX,
            carouselPageMeasureWidth(CAROUSEL_OUTER_WIDTH_PX, CAROUSEL_HORIZONTAL_PADDING_PX),
        )
        assertEquals(
            CAROUSEL_OUTER_WIDTH_PX,
            carouselPageMeasureWidth(CAROUSEL_OUTER_WIDTH_PX, NO_PADDING_PX),
        )
    }

    @Test
    fun `padding wider than the carousel measures at zero, never at a negative width`() {
        assertEquals(
            CAROUSEL_UNMEASURED_WIDTH_PX,
            carouselPageMeasureWidth(CAROUSEL_HORIZONTAL_PADDING_PX, CAROUSEL_OUTER_WIDTH_PX),
        )
    }

    @Test
    fun `a carousel page is measured EXACTLY only when the carousel actually has a width`() {
        assertEquals(
            View.MeasureSpec.EXACTLY,
            carouselPageMeasureMode(View.MeasureSpec.EXACTLY, CAROUSEL_OUTER_WIDTH_PX),
        )
        assertEquals(
            View.MeasureSpec.EXACTLY,
            carouselPageMeasureMode(View.MeasureSpec.AT_MOST, CAROUSEL_OUTER_WIDTH_PX),
        )
    }

    @Test
    fun `an UNSPECIFIED parent or a zero width lets the page state its own width`() {
        // EXACTLY 0 here is what collapsed the whole carousel: every page
        // measures zero-wide, so every page reports zero height.
        assertEquals(
            View.MeasureSpec.UNSPECIFIED,
            carouselPageMeasureMode(View.MeasureSpec.UNSPECIFIED, CAROUSEL_UNMEASURED_WIDTH_PX),
        )
        assertEquals(
            View.MeasureSpec.UNSPECIFIED,
            carouselPageMeasureMode(View.MeasureSpec.UNSPECIFIED, CAROUSEL_OUTER_WIDTH_PX),
        )
        assertEquals(
            View.MeasureSpec.UNSPECIFIED,
            carouselPageMeasureMode(View.MeasureSpec.EXACTLY, CAROUSEL_UNMEASURED_WIDTH_PX),
        )
    }

    /**
     * Closes the indirection gap the two `carouselPageLayoutSize()` tests
     * above leave open: they pin what the helper RETURNS, but nothing
     * asserted the adapter that builds real page holders actually calls it —
     * a holder built with an inline `WRAP_CONTENT` would have passed both.
     *
     * `ViewGroup.LayoutParams` cannot be inspected here (the stub
     * `android.jar` constructor has no body, so a constructed LayoutParams
     * reports 0/0 — see [carouselPageLayoutSize]'s own doc), so the
     * assertion is on the CALL: the file facade's top-level functions are
     * mocked, the adapter is asked for a real holder, and the helper must
     * have been consulted.
     */
    @Test
    fun `the page adapter builds every holder from carouselPageLayoutSize, not its own literals`() {
        mockkStatic(NODE_VIEW_FACTORY_FILE_CLASS)
        try {
            every { carouselPageLayoutSize() } returns
                CarouselPageSize(MATCH_PARENT_LAYOUT_DIMENSION, MATCH_PARENT_LAYOUT_DIMENSION)
            val parent = mockk<ViewGroup>(relaxed = true)
            every { parent.context } returns mockContext()

            CarouselPageAdapter(pages = emptyList()).onCreateViewHolder(parent, ADAPTER_DEFAULT_VIEW_TYPE)

            verify(exactly = 1) { carouselPageLayoutSize() }
        } finally {
            unmockkStatic(NODE_VIEW_FACTORY_FILE_CLASS)
        }
    }

    // ---- video / lottie (wave D2) ---------------------------------------
    //
    // WHAT IS NOT HERE, and cannot be: whether the `MediaPlayer` actually
    // starts, whether it pauses when the node scrolls off screen, and whether
    // audio genuinely stops. All three are device-only — this module's stub
    // android.jar (`isReturnDefaultValues = true`) makes `MediaPlayer`,
    // `TextureView` and `Surface` inert, so a test asserting "it played"
    // would be asserting the stub's default, not the renderer. What IS pinned
    // is the RULE those calls obey (`videoPlaybackCommand`), the ratio
    // arithmetic, and the whole lottie registration/default-resolution path,
    // none of which touch a stubbed Android type.

    @AfterEach
    fun clearLottieRegistration() {
        // Registration is PROCESS-LEVEL state. Without this, a test that
        // registers a player leaks it into every test that runs after it —
        // including `a lottie node with no registered renderer...`, which
        // would then pass or fail on ordering.
        registerLottieRenderer(null)
    }

    @Test
    fun `an off-screen video pauses whatever the author asked for`() {
        assertEquals(VideoPlaybackCommand.PAUSE, videoPlaybackCommand(active = false, autoplay = true))
        assertEquals(VideoPlaybackCommand.PAUSE, videoPlaybackCommand(active = false, autoplay = false))
    }

    @Test
    fun `an on-screen autoplay video plays`() {
        assertEquals(VideoPlaybackCommand.PLAY, videoPlaybackCommand(active = true, autoplay = true))
    }

    @Test
    fun `an on-screen video with autoplay false is left alone, not started`() {
        // The whole reason the command has three states. A two-state boolean
        // would collapse this onto PLAY and start a clip the author said
        // must not start itself.
        assertEquals(VideoPlaybackCommand.LEAVE_ALONE, videoPlaybackCommand(active = true, autoplay = false))
    }

    @Test
    fun `an absent aspectRatio applies no ratio until the source reports its own`() {
        assertNull(
            videoEffectiveAspectRatio(
                authored = null,
                sourceWidthPx = UNREPORTED_VIDEO_DIMENSION_PX,
                sourceHeightPx = UNREPORTED_VIDEO_DIMENSION_PX,
            ),
            "no authored ratio and no source dimensions must substitute NO number",
        )
        assertEquals(
            SOURCE_VIDEO_WIDTH_PX.toDouble() / SOURCE_VIDEO_HEIGHT_PX.toDouble(),
            videoEffectiveAspectRatio(
                authored = null,
                sourceWidthPx = SOURCE_VIDEO_WIDTH_PX,
                sourceHeightPx = SOURCE_VIDEO_HEIGHT_PX,
            ),
        )
    }

    @Test
    fun `an authored aspectRatio wins over the source's own dimensions`() {
        assertEquals(
            AUTHORED_ASPECT_RATIO,
            videoEffectiveAspectRatio(
                authored = AUTHORED_ASPECT_RATIO,
                sourceWidthPx = SOURCE_VIDEO_WIDTH_PX,
                sourceHeightPx = SOURCE_VIDEO_HEIGHT_PX,
            ),
        )
    }

    @Test
    fun `aspect ratio is width over height, not height over width`() {
        // Inverting this is the classic version of this bug and would still
        // produce a plausible-looking box, so the assertion pins the
        // direction rather than merely "some height came back". The ratio
        // divides the width EXACTLY, so the expected value is a literal
        // rather than the implementation's own arithmetic restated (which
        // would pass however the division were written).
        assertEquals(
            EXACTLY_DIVIDED_HEIGHT_PX,
            videoHeightForAspectRatio(SOURCE_VIDEO_WIDTH_PX, EXACTLY_DIVIDING_ASPECT_RATIO),
        )
        assertTrue(videoHeightForAspectRatio(MEASURED_SLOT_PX, AUTHORED_ASPECT_RATIO) < MEASURED_SLOT_PX)
    }

    @Test
    fun `an unparsable video source is decided before any player exists`() {
        assertTrue(videoHasParsableSource(ThemePair(light = "https://x/a.mp4"), dark = false))
        assertFalse(videoHasParsableSource(ThemePair(light = "not a url"), dark = false))
    }

    // ---- video letterboxing (I1) ----------------------------------------
    //
    // The box is measured at the AUTHORED ratio (videoEffectiveAspectRatio,
    // above); this is how the picture sits inside that box. A TextureView
    // stretches its texture to its bounds by default, so without this the
    // authored ratio distorts the image while web (object-fit: contain) and
    // iOS (resizeAspect) letterbox it. Expected factors are literals, and
    // each case also pins WHICH axis moved, so an implementation that scales
    // the wrong axis (or inverts the ratio) fails rather than merely
    // producing a different plausible number.

    @Test
    fun `a source wider than its box keeps its width and gives up height`() {
        assertEquals(
            VideoSurfaceScale(scaleX = 1.0f, scaleY = SQUARE_BOX_FIT_SCALE),
            videoSurfaceFitScale(
                viewWidthPx = SQUARE_BOX_PX,
                viewHeightPx = SQUARE_BOX_PX,
                sourceWidthPx = SOURCE_VIDEO_WIDTH_PX,
                sourceHeightPx = SOURCE_VIDEO_HEIGHT_PX,
            ),
        )
    }

    @Test
    fun `a source taller than its box keeps its height and gives up width`() {
        assertEquals(
            VideoSurfaceScale(scaleX = WIDE_BOX_FIT_SCALE, scaleY = 1.0f),
            videoSurfaceFitScale(
                viewWidthPx = WIDE_BOX_WIDTH_PX,
                viewHeightPx = WIDE_BOX_HEIGHT_PX,
                // The same source turned on its side, so the axis that gives
                // way is the other one.
                sourceWidthPx = SOURCE_VIDEO_HEIGHT_PX,
                sourceHeightPx = SOURCE_VIDEO_WIDTH_PX,
            ),
        )
    }

    @Test
    fun `a source shaped like its box is left alone`() {
        // The common case — no authored ratio, so the box was measured at the
        // source's own ratio. Letterboxing must be a CORRECTION, never a
        // resize that shrinks a video that already fitted.
        assertEquals(
            VideoSurfaceScale(scaleX = 1.0f, scaleY = 1.0f),
            videoSurfaceFitScale(
                viewWidthPx = SOURCE_VIDEO_WIDTH_PX,
                viewHeightPx = SOURCE_VIDEO_HEIGHT_PX,
                sourceWidthPx = SOURCE_VIDEO_WIDTH_PX,
                sourceHeightPx = SOURCE_VIDEO_HEIGHT_PX,
            ),
        )
    }

    @Test
    fun `letterboxing only ever shrinks, never crops`() {
        // Direction check independent of the exact factors: a fit-INSIDE must
        // never scale an axis above 1, which is what a fit-outside (cover)
        // implementation would do and what would crop the picture.
        val wide = videoSurfaceFitScale(
            viewWidthPx = SQUARE_BOX_PX,
            viewHeightPx = SQUARE_BOX_PX,
            sourceWidthPx = SOURCE_VIDEO_WIDTH_PX,
            sourceHeightPx = SOURCE_VIDEO_HEIGHT_PX,
        )
        assertTrue(wide!!.scaleY < 1.0f, "a wider-than-box source must give up HEIGHT")
        assertEquals(1.0f, wide.scaleX, "its width already fits, so it must not move")
    }

    @Test
    fun `no fit is computed until both the box and the source are known`() {
        assertNull(
            videoSurfaceFitScale(
                viewWidthPx = SQUARE_BOX_PX,
                viewHeightPx = SQUARE_BOX_PX,
                sourceWidthPx = UNREPORTED_VIDEO_DIMENSION_PX,
                sourceHeightPx = UNREPORTED_VIDEO_DIMENSION_PX,
            ),
            "a source whose natural size MediaPlayer has not reported yet cannot be fitted",
        )
        assertNull(
            videoSurfaceFitScale(
                viewWidthPx = UNMEASURED_VIEW_DIMENSION_PX,
                viewHeightPx = UNMEASURED_VIEW_DIMENSION_PX,
                sourceWidthPx = SOURCE_VIDEO_WIDTH_PX,
                sourceHeightPx = SOURCE_VIDEO_HEIGHT_PX,
            ),
            "an unmeasured box has no shape to fit into",
        )
    }

    @Test
    fun `a lottie node with no registered renderer has no view to build`() {
        registerLottieRenderer(null)
        assertNull(lottieViewOrNull(context = mockContext(), request = bareLottieRequest()))
    }

    @Test
    fun `a registered lottie renderer receives the resolved defaults`() {
        var captured: LottieRenderRequest? = null
        val hostView = mockk<View>(relaxed = true)
        registerLottieRenderer { _, request ->
            captured = request
            hostView
        }

        val view = lottieViewOrNull(mockContext(), lottieRenderRequest(bareLottieNode(), playing = true, dark = false))

        assertSame(hostView, view)
        // Literal expected values, not the constants themselves — comparing a
        // constant against itself would pass no matter what it held. The
        // constants are separately pinned against schema.ts by the by-value
        // sync test in BuilderConfigModelTest.
        assertEquals(
            LottieRenderRequest(
                url = "https://x/a.json",
                loop = true,
                autoplay = true,
                speed = 1.0,
                playing = true,
            ),
            captured,
        )
    }

    @Test
    fun `an authored lottie's own values are handed over unclamped`() {
        var captured: LottieRenderRequest? = null
        registerLottieRenderer { _, request ->
            captured = request
            mockk<View>(relaxed = true)
        }
        // Above LOTTIE_MAX_SPEED on purpose: the shared range is authoring-
        // time ADVICE (a validator warning), not a clamp, so the renderer
        // must pass it through unchanged on every platform.
        val node = bareLottieNode().copy(loop = false, autoplay = false, speed = OVER_ADVISED_LOTTIE_SPEED)

        lottieViewOrNull(mockContext(), lottieRenderRequest(node, playing = false, dark = false))

        assertEquals(
            LottieRenderRequest(
                url = "https://x/a.json",
                loop = false,
                autoplay = false,
                speed = OVER_ADVISED_LOTTIE_SPEED,
                playing = false,
            ),
            captured,
        )
    }

    @Test
    fun `a lottie's dark url wins in dark mode`() {
        val node = bareLottieNode().copy(url = ThemePair(light = "https://x/a.json", dark = "https://x/a-dark.json"))
        assertEquals("https://x/a-dark.json", lottieRenderRequest(node, playing = true, dark = true).url)
        assertEquals("https://x/a.json", lottieRenderRequest(node, playing = true, dark = false).url)
    }

    // ---- lottie URL parsing (I6) -----------------------------------------
    //
    // iOS has always parsed the URL and treated an unparsable one as "cannot
    // render"; Android used to hand the raw string — INCLUDING the "" that
    // every freshly created lottie carries — straight to the host's player.
    // The three now agree, and agree with how `video` already behaved.

    @Test
    fun `a blank lottie url cannot render`() {
        // Not an edge case: `newNode("lottie")` creates `url: { light: "" }`,
        // so this is the state of every lottie the builder has just added.
        assertFalse(lottieHasParsableSource(ThemePair(light = ""), dark = false))
        assertFalse(lottieHasParsableSource(ThemePair(light = "   "), dark = false))
    }

    @Test
    fun `an unparsable lottie url cannot render`() {
        assertFalse(lottieHasParsableSource(ThemePair(light = "not a url"), dark = false))
    }

    @Test
    fun `an absolute lottie url can render`() {
        assertTrue(lottieHasParsableSource(ThemePair(light = "https://x/a.json"), dark = false))
    }

    @Test
    fun `a relative lottie url can render, matching web and iOS`() {
        // Web resolves a relative source against the hosting document and iOS's
        // `URL(string:)` accepts a relative reference, so rejecting one here
        // would drop a node the other two draw. Being stricter is as much a
        // divergence as being laxer.
        assertTrue(lottieHasParsableSource(ThemePair(light = "anim.json"), dark = false))
        assertTrue(lottieHasParsableSource(ThemePair(light = "/assets/anim.json"), dark = false))
    }

    @Test
    fun `the theme half that would actually be used is the one parsed`() {
        val onlyDarkIsUsable = ThemePair(light = "", dark = "https://x/a-dark.json")
        assertTrue(lottieHasParsableSource(onlyDarkIsUsable, dark = true))
        assertFalse(lottieHasParsableSource(onlyDarkIsUsable, dark = false))
    }

    @Test
    fun `a lottie with an unparsable url never reaches the registered player`() {
        var requests = 0
        registerLottieRenderer { _, _ ->
            requests++
            mockk<View>(relaxed = true)
        }

        val view = NodeViewFactory.build(
            mockContext(),
            bareLottieNode().copy(url = ThemePair(light = "")),
            renderContext(),
            cell = null,
        )

        // Drawing nothing is what drops the node from a carousel's page and
        // dot counts, exactly as an unregistered player does.
        assertNull(view)
        assertEquals(0, requests, "a host player must not be handed a URL the node already knows cannot render")
    }

    @Test
    fun `a lottie with an unparsable url draws its fallback when it has one`() {
        registerLottieRenderer { _, _ -> mockk<View>(relaxed = true) }

        val view = NodeViewFactory.build(
            mockContext(),
            bareLottieNode().copy(url = ThemePair(light = ""), fallback = textNode()),
            renderContext(),
            cell = null,
        )

        assertTrue(view != null, "an unparsable URL takes the same fallback path an unregistered player takes")
    }

    private fun bareLottieNode() = BuilderNode.Lottie(id = "lot", url = ThemePair(light = "https://x/a.json"))

    private fun bareLottieRequest() = lottieRenderRequest(bareLottieNode(), playing = true, dark = false)

    // ---- carousel dot colour (I9) ---------------------------------------
    //
    // resolvedInkTintColorInt is already pinned above; what was NOT pinned
    // is that a carousel's OWN indicatorColor field is what reaches the
    // paint. The wave-B scar on this platform was a correct branch feeding
    // a wrong value downstream, so these assert the resolved value starting
    // from a real BuilderNode.Carousel — the same object buildCarousel
    // hands to carouselDotSpec, which is now the single place any dot
    // colour is decided.

    private fun carouselNode(indicatorColor: ThemePair? = null) = BuilderNode.Carousel(
        id = "c",
        children = listOf(BuilderNode.Text(id = "p1", key = "a", role = TextRole.BODY)),
        indicatorColor = indicatorColor,
    )

    @Test
    fun `an uncoloured carousel dot paints the resolved ink, not white and not transparent`() {
        val light = carouselDotSpec(carouselNode(), dark = false)
        assertEquals(parseHexColor("#0F172A")!!.toColorInt(), light.colorInt)
        assertTrue(light.colorInt != WHITE_COLOR_INT, "must not fall back to white")
        assertTrue(light.colorInt != TRANSPARENT_COLOR_INT, "must not fall back to no colour at all")
    }

    @Test
    fun `an uncoloured carousel dot uses the dark ink in dark mode`() {
        assertEquals(
            parseHexColor("#F8FAFC")!!.toColorInt(),
            carouselDotSpec(carouselNode(), dark = true).colorInt,
        )
    }

    @Test
    fun `the carousel's own indicatorColor reaches the dot paint, per theme`() {
        val node = carouselNode(ThemePair(light = "#112233", dark = "#445566"))
        assertEquals(parseHexColor("#112233")!!.toColorInt(), carouselDotSpec(node, dark = false).colorInt)
        assertEquals(parseHexColor("#445566")!!.toColorInt(), carouselDotSpec(node, dark = true).colorInt)
    }

    @Test
    fun `the active dot is opaque and the inactive one is visibly dimmer, on Android's 0-255 scale`() {
        val spec = carouselDotSpec(carouselNode(), dark = false)
        assertEquals(OPAQUE_ALPHA_CHANNEL, spec.activeAlpha255)
        assertTrue(spec.inactiveAlpha255 < spec.activeAlpha255, "the inactive dot must read as inactive")
        assertTrue(spec.inactiveAlpha255 > TRANSPARENT_ALPHA_CHANNEL, "an invisible dot indicates nothing")
    }

    // ---- deferred image decode (I6) -------------------------------------
    //
    // buildImage calls loadImageInto one statement after constructing the
    // ImageView, so on a first render the view has never been measured and
    // sampleSizeForWidth (correctly) answers a zero target with "full
    // size". Decoding there meant downsampling never happened at all, so
    // the decode is deferred until the slot has a measured WIDTH.
    //
    // WHY THESE ASSERT THE DECODE AND NOT JUST THE LISTENER: the tests this
    // section replaces pinned only WHEN a ViewTreeObserver listener gets
    // registered, and assumed a slot eventually reports a size. Production
    // waited on width AND height; an image with no authored `height` is
    // WRAP_CONTENT tall with adjustViewBounds, so with no drawable yet it
    // measures 0 tall forever and the wait could never end. Those tests
    // stayed green while no image ever loaded on a device. Every test below
    // therefore drives the captured listener with real geometry and asserts
    // the DECODE ITSELF is reached — loadImageInto takes its decode step as
    // a parameter for exactly this reason, and a recorder is passed in place
    // of the network fetch.

    private fun cancelledScope() = CoroutineScope(Job()).also { it.cancel() }

    /** A measured [ImageView] test double plus its (mocked) observer, wired
     *  so the layout and attach-state listeners `loadImageInto` registers
     *  can be captured and driven by hand. */
    private class ImageSlotFixture {
        val observer = mockk<ViewTreeObserver>(relaxed = true)
        val imageView = mockk<ImageView>(relaxed = true)
        val layoutListener = slot<ViewTreeObserver.OnGlobalLayoutListener>()
        val attachListener = slot<View.OnAttachStateChangeListener>()
        val decodedWidths = mutableListOf<Int>()

        init {
            every { imageView.viewTreeObserver } returns observer
            every { observer.isAlive } returns true
            every { observer.addOnGlobalLayoutListener(capture(layoutListener)) } just Runs
            every { imageView.addOnAttachStateChangeListener(capture(attachListener)) } just Runs
            measure(UNMEASURED_VIEW_DIMENSION_PX, UNMEASURED_VIEW_DIMENSION_PX)
        }

        fun measure(width: Int, height: Int) {
            every { imageView.width } returns width
            every { imageView.height } returns height
        }

        /** Records the target width instead of fetching, so a unit test can
         *  assert the deferred work completed without any network. */
        fun recorder() = ImageDecodeRequest { _, _, _, targetWidth -> decodedWidths += targetWidth }
    }

    /**
     * THE REGRESSION TEST. Simulates the geometry `buildImage` actually
     * produces for an `image` with no authored height — MATCH_PARENT width
     * resolves on the first layout pass, WRAP_CONTENT height stays 0 because
     * the drawable that would give it a height is the very thing being
     * decoded — and asserts the decode still happens.
     *
     * Restore the `&& imageView.height > 0` half of the wait and this fails:
     * decodedWidths stays empty forever, which is what shipped.
     */
    @Test
    fun `loadImageInto decodes once the WIDTH is measured, while the height is still zero`() {
        val slot = ImageSlotFixture()
        val scope = CoroutineScope(Job())

        loadImageInto(slot.imageView, "https://example.test/rovenue-wrap-content.png", scope, slot.recorder())

        // Pass 1: the parent has not laid out yet, so nothing is measured.
        slot.layoutListener.captured.onGlobalLayout()
        assertTrue(slot.decodedWidths.isEmpty(), "an unmeasured slot must not fix a sample size")

        // Pass 2: the real WRAP_CONTENT-height case.
        slot.measure(width = MEASURED_SLOT_PX, height = UNMEASURED_VIEW_DIMENSION_PX)
        slot.layoutListener.captured.onGlobalLayout()

        assertEquals(
            listOf(MEASURED_SLOT_PX),
            slot.decodedWidths,
            "a zero height must not hold the decode: the decode is what produces the height",
        )
    }

    @Test
    fun `a completed deferred load unregisters its listeners -- render() runs on every package tap`() {
        val slot = ImageSlotFixture()
        loadImageInto(slot.imageView, "https://example.test/rovenue-unregister.png", CoroutineScope(Job()), slot.recorder())

        slot.measure(width = MEASURED_SLOT_PX, height = UNMEASURED_VIEW_DIMENSION_PX)
        slot.layoutListener.captured.onGlobalLayout()

        verify(exactly = 1) { slot.observer.removeOnGlobalLayoutListener(slot.layoutListener.captured) }
        verify(exactly = 1) { slot.imageView.removeOnAttachStateChangeListener(slot.attachListener.captured) }
    }

    /**
     * The leak half: an attached view's `getViewTreeObserver()` is the
     * WINDOW's observer, shared by the whole hierarchy, so a listener left
     * on it outlives the ImageView that registered it — once more per
     * package tap, since render() rebuilds the tree every time.
     */
    @Test
    fun `a never-measured deferred load unregisters when its view leaves the window`() {
        val slot = ImageSlotFixture()
        loadImageInto(slot.imageView, "https://example.test/rovenue-detached.png", CoroutineScope(Job()), slot.recorder())

        // Never measured — a GONE or zero-width slot — then discarded.
        slot.layoutListener.captured.onGlobalLayout()
        verify(exactly = 0) { slot.observer.removeOnGlobalLayoutListener(any()) }

        slot.attachListener.captured.onViewDetachedFromWindow(slot.imageView)

        verify(exactly = 1) { slot.observer.removeOnGlobalLayoutListener(slot.layoutListener.captured) }
        assertTrue(slot.decodedWidths.isEmpty(), "a detached view has nothing to decode into")
    }

    @Test
    fun `a deferred load unregisters instead of decoding once its scope is cancelled`() {
        val slot = ImageSlotFixture()
        loadImageInto(slot.imageView, "https://example.test/rovenue-cancelled.png", cancelledScope(), slot.recorder())

        slot.measure(width = MEASURED_SLOT_PX, height = MEASURED_SLOT_PX)
        slot.layoutListener.captured.onGlobalLayout()

        verify(exactly = 1) { slot.observer.removeOnGlobalLayoutListener(slot.layoutListener.captured) }
        assertTrue(slot.decodedWidths.isEmpty(), "RovenuePaywallView cancels the scope on detach")
    }

    @Test
    fun `loadImageInto does not wait for a layout pass when the width is already measured`() {
        val slot = ImageSlotFixture()
        // Height deliberately left at 0: it is not, and must never become, a
        // precondition of the decode.
        slot.measure(width = MEASURED_SLOT_PX, height = UNMEASURED_VIEW_DIMENSION_PX)

        loadImageInto(slot.imageView, "https://example.test/rovenue-measured.png", CoroutineScope(Job()), slot.recorder())

        verify(exactly = 0) { slot.observer.addOnGlobalLayoutListener(any()) }
        assertEquals(listOf(MEASURED_SLOT_PX), slot.decodedWidths)
    }

    @Test
    fun `loadImageInto defers the decode while the width is unmeasured`() {
        val slot = ImageSlotFixture()

        loadImageInto(slot.imageView, "https://example.test/rovenue-unmeasured.png", CoroutineScope(Job()), slot.recorder())

        verify(exactly = 1) { slot.observer.addOnGlobalLayoutListener(any()) }
        assertTrue(slot.decodedWidths.isEmpty(), "decoding at 0 width samples at full size — the bug this defers around")
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

    private companion object {
        /** `ViewGroup.LayoutParams.MATCH_PARENT`, spelled out as the literal
         *  integer `ViewPager2.enforceChildFillListener` actually compares
         *  against — asserting against the platform symbol would pass even
         *  if the platform symbol itself were the thing that changed. */
        const val MATCH_PARENT_LAYOUT_DIMENSION = -1

        /** `ViewGroup.LayoutParams.WRAP_CONTENT` — the value that made every
         *  carousel throw on first attach. */
        const val WRAP_CONTENT_LAYOUT_DIMENSION = -2

        const val OPAQUE_ALPHA_CHANNEL = 255
        const val TRANSPARENT_ALPHA_CHANNEL = 0
        const val WHITE_COLOR_INT = 0xFFFFFFFF.toInt()
        const val TRANSPARENT_COLOR_INT = 0

        /** A plausible measured image slot, in px — any positive size works;
         *  the branch under test is "measured at all vs not". */
        const val MEASURED_SLOT_PX = 300

        /** A plausible measured carousel width and a plausible horizontal
         *  padding, in px. Any positive pair works; what is under test is
         *  that one is subtracted from the other. */
        const val CAROUSEL_OUTER_WIDTH_PX = 1080
        const val CAROUSEL_HORIZONTAL_PADDING_PX = 48
        const val NO_PADDING_PX = 0

        /** The JVM class Kotlin compiles NodeViewFactory.kt's top-level
         *  functions into — what `mockkStatic` needs to intercept them. */
        const val NODE_VIEW_FACTORY_FILE_CLASS = "dev.rovenue.sdk.paywallui.NodeViewFactoryKt"

        /** `RecyclerView.Adapter.getItemViewType`'s default: the carousel
         *  adapter has a single page type. */
        const val ADAPTER_DEFAULT_VIEW_TYPE = 0

        /** What `MediaPlayer` reports for a video's natural size before it
         *  has parsed the media — the "no dimensions yet" case. */
        const val UNREPORTED_VIDEO_DIMENSION_PX = 0

        /** A plausible reported source size. Deliberately NOT 16:9, so a test
         *  cannot pass by accidentally matching the authored ratio below. */
        const val SOURCE_VIDEO_WIDTH_PX = 640
        const val SOURCE_VIDEO_HEIGHT_PX = 480

        /** The fixture's own authored ratio (`video-full`), wider than tall
         *  so an inverted width/height division is visible. */
        const val AUTHORED_ASPECT_RATIO = 1.777

        /** A ratio that divides [SOURCE_VIDEO_WIDTH_PX] exactly, so the
         *  expected height is a literal and rounding plays no part. */
        const val EXACTLY_DIVIDING_ASPECT_RATIO = 2.0
        const val EXACTLY_DIVIDED_HEIGHT_PX = 320

        /** Above `LOTTIE_MAX_SPEED` on purpose — the shared range is advice,
         *  not a clamp. */
        const val OVER_ADVISED_LOTTIE_SPEED = 9.0

        /** A square box, so a 4:3 source is unambiguously the WIDER shape and
         *  the axis that gives way is not in doubt. */
        const val SQUARE_BOX_PX = 300

        /** 480/640 ÷ (300/300) — the height a 4:3 source keeps inside a square
         *  box. A literal rather than the implementation's own division
         *  restated, which would pass however the ratio were written. */
        const val SQUARE_BOX_FIT_SCALE = 0.75f

        /** A box four times wider than it is tall. */
        const val WIDE_BOX_WIDTH_PX = 400
        const val WIDE_BOX_HEIGHT_PX = 100

        /** (480/640) ÷ (400/100) — the width a 3:4 source keeps inside that
         *  box. Also a literal, for the same reason. */
        const val WIDE_BOX_FIT_SCALE = 0.1875f
    }
}
