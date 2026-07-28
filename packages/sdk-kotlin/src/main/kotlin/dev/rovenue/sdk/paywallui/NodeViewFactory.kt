package dev.rovenue.sdk.paywallui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import dev.rovenue.sdk.Offering
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.floor
import kotlin.math.roundToInt

// =============================================================
// Android Views renderer for the Phase-B builder-paywall tree —
// draws the same 7-node component tree the web renderer (packages/
// paywall-renderer) and the SwiftUI renderer (packages/sdk-swift
// .../PaywallUI/{RovenuePaywallView,NodeViews,PaywallRenderSupport}.swift)
// draw. Semantics mirror the web renderer (the normative sibling):
// unknown node -> its fallback else nothing, never a crash; the
// renderer NEVER opens URLs itself.
//
// Split in two halves:
//  1. Pure functions/data classes (style + layout + action-routing
//     computation) — unit-testable WITHOUT an Android runtime, see
//     NodeViewFactoryTest.kt.
//  2. NodeViewFactory — turns a BuilderNode + render context into an
//     actual android.view.View tree. Requires a real/Robolectric
//     Android runtime, so it's exercised by manual smoke rather than
//     an automated test (see RovenuePaywallView.kt's class doc for
//     why Robolectric isn't wired up in this module).
// =============================================================

// ---------------------------------------------------------------
// Pure: color parsing
// ---------------------------------------------------------------

/** Parsed sRGB components in 0..1. Alpha defaults to 1. */
data class RgbaColor(val red: Double, val green: Double, val blue: Double, val alpha: Double)

/**
 * Parses `#RRGGBB` or `#RRGGBBAA` (leading `#` optional, case-insensitive —
 * the dashboard's color inputs emit `#RRGGBB`). Anything else -> `null`;
 * the renderer skips unparseable colors rather than guessing. Mirrors
 * Swift's `parseHexColor` byte-for-byte.
 */
fun parseHexColor(raw: String): RgbaColor? {
    var hex = raw.trim()
    if (hex.startsWith("#")) hex = hex.substring(1)
    if (hex.length != 6 && hex.length != 8) return null
    if (!hex.all { it.isHexDigitChar() }) return null
    val value = hex.toULongOrNull(16) ?: return null

    return if (hex.length == 6) {
        RgbaColor(
            red = ((value shr 16) and 0xFFuL).toDouble() / 255.0,
            green = ((value shr 8) and 0xFFuL).toDouble() / 255.0,
            blue = (value and 0xFFuL).toDouble() / 255.0,
            alpha = 1.0,
        )
    } else {
        RgbaColor(
            red = ((value shr 24) and 0xFFuL).toDouble() / 255.0,
            green = ((value shr 16) and 0xFFuL).toDouble() / 255.0,
            blue = ((value shr 8) and 0xFFuL).toDouble() / 255.0,
            alpha = (value and 0xFFuL).toDouble() / 255.0,
        )
    }
}

private fun Char.isHexDigitChar(): Boolean = this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

/**
 * Packs [RgbaColor] into a 32-bit ARGB int matching
 * `android.graphics.Color.argb(...)` bit-for-bit — hand-rolled (rather than
 * calling the framework method) so it stays a pure function testable
 * without an Android runtime.
 */
fun RgbaColor.toColorInt(): Int {
    val a = (alpha * 255).roundToInt().coerceIn(0, 255)
    val r = (red * 255).roundToInt().coerceIn(0, 255)
    val g = (green * 255).roundToInt().coerceIn(0, 255)
    val b = (blue * 255).roundToInt().coerceIn(0, 255)
    return (a shl 24) or (r shl 16) or (g shl 8) or b
}

/** Picks the side of a theme pair for the effective scheme: dark when dark
 *  mode AND a dark value exists, else light (mirrors the web renderer and
 *  Swift's `themeValue`). */
fun themeValue(pair: ThemePair, dark: Boolean): String = if (dark && pair.dark != null) pair.dark else pair.light

/** `options.darkMode` wins when set; otherwise follows the platform's
 *  current night-mode configuration. */
fun computeDarkMode(optionsDarkMode: Boolean?, isSystemNight: Boolean): Boolean =
    optionsDarkMode ?: isSystemNight

// ---------------------------------------------------------------
// Pure: purchase / action-visibility rules
// ---------------------------------------------------------------

/** The purchase button is tappable only with a live selection and no
 *  purchase already in flight (mirrors the web renderer's disabled rule). */
fun purchaseEnabled(selectedPackageId: String?, isPurchasing: Boolean): Boolean =
    selectedPackageId != null && !isPurchasing

/** Whether an action button renders at all. Restore buttons are HIDDEN
 *  when the host supplies no restore handler (web-renderer parity); every
 *  other action stays visible even handler-less (inert). */
fun actionButtonVisible(action: ButtonAction, hasRestoreHandler: Boolean): Boolean =
    if (action is ButtonAction.Restore) hasRestoreHandler else true

/** Dispatches a tapped button's action to the matching host handler. A
 *  missing handler is a silent no-op (never throws) — matches
 *  `actionButtonVisible`'s "inert when handler-less" contract for actions
 *  that stay visible without one (close/url; restore is hidden instead). */
fun routeButtonAction(
    action: ButtonAction,
    onClose: (() -> Unit)?,
    onRestore: (() -> Unit)?,
    onUrl: ((String) -> Unit)?,
) {
    when (action) {
        is ButtonAction.Close -> onClose?.invoke()
        is ButtonAction.Restore -> onRestore?.invoke()
        is ButtonAction.Url -> onUrl?.invoke(action.url)
    }
}

/** PackageView for the currently relevant package: the cell's own package
 *  inside a packageList cell, else the selected one. `null` leaves
 *  variables verbatim (resolveVariables contract). Mirrors Swift's
 *  `relevantPackageView`. */
fun relevantPackageView(cell: PackageView?, selectedPackageId: String?, offering: Offering?): PackageView? {
    if (cell != null) return cell
    val id = selectedPackageId ?: return null
    val pkg = offering?.packageBy(id) ?: return null
    return packageView(pkg.product, pkg.product.displayName, offering)
}

// ---------------------------------------------------------------
// Pure: text style scale
// ---------------------------------------------------------------

/** title 24sp bold, subtitle 18sp regular, body 15sp regular, caption 12sp
 *  regular — the Android mirror of the SwiftUI renderer's
 *  `.title`/`.title3`/`.body`/`.caption` step scale. */
data class TextStyleSpec(val sizeSp: Float, val bold: Boolean)

fun textStyleFor(role: TextRole): TextStyleSpec = when (role) {
    TextRole.TITLE -> TextStyleSpec(sizeSp = 24f, bold = true)
    TextRole.SUBTITLE -> TextStyleSpec(sizeSp = 18f, bold = false)
    TextRole.BODY -> TextStyleSpec(sizeSp = 15f, bold = false)
    TextRole.CAPTION -> TextStyleSpec(sizeSp = 12f, bold = false)
}

// ---------------------------------------------------------------
// Pure: gravity mapping (HAlign -> android.view.Gravity)
// ---------------------------------------------------------------

/** Cross-axis alignment for a LinearLayout stack's own `gravity` (governs
 *  where children sit across the axis they're NOT stacked on), or the
 *  z-stack gravity for a `z` axis. */
fun crossAxisGravity(axis: Axis, align: HAlign?): Int = when (axis) {
    Axis.V -> when (align) {
        HAlign.CENTER -> Gravity.CENTER_HORIZONTAL
        HAlign.END -> Gravity.END
        HAlign.START, null -> Gravity.START
    }
    Axis.H -> when (align) {
        HAlign.CENTER -> Gravity.CENTER_VERTICAL
        HAlign.END -> Gravity.BOTTOM
        HAlign.START, null -> Gravity.TOP
    }
    Axis.Z -> zGravity(align)
}

/** Per-child gravity inside a `z` stack (FrameLayout): start -> top-left,
 *  end -> bottom-right, center/null -> center — mirrors the SwiftUI
 *  renderer's `.topLeading`/`.bottomTrailing`/`.center`. */
fun zGravity(align: HAlign?): Int = when (align) {
    HAlign.START -> Gravity.TOP or Gravity.START
    HAlign.END -> Gravity.BOTTOM or Gravity.END
    HAlign.CENTER, null -> Gravity.CENTER
}

/** Text-node `align` -> TextView gravity (also drives horizontal text
 *  alignment within its own bounds). */
fun textGravity(align: HAlign?): Int = when (align) {
    HAlign.CENTER -> Gravity.CENTER_HORIZONTAL
    HAlign.END -> Gravity.END
    HAlign.START, null -> Gravity.START
}

// ---------------------------------------------------------------
// Pure: per-child layout-param computation
// ---------------------------------------------------------------

enum class DimenMode { MATCH_PARENT, WRAP_CONTENT, FIXED, WEIGHTED_ZERO }

/** One axis of a child's computed size. [valueDp] is only meaningful when
 *  [mode] is [DimenMode.FIXED]. */
data class ChildDimen(val mode: DimenMode, val valueDp: Double = 0.0)

data class ChildLayout(val width: ChildDimen, val height: ChildDimen, val weight: Float)

private fun dimenFor(spec: NodeSize?, isMainAxis: Boolean): ChildDimen = when (spec) {
    null, NodeSize.Fit -> ChildDimen(DimenMode.WRAP_CONTENT)
    NodeSize.Fill -> if (isMainAxis) ChildDimen(DimenMode.WEIGHTED_ZERO) else ChildDimen(DimenMode.MATCH_PARENT)
    is NodeSize.Value -> ChildDimen(DimenMode.FIXED, spec.value)
}

/**
 * Computes a child node's layout params relative to its parent stack's
 * [axis]. Only [BuilderNode.Stack] children carry an explicit `size`
 * (schema-level — other node types render at their intrinsic/content
 * size); [BuilderNode.Spacer] gets special flex-space handling mirroring
 * SwiftUI's bare `Spacer()`; every other node type is WRAP_CONTENT with no
 * weight.
 */
fun childLayoutFor(axis: Axis, child: BuilderNode): ChildLayout = when (child) {
    is BuilderNode.Stack -> stackChildLayout(axis, child.size)
    is BuilderNode.Spacer -> spacerChildLayout(axis, child.size)
    is BuilderNode.Divider -> dividerChildLayout(child.thickness)
    is BuilderNode.Icon -> iconChildLayout(child.size)
    else -> ChildLayout(ChildDimen(DimenMode.WRAP_CONTENT), ChildDimen(DimenMode.WRAP_CONTENT), weight = 0f)
}

private fun stackChildLayout(axis: Axis, size: SizeSpec?): ChildLayout = when (axis) {
    Axis.V -> ChildLayout(
        width = dimenFor(size?.width, isMainAxis = false),
        height = dimenFor(size?.height, isMainAxis = true),
        weight = if (size?.height == NodeSize.Fill) 1f else 0f,
    )
    Axis.H -> ChildLayout(
        width = dimenFor(size?.width, isMainAxis = true),
        height = dimenFor(size?.height, isMainAxis = false),
        weight = if (size?.width == NodeSize.Fill) 1f else 0f,
    )
    Axis.Z -> ChildLayout(
        width = dimenFor(size?.width, isMainAxis = false),
        height = dimenFor(size?.height, isMainAxis = false),
        weight = 0f,
    )
}

/** A sized spacer is a fixed square box (mirrors Swift's
 *  `Spacer().frame(width:height:)`); an unsized one takes up all available
 *  space on the parent's main axis only (mirrors bare `Spacer()`). */
private fun spacerChildLayout(axis: Axis, size: Double?): ChildLayout {
    if (size != null) {
        return ChildLayout(ChildDimen(DimenMode.FIXED, size), ChildDimen(DimenMode.FIXED, size), weight = 0f)
    }
    return when (axis) {
        Axis.V -> ChildLayout(ChildDimen(DimenMode.WRAP_CONTENT), ChildDimen(DimenMode.WEIGHTED_ZERO), weight = 1f)
        Axis.H -> ChildLayout(ChildDimen(DimenMode.WEIGHTED_ZERO), ChildDimen(DimenMode.WRAP_CONTENT), weight = 1f)
        Axis.Z -> ChildLayout(ChildDimen(DimenMode.WRAP_CONTENT), ChildDimen(DimenMode.WRAP_CONTENT), weight = 0f)
    }
}

/** A divider fills its parent's cross axis (mirrors the SwiftUI renderer's
 *  bare `Rectangle()`, which fills without an explicit frame, and the web
 *  renderer's 100%-width bar) and takes exactly its (possibly-default)
 *  thickness on the other axis, regardless of the parent stack's axis. */
private fun dividerChildLayout(thickness: Double?): ChildLayout = ChildLayout(
    width = ChildDimen(DimenMode.MATCH_PARENT),
    height = ChildDimen(DimenMode.FIXED, thickness ?: DIVIDER_DEFAULT_THICKNESS_DP),
    weight = 0f,
)

/** An icon is a fixed square — its (possibly-default) size in both
 *  dimensions, matching the SwiftUI renderer's `.frame(width:height:)`. */
private fun iconChildLayout(size: Double?): ChildLayout {
    val value = size ?: ICON_DEFAULT_SIZE_DP
    return ChildLayout(ChildDimen(DimenMode.FIXED, value), ChildDimen(DimenMode.FIXED, value), weight = 0f)
}

// =================================================================
// Android view construction (requires a real Android runtime — not
// unit-tested, see class doc above).
// =================================================================

// #3478F6 (opaque) — a neutral accent; ARGB literals >= 0x80000000 overflow
// a 32-bit Int literal, so route through Long and truncate (reproduces the
// exact same bit pattern `android.graphics.Color.parseColor` would produce).
private val ACCENT_COLOR = 0xFF3478F6L.toInt()
private val SELECTED_STROKE_COLOR = ACCENT_COLOR
private const val UNSELECTED_STROKE_COLOR = 0x59808080 // translucent gray

// Defaults mirroring packages/shared/src/paywall/schema.ts's
// DIVIDER_DEFAULT_THICKNESS / DIVIDER_DEFAULT_INSET / ICON_DEFAULT_SIZE /
// DIVIDER_DEFAULT_COLOR — device-independent pixels, converted with the
// display density (see `dp`) before use as view dimensions.
// `DIVIDER_DEFAULT_COLOR` below mirrors schema.ts's constant by hand (no
// codegen step shares it across platforms). There is deliberately no
// ICON default tint constant: an uncoloured icon INHERITS the ambient text
// colour (see `buildIcon`), matching SwiftUI's `nil` -> `.foregroundColor`
// and the web renderer's un-set `color` -> CSS inheritance. `android:tint`
// was stripped from every vendored drawable (see res/drawable/README.md),
// so nothing supplies a colour unless the node has one or we tint it here.
//
// NOT `private` (module-internal instead) for the ones a test needs to
// compare against packages/shared/src/paywall/render-fixtures.json's
// generated `defaults` object BY VALUE (see NodeViewFactoryTest's
// `nativeDefaultsMatchTheSharedFixture` — Kotlin's `private` at file scope
// is file-local even within the same module, unlike `internal`).
internal const val DIVIDER_DEFAULT_THICKNESS_DP = 1.0
internal const val DIVIDER_DEFAULT_INSET_DP = 0.0
private const val ICON_DEFAULT_SIZE_DP = 24.0
internal val DIVIDER_DEFAULT_COLOR = ThemePair(light = "#E5E7EB", dark = "#374151")

// Defaults mirroring packages/shared/src/paywall/schema.ts's
// FEATURE_ROW_DEFAULT_ICON / FEATURE_ROW_EXCLUDED_ICON /
// FEATURE_ROW_DEFAULT_INCLUDED / TIMELINE_ROW_DEFAULT_ICON /
// TIMELINE_CONNECTOR_DEFAULT_COLOR (same hex as DIVIDER_DEFAULT_COLOR — the
// connector is the same hairline as a divider) / SOCIAL_PROOF_STAR_DEFAULT_
// COLOR / SOCIAL_PROOF_MAX_RATING. Keep in sync with schema.ts by hand;
// there is no codegen step sharing these across platforms. NOT `private`
// for the same reason as the divider defaults above.
internal const val FEATURE_ROW_DEFAULT_ICON = "check"
internal const val FEATURE_ROW_EXCLUDED_ICON = "x"
internal const val FEATURE_ROW_DEFAULT_INCLUDED = true
internal const val TIMELINE_ROW_DEFAULT_ICON = "clock"
internal val TIMELINE_CONNECTOR_DEFAULT_COLOR = DIVIDER_DEFAULT_COLOR
internal val SOCIAL_PROOF_STAR_DEFAULT_COLOR = ThemePair(light = "#F59E0B", dark = "#FBBF24")
internal const val SOCIAL_PROOF_MAX_RATING = 5
private const val SOCIAL_PROOF_STAR_ICON_NAME = "star"
private const val SOCIAL_PROOF_STAR_BORDER_ICON_NAME = "star_border"

// The row's own text colour when nothing more specific is configured —
// mirrors paywall-renderer/styles.ts's `DEFAULT_INK` byte-for-byte (a
// web-only constant, not one of schema.ts's shared cross-platform
// defaults, so this is hand-picked rather than sync-tested). Used to tint
// an icon that would otherwise draw with NO tint at all: on Android that
// means the vendored drawable's own baked-in white fill shows through
// (see res/drawable/README.md), which disappears on a light background —
// unlike iOS (`Image` with no `.foregroundColor` inherits the ambient
// label colour natively) and web (`currentColor` inherits the row's own
// CSS `color`), Android's ImageView has no such automatic inheritance, so
// "inherit" has to mean "tint with the same ink the label text resolves
// to" rather than "apply no tint."
private val TEXT_INK_DEFAULT_COLOR = ThemePair(light = "#0F172A", dark = "#F8FAFC")

// Layout constants for the three row-carrying node types, in dp — no
// cross-platform pixel-parity contract exists for these gaps (see the
// wave-B notes: star half-fill / connector alignment / row spacing at
// accessibility text sizes is a device question for the next smoke
// session), but the values still get names rather than being inlined.
private const val FEATURE_LIST_ROW_SPACING_DP = 8.0
private const val FEATURE_ROW_ICON_GAP_DP = 8.0
private const val TIMELINE_MARK_GAP_DP = 12.0
private const val TIMELINE_CONNECTOR_WIDTH_DP = 2.0
private const val SOCIAL_PROOF_STAR_GAP_DP = 2.0
private const val SOCIAL_PROOF_LABEL_GAP_DP = 4.0

// Defaults mirroring packages/shared/src/paywall/schema.ts's
// STICKY_FOOTER_DEFAULT_BACKGROUND / COUNTDOWN_DEFAULT_ON_EXPIRY /
// COUNTDOWN_TICK_MS. Keep in sync with schema.ts by hand; there is no
// codegen step sharing these across platforms. NOT `private` for the same
// reason as the divider/feature-row defaults above — a test compares them
// against render-fixtures.json's generated `defaults` object by value.
internal val STICKY_FOOTER_DEFAULT_BACKGROUND = ThemePair(light = "#FFFFFF", dark = "#111827")
internal val COUNTDOWN_DEFAULT_ON_EXPIRY = CountdownOnExpiry.FREEZE

/** Milliseconds between countdown ticks, matching schema.ts's
 *  `COUNTDOWN_TICK_MS` (identical on all three platforms). */
internal const val COUNTDOWN_TICK_MS = 1000L

// Defaults mirroring packages/shared/src/paywall/schema.ts's
// CAROUSEL_DEFAULT_SHOWS_INDICATOR / CAROUSEL_DEFAULT_LOOP /
// CAROUSEL_MIN_AUTO_ADVANCE_SECONDS. Keep in sync with schema.ts by hand;
// there is no codegen step sharing these across platforms. NOT `private`
// for the same reason as the divider/countdown defaults above — a test
// compares them against render-fixtures.json's generated `defaults` object
// by value.
internal const val CAROUSEL_DEFAULT_SHOWS_INDICATOR = true
internal const val CAROUSEL_DEFAULT_LOOP = false

/** Seconds. Authoring-time advice only (schema.ts's own comment: below this,
 *  dots move faster than a reader can follow) — the renderer honours
 *  whatever `autoAdvanceSeconds` it is given; this is NOT a clamp. */
internal const val CAROUSEL_MIN_AUTO_ADVANCE_SECONDS = 2

// Hand-drawn dot-indicator constants, in dp/alpha — ViewPager2 supplies no
// built-in page indicator, so these are drawn by CarouselDotsRow. No
// cross-platform pixel-parity contract exists for these (same footing as
// FEATURE_LIST_ROW_SPACING_DP et al.), but they still get names rather than
// being inlined.
private const val CAROUSEL_DOT_SIZE_DP = 6.0
private const val CAROUSEL_DOT_GAP_DP = 6.0
private const val CAROUSEL_DOT_ACTIVE_ALPHA = 1.0f
private const val CAROUSEL_DOT_INACTIVE_ALPHA = 0.3f
private const val CAROUSEL_DOTS_TOP_MARGIN_DP = 8.0

/** Pre-measurement initial value for the scrolled content's bottom
 *  clearance beneath a pinned `stickyFooter`, used only until the footer's
 *  first real layout pass reports its height (see
 *  [stickyFooterClearancePx]) — mirrors the web renderer's
 *  `STICKY_FOOTER_CONTENT_CLEARANCE_PX` / the Swift renderer's
 *  `stickyFooterContentClearanceDefault`. Not one of schema.ts's shared
 *  cross-platform constants (each renderer picks its own pre-measurement
 *  guess), so this is hand-picked to match rather than sync-tested. */
internal const val STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT_DP = 96.0

private const val COUNTDOWN_LABEL_GAP_DP = 4.0

/**
 * A feature row's mark: its own `icon` if given, otherwise the excluded mark
 * when `included` resolves to `false`, else the included default. Exposed
 * (not private) so tests can assert WHICH drawable an excluded row resolves
 * to via `drawableResFor` — asserting merely that *some* drawable resolved
 * would pass even with the wrong branch, since both `check` and `x` are
 * real, vendored drawables. Mirrors the Swift renderer's
 * `resolvedFeatureRowIconName` / the web renderer's `renderFeatureList` row-
 * icon resolution.
 */
internal fun resolvedFeatureRowIconName(row: FeatureRow): String {
    val included = row.included ?: FEATURE_ROW_DEFAULT_INCLUDED
    return row.icon ?: if (included) FEATURE_ROW_DEFAULT_ICON else FEATURE_ROW_EXCLUDED_ICON
}

/**
 * The tint an icon/mark draws with when nothing more specific is
 * configured: [explicit] if given, else [TEXT_INK_DEFAULT_COLOR] — the same
 * ink a row's own label text resolves to. Exposed (not private) so a test
 * can assert the fallback equals the resolved ink colour, not white (the
 * vendored drawables' own baked-in fill — see res/drawable/README.md).
 * Unlike [buildText] (which only sets a colour when the node has one, and
 * otherwise leaves the system/theme default text colour alone), an icon
 * with no tint at all just shows that white fill through — so "inherit"
 * here has to mean "tint with the ink", never "apply no tint."
 */
internal fun resolvedInkTintColorInt(explicit: ThemePair?, dark: Boolean): Int =
    explicit?.let { parseHexColor(themeValue(it, dark))?.toColorInt() }
        ?: parseHexColor(themeValue(TEXT_INK_DEFAULT_COLOR, dark))!!.toColorInt()

/**
 * Whether the star at [index] (0-based) is filled for [rating]: the first
 * `floor(rating)` stars, so a rating of 4.5 fills indices 0-3 (4 stars),
 * not 0-4 — showing a fractional rating identically to the next whole one
 * overstates it, the wrong direction for social proof. Exposed (not
 * private) so a fractional-rating test can pin it directly. Mirrors the
 * web renderer's `renderSocialProof` (`Math.floor`) and the Swift
 * renderer's `socialProofStarFilled` (`rating.rounded(.down)`).
 */
internal fun socialProofStarFilled(index: Int, rating: Double): Boolean = index < floor(rating)

// ---------------------------------------------------------------
// Pure: countdown
// ---------------------------------------------------------------

/**
 * `hh:mm:ss`, dropping the hours segment entirely once it's zero — a
 * countdown under an hour shows `mm:ss`, never a leading `00:`. Exposed
 * (internal) so it's directly unit-testable without an Android runtime —
 * this is the only part of a countdown a JVM test here can reach. Mirrors
 * the Swift renderer's `countdownText` / the web renderer's
 * `formatCountdown`. A negative [remaining] (there should never be one
 * live, but a stale/replayed value could produce one) clamps to zero
 * rather than producing a negative display.
 */
internal fun countdownText(remaining: Long): String {
    val total = maxOf(remaining, 0L)
    val hours = total / 3600
    val minutes = (total % 3600) / 60
    val seconds = total % 60
    return if (hours > 0) {
        "%02d:%02d:%02d".format(hours, minutes, seconds)
    } else {
        "%02d:%02d".format(minutes, seconds)
    }
}

/**
 * Parses an ISO-8601 instant (`endsAt`) to epoch millis. `java.time.Instant
 * .parse` tolerates both a bare `Z`-suffixed UTC timestamp and one carrying
 * fractional seconds in one call — unlike the Swift renderer, which needs
 * two configured `ISO8601DateFormatter`s for the same two shapes. `null` on
 * any parse failure (never throws) — an unparsable `endsAt` is treated the
 * same as "no deadline at all" by [countdownDeadlineMillis].
 */
internal fun parseIsoInstantMillis(raw: String): Long? = try {
    java.time.Instant.parse(raw).toEpochMilli()
} catch (_: Exception) {
    null
}

/**
 * The deadline (epoch millis) a `countdown` node resolves to: [BuilderNode.
 * Countdown.endsAt] directly when present, else [BuilderNode.Countdown.
 * durationSeconds] anchored to [anchorMillis] — a PERSISTED first-show
 * instant (see [countdownFirstShownAtMillis]), never this render's own
 * construction time, which would make the deadline restart on every open.
 * [anchorMillis] is a SUPPLIER (not a value) so it is only invoked — and
 * only then does it read/stamp `SharedPreferences` — when a
 * `durationSeconds` node actually needs it; an `endsAt` node never touches
 * storage. `null` when the node carries neither (the validator's
 * `COUNTDOWN_NO_DEADLINE` already flags that at author time; this is a
 * defensive fail-open, not the primary guard). Mirrors the Swift renderer's
 * `CountdownView.deadline`.
 */
internal fun countdownDeadlineMillis(node: BuilderNode.Countdown, anchorMillis: () -> Long): Long? {
    node.endsAt?.let { return parseIsoInstantMillis(it) }
    node.durationSeconds?.let { seconds -> return anchorMillis() + (seconds * 1000).toLong() }
    return null
}

/**
 * Whether an expired `countdown` node collapses out of the layout right
 * now: only `onExpiry: "hide"` does, and only once [remainingSeconds] has
 * actually reached zero ([CountdownOnExpiry.FREEZE] holds the display at
 * `00:00`, still visible). Pure so the rule is testable, and because it is
 * asked TWICE — once for the visibility itself and once for "is there
 * anything left to tick for", the ticker being stopped rather than left
 * firing once a second against a `GONE` row for the rest of the session.
 */
internal fun countdownHidesNow(remainingSeconds: Long, onExpiry: CountdownOnExpiry): Boolean =
    remainingSeconds <= 0L && onExpiry == CountdownOnExpiry.HIDE

/** Seconds remaining until [deadlineMillis] from [nowMillis], rounded UP —
 *  mirrors the Swift renderer's `.rounded(.up)` so the displayed second only
 *  decrements once a full second has actually elapsed, never a moment
 *  early. Never negative. */
internal fun countdownRemainingSeconds(deadlineMillis: Long, nowMillis: Long): Long =
    maxOf(kotlin.math.ceil((deadlineMillis - nowMillis) / 1000.0).toLong(), 0L)

// ---------------------------------------------------------------
// Pure: carousel
// ---------------------------------------------------------------

/**
 * The page index one auto-advance tick (or a manual "advance") moves to:
 * [current] + 1, EXCEPT that reaching the end wraps to page 0 only when
 * [loop] is true. With `loop = false`, reaching the last page returns
 * [current] UNCHANGED — that is the signal callers use to stop the
 * auto-advance timer for good (spec §5): a stopped carousel never rewinds.
 * `pageCount <= 0` is defensive (never reached in practice — a childless
 * carousel renders its `fallback` instead, see `buildCarousel`) and returns
 * [current] unchanged rather than dividing by/indexing into nothing. This is
 * the one piece of substantive new logic wave-D1 adds to this renderer, kept
 * pure specifically so the loop rule is unit-testable without any Android
 * runtime — mirrors the Swift renderer's `CarouselView.advance()` / the web
 * renderer's carousel auto-advance effect.
 */
internal fun nextCarouselPage(current: Int, pageCount: Int, loop: Boolean): Int {
    if (pageCount <= 0) return current
    val next = current + 1
    return when {
        next < pageCount -> next
        loop -> 0
        else -> current
    }
}

private const val COUNTDOWN_NO_ANCHOR = -1L

/** `SharedPreferences` key prefix for a countdown's persisted "first shown
 *  to this user" instant, one per paywall identifier. Mirrors schema.ts's
 *  `COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX` — the Swift SDK's `UserDefaults`
 *  key and the web's `localStorage` key are the same string, so the three
 *  platforms agree on where a paywall's anchor lives. `internal`, not
 *  `private`, so the shared-defaults fixture test can compare it BY VALUE. */
internal const val COUNTDOWN_FIRST_SHOWN_KEY_PREFIX = "rovenue.paywall.countdown.firstShownAt."

/** The `SharedPreferences` file name this SDK persists a countdown's
 *  first-show anchor to. Not `private`: [RovenuePaywallView] opens it by
 *  name. */
internal const val COUNTDOWN_PREFS_NAME = "rovenue_paywall_countdown"

/**
 * The persisted instant (epoch millis) a `durationSeconds` countdown
 * anchors its deadline to, keyed by [paywallIdentifier] — every countdown
 * node on the SAME paywall shares one anchor, since "first show" is a
 * paywall-level concept, not a per-node one. On the FIRST call for a given
 * identifier, stamps and stores [now]; every subsequent call for the same
 * identifier reads the stored value back rather than re-stamping it — this
 * is what makes `durationSeconds` an actual deadline rather than a timer
 * that restarts on every open. [prefs] is injectable for test isolation
 * (mirrors the Swift renderer's injectable `UserDefaults` parameter, which
 * defaults to `.standard`); production call sites pass the real
 * `SharedPreferences` opened from [COUNTDOWN_PREFS_NAME] ([RovenuePaywallView]
 * does this). [now] is injectable so a test can assert the SECOND call
 * reuses the FIRST call's stamp without a real clock racing it.
 */
internal fun countdownFirstShownAtMillis(
    paywallIdentifier: String?,
    prefs: android.content.SharedPreferences,
    now: () -> Long = System::currentTimeMillis,
): Long {
    val key = COUNTDOWN_FIRST_SHOWN_KEY_PREFIX + (paywallIdentifier ?: "")
    val existing = prefs.getLong(key, COUNTDOWN_NO_ANCHOR)
    if (existing != COUNTDOWN_NO_ANCHOR) return existing
    val stamped = now()
    prefs.edit().putLong(key, stamped).apply()
    return stamped
}

// `internal`, not `private`: RovenuePaywallView.kt needs it too, for the
// pinned-stickyFooter clearance/inset padding (its own render() lives in a
// different file, same module).
internal fun dp(context: Context, value: Double): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), context.resources.displayMetrics)
        .roundToInt()

private fun ChildDimen.toPx(context: Context): Int = when (mode) {
    DimenMode.MATCH_PARENT -> ViewGroup.LayoutParams.MATCH_PARENT
    DimenMode.WRAP_CONTENT -> ViewGroup.LayoutParams.WRAP_CONTENT
    DimenMode.WEIGHTED_ZERO -> 0
    DimenMode.FIXED -> dp(context, valueDp)
}

/**
 * Mutable per-bind render state threaded through the whole node tree.
 * Rebuilt fresh on every [RovenuePaywallView] render pass (selection
 * change, purchase-state change, rebind) — the tree is fully re-rendered
 * rather than diffed, same simplification the web renderer's remount takes
 * (see the Phase-C plan's Task 6 notes).
 */
internal class PaywallRenderContext(
    val config: BuilderConfigModel,
    val locale: String?,
    val dark: Boolean,
    val offering: Offering?,
    val selectedPackageId: String?,
    val isPurchasing: Boolean,
    val select: (String) -> Unit,
    val purchase: () -> Unit,
    val onClose: (() -> Unit)?,
    val onRestore: (() -> Unit)?,
    val onUrl: ((String) -> Unit)?,
    val loadImage: (ImageView, String) -> Unit,
    /** The host app's version, as supplied to `Rovenue.configure`/`shared`
     *  at bind time — feeds the `visibility.minAppVersion`/
     *  `maxAppVersion` gate in [NodeViewFactory.build]. `null` when a
     *  paywall renders before an appVersion was ever configured; the
     *  gate fails open in that case (see Visibility.kt), never crashes. */
    val appVersion: String? = null,
    /** Resolves the persisted first-show anchor (epoch millis) for a
     *  `durationSeconds` countdown's deadline — see
     *  [countdownFirstShownAtMillis]. [RovenuePaywallView] closes this over
     *  the real `SharedPreferences` opened from [COUNTDOWN_PREFS_NAME] and
     *  this bind's `paywallIdentifier`; the default here (plain "now") only
     *  ever runs if a caller builds a [PaywallRenderContext] without wiring
     *  it — production code always does. */
    val countdownAnchorMillis: () -> Long = System::currentTimeMillis,
) {
    /** Localized + variable-resolved label. [cell] scopes variables to a
     *  package cell; elsewhere the selected package wins. */
    fun label(key: String, cell: CellScope?): String {
        val text = resolveText(config, locale, key) ?: ""
        val pkg = relevantPackageView(cell?.view, selectedPackageId, offering)
        return resolveVariables(text, pkg)
    }
}

/**
 * The package a `cellTemplate` subtree is currently scoped to — carries
 * both the identifier (needed to evaluate the `selected` override
 * condition against the live global selection) and its resolved
 * [PackageView] (needed for `{{variable}}` substitution). `null` outside
 * any `cellTemplate` subtree. Mirrors the Swift renderer's `CellScope` +
 * nodes.tsx's `insideCellTemplate` + `cellPackageId` pair, bundled into one
 * value since they always travel together.
 */
internal data class CellScope(val packageId: String, val view: PackageView)

/** This SDK's compile-time platform literal for the `visibility` gate —
 *  never "web", the other value the shared `VisibilityPlatform` enum
 *  allows (see BuilderConfigModel.kt's `VISIBILITY_PLATFORMS`). */
private const val PLATFORM = "android"

/** Builds the android.view.View tree for a [BuilderNode] subtree. */
internal object NodeViewFactory {

    fun build(context: Context, node: BuilderNode, ctx: PaywallRenderContext, cell: CellScope?): View? {
        // Visibility is gated FIRST, on the RAW node — before overrides
        // are resolved, and before any style/text/child work happens. A
        // hidden node renders NOTHING: not its fallback, not its
        // children. `visibility` is deliberately NOT overridable (see
        // BuilderConfigModel.kt's `Visibility` doc), so it must be read
        // off `node`, never off the post-`applyOverrides` result.
        if (!isNodeVisible(node.visibility, PLATFORM, ctx.appVersion)) return null

        // Every node passes through `applyOverrides` here, BEFORE any
        // style/text resolution happens in the per-type builders below —
        // `resolved` (not the original `node`) is what gets dispatched.
        // Mirrors the Swift renderer's `BuilderNodeView.body` and
        // nodes.tsx's `renderNode`.
        val active = activeOverrideConditions(
            cellPackageId = cell?.packageId, selectedPackageId = ctx.selectedPackageId, offering = ctx.offering,
        )
        return when (val resolved = applyOverrides(node, active)) {
            is BuilderNode.Stack -> buildStack(context, resolved, ctx, cell)
            is BuilderNode.Text -> buildText(context, resolved, ctx, cell)
            is BuilderNode.Image -> buildImage(context, resolved, ctx, cell)
            is BuilderNode.Button -> buildButton(context, resolved, ctx, cell)
            is BuilderNode.PackageList -> buildPackageList(context, resolved, ctx)
            is BuilderNode.PurchaseButton -> buildPurchaseButton(context, resolved, ctx)
            is BuilderNode.Spacer -> View(context)
            is BuilderNode.Divider -> buildDivider(context, resolved, ctx)
            is BuilderNode.Icon -> buildIcon(context, resolved, ctx)
            is BuilderNode.FeatureList -> buildFeatureList(context, resolved, ctx, cell)
            is BuilderNode.Timeline -> buildTimeline(context, resolved, ctx, cell)
            is BuilderNode.SocialProof -> buildSocialProof(context, resolved, ctx, cell)
            is BuilderNode.StickyFooter -> buildStickyFooter(context, resolved, ctx, cell)
            is BuilderNode.Countdown -> buildCountdown(context, resolved, ctx, cell)
            is BuilderNode.Carousel -> buildCarousel(context, resolved, ctx, cell)
            is BuilderNode.Unknown -> resolved.fallback?.let { build(context, it, ctx, cell) }
        }
    }

    private fun buildStack(
        context: Context,
        node: BuilderNode.Stack,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View {
        val group: ViewGroup = when (node.axis) {
            Axis.V -> LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = crossAxisGravity(node.axis, node.align)
            }
            Axis.H -> LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = crossAxisGravity(node.axis, node.align)
            }
            Axis.Z -> FrameLayout(context)
        }

        node.padding?.let { p ->
            group.setPadding(
                dp(context, p.l ?: 0.0),
                dp(context, p.t ?: 0.0),
                dp(context, p.r ?: 0.0),
                dp(context, p.b ?: 0.0),
            )
        }

        if (node.background != null || node.cornerRadius != null) {
            group.background = GradientDrawable().apply {
                cornerRadius = dp(context, node.cornerRadius ?: 0.0).toFloat()
                val color = node.background?.let { parseHexColor(themeValue(it, ctx.dark))?.toColorInt() }
                setColor(color ?: 0x00000000)
            }
        }

        node.children.forEachIndexed { index, child ->
            val childView = build(context, child, ctx, cell) ?: return@forEachIndexed
            // [build] resolves overrides INTERNALLY before dispatching on
            // `child`'s type, so an active override (e.g. a divider's
            // `thickness`) is what actually drew — but the height/width
            // passed to layout here must come off that SAME resolved node,
            // not the raw pre-override `child`, or an active override
            // changes what's drawn without changing the box it's laid out
            // in (silently clipped/misfit). Web and Swift both read layout
            // off the resolved node; this mirrors them.
            val active = activeOverrideConditions(
                cellPackageId = cell?.packageId, selectedPackageId = ctx.selectedPackageId, offering = ctx.offering,
            )
            val resolvedChild = applyOverrides(child, active)
            val dimen = childLayoutFor(node.axis, resolvedChild)
            val lp = when (node.axis) {
                Axis.Z -> FrameLayout.LayoutParams(
                    dimen.width.toPx(context),
                    dimen.height.toPx(context),
                    zGravity(node.align),
                )
                else -> LinearLayout.LayoutParams(dimen.width.toPx(context), dimen.height.toPx(context)).apply {
                    weight = dimen.weight
                    if (index > 0 && node.spacing != null) {
                        when (node.axis) {
                            Axis.V -> topMargin = dp(context, node.spacing)
                            Axis.H -> leftMargin = dp(context, node.spacing)
                            Axis.Z -> {}
                        }
                    }
                }
            }
            group.addView(childView, lp)
        }
        return group
    }

    private fun buildText(
        context: Context,
        node: BuilderNode.Text,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): TextView {
        val style = textStyleFor(node.role)
        return TextView(context).apply {
            text = ctx.label(node.key, cell)
            textSize = style.sizeSp
            setTypeface(typeface, if (style.bold) Typeface.BOLD else Typeface.NORMAL)
            gravity = textGravity(node.align)
            node.color?.let { pair -> parseHexColor(themeValue(pair, ctx.dark))?.let { setTextColor(it.toColorInt()) } }
        }
    }

    private fun buildImage(
        context: Context,
        node: BuilderNode.Image,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): ImageView {
        val iv = ImageView(context).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            adjustViewBounds = true
            contentDescription = node.alt?.let { ctx.label(it, cell) }
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                node.height?.let { dp(context, it) } ?: ViewGroup.LayoutParams.WRAP_CONTENT,
            )
        }
        if ((node.cornerRadius ?: 0.0) > 0.0) {
            val radiusPx = dp(context, node.cornerRadius ?: 0.0).toFloat()
            iv.clipToOutline = true
            iv.outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: android.graphics.Outline) {
                    outline.setRoundRect(0, 0, view.width, view.height, radiusPx)
                }
            }
        }
        ctx.loadImage(iv, themeValue(node.url, ctx.dark))
        return iv
    }

    private fun buildButton(
        context: Context,
        node: BuilderNode.Button,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View? {
        if (!actionButtonVisible(node.action, hasRestoreHandler = ctx.onRestore != null)) return null
        return Button(context).apply {
            text = ctx.label(node.labelKey, cell)
            isAllCaps = false
            setTypeface(typeface, if (node.style == ButtonVisualStyle.PRIMARY) Typeface.BOLD else Typeface.NORMAL)
            alpha = if (node.style == ButtonVisualStyle.PLAIN) 0.7f else 1f
            setOnClickListener {
                routeButtonAction(node.action, onClose = ctx.onClose, onRestore = ctx.onRestore, onUrl = ctx.onUrl)
            }
        }
    }

    private fun buildPackageList(context: Context, node: BuilderNode.PackageList, ctx: PaywallRenderContext): View {
        val ids = effectivePackageIds(node, ctx.offering)
        val cells = ids.mapNotNull { id -> ctx.offering?.packageBy(id) }
        val row = node.cellLayout == CellLayout.ROW
        val container = LinearLayout(context).apply {
            orientation = if (row) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        }
        cells.forEach { pkg ->
            val cellView = buildPackageCell(context, pkg, ctx, node.cellTemplate)
            val margin = dp(context, 4.0)
            val lp = LinearLayout.LayoutParams(
                if (row) 0 else LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                if (row) weight = 1f
                setMargins(margin, margin, margin, margin)
            }
            container.addView(cellView, lp)
        }
        return container
    }

    private fun buildPackageCell(
        context: Context,
        pkg: dev.rovenue.sdk.Package,
        ctx: PaywallRenderContext,
        template: BuilderNode?,
    ): View {
        val selected = ctx.selectedPackageId == pkg.identifier

        // A cellTemplate REPLACES the built-in (name + price) cell content,
        // rendered INSIDE the same pressable/selectable cell wrapper — the
        // cell-scoped CellScope is what makes `{{price}}` etc. inside the
        // template resolve to THIS cell's package rather than the globally
        // selected one, and what makes a `selected`-condition override
        // inside the template match only the currently-selected cell.
        if (template != null) {
            val view = packageView(pkg.product, pkg.product.displayName, ctx.offering)
            val cell = CellScope(packageId = pkg.identifier, view = view)
            val templateView = build(context, template, ctx, cell) ?: View(context)
            return FrameLayout(context).apply {
                isClickable = true
                isFocusable = true
                // The `isSelected`-state flag is this renderer's aria-equivalent
                // (mirrors Swift's `.accessibilityAddTraits(.isSelected)`).
                isSelected = selected
                addView(templateView)
                setOnClickListener { ctx.select(pkg.identifier) }
            }
        }

        // No cellTemplate -> built-in cell (name + price), unchanged from
        // before overrides/cellTemplate existed.
        val view = packageView(pkg.product, pkg.product.displayName, ctx.offering)
        val nameText = TextView(context).apply {
            text = view.packageName
            textSize = 15f
            setTypeface(typeface, Typeface.BOLD)
        }
        val priceText = TextView(context).apply {
            text = view.pricePerPeriod
            textSize = 12f
        }
        val pad = dp(context, 10.0)
        return LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            isClickable = true
            isFocusable = true
            isSelected = selected
            setPadding(pad, pad, pad, pad)
            background = GradientDrawable().apply {
                cornerRadius = dp(context, 10.0).toFloat()
                setColor(0x00000000)
                setStroke(dp(context, if (selected) 2.0 else 1.0), if (selected) SELECTED_STROKE_COLOR else UNSELECTED_STROKE_COLOR)
            }
            addView(nameText)
            addView(priceText)
            setOnClickListener { ctx.select(pkg.identifier) }
        }
    }

    private fun buildPurchaseButton(context: Context, node: BuilderNode.PurchaseButton, ctx: PaywallRenderContext): View {
        val enabled = purchaseEnabled(ctx.selectedPackageId, ctx.isPurchasing)
        // The GLOBAL selection, not any cellTemplate scope — a purchaseButton
        // is schema-forbidden inside cellTemplate, so `cell = null` here
        // always resolves the same selected PackageView `ctx.label` itself
        // uses for this node. Mirrors nodes.tsx calling `resolveCtaLabelKey`
        // with the selected package's view and Swift's `PurchaseButtonView`.
        val selectedView = relevantPackageView(cell = null, selectedPackageId = ctx.selectedPackageId, offering = ctx.offering)
        val resolvedLabelKey = ctaLabelKey(labelKey = node.labelKey, trialLabelKey = node.trialLabelKey, selectedView = selectedView)
        return Button(context).apply {
            text = ctx.label(resolvedLabelKey, null)
            isAllCaps = false
            isEnabled = enabled
            setTypeface(typeface, Typeface.BOLD)
            background = GradientDrawable().apply {
                cornerRadius = dp(context, 12.0).toFloat()
                setColor(ACCENT_COLOR)
                alpha = if (enabled) 255 else 102 // ~0.4 opacity, mirrors the SwiftUI renderer
            }
            setOnClickListener { ctx.purchase() }
        }
    }

    /**
     * A thin colored bar. Height/width are handled generically by
     * [childLayoutFor] (see [dividerChildLayout]); the horizontal `inset` is
     * NOT expressible through that generic per-child layout path (it's a
     * property of this node alone, not every node), so it's applied here as
     * padding on a wrapping [FrameLayout] instead — padding, unlike a plain
     * View's background, IS respected when laying out a ViewGroup's child.
     */
    private fun buildDivider(context: Context, node: BuilderNode.Divider, ctx: PaywallRenderContext): View {
        // A hairline rule, not body text: an uncoloured divider falls back to
        // the shared DIVIDER_DEFAULT_COLOR, not a plain mid-gray — this used
        // to draw a fixed 0x4D808080 that read differently from web/iOS's
        // opaque light/dark-aware defaults for the exact same uncoloured node.
        val resolvedColor = node.color?.let { pair -> parseHexColor(themeValue(pair, ctx.dark))?.toColorInt() }
            ?: parseHexColor(themeValue(DIVIDER_DEFAULT_COLOR, ctx.dark))?.toColorInt()
        val insetPx = dp(context, node.inset ?: DIVIDER_DEFAULT_INSET_DP)
        val line = View(context).apply {
            setBackgroundColor(resolvedColor ?: 0xFF808080.toInt())
        }
        return FrameLayout(context).apply {
            setPadding(insetPx, 0, insetPx, 0)
            addView(line, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
    }

    /**
     * Resolves [BuilderNode.Icon.name] to a vendored drawable resource id via
     * the STATIC [drawableResFor] map (`R.drawable.rovenue_ic_*`), which
     * returns `null` when nothing matches — `icon.name` is a free string by
     * design, so a paywall authored against a newer registry must fail open
     * on an older app.
     *
     * `color` absent falls back to [resolvedInkTintColorInt]'s default ink,
     * NEVER "no tint at all": every vendored drawable ships a white fill
     * (see res/drawable/README.md) with `android:tint` stripped, so leaving
     * `imageTintList` unset draws that raw white fill through — invisible
     * on a light background. iOS's `Image` with no `.foregroundColor`
     * inherits the ambient label colour natively, and web's un-set `color`
     * inherits the row's own CSS `color` — Android has no equivalent
     * automatic inheritance, so tinting with the resolved text ink is what
     * makes "inherit" actually mean something here.
     */
    private fun buildIcon(context: Context, node: BuilderNode.Icon, ctx: PaywallRenderContext): View? {
        val resId = drawableResFor(node.name) ?: return null
        val tint = resolvedInkTintColorInt(node.color, ctx.dark)
        return ImageView(context).apply {
            setImageResource(resId)
            imageTintList = android.content.res.ColorStateList.valueOf(tint)
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
    }

    /** A vertical LinearLayout of rows, each an ImageView (the row's resolved
     *  mark, via [resolvedFeatureRowIconName] + the static [drawableResFor]
     *  map) plus a TextView. Mirrors the web renderer's `renderFeatureList`. */
    private fun buildFeatureList(
        context: Context,
        node: BuilderNode.FeatureList,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View {
        val container = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        val rowSpacing = dp(context, FEATURE_LIST_ROW_SPACING_DP)
        node.rows.forEachIndexed { index, row ->
            val rowView = buildFeatureRow(context, row, node.iconColor, ctx, cell)
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                if (index > 0) topMargin = rowSpacing
            }
            container.addView(rowView, lp)
        }
        return container
    }

    private fun buildFeatureRow(
        context: Context,
        row: FeatureRow,
        iconColor: ThemePair?,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View {
        val rowLayout = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val resId = drawableResFor(resolvedFeatureRowIconName(row))
        if (resId != null) {
            // Absent `iconColor` falls back to the resolved text ink (see
            // resolvedInkTintColorInt/buildIcon) — NEVER "no tint", which on
            // Android draws the vendored drawable's own baked-in white fill,
            // invisible on a light background.
            val tint = resolvedInkTintColorInt(iconColor, ctx.dark)
            val iv = ImageView(context).apply {
                setImageResource(resId)
                scaleType = ImageView.ScaleType.FIT_CENTER
                imageTintList = android.content.res.ColorStateList.valueOf(tint)
            }
            val size = dp(context, ICON_DEFAULT_SIZE_DP)
            val ivLp = LinearLayout.LayoutParams(size, size).apply {
                rightMargin = dp(context, FEATURE_ROW_ICON_GAP_DP)
            }
            rowLayout.addView(iv, ivLp)
        }
        val label = TextView(context).apply {
            text = ctx.label(row.labelKey, cell)
            textSize = textStyleFor(TextRole.BODY).sizeSp
        }
        rowLayout.addView(label)
        return rowLayout
    }

    /** A vertical LinearLayout of rows: each row's mark, a thin connector bar
     *  below it for every row but the last, the label, and the optional
     *  caption. `connectorColor` absent falls back to
     *  [TIMELINE_CONNECTOR_DEFAULT_COLOR] — a rule, not text, so unlike a
     *  row's own mark (which always inherits — [TimelineRow] carries no
     *  color at all) it is never left to inherit. Mirrors the web renderer's
     *  `renderTimeline`. */
    private fun buildTimeline(
        context: Context,
        node: BuilderNode.Timeline,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View {
        val container = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        node.rows.forEachIndexed { index, row ->
            val isLast = index == node.rows.size - 1
            container.addView(buildTimelineRow(context, row, node.connectorColor, isLast, ctx, cell))
        }
        return container
    }

    private fun buildTimelineRow(
        context: Context,
        row: TimelineRow,
        connectorColor: ThemePair?,
        isLast: Boolean,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View {
        val rowLayout = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }

        val markColumn = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }
        val resId = drawableResFor(row.icon ?: TIMELINE_ROW_DEFAULT_ICON)
        if (resId != null) {
            // A timeline row's own mark has NO configurable color at all
            // (TimelineRow carries none) — no authorable config could ever
            // fix an untinted mark here, so it ALWAYS resolves through
            // resolvedInkTintColorInt (explicit = null), same fallback
            // buildFeatureRow uses when its own iconColor is absent.
            val iv = ImageView(context).apply {
                setImageResource(resId)
                scaleType = ImageView.ScaleType.FIT_CENTER
                imageTintList = android.content.res.ColorStateList.valueOf(resolvedInkTintColorInt(null, ctx.dark))
            }
            val size = dp(context, ICON_DEFAULT_SIZE_DP)
            markColumn.addView(iv, LinearLayout.LayoutParams(size, size))
        }
        if (!isLast) {
            val resolvedColor = connectorColor?.let { pair -> parseHexColor(themeValue(pair, ctx.dark))?.toColorInt() }
                ?: parseHexColor(themeValue(TIMELINE_CONNECTOR_DEFAULT_COLOR, ctx.dark))?.toColorInt()
            val connector = View(context).apply {
                setBackgroundColor(resolvedColor ?: 0xFF808080.toInt())
            }
            val connectorLp = LinearLayout.LayoutParams(
                dp(context, TIMELINE_CONNECTOR_WIDTH_DP),
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { weight = 1f }
            markColumn.addView(connector, connectorLp)
        }

        val textColumn = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        textColumn.addView(
            TextView(context).apply {
                text = ctx.label(row.labelKey, cell)
                textSize = textStyleFor(TextRole.BODY).sizeSp
            },
        )
        row.captionKey?.let { captionKey ->
            textColumn.addView(
                TextView(context).apply {
                    text = ctx.label(captionKey, cell)
                    textSize = textStyleFor(TextRole.CAPTION).sizeSp
                },
            )
        }

        val markLp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.MATCH_PARENT,
        ).apply { rightMargin = dp(context, TIMELINE_MARK_GAP_DP) }
        rowLayout.addView(markColumn, markLp)
        rowLayout.addView(textColumn)
        return rowLayout
    }

    /** [SOCIAL_PROOF_MAX_RATING] star ImageViews, the first [socialProofStarFilled]
     *  drawing the filled star glyph and the rest the distinct outline glyph
     *  (`star_border`, vendored alongside the other twelve — see
     *  res/drawable/README.md) — a filled/unfilled distinction by DRAWABLE,
     *  not alpha, so an unearned star reads as "not earned" rather than
     *  "disabled." Then the label. `rating` absent renders no stars at all —
     *  not zero filled ones. `starColor` absent falls back to
     *  [SOCIAL_PROOF_STAR_DEFAULT_COLOR], same pattern as the timeline
     *  connector. Mirrors the web renderer's `renderSocialProof`. */
    private fun buildSocialProof(
        context: Context,
        node: BuilderNode.SocialProof,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View {
        val container = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        val rating = node.rating
        if (rating != null) {
            val starsRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
            val tint = node.starColor?.let { pair -> parseHexColor(themeValue(pair, ctx.dark))?.toColorInt() }
                ?: parseHexColor(themeValue(SOCIAL_PROOF_STAR_DEFAULT_COLOR, ctx.dark))?.toColorInt()
            val size = dp(context, ICON_DEFAULT_SIZE_DP)
            for (index in 0 until SOCIAL_PROOF_MAX_RATING) {
                val filled = socialProofStarFilled(index, rating)
                val resId = drawableResFor(if (filled) SOCIAL_PROOF_STAR_ICON_NAME else SOCIAL_PROOF_STAR_BORDER_ICON_NAME)
                    ?: continue
                val iv = ImageView(context).apply {
                    setImageResource(resId)
                    scaleType = ImageView.ScaleType.FIT_CENTER
                    if (tint != null) {
                        imageTintList = android.content.res.ColorStateList.valueOf(tint)
                    }
                }
                val lp = LinearLayout.LayoutParams(size, size).apply {
                    if (index > 0) leftMargin = dp(context, SOCIAL_PROOF_STAR_GAP_DP)
                }
                starsRow.addView(iv, lp)
            }
            container.addView(
                starsRow,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { bottomMargin = dp(context, SOCIAL_PROOF_LABEL_GAP_DP) },
            )
        }
        container.addView(
            TextView(context).apply {
                text = ctx.label(node.labelKey, cell)
                textSize = textStyleFor(TextRole.BODY).sizeSp
            },
        )
        return container
    }

    /**
     * Renders `stickyFooter` reached through the ORDINARY [build] dispatch —
     * always the plain, in-flow shape (background + a vertical
     * `LinearLayout` of children), never pinned. [RovenuePaywallView.render]
     * is what gives a ROOT-level instance its pinned behaviour: it renders
     * this SAME node through this SAME function, then wraps the result in a
     * measured, non-scrolling container below the `NestedScrollView` — the
     * pinning lives entirely in that wrapper, not here. A misplaced footer
     * (anywhere but the root's last direct child) therefore renders
     * identically to this, just without the wrapper — deliberate, mirrors
     * the web/Swift renderers' `stickyFooter` doc comments. The validator's
     * `STICKY_FOOTER_NOT_AT_ROOT` warning is what tells the author about
     * that case.
     */
    internal fun buildStickyFooter(
        context: Context,
        node: BuilderNode.StickyFooter,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View {
        val container = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        // A pinned bar needs an opaque background or the content scrolls
        // visibly beneath it — absent `background` falls back to
        // STICKY_FOOTER_DEFAULT_BACKGROUND, never transparent/inherit,
        // unlike an ordinary node's colour (see buildIcon/buildDivider).
        val resolvedColor = node.background?.let { pair -> parseHexColor(themeValue(pair, ctx.dark))?.toColorInt() }
            ?: parseHexColor(themeValue(STICKY_FOOTER_DEFAULT_BACKGROUND, ctx.dark))?.toColorInt()
        container.setBackgroundColor(resolvedColor ?: 0xFFFFFFFF.toInt())
        node.children.forEach { child ->
            val childView = build(context, child, ctx, cell) ?: return@forEach
            container.addView(childView)
        }
        return container
    }

    /**
     * Renders `countdown`. Builds a dedicated [TickingCountdownRow] (not a
     * bare `TextView`) so the `Handler`-driven tick is tied to ITS OWN
     * `onAttachedToWindow`/`onDetachedFromWindow` — started when this node's
     * view enters a window, stopped when it leaves, so the handler never
     * outlives the view holding it. This mirrors the Swift renderer's
     * `.onAppear`/`.onDisappear`-scoped `Timer.publish` subscription, and
     * the same "cancel on detach" discipline [RovenuePaywallView] already
     * applies to its own `viewScope` — kept deliberately separate from
     * `purchaseScope`, which is NOT tied to the view's lifecycle; the
     * countdown tick belongs with the former, not the latter.
     *
     * The deadline is `endsAt` directly when present, else
     * `durationSeconds` anchored to [countdownFirstShownAtMillis] (a
     * PERSISTED first-show instant) — never this view's own construction
     * time, which would make the deadline restart on every open. `null`
     * when the node carries neither — falls back to
     * [BuilderNode.Countdown.fallback] else nothing, mirroring every other
     * node type's unknown/undecidable case.
     */
    internal fun buildCountdown(
        context: Context,
        node: BuilderNode.Countdown,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View? {
        val deadlineMillis = countdownDeadlineMillis(node, ctx.countdownAnchorMillis)
            ?: return node.fallback?.let { build(context, it, ctx, cell) }

        val onExpiry = node.onExpiry ?: COUNTDOWN_DEFAULT_ON_EXPIRY
        // Absent `color` never calls setTextColor, so both the label and the
        // time text inherit the ambient ink — never a substituted value
        // (this is ordinary text, unlike the footer's background).
        val resolvedColorInt = node.color?.let { pair -> parseHexColor(themeValue(pair, ctx.dark))?.toColorInt() }
        val timeView = TextView(context).apply {
            resolvedColorInt?.let { setTextColor(it) }
        }
        val row = TickingCountdownRow(context, deadlineMillis, onExpiry, timeView)
        node.labelKey?.let { key ->
            val labelView = TextView(context).apply {
                text = ctx.label(key, cell)
                resolvedColorInt?.let { setTextColor(it) }
            }
            row.addView(
                labelView,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply { rightMargin = dp(context, COUNTDOWN_LABEL_GAP_DP) },
            )
        }
        row.addView(timeView)
        row.refresh()
        return row
    }

    /**
     * Renders `carousel`. Each child renders through the ORDINARY [build]
     * dispatch (a page is any node, not only images — the same freedom
     * `stack` gives), then gets handed to a [CarouselPagerView], which owns
     * `ViewPager2` + the hand-drawn dots + the auto-advance `Handler` —
     * mirrors [buildStickyFooter]/[buildCountdown]'s split of "resolve this
     * node's own fields here, delegate the stateful/ticking part to a
     * dedicated View subclass".
     *
     * A carousel with no children (or whose every child renders nothing —
     * e.g. all hidden by `visibility`) cannot page anywhere, so it falls to
     * [BuilderNode.Carousel.fallback] else nothing, exactly like every other
     * node type's undecidable case.
     */
    internal fun buildCarousel(
        context: Context,
        node: BuilderNode.Carousel,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View? {
        val pageViews = node.children.mapNotNull { child -> build(context, child, ctx, cell) }
        if (pageViews.isEmpty()) return node.fallback?.let { build(context, it, ctx, cell) }

        val showsIndicator = node.showsIndicator ?: CAROUSEL_DEFAULT_SHOWS_INDICATOR
        val loop = node.loop ?: CAROUSEL_DEFAULT_LOOP
        // Absent `indicatorColor` inherits the ambient text ink — the same
        // "inherit" resolution buildSocialProof/buildFeatureList/buildTimeline
        // already use for an uncoloured icon tint (see
        // resolvedInkTintColorInt's own doc): a hand-drawn dot has no
        // automatic colour inheritance the way an uncoloured TextView does,
        // so "no override" must still resolve to a CONCRETE paint colour.
        // Deliberately resolved here (not read back off which branch ran) —
        // the wave-B scar on this exact platform was a resolved-colour bug
        // (the substituted value lived in a vendored drawable asset), not a
        // branch bug.
        val dotColorInt = resolvedInkTintColorInt(node.indicatorColor, ctx.dark)

        return CarouselPagerView(context, pageViews, showsIndicator, loop, node.autoAdvanceSeconds, dotColorInt)
    }
}

/**
 * The Handler-ticking row a `countdown` node builds into: a horizontal
 * `LinearLayout` of an optional label plus the live remaining-time
 * [timeView]. Ticks at [COUNTDOWN_TICK_MS] via a
 * `Handler(Looper.getMainLooper())` posted from [onAttachedToWindow] and
 * removed in [onDetachedFromWindow] — a handler outliving this view would
 * leak it. Past [deadlineMillis], [onExpiry] decides: [CountdownOnExpiry.
 * FREEZE] holds the display at `00:00` (still visible), [CountdownOnExpiry.
 * HIDE] collapses this row ([View.GONE]) instead — and stops the tick with
 * it, since a collapsed row has nothing left to redraw and a timer still
 * firing once a second against it is pure battery drain for the rest of the
 * session.
 */
private class TickingCountdownRow(
    context: Context,
    private val deadlineMillis: Long,
    private val onExpiry: CountdownOnExpiry,
    private val timeView: TextView,
) : LinearLayout(context) {
    init {
        orientation = HORIZONTAL
    }

    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    /** Latched by [refresh] the moment `onExpiry: "hide"` collapses this
     *  row. A deadline only ever recedes into the past, so this never
     *  un-latches: it is what stops the tick from being re-posted (and from
     *  being posted at all on a later re-attach) once there is nothing left
     *  to display. */
    private var hiddenOnExpiry = false

    private val tick: Runnable = object : Runnable {
        override fun run() {
            refresh()
            if (!hiddenOnExpiry) handler.postDelayed(this, COUNTDOWN_TICK_MS)
        }
    }

    fun refresh() {
        val remaining = countdownRemainingSeconds(deadlineMillis, System.currentTimeMillis())
        if (countdownHidesNow(remaining, onExpiry)) {
            visibility = GONE
            hiddenOnExpiry = true
            // Belt and braces with the tick's own re-post guard: refresh()
            // is also called directly (from buildCountdown), where no
            // Runnable is on the stack to check the flag.
            handler.removeCallbacks(tick)
            return
        }
        visibility = VISIBLE
        timeView.text = countdownText(remaining)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!hiddenOnExpiry) handler.post(tick)
    }

    override fun onDetachedFromWindow() {
        handler.removeCallbacks(tick)
        super.onDetachedFromWindow()
    }
}

/**
 * The `carousel` node's own top-level view: a vertical `LinearLayout` of a
 * `ViewPager2` (paging) plus an optional hand-drawn [CarouselDotsRow]
 * (indicator) below it, driving its own auto-advance [Handler] — posted from
 * its OWN [onAttachedToWindow] and removed in [onDetachedFromWindow], the
 * same discipline [TickingCountdownRow] applies to its tick, so a rebuild
 * (this view detaching) never leaves a stray callback running against a view
 * nothing points at any more.
 *
 * Auto-advance ticks by POSTING ONE STEP AT A TIME (`handler.postDelayed`
 * scheduled fresh after every page change), never a repeating ticker —
 * [ViewPager2.OnPageChangeCallback.onPageSelected] fires for BOTH a
 * timer-driven [advance] and a real user swipe, and reschedules from there
 * either way. That is what makes a manual swipe restart the auto-advance
 * wait rather than race a stale schedule (spec §5) — there is only one
 * rescheduling call site, not two paths that could disagree.
 *
 * `loop = false` reaching the last page latches [stoppedAtEnd] instead of
 * moving `currentItem` — since `currentItem` does not change on that step,
 * `onPageSelected` never fires to reschedule on its own, so the timer stops
 * for good rather than one dangling `postDelayed` firing once more. Mirrors
 * `TickingCountdownRow.hiddenOnExpiry` (a latch that never un-latches) and
 * the Swift renderer's `CarouselView.stoppedAtEnd`.
 */
private class CarouselPagerView(
    context: Context,
    pageViews: List<View>,
    showsIndicator: Boolean,
    private val loop: Boolean,
    private val autoAdvanceSeconds: Double?,
    dotColorInt: Int,
) : LinearLayout(context) {
    private val pageCount = pageViews.size
    private val handler = Handler(Looper.getMainLooper())

    private val viewPager = ViewPager2(context).apply {
        adapter = CarouselPageAdapter(pageViews)
    }

    // A single dot is nothing to indicate, so it is skipped even when
    // `showsIndicator` resolves true.
    private val dotsRow: CarouselDotsRow? =
        if (showsIndicator && pageCount > 1) CarouselDotsRow(context, pageCount, dotColorInt) else null

    /** Latched permanently the moment a `loop: false` carousel reaches its
     *  last page — see this class's own doc comment. Never un-latches: a
     *  deadline only ever recedes, the same invariant
     *  [TickingCountdownRow.hiddenOnExpiry] relies on. */
    private var stoppedAtEnd = false

    private val tick = Runnable { advance() }

    init {
        orientation = VERTICAL
        addView(viewPager, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        dotsRow?.let { row ->
            addView(
                row,
                LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                    gravity = Gravity.CENTER_HORIZONTAL
                    topMargin = dp(context, CAROUSEL_DOTS_TOP_MARGIN_DP)
                },
            )
        }
        viewPager.registerOnPageChangeCallback(
            object : ViewPager2.OnPageChangeCallback() {
                override fun onPageSelected(position: Int) {
                    dotsRow?.setActivePage(position)
                    scheduleNextTick()
                }
            },
        )
    }

    private fun scheduleNextTick() {
        handler.removeCallbacks(tick)
        val seconds = autoAdvanceSeconds
        // Absent `autoAdvanceSeconds` means OFF, deliberately not a default
        // interval (mirrors BuilderNode.Carousel.autoAdvanceSeconds's own
        // doc) — and a single page (or none) has nothing to advance to.
        if (seconds == null || seconds <= 0.0 || stoppedAtEnd || pageCount <= 1) return
        handler.postDelayed(tick, (seconds * MILLIS_PER_SECOND).toLong())
    }

    private fun advance() {
        val current = viewPager.currentItem
        val next = nextCarouselPage(current, pageCount, loop)
        if (next == current) {
            // loop=false at the last page: stop for good, never rewind.
            stoppedAtEnd = true
            return
        }
        viewPager.currentItem = next
        // onPageSelected (registered in init) reschedules the next tick.
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        scheduleNextTick()
    }

    override fun onDetachedFromWindow() {
        handler.removeCallbacks(tick)
        super.onDetachedFromWindow()
    }
}

private const val MILLIS_PER_SECOND = 1000.0

/**
 * The `RecyclerView.Adapter` a `carousel`'s `ViewPager2` pages through. Each
 * page was already built by the ordinary [NodeViewFactory.build] dispatch
 * (see [NodeViewFactory.buildCarousel]) — this adapter's only job is
 * attaching the right pre-built [View] into a recycled holder's container,
 * detaching it from wherever it last lived first (a [View] can only ever
 * have one parent; `ViewPager2`/`RecyclerView` re-binding an existing holder
 * without this would crash on "specified child already has a parent").
 */
private class CarouselPageAdapter(private val pages: List<View>) :
    RecyclerView.Adapter<CarouselPageAdapter.Holder>() {

    class Holder(val container: FrameLayout) : RecyclerView.ViewHolder(container)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(
            FrameLayout(parent.context).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            },
        )

    override fun getItemCount(): Int = pages.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val page = pages[position]
        (page.parent as? ViewGroup)?.removeView(page)
        holder.container.removeAllViews()
        holder.container.addView(page)
    }
}

/**
 * Hand-drawn page-indicator dots for `carousel` — `ViewPager2` supplies
 * paging but no built-in indicator. One dot per page; the active page's dot
 * draws at [CAROUSEL_DOT_ACTIVE_ALPHA], every other at
 * [CAROUSEL_DOT_INACTIVE_ALPHA], both over the SAME resolved [colorInt] (see
 * [NodeViewFactory.buildCarousel]'s doc comment for why an absent
 * `indicatorColor` still resolves to a concrete paint colour here, unlike an
 * ordinary uncoloured TextView).
 */
private class CarouselDotsRow(
    context: Context,
    private val pageCount: Int,
    private val colorInt: Int,
) : View(context) {
    private var activePage = 0
    private val dotDiameterPx = dp(context, CAROUSEL_DOT_SIZE_DP)
    private val dotGapPx = dp(context, CAROUSEL_DOT_GAP_DP)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)

    fun setActivePage(page: Int) {
        activePage = page
        invalidate()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = pageCount * dotDiameterPx + (pageCount - 1).coerceAtLeast(0) * dotGapPx
        setMeasuredDimension(width, dotDiameterPx)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val radius = dotDiameterPx / 2f
        for (index in 0 until pageCount) {
            val cx = index * (dotDiameterPx + dotGapPx) + radius
            paint.color = colorInt
            val alphaFraction = if (index == activePage) CAROUSEL_DOT_ACTIVE_ALPHA else CAROUSEL_DOT_INACTIVE_ALPHA
            paint.alpha = (alphaFraction * 255).roundToInt()
            canvas.drawCircle(cx.toFloat(), radius, radius, paint)
        }
    }
}

/** Connect/read timeouts for [loadImageInto]'s [HttpURLConnection]. */
private const val IMAGE_LOAD_CONNECT_TIMEOUT_MS = 10_000
private const val IMAGE_LOAD_READ_TIMEOUT_MS = 10_000

/**
 * Process-wide bitmap cache shared by every [loadImageInto] call. Module
 * level (not per-view) because [RovenuePaywallView] rebuilds its entire
 * view tree on every state change (see its class doc-comment), so the
 * same URL is decoded by a freshly-constructed [ImageView] on every
 * package tap — this is what turns that rebuild back into a map lookup.
 */
private val imageCache = BitmapLruCache<Bitmap>()

/**
 * Minimal, dependency-free image loader (HttpURLConnection + BitmapFactory
 * — explicitly NO Coil per the Phase-C spec's non-goals). Runs on
 * [scope]'s dispatcher; lifecycle-safe because [scope] is cancelled by
 * [RovenuePaywallView] on detach, which cancels this coroutine before it
 * ever touches the (possibly-recycled) [imageView].
 *
 * Cache-hit path returns synchronously without launching a coroutine at
 * all: the caller is a full-tree rebuild on every state change, so the
 * common case (image already fetched) must cost nothing more than a map
 * lookup, not a dispatcher hop.
 */
internal fun loadImageInto(imageView: ImageView, url: String, scope: CoroutineScope) {
    val cached = imageCache.get(url)
    if (cached != null) {
        imageView.setImageBitmap(cached)
        return
    }
    scope.launch(Dispatchers.IO) {
        val bitmap = runCatching {
            val connection = URL(url).openConnection() as HttpURLConnection
            connection.connectTimeout = IMAGE_LOAD_CONNECT_TIMEOUT_MS
            connection.readTimeout = IMAGE_LOAD_READ_TIMEOUT_MS
            connection.doInput = true
            connection.connect()
            val bytes = connection.inputStream.use { it.readBytes() }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            val options = BitmapFactory.Options().apply {
                inSampleSize = sampleSizeFor(
                    sourceWidth = bounds.outWidth,
                    sourceHeight = bounds.outHeight,
                    targetWidth = imageView.width,
                    targetHeight = imageView.height,
                )
            }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        }.getOrNull()
        if (bitmap != null) {
            imageCache.put(url, bitmap)
            withContext(Dispatchers.Main) {
                if (isActive) imageView.setImageBitmap(bitmap)
            }
        }
    }
}
