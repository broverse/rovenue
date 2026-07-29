package dev.rovenue.sdk.paywallui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.SurfaceTexture
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.ViewTreeObserver
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.MediaController
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
// Pure: node style pass (border / background / labelColor / cornerRadius,
// spec 2026-07-29). Mirrors packages/paywall-renderer/src/styles.ts's own
// pure helpers (`borderStyle`, `resolveButtonVisualStyle`) and Swift's
// `resolveBorder`/`resolveButtonVisual` in PaywallRenderSupport.swift — same
// precedence rule (custom always wins, absent leaves the base/variant
// untouched), same "skip rather than guess" leniency on an unparsable color.
// All additive: every helper below returns exactly what the pre-existing
// call sites produced when the new props are absent, which is the
// regression pin this wave requires.
// ---------------------------------------------------------------

/** A border resolved for the active color scheme. `null` when [NodeBorder]
 *  itself is absent OR its color fails to parse — mirrors [parseHexColor]'s
 *  own "skip, don't guess" contract; there is no default border to fall
 *  back to; absent means no border, today's output. */
data class ResolvedBorder(val width: Double, val color: RgbaColor)

/** Resolves a `NodeBorder?` against the active color scheme. Drawn INSIDE
 *  the node's own `cornerRadius` at every call site — this helper only
 *  resolves the color/width, the caller supplies the shared radius. */
fun resolveBorder(border: NodeBorder?, dark: Boolean): ResolvedBorder? {
    if (border == null) return null
    val rgba = parseHexColor(themeValue(border.color, dark)) ?: return null
    return ResolvedBorder(width = border.width, color = rgba)
}

/** The visual a button/purchaseButton draws before any of its own custom
 *  style props are considered. On this platform NEITHER node type has ever
 *  drawn a background/label-color/border from anything but this base — for
 *  `button` that base is "nothing" ([Button]'s stock OS chrome is left
 *  untouched below, unlike [background]/[border]), for `purchaseButton` it
 *  is the fixed accent-color chip [buildPurchaseButton] has always drawn.
 *  Passing an all-null [ButtonBaseVisual] is therefore the correct base for
 *  `button`; `purchaseButton`'s own base is assembled at its call site
 *  because it depends on `enabled`, which this pure helper has no way to
 *  know about. */
data class ButtonBaseVisual(
    val background: RgbaColor? = null,
    val labelColor: RgbaColor? = null,
    val border: ResolvedBorder? = null,
)

/** The subset of [BuilderNode.Button]/[BuilderNode.PurchaseButton] this wave
 *  added — both node payload classes carry these four fields with
 *  identical names/types, so one shape covers either caller. */
data class ButtonCustomStyleProps(
    val background: ThemePair? = null,
    val labelColor: ThemePair? = null,
    val border: NodeBorder? = null,
    val cornerRadius: Double? = null,
)

/** A button/purchaseButton's fully-resolved visual, ready to hand to the
 *  view construction below. */
data class ResolvedButtonVisual(
    val background: RgbaColor?,
    val labelColor: RgbaColor?,
    val border: ResolvedBorder?,
    val cornerRadius: Double,
)

/** `button`'s shared default corner radius for a chip that gains one for
 *  the first time because a custom style prop made it visible — mirrors the
 *  web renderer's `NODE_BUTTON_DEFAULT_CORNER_RADIUS_PX` (8) and Swift's
 *  `nodeButtonDefaultCornerRadiusPx`. `purchaseButton` does NOT use this
 *  constant: unlike `button`, it has drawn its own 12dp chip since before
 *  this wave, regardless of any new prop, and that pre-existing value is its
 *  own default (see [PURCHASE_BUTTON_DEFAULT_CORNER_RADIUS_DP]) — switching
 *  it to 8 here would violate the regression pin. */
internal const val NODE_BUTTON_DEFAULT_CORNER_RADIUS_DP = 8.0

/** `purchaseButton`'s pre-existing corner radius, unrelated to
 *  [NODE_BUTTON_DEFAULT_CORNER_RADIUS_DP] — this platform has drawn a 12dp
 *  chip here since before the node style pass, and the regression pin
 *  requires that pre-existing default survive unchanged when `cornerRadius`
 *  is absent. */
internal const val PURCHASE_BUTTON_DEFAULT_CORNER_RADIUS_DP = 12.0

/**
 * Merge a button/purchaseButton's base visual with its own optional custom
 * style props (mirrors the web renderer's `resolveButtonVisualStyle`).
 * Custom always wins; an absent custom prop leaves [base]'s own value
 * untouched — the regression pin: a node with none of the four new props
 * produces exactly [base], unchanged in `background`/`labelColor`/`border`,
 * with `cornerRadius` resolving to [defaultCornerRadius] (the caller's own
 * literal — see [NODE_BUTTON_DEFAULT_CORNER_RADIUS_DP]'s doc comment for why
 * button and purchaseButton do not share one).
 */
fun resolveButtonVisual(
    base: ButtonBaseVisual,
    custom: ButtonCustomStyleProps,
    defaultCornerRadius: Double,
    dark: Boolean,
): ResolvedButtonVisual {
    val customBackground = custom.background?.let { parseHexColor(themeValue(it, dark)) }
    val customLabelColor = custom.labelColor?.let { parseHexColor(themeValue(it, dark)) }
    return ResolvedButtonVisual(
        background = customBackground ?: base.background,
        labelColor = customLabelColor ?: base.labelColor,
        border = resolveBorder(custom.border, dark) ?: base.border,
        cornerRadius = custom.cornerRadius ?: defaultCornerRadius,
    )
}

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

// Defaults mirroring packages/shared/src/paywall/schema.ts's
// VIDEO_DEFAULT_* / LOTTIE_DEFAULT_* / LOTTIE_MIN_SPEED / LOTTIE_MAX_SPEED
// (wave D2). Keep in sync with schema.ts BY HAND; there is no codegen step
// sharing these across platforms. NOT `private` for the same reason as the
// divider/countdown/carousel defaults above — a test compares them against
// render-fixtures.json's generated `defaults` object by value, which is the
// only thing that catches schema.ts moving without this file following.
internal const val VIDEO_DEFAULT_AUTOPLAY = true
internal const val VIDEO_DEFAULT_LOOP = true

/** Muted is the default because it is the only one under which autoplay
 *  works on all three platforms (browsers refuse to autoplay with sound). */
internal const val VIDEO_DEFAULT_MUTED = true
internal const val VIDEO_DEFAULT_SHOWS_CONTROLS = false

internal const val LOTTIE_DEFAULT_LOOP = true
internal const val LOTTIE_DEFAULT_AUTOPLAY = true
internal const val LOTTIE_DEFAULT_SPEED = 1.0

/** Authoring-time advice only (schema.ts's own comment: outside this range
 *  playback reads as broken rather than stylised) — like
 *  [CAROUSEL_MIN_AUTO_ADVANCE_SECONDS] this is NOT a clamp, and the renderer
 *  hands the host player whatever `speed` it was given. Mirrored here purely
 *  so the by-value sync test covers every key schema.ts exports. */
internal const val LOTTIE_MIN_SPEED = 0.1
internal const val LOTTIE_MAX_SPEED = 4.0

/** Both volume channels at silence — what `muted: true` means to a
 *  `MediaPlayer`, which has no mute flag of its own. */
private const val MUTED_VOLUME = 0f

/** A `video`/`lottie` node's `playing` verdict before the shared visibility
 *  detector has taken its first sample. FAIL OPEN, the same direction (and
 *  for the same reason) as [NodeVisibilityDetector.isActive]'s initial value
 *  and `isNodeOnScreen`'s unmeasured branch: a node that starts paused and is
 *  never told otherwise is worse than one that starts and is told to stop. */
private const val NODE_PLAYING_BEFORE_FIRST_SAMPLE = true

/** `MediaPlayer` reports a video's natural size as 0 x 0 until the media is
 *  parsed (and for audio-only sources, forever) — the sentinel
 *  [videoEffectiveAspectRatio] reads as "no source dimensions yet". */
private const val VIDEO_SOURCE_DIMENSION_UNKNOWN_PX = 0

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

/** The width/height a `carousel` page container must carry. Plain ints, not
 *  a `ViewGroup.LayoutParams`, deliberately — see [carouselPageLayoutSize]. */
internal data class CarouselPageSize(val width: Int, val height: Int)

/**
 * The layout params EVERY `carousel` page container must be built with.
 *
 * `ViewPager2` registers `enforceChildFillListener()` on its internal
 * `RecyclerView`; that listener reads each attaching child's layout params
 * and throws
 * `IllegalStateException("Pages must fill the whole ViewPager2 (use match_parent)")`
 * unless BOTH dimensions are `MATCH_PARENT`. This is a hard library
 * invariant, not a style preference: a page holder built with anything else
 * (this one was `WRAP_CONTENT` in height) crashes the paywall the instant
 * the carousel attaches to a window.
 *
 * Hoisted out of [CarouselPageAdapter.onCreateViewHolder] as a pure function
 * so a JVM test can pin both dimensions without an Android runtime. It
 * returns plain ints rather than a constructed `ViewGroup.LayoutParams`
 * because this module compiles against the stub `android.jar` with
 * `isReturnDefaultValues = true` — a `LayoutParams` built in a unit test
 * reports 0/0, since the stub constructor has no body to store the
 * arguments.
 */
internal fun carouselPageLayoutSize(): CarouselPageSize =
    CarouselPageSize(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)

/** Height a carousel page measures to before it has been measured at all,
 *  and the floor [tallestPageHeight] reports. */
internal const val CAROUSEL_UNMEASURED_HEIGHT_PX = 0

/**
 * The height a `carousel`'s `ViewPager2` is given: the tallest of its
 * pages' measured heights (see `CarouselPagerView.onMeasure` for why the
 * carousel has to compute this itself).
 *
 * Pure so the rule — MAX of the pages, never the first page's height and
 * never their sum — is pinned without an Android runtime.
 */
internal fun tallestPageHeight(measuredPageHeights: List<Int>): Int =
    measuredPageHeights.maxOrNull()?.coerceAtLeast(CAROUSEL_UNMEASURED_HEIGHT_PX)
        ?: CAROUSEL_UNMEASURED_HEIGHT_PX

/** Width a carousel page has to lay out in when the carousel itself has no
 *  width to give it, and the floor [carouselPageMeasureWidth] reports. */
internal const val CAROUSEL_UNMEASURED_WIDTH_PX = 0

/**
 * The width `CarouselPagerView.onMeasure` measures each page at: the
 * carousel's own width-spec size LESS its horizontal padding.
 *
 * Subtracting the padding is the whole point. `MeasureSpec.getSize` reports
 * the carousel's outer width; measuring a page at that width means every
 * page is measured wider than the box it will actually be laid out in, so
 * wrapping text wraps at the wrong point and the tallest-page height comes
 * out SHORT — which crops the carousel exactly as much as the padding it
 * ignored. Clamped at [CAROUSEL_UNMEASURED_WIDTH_PX] because padding wider
 * than the carousel would otherwise ask for a negative measurement.
 */
internal fun carouselPageMeasureWidth(specWidth: Int, horizontalPadding: Int): Int =
    (specWidth - horizontalPadding).coerceAtLeast(CAROUSEL_UNMEASURED_WIDTH_PX)

/**
 * The `MeasureSpec` MODE each carousel page is measured with.
 *
 * `EXACTLY` at the computed width is right whenever the carousel HAS a
 * width. It is wrong under an `UNSPECIFIED` parent (a `HorizontalScrollView`
 * ancestor, or a `ScrollView`'s own unbounded pass), where
 * `MeasureSpec.getSize` reports 0: `EXACTLY 0` measures every page as
 * zero-wide, so every page reports zero height and the carousel collapses.
 * `UNSPECIFIED` instead lets each page report the width it wants, which is
 * the only meaningful answer when nobody has said how wide it may be.
 */
internal fun carouselPageMeasureMode(parentWidthMode: Int, pageWidth: Int): Int =
    if (parentWidthMode == View.MeasureSpec.UNSPECIFIED || pageWidth <= CAROUSEL_UNMEASURED_WIDTH_PX) {
        View.MeasureSpec.UNSPECIFIED
    } else {
        View.MeasureSpec.EXACTLY
    }

/** Fully-opaque alpha on Android's 0..255 channel scale. */
private const val OPAQUE_ALPHA_255 = 255

/** Everything `CarouselDotsRow` needs to paint one dot: the resolved paint
 *  colour plus the two alphas, already on Android's 0..255 channel scale. */
internal data class CarouselDotSpec(
    val colorInt: Int,
    val activeAlpha255: Int,
    val inactiveAlpha255: Int,
)

/**
 * How a `carousel`'s hand-drawn indicator dots paint, resolved from the
 * node itself.
 *
 * An absent `indicatorColor` inherits the ambient text ink — the same
 * "inherit" resolution an uncoloured icon tint uses (see
 * [resolvedInkTintColorInt]'s own doc). A hand-drawn dot has no automatic
 * colour inheritance the way an uncoloured `TextView` does, so "no
 * override" must still resolve to a CONCRETE paint colour.
 *
 * This takes the whole [BuilderNode.Carousel] rather than a pre-resolved
 * colour on purpose: the wave-B scar on this exact platform was a *correct
 * branch feeding a wrong value downstream*, so the thing worth pinning is
 * "the node's own `indicatorColor` field ends up as the paint colour", not
 * "some resolution function returns the right answer". `buildCarousel`
 * therefore does no colour arithmetic of its own — it calls this and hands
 * the result straight to the row that paints it.
 */
internal fun carouselDotSpec(node: BuilderNode.Carousel, dark: Boolean): CarouselDotSpec =
    CarouselDotSpec(
        colorInt = resolvedInkTintColorInt(node.indicatorColor, dark),
        activeAlpha255 = (CAROUSEL_DOT_ACTIVE_ALPHA * OPAQUE_ALPHA_255).roundToInt(),
        inactiveAlpha255 = (CAROUSEL_DOT_INACTIVE_ALPHA * OPAQUE_ALPHA_255).roundToInt(),
    )

// ---------------------------------------------------------------
// Pure: video / lottie (wave D2)
// ---------------------------------------------------------------

/**
 * What to do with a `video`'s player right now.
 *
 * THREE states, not two, and the third is the point: [LEAVE_ALONE] is what
 * keeps a NON-autoplay clip the reader started by hand from being restarted
 * by every scroll frame that reports it visible. Pausing, by contrast, is
 * unconditional the moment the node stops running — that half of the rule
 * holds for a clip the reader started as much as for one that started itself,
 * because the audible half of "off-screen means paused" is what a reader
 * actually notices. A boolean cannot express this, which is why neither the
 * web (`VIDEO_PLAYBACK_COMMAND` in nodes.tsx) nor the iOS sibling
 * (`VideoPlaybackCommand` in RovenuePaywallView.swift) uses one.
 */
internal enum class VideoPlaybackCommand { PLAY, PAUSE, LEAVE_ALONE }

/**
 * The single playback rule a `video` obeys, a pure free function for exactly
 * the reason [carouselAutoAdvanceDelayMillis] and [countdownTickShouldRun]
 * are: the rule is testable here, while the `MediaPlayer` it drives is not.
 *
 * [active] is the SHARED verdict from [NodeVisibilityDetector] — the very one
 * `countdown` and `carousel` already consume, so this wave adds a third
 * consumer rather than a third copy of "when is this node on screen".
 *
 * [autoplay] is the author's standing instruction and is HONOURED on all
 * three platforms: a node that said `autoplay: false` is never STARTED by
 * scrolling into view.
 */
internal fun videoPlaybackCommand(active: Boolean, autoplay: Boolean): VideoPlaybackCommand = when {
    !active -> VideoPlaybackCommand.PAUSE
    autoplay -> VideoPlaybackCommand.PLAY
    else -> VideoPlaybackCommand.LEAVE_ALONE
}

/**
 * Whether a `video`'s theme-resolved source is USABLE — the only half of "will
 * this draw?" that is knowable BEFORE a player exists, and so the only half a
 * carousel counting its pages can act on (see [NodeViewFactory.buildVideo]).
 * Mirrors the Swift sibling's `videoHasUsableSource` and web's
 * `videoHasUsableSource`.
 *
 * Delegates to [mediaSourceIsUsable] — the same rule [lottieHasUsableSource]
 * uses, because "is this playable at all?" is one question, not two answered by
 * coincidence.
 */
internal fun videoHasUsableSource(url: ThemePair, dark: Boolean): Boolean =
    mediaSourceIsUsable(url, dark)

/**
 * The ratio a `video` should be laid out at, or `null` for "apply no ratio at
 * all".
 *
 * An ABSENT [authored] ratio does NOT substitute a number — it defers to the
 * source's own dimensions, which `MediaPlayer` only reports once it has
 * parsed the media ([VIDEO_SOURCE_DIMENSION_UNKNOWN_PX] until then). Until
 * both are known there is genuinely no ratio to apply, and the node measures
 * like any other unmeasured view rather than being forced into a guess. Same
 * contract as the Swift sibling's `ratioedSurface` (no `.aspectRatio`
 * modifier at all) and the web sibling's `videoStyle` (no `aspect-ratio`
 * property at all).
 */
internal fun videoEffectiveAspectRatio(
    authored: Double?,
    sourceWidthPx: Int,
    sourceHeightPx: Int,
): Double? {
    if (authored != null && authored > 0.0) return authored
    if (sourceWidthPx <= VIDEO_SOURCE_DIMENSION_UNKNOWN_PX ||
        sourceHeightPx <= VIDEO_SOURCE_DIMENSION_UNKNOWN_PX
    ) {
        return null
    }
    return sourceWidthPx.toDouble() / sourceHeightPx.toDouble()
}

/** The height, in px, that [widthPx] implies at [aspectRatio] (width ÷
 *  height). Split out from the measure pass so the arithmetic is pinned by a
 *  unit test rather than only by looking at a device. */
internal fun videoHeightForAspectRatio(widthPx: Int, aspectRatio: Double): Int =
    (widthPx / aspectRatio).roundToInt()

/** No scaling at all along an axis — the picture already fills the view on
 *  that axis, which is a `TextureView`'s own untransformed behaviour. */
private const val VIDEO_SURFACE_SCALE_NONE = 1.0f

/** The pivot the fit-inside scale is applied about, as a fraction of the
 *  view's size: the CENTRE, so the letterbox bars are equal on both sides
 *  rather than all on one. */
private const val VIDEO_SURFACE_CENTER_FRACTION = 0.5f

/**
 * How the picture must be scaled inside a `video` node's box so that it
 * LETTERBOXES instead of stretching, or `null` when there is not yet enough
 * information to say (the view is unmeasured, or `MediaPlayer` has not
 * reported the source's natural size).
 *
 * WHY THIS EXISTS AT ALL. A `TextureView` scales its `SurfaceTexture` to its
 * own bounds, so with no transform the picture is DISTORTED whenever the box
 * it sits in has a different shape from the source — which is exactly what an
 * authored `aspectRatio` does. Both sibling renderers letterbox instead: web
 * gets `object-fit: contain` (the default for `<video>`), iOS uses
 * `AVLayerVideoGravity.resizeAspect`. A stretched face is worse than black
 * bars on its own merits, and disagreeing with the other two about it is a
 * visible cross-platform divergence, so Android matches them here.
 *
 * The returned factors are relative to that stretched-to-bounds default, which
 * is why the axis that already fits is [VIDEO_SURFACE_SCALE_NONE] and only the
 * over-filled axis shrinks. An authored ratio that MATCHES the source's own
 * therefore returns 1 x 1 and changes nothing, and so does an absent authored
 * ratio (the box is measured at the source's ratio in that case) — this is
 * only ever a correction, never a resize.
 *
 * Pure, and separate from the `Matrix` that carries it, so the arithmetic is
 * pinned by unit tests; `Matrix` and `TextureView` are both inert under this
 * module's stub `android.jar`.
 */
internal fun videoSurfaceFitScale(
    viewWidthPx: Int,
    viewHeightPx: Int,
    sourceWidthPx: Int,
    sourceHeightPx: Int,
): VideoSurfaceScale? {
    if (viewWidthPx <= UNMEASURED_VIEW_DIMENSION_PX || viewHeightPx <= UNMEASURED_VIEW_DIMENSION_PX) return null
    if (sourceWidthPx <= VIDEO_SOURCE_DIMENSION_UNKNOWN_PX ||
        sourceHeightPx <= VIDEO_SOURCE_DIMENSION_UNKNOWN_PX
    ) {
        return null
    }
    val viewRatio = viewWidthPx.toDouble() / viewHeightPx.toDouble()
    val sourceRatio = sourceWidthPx.toDouble() / sourceHeightPx.toDouble()
    return if (sourceRatio > viewRatio) {
        // Source is the wider shape: it keeps the full width and gives up
        // height, leaving bars above and below.
        VideoSurfaceScale(scaleX = VIDEO_SURFACE_SCALE_NONE, scaleY = (viewRatio / sourceRatio).toFloat())
    } else {
        // Source is the taller shape (or the same): full height, bars at the
        // sides.
        VideoSurfaceScale(scaleX = (sourceRatio / viewRatio).toFloat(), scaleY = VIDEO_SURFACE_SCALE_NONE)
    }
}

/** The two axis factors [videoSurfaceFitScale] resolves to. A value type
 *  rather than a `Pair` so neither call site nor test can silently swap the
 *  axes. */
internal data class VideoSurfaceScale(val scaleX: Float, val scaleY: Float)

/**
 * Everything a host's Lottie player needs for one `lottie` node.
 *
 * These FIVE fields are the cross-platform contract, byte-for-byte the props
 * of packages/paywall-renderer's `LottieRenderer` and the fields of the Swift
 * SDK's `LottieRenderRequest`. [playing] rides the SHARED visibility signal
 * (NodeVisibility.kt) that `countdown`, `carousel` and `video` all consume,
 * so a host player that honours it pauses off screen for free.
 *
 * A `data class` so a test can pin the RESOLVED request by value — which
 * defaults were substituted, and which theme half of `url` won — rather than
 * merely that some request arrived.
 */
data class LottieRenderRequest(
    val url: String,
    val loop: Boolean,
    val autoplay: Boolean,
    val speed: Double,
    /** The moment-to-moment "on screen AND app in front" verdict, NOT the
     *  same question as [autoplay] (the author's standing instruction). */
    val playing: Boolean,
)

/**
 * A host's Lottie player: one request in, one `View` out. Returning `null` is
 * a legitimate "I cannot draw this", and routes the node onto the ordinary
 * `fallback`-else-nothing path.
 *
 * This SDK ships NO Lottie runtime of its own — no `com.airbnb.android:lottie`
 * in build.gradle.kts, and this wave adds none. The host app registers
 * whichever player it already ships, once, at startup.
 */
fun interface LottieRenderer {
    fun createView(context: Context, request: LottieRenderRequest): View?
}

/**
 * PROCESS-LEVEL state, deliberately: the host registers its player once, well
 * before any paywall is presented, so this is not per-view configuration.
 *
 * Which also means it LEAKS ACROSS TESTS — every test that registers a
 * renderer must reset it (`registerLottieRenderer(null)`) in a teardown, the
 * same warning the web and Swift siblings carry on their own registries.
 */
private object LottieRendererRegistry {
    var current: LottieRenderer? = null
}

/** Register (or, with `null`, unregister) the host's Lottie player. */
fun registerLottieRenderer(render: LottieRenderer?) {
    LottieRendererRegistry.current = render
}

/**
 * The resolved request for [node]. Pure, and separate from [lottieViewOrNull]
 * below, so the DEFAULT RESOLUTION (`loop`/`autoplay`/`speed` falling back to
 * the mirrored schema.ts constants, and which theme half of `url` wins) is
 * testable without registering anything.
 */
internal fun lottieRenderRequest(
    node: BuilderNode.Lottie,
    playing: Boolean,
    dark: Boolean,
): LottieRenderRequest = LottieRenderRequest(
    url = themeValue(node.url, dark),
    loop = node.loop ?: LOTTIE_DEFAULT_LOOP,
    autoplay = node.autoplay ?: LOTTIE_DEFAULT_AUTOPLAY,
    speed = node.speed ?: LOTTIE_DEFAULT_SPEED,
    playing = playing,
)

/**
 * What a `lottie` node draws right now, or `null` when it draws nothing —
 * nothing registered, or a registered player that declined. `null` is what
 * routes the node onto the ordinary `fallback`-else-nothing path in
 * [NodeViewFactory.buildLottie]; this function deliberately does not know
 * about `fallback` itself, so the one place that decides "fall back" stays
 * the one place every other node type uses.
 *
 * Decidable SYNCHRONOUSLY (registration is process state and the request is
 * already in hand), unlike a video's load failure — see [buildLottie].
 */
internal fun lottieViewOrNull(context: Context, request: LottieRenderRequest): View? =
    LottieRendererRegistry.current?.createView(context, request)

/**
 * Whether a `lottie`'s theme-resolved source is USABLE — the second half of
 * "will this draw?", alongside "did the host register a player?", and knowable
 * at the same synchronous, pre-mount moment. Mirrors iOS's `lottieCanRender`
 * (`RovenuePaywallLottie.swift`) and the web sibling, and follows the same
 * shape `video` already uses here ([videoHasUsableSource]).
 *
 * THE BLANK URL IS THE DEFAULT STATE, not an edge case: `newNode("lottie")`
 * creates `url: { light: "" }`, so every freshly added lottie in the builder is
 * in exactly this state until a URL is pasted. Handing `""` to a registered
 * host player and leaving it to discover the problem is not a contract worth
 * shipping — an absent source means the node cannot render, so it takes the
 * same path an unregistered player takes: `fallback`, else nothing.
 *
 * RELATIVE AND EVEN MALFORMED SOURCES ARE USABLE, deliberately — delegates to
 * [mediaSourceIsUsable], the same rule [videoHasUsableSource] uses. A player
 * handed a string it cannot load fails at load time, which is the ordinary
 * error path; only an ABSENT source is unrecoverable.
 */
internal fun lottieHasUsableSource(url: ThemePair, dark: Boolean): Boolean =
    mediaSourceIsUsable(url, dark)

/**
 * THE RULE, identical on Android, web and iOS: a media source is USABLE when
 * it is non-blank after trimming leading and trailing whitespace. Nothing
 * more. There is deliberately NO syntactic URL validation here.
 *
 * Why no URL parsing: validating URL *syntax* is the platform's job at LOAD
 * time — a malformed URL simply fails to load and takes the existing error
 * path to `fallback`. What this pre-mount check exists for is the one case a
 * renderer cannot recover from: a source that is ABSENT, which is exactly the
 * builder's `newNode` default (`url: { light: "" }`) and its whitespace
 * cousins, so every freshly added media node is in this state until a URL is
 * pasted.
 *
 * Why not "whatever a URL parser says": the three platforms' parsers do not
 * agree and never will. This function used to run `java.net.URI`, which
 * rejects `"not a url"` and `"://x"`; iOS's `URL(string:)` accepts both, plus
 * `" "`; the browser's WHATWG parser accepts two of the three. That left a
 * whitespace-only source taking a phantom carousel page and dot on iOS alone.
 * Worse, iOS's own answer is OS-version dependent (CFURL before iOS 17, an
 * RFC-3986 parser after), so a rule pinned to parser agreement drifts on its
 * own. A rule WE define is stable; a rule three URL parsers happen to share is
 * not. This is a RELAXATION on Android: a present-but-malformed source now
 * mounts and fails at load, exactly as a valid-but-404 one always did.
 *
 * [videoHasUsableSource] and [lottieHasUsableSource] both delegate here — one
 * predicate, not two that happen to agree. The inputs `""`, `" "`,
 * `"a/b.mp4"`, `"not a url"` and `"https://x/a.mp4"` are asserted against this
 * function in `NodeViewFactoryTest.kt`, and against its two siblings in
 * `renderer.test.tsx` and `PaywallMediaSourceTests.swift` — the same inputs
 * with the same answers, so the agreement is pinned rather than assumed.
 */
internal fun mediaSourceIsUsable(url: ThemePair, dark: Boolean): Boolean =
    mediaSourceIsUsable(themeValue(url, dark))

/**
 * The rule itself, over one already theme-resolved string. Split out from the
 * [ThemePair] overload above so the contract table can exercise the rule
 * directly, with no theme resolution in the way.
 *
 * Kotlin's [String.trim] removes every character [Char.isWhitespace] accepts,
 * which covers newlines — matching JavaScript's `String.prototype.trim` and
 * Swift's `.whitespacesAndNewlines`, so a source containing only a newline
 * gets the same answer on all three platforms.
 */
internal fun mediaSourceIsUsable(rawSource: String): Boolean =
    rawSource.trim() != BLANK_MEDIA_SOURCE

/**
 * The one source string that is NOT usable: nothing left after trimming.
 * Named so [mediaSourceIsUsable] reads as the rule it implements rather than
 * as an incidental comparison against a bare literal.
 */
internal const val BLANK_MEDIA_SOURCE = ""

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
            is BuilderNode.Video -> buildVideo(context, resolved, ctx, cell)
            is BuilderNode.Lottie -> buildLottie(context, resolved, ctx, cell)
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

        if (node.background != null || node.cornerRadius != null || node.border != null) {
            group.background = GradientDrawable().apply {
                cornerRadius = dp(context, node.cornerRadius ?: 0.0).toFloat()
                val color = node.background?.let { parseHexColor(themeValue(it, ctx.dark))?.toColorInt() }
                setColor(color ?: 0x00000000)
                // Drawn INSIDE the same cornerRadius the fill above uses —
                // absent `border` (or an unparsable color) draws nothing,
                // today's output.
                resolveBorder(node.border, ctx.dark)?.let { border ->
                    setStroke(dp(context, border.width), border.color.toColorInt())
                }
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
            // Badge/chip fill (spec 2026-07-29): absent background AND
            // absent cornerRadius leave `background` untouched (today's
            // output, byte-identical).
            if (node.background != null || node.cornerRadius != null) {
                background = GradientDrawable().apply {
                    cornerRadius = dp(context, node.cornerRadius ?: 0.0).toFloat()
                    val color = node.background?.let { parseHexColor(themeValue(it, ctx.dark))?.toColorInt() }
                    setColor(color ?: 0x00000000)
                }
            }
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
        // Drawn INSIDE the same cornerRadius the image itself is clipped to
        // (foreground draws on top of the bitmap, unlike `background`) —
        // absent `border` (or an unparsable color) draws nothing, today's
        // output.
        resolveBorder(node.border, ctx.dark)?.let { border ->
            iv.foreground = GradientDrawable().apply {
                cornerRadius = dp(context, node.cornerRadius ?: 0.0).toFloat()
                setColor(0x00000000)
                setStroke(dp(context, border.width), border.color.toColorInt())
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
        // Node style pass (spec 2026-07-29): `button`'s `style` variant has
        // never drawn a background/label-color/border of its own on this
        // platform (only typeface weight + opacity, below) — the ONLY
        // source of a background/border/custom label color is the node's
        // own new props, so an absent-everything node leaves the stock
        // Button chrome completely untouched (the regression pin).
        val hasCustomVisual = node.background != null || node.labelColor != null ||
            node.border != null || node.cornerRadius != null
        return Button(context).apply {
            text = ctx.label(node.labelKey, cell)
            isAllCaps = false
            setTypeface(typeface, if (node.style == ButtonVisualStyle.PRIMARY) Typeface.BOLD else Typeface.NORMAL)
            alpha = if (node.style == ButtonVisualStyle.PLAIN) 0.7f else 1f
            if (hasCustomVisual) {
                val visual = resolveButtonVisual(
                    base = ButtonBaseVisual(),
                    custom = ButtonCustomStyleProps(
                        background = node.background, labelColor = node.labelColor,
                        border = node.border, cornerRadius = node.cornerRadius,
                    ),
                    defaultCornerRadius = NODE_BUTTON_DEFAULT_CORNER_RADIUS_DP,
                    dark = ctx.dark,
                )
                background = GradientDrawable().apply {
                    cornerRadius = dp(context, visual.cornerRadius).toFloat()
                    setColor(visual.background?.toColorInt() ?: 0x00000000)
                    visual.border?.let { border -> setStroke(dp(context, border.width), border.color.toColorInt()) }
                }
                visual.labelColor?.let { setTextColor(it.toColorInt()) }
            }
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
        // Node style pass (spec 2026-07-29): the fixed accent-color/12dp chip
        // below has always been this node's OWN base visual (unlike
        // `button`, which draws nothing of its own) — passing an all-null
        // [ButtonBaseVisual] here and falling back to the pre-existing
        // literals at each field below is what keeps an absent-everything
        // node byte-identical to today's output.
        val visual = resolveButtonVisual(
            base = ButtonBaseVisual(),
            custom = ButtonCustomStyleProps(
                background = node.background, labelColor = node.labelColor,
                border = node.border, cornerRadius = node.cornerRadius,
            ),
            defaultCornerRadius = PURCHASE_BUTTON_DEFAULT_CORNER_RADIUS_DP,
            dark = ctx.dark,
        )
        return Button(context).apply {
            text = ctx.label(resolvedLabelKey, null)
            isAllCaps = false
            isEnabled = enabled
            setTypeface(typeface, Typeface.BOLD)
            // The disabled-state dim has ALWAYS applied to the background
            // fill only (never the label) — preserved here by dimming
            // whichever fill wins (custom or the accent-color base), not
            // the label color, which is set (if at all) below.
            background = GradientDrawable().apply {
                cornerRadius = dp(context, visual.cornerRadius).toFloat()
                setColor(visual.background?.toColorInt() ?: ACCENT_COLOR)
                alpha = if (enabled) 255 else 102 // ~0.4 opacity, mirrors the SwiftUI renderer
                visual.border?.let { border -> setStroke(dp(context, border.width), border.color.toColorInt()) }
            }
            visual.labelColor?.let { setTextColor(it.toColorInt()) }
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
        // All of the dot-painting decisions (including how an absent
        // `indicatorColor` resolves) live in the pure carouselDotSpec, which
        // is pinned by value in NodeViewFactoryTest. This call site is
        // deliberately arithmetic-free so there is nothing here left to get
        // wrong between the node and the paint.
        val dotSpec = carouselDotSpec(node, ctx.dark)

        return CarouselPagerView(context, pageViews, showsIndicator, loop, node.autoAdvanceSeconds, dotSpec)
    }

    /**
     * Renders `video`.
     *
     * Split the same way the Swift sibling is: this function answers the one
     * question that IS decidable before a player exists — is a source present
     * at all? — and falls back otherwise, mirroring every other node type's
     * "cannot draw this" contract. Everything past that point needs the
     * `MediaPlayer`, and lives in [VideoNodeView].
     *
     * KNOWN CROSS-PLATFORM GAP, shared with web and iOS and now an ACCEPTED
     * LIMIT rather than an open question: a load failure arrives
     * ASYNCHRONOUSLY, so a video that fails AFTER mount cannot retract the
     * page it already occupies in a `carousel` — the carousel counted its
     * pages synchronously, above. Spec §3.3 records it, and the validator's
     * `VIDEO_IN_CAROUSEL_NO_FALLBACK` is what warns the author. Closing it
     * needs a page list that can shrink after mount, which would be a
     * three-platform change, not an Android one. A video with NO source
     * (checked right here) is handled correctly, because this returns `null`
     * when there is no fallback and `mapNotNull` drops it.
     */
    internal fun buildVideo(
        context: Context,
        node: BuilderNode.Video,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View? {
        if (!videoHasUsableSource(node.url, ctx.dark)) {
            return node.fallback?.let { build(context, it, ctx, cell) }
        }
        val poster = node.posterUrl?.let { pair ->
            ImageView(context).apply {
                scaleType = ImageView.ScaleType.FIT_CENTER
                adjustViewBounds = true
            }.also { view -> ctx.loadImage(view, themeValue(pair, ctx.dark)) }
        }
        return VideoNodeView(
            context = context,
            sourceUrl = themeValue(node.url, ctx.dark),
            autoplay = node.autoplay ?: VIDEO_DEFAULT_AUTOPLAY,
            loop = node.loop ?: VIDEO_DEFAULT_LOOP,
            muted = node.muted ?: VIDEO_DEFAULT_MUTED,
            showsControls = node.showsControls ?: VIDEO_DEFAULT_SHOWS_CONTROLS,
            authoredAspectRatio = node.aspectRatio,
            poster = poster,
            buildFallback = { node.fallback?.let { build(context, it, ctx, cell) } },
        )
    }

    /**
     * Renders `lottie` by handing a [LottieRenderRequest] to whatever player
     * the host registered. With no source, with nothing registered, or with a
     * registered player that declines, this draws `fallback`, else nothing —
     * the machinery every node type already has rather than a new failure
     * mode.
     *
     * THE SOURCE IS CHECKED BEFORE THE REGISTRY IS CONSULTED
     * ([lottieHasUsableSource]), so a registered player is never handed a
     * blank string to fail on — the same order iOS uses, and the same question
     * [buildVideo] asks of its own source.
     *
     * Unlike [buildVideo], that decision is made HERE, synchronously, so a
     * `lottie` inside a `carousel` never costs a phantom dot: registration is
     * process state and the source is already in hand.
     *
     * The first request is issued with [NODE_PLAYING_BEFORE_FIRST_SAMPLE]
     * because that is what the detector's own pre-sample answer is; the view
     * re-issues it whenever the verdict actually flips.
     */
    internal fun buildLottie(
        context: Context,
        node: BuilderNode.Lottie,
        ctx: PaywallRenderContext,
        cell: CellScope?,
    ): View? {
        if (!lottieHasUsableSource(node.url, ctx.dark)) {
            return node.fallback?.let { build(context, it, ctx, cell) }
        }
        val initialRequest = lottieRenderRequest(node, NODE_PLAYING_BEFORE_FIRST_SAMPLE, ctx.dark)
        val initialContent = lottieViewOrNull(context, initialRequest)
            ?: return node.fallback?.let { build(context, it, ctx, cell) }
        return LottieNodeView(context, node, ctx.dark, initialContent)
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
 *
 * On top of that, the tick obeys the renderer-wide rule every time-driven
 * node obeys — [NodeVisibilityDetector]: it runs only while this row is on
 * screen and the app is in front. [onDetachedFromWindow] cannot see either of
 * those (a row scrolled out of the viewport is still attached, and so is one
 * in a backgrounded app), which is why the detector exists alongside the
 * handler teardown rather than instead of it.
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
            if (countdownTickShouldRun(visibilityDetector.isActive, hiddenOnExpiry)) {
                handler.postDelayed(this, COUNTDOWN_TICK_MS)
            }
        }
    }

    /** Started and stopped by [onAttachedToWindow]/[onDetachedFromWindow];
     *  flips the tick on and off in between as this row scrolls in and out of
     *  the viewport or the app leaves the foreground. */
    private val visibilityDetector = NodeVisibilityDetector(this) { active ->
        handler.removeCallbacks(tick)
        if (countdownTickShouldRun(active, hiddenOnExpiry)) handler.post(tick)
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
        // Deliberately no direct post: start() takes its first sample
        // synchronously and posts the tick through the callback above if this
        // row is actually visible. Attaching off-screen must not start a timer.
        visibilityDetector.start()
    }

    override fun onDetachedFromWindow() {
        visibilityDetector.stop()
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
    private val pageViews: List<View>,
    showsIndicator: Boolean,
    private val loop: Boolean,
    private val autoAdvanceSeconds: Double?,
    dotSpec: CarouselDotSpec,
) : LinearLayout(context) {
    private val pageCount = pageViews.size
    private val handler = Handler(Looper.getMainLooper())

    private val viewPager = ViewPager2(context).apply {
        adapter = CarouselPageAdapter(pageViews)
    }

    // A single dot is nothing to indicate, so it is skipped even when
    // `showsIndicator` resolves true.
    private val dotsRow: CarouselDotsRow? =
        if (showsIndicator && pageCount > 1) CarouselDotsRow(context, pageCount, dotSpec) else null

    /** Latched permanently the moment a `loop: false` carousel reaches its
     *  last page — see this class's own doc comment. Never un-latches: a
     *  deadline only ever recedes, the same invariant
     *  [TickingCountdownRow.hiddenOnExpiry] relies on. */
    private var stoppedAtEnd = false

    private val tick = Runnable { advance() }

    /**
     * Spec §5 rule 1 — "off-screen means paused" — for the two cases
     * [onDetachedFromWindow] cannot see: this carousel scrolling out of the
     * viewport while still attached, and the app going to the background.
     *
     * A backgrounded app's main looper keeps delivering messages, so a bare
     * `postDelayed` chain keeps advancing pages while the user is somewhere
     * else entirely, and CHANGES THE PAGE THEY COME BACK TO. (iOS gets this
     * for free from run-loop suspension; Android does not.) The same is true
     * of a carousel scrolled far below the fold. The web renderer pauses on
     * `IntersectionObserver` + `visibilitychange`; this is the Android
     * equivalent, and it is the SHARED [NodeVisibilityDetector] rather than
     * anything carousel-specific — the countdown row uses the same one.
     *
     * The auto-advance schedule is started ONLY from here, never directly
     * from [onAttachedToWindow]: [NodeVisibilityDetector.start] takes its
     * first sample synchronously, so attaching while visible and foregrounded
     * schedules through this callback, and attaching off-screen or
     * backgrounded correctly schedules nothing — which a direct call in
     * [onAttachedToWindow] would have defeated.
     */
    private val visibilityDetector = NodeVisibilityDetector(this) { active ->
        if (active) scheduleNextTick() else handler.removeCallbacks(tick)
    }

    init {
        orientation = VERTICAL
        // Height starts at "not measured yet" and is filled in by onMeasure
        // below, which is the only thing that ever sets it. A WRAP_CONTENT
        // ViewPager2 measures to zero (its pages are required to be
        // MATCH_PARENT, so there is nothing for it to wrap), and the
        // carousel would simply not appear.
        addView(viewPager, LayoutParams(LayoutParams.MATCH_PARENT, CAROUSEL_UNMEASURED_HEIGHT_PX))
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

    /**
     * Gives the `ViewPager2` an explicit height equal to its tallest page,
     * then measures normally.
     *
     * WHY THIS EXISTS — do not "simplify" it back to `WRAP_CONTENT`.
     * `ViewPager2` requires every page to be `MATCH_PARENT` x `MATCH_PARENT`
     * (see [carouselPageLayoutSize]: it throws otherwise), which makes a
     * `WRAP_CONTENT` pager circular — the pages size to the pager, the pager
     * has nothing to size to, and the whole carousel collapses to zero
     * height. `ViewPager2` does NOT size itself to its tallest page, and it
     * is `final`, so its `onMeasure` cannot be overridden to make it.
     *
     * The one view in the chain we DO own is this `LinearLayout`, so it does
     * the max-of-pages pass itself: measure every page at the carousel's own
     * width with an unbounded height, take the tallest, hand that to the
     * pager. Chosen over an explicit authored height because `carousel` has
     * no height prop in the shared schema and pages are arbitrary nodes —
     * a fixed height would clip or pad every carousel that is not exactly
     * that tall. The cost is measuring off-screen pages too; a carousel is a
     * handful of pages, and it means paging between them never resizes.
     *
     * The height is written into the EXISTING `LayoutParams` instance rather
     * than assigned as a new one: assigning `layoutParams` calls
     * `requestLayout()`, and calling that from inside a measure pass is how
     * measure loops are born. `super.onMeasure` re-measures children after
     * this, so it picks the new height up.
     */
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val tallest = tallestPageHeight(measurePagesForHeight(widthMeasureSpec))
        val params = viewPager.layoutParams
        if (tallest > CAROUSEL_UNMEASURED_HEIGHT_PX && params.height != tallest) params.height = tallest
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    /** Measures every page at the carousel's own width with an unbounded
     *  height and returns the measured heights, for [tallestPageHeight].
     *  These measurements are transient — `RecyclerView` re-measures each
     *  page it lays out with its own exact specs. */
    private fun measurePagesForHeight(widthMeasureSpec: Int): List<Int> {
        val pageWidth = carouselPageMeasureWidth(
            specWidth = MeasureSpec.getSize(widthMeasureSpec),
            horizontalPadding = paddingLeft + paddingRight,
        )
        val pageWidthSpec = MeasureSpec.makeMeasureSpec(
            pageWidth,
            carouselPageMeasureMode(MeasureSpec.getMode(widthMeasureSpec), pageWidth),
        )
        val pageHeightSpec =
            MeasureSpec.makeMeasureSpec(CAROUSEL_UNMEASURED_HEIGHT_PX, MeasureSpec.UNSPECIFIED)
        return pageViews.map { page ->
            page.measure(pageWidthSpec, pageHeightSpec)
            page.measuredHeight
        }
    }

    /**
     * The single rescheduling call site. Every reason NOT to schedule —
     * paused, latched at the end, no positive interval, nothing to advance to
     * — lives in [carouselAutoAdvanceDelayMillis], where it is unit-testable;
     * this reads the detector's current answer rather than keeping a second
     * copy of the visibility state.
     */
    private fun scheduleNextTick() {
        handler.removeCallbacks(tick)
        val delayMillis = carouselAutoAdvanceDelayMillis(
            active = visibilityDetector.isActive,
            stoppedAtEnd = stoppedAtEnd,
            autoAdvanceSeconds = autoAdvanceSeconds,
            pageCount = pageCount,
        ) ?: return
        handler.postDelayed(tick, delayMillis)
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
        // Deliberately no scheduleNextTick() here — see [visibilityDetector]'s doc for
        // why the schedule starts from the detector callback instead. The
        // fail-soft handling of an app with no ProcessLifecycleOwner (and of a
        // node with no measurable size yet) lives in NodeVisibilityDetector.
        visibilityDetector.start()
    }

    override fun onDetachedFromWindow() {
        visibilityDetector.stop()
        handler.removeCallbacks(tick)
        super.onDetachedFromWindow()
    }
}

/**
 * The `RecyclerView.Adapter` a `carousel`'s `ViewPager2` pages through. Each
 * page was already built by the ordinary [NodeViewFactory.build] dispatch
 * (see [NodeViewFactory.buildCarousel]) — this adapter's only job is
 * attaching the right pre-built [View] into a recycled holder's container,
 * detaching it from wherever it last lived first (a [View] can only ever
 * have one parent; `ViewPager2`/`RecyclerView` re-binding an existing holder
 * without this would crash on "specified child already has a parent").
 */
internal class CarouselPageAdapter(private val pages: List<View>) :
    RecyclerView.Adapter<CarouselPageAdapter.Holder>() {

    class Holder(val container: FrameLayout) : RecyclerView.ViewHolder(container)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        // MATCH_PARENT in BOTH dimensions is a ViewPager2 requirement, not a
        // preference — see carouselPageLayoutSize, which is where the
        // dimensions live and where they are pinned by a test.
        val size = carouselPageLayoutSize()
        return Holder(
            FrameLayout(parent.context).apply {
                layoutParams = ViewGroup.LayoutParams(size.width, size.height)
            },
        )
    }

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
 * draws at [CarouselDotSpec.activeAlpha255], every other at
 * [CarouselDotSpec.inactiveAlpha255], both over the SAME
 * [CarouselDotSpec.colorInt]. This class makes no colour decisions of its
 * own — [carouselDotSpec] made all of them, and is where they are tested
 * (including why an absent `indicatorColor` still resolves to a concrete
 * paint colour here, unlike an ordinary uncoloured TextView).
 */
private class CarouselDotsRow(
    context: Context,
    private val pageCount: Int,
    private val spec: CarouselDotSpec,
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
            paint.color = spec.colorInt
            paint.alpha = if (index == activePage) spec.activeAlpha255 else spec.inactiveAlpha255
            canvas.drawCircle(cx.toFloat(), radius, radius, paint)
        }
    }
}

/**
 * The `video` node's own top-level view: a [TextureView] driven by a plain
 * framework [MediaPlayer], with an optional poster laid over it until the
 * first frame is rendered.
 *
 * `MediaPlayer` ON A `TextureView`, deliberately — no ExoPlayer, no new
 * dependency for an SDK that customers embed. `TextureView` rather than
 * `SurfaceView` because a paywall clip is composited inside a scrolling,
 * possibly rounded/animated layout, which is exactly the case a `SurfaceView`
 * (its own window, punched through the hierarchy) draws wrong.
 *
 * THE PICTURE LETTERBOXES, it never stretches. A bare `TextureView` scales its
 * texture to its bounds, so an authored `aspectRatio` unlike the source's own
 * would distort the image; [onLayout] applies [videoSurfaceFitScale] to
 * correct that, matching web's `object-fit: contain` and iOS's
 * `resizeAspect`. The poster laid over it already letterboxes
 * (`ImageView.ScaleType.FIT_CENTER`), so the two now agree as well.
 *
 * PAUSE AND RESUME GO THROUGH THE PLAYER, never through rebuilding this view:
 * a rebuild restarts playback from zero, which is a different and worse
 * behaviour than "resume where it left off", and it is what both sibling
 * renderers deliberately avoid (web drives its own `<video>` element, iOS
 * holds the `AVPlayer` in a `@StateObject`). The verdict comes from the
 * SHARED [NodeVisibilityDetector] — the same one `countdown` and `carousel`
 * consume — through the pure [videoPlaybackCommand], whose third state is
 * what stops a `autoplay: false` clip from being started by a scroll.
 *
 * EVERYTHING ACQUIRED IS RELEASED IN [onDetachedFromWindow]. `render()` runs
 * on every package tap, so this view is built and thrown away repeatedly; a
 * `MediaPlayer` left holding a codec (and, on some devices, the audio focus)
 * is worse than a leaked listener, and this renderer has shipped a
 * listener-retention defect once already. Release is idempotent — the surface
 * being destroyed and the view being detached can happen in either order.
 *
 * DEVICE-ONLY: whether the player actually starts, pauses when the node
 * scrolls away, and genuinely stops making sound is NOT observable under this
 * module's stub `android.jar` (`MediaPlayer` there is inert). The RULE it
 * obeys is pinned by unit tests on [videoPlaybackCommand]; the plumbing is a
 * device smoke item.
 */
private class VideoNodeView(
    context: Context,
    private val sourceUrl: String,
    private val autoplay: Boolean,
    private val loop: Boolean,
    private val muted: Boolean,
    private val showsControls: Boolean,
    private val authoredAspectRatio: Double?,
    poster: ImageView?,
    private val buildFallback: () -> View?,
) : FrameLayout(context) {

    private val textureView = TextureView(context)
    private var posterView: ImageView? = poster

    /** Reused across every layout pass so a scroll-driven re-layout allocates
     *  nothing. Carries [videoSurfaceFitScale]'s answer onto the surface. */
    private val surfaceTransform = Matrix()

    private var player: MediaPlayer? = null
    private var playerSurface: Surface? = null

    /** `MediaPlayer.start()`/`pause()` are only legal once the player has
     *  prepared, so the verdict is remembered and applied on preparation
     *  instead of being dropped. */
    private var prepared = false

    /** The last non-[VideoPlaybackCommand.LEAVE_ALONE] verdict. Also what
     *  keeps a loop restart from resurrecting a clip that was paused for
     *  being off screen. */
    private var shouldBePlaying = false

    /** The source failed to load. Latched: a failed clip does not retry, it
     *  hands over to `fallback` (else nothing) like every other node type. */
    private var failed = false

    private var sourceWidthPx = VIDEO_SOURCE_DIMENSION_UNKNOWN_PX
    private var sourceHeightPx = VIDEO_SOURCE_DIMENSION_UNKNOWN_PX

    /** Only built when the node asked for controls — `MediaController` opens
     *  its own window, which is not something to hold for the default case. */
    private var mediaController: MediaController? = null

    private val visibilityDetector = NodeVisibilityDetector(this) { active ->
        applyPlaybackCommand(videoPlaybackCommand(active, autoplay))
    }

    private val surfaceTextureListener = object : TextureView.SurfaceTextureListener {
        override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
            openPlayer(Surface(texture))
        }

        override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = Unit

        /** `true` = we are done with the texture and the system may release
         *  it, which is only safe once the player has let go of the surface
         *  built from it. */
        override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
            releasePlayer()
            return true
        }

        override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
    }

    init {
        addView(textureView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        posterView?.let { addView(it, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)) }
        textureView.surfaceTextureListener = surfaceTextureListener
        if (showsControls) {
            // Tapping the surface is the only affordance the framework gives
            // for revealing transport controls (this is what `VideoView` does
            // too) — `MediaController` hides itself again on a timeout.
            setOnClickListener { mediaController?.show() }
        }
    }

    /**
     * An ABSENT authored ratio applies NO ratio until the source's own
     * dimensions are known, at which point they govern — never a substituted
     * number. With no ratio at all this measures like any other view, which
     * for a bare `TextureView` means zero height until
     * [MediaPlayer.OnVideoSizeChangedListener] fires and requests a re-layout.
     */
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val ratio = if (failed) {
            null
        } else {
            videoEffectiveAspectRatio(authoredAspectRatio, sourceWidthPx, sourceHeightPx)
        }
        if (ratio == null) {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec)
            return
        }
        val widthPx = MeasureSpec.getSize(widthMeasureSpec)
        super.onMeasure(
            MeasureSpec.makeMeasureSpec(widthPx, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(videoHeightForAspectRatio(widthPx, ratio), MeasureSpec.EXACTLY),
        )
    }

    /**
     * [onMeasure] decides how big the BOX is; this decides how the picture
     * sits inside it — letterboxed, never stretched (see
     * [videoSurfaceFitScale]).
     *
     * Driven from layout rather than from the size callback because BOTH
     * inputs can change independently: the box is re-measured when the paywall
     * re-lays out, and the source's natural size arrives later, from
     * `OnVideoSizeChangedListener`. That callback already calls
     * `requestLayout()`, which guarantees another pass through here, so this
     * one site covers both.
     */
    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        if (failed) return
        val scale = videoSurfaceFitScale(
            viewWidthPx = textureView.width,
            viewHeightPx = textureView.height,
            sourceWidthPx = sourceWidthPx,
            sourceHeightPx = sourceHeightPx,
        ) ?: return
        surfaceTransform.setScale(
            scale.scaleX,
            scale.scaleY,
            textureView.width * VIDEO_SURFACE_CENTER_FRACTION,
            textureView.height * VIDEO_SURFACE_CENTER_FRACTION,
        )
        textureView.setTransform(surfaceTransform)
    }

    private fun openPlayer(surface: Surface) {
        if (failed) {
            surface.release()
            return
        }
        // Defensive: a surface arriving while one is already open would
        // otherwise strand the previous player holding a codec.
        releasePlayer()
        playerSurface = surface
        val mp = MediaPlayer()
        player = mp
        try {
            mp.setSurface(surface)
            mp.isLooping = loop
            if (muted) mp.setVolume(MUTED_VOLUME, MUTED_VOLUME)
            mp.setOnPreparedListener {
                prepared = true
                attachControllerIfRequested(mp)
                // Re-apply the verdict the detector already published while
                // the player was still preparing, rather than dropping it.
                if (shouldBePlaying) startPlayer(mp)
            }
            mp.setOnVideoSizeChangedListener { _, width, height ->
                sourceWidthPx = width
                sourceHeightPx = height
                // Only matters when no ratio was authored, but requesting a
                // layout unconditionally keeps the branch out of a callback.
                requestLayout()
            }
            mp.setOnInfoListener { _, what, _ ->
                // The Android equivalent of iOS's `readyToPlay` retiring the
                // poster: the first frame is genuinely on screen now, so
                // anything covering it is hiding real content.
                if (what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) retirePoster()
                false
            }
            mp.setOnErrorListener { _, _, _ ->
                showFallback()
                // `true` = handled; without it the framework also invokes the
                // completion listener, i.e. reports the failure twice.
                true
            }
            mp.setDataSource(sourceUrl)
            mp.prepareAsync()
        } catch (_: Exception) {
            // setDataSource/prepareAsync throw for an unreachable or
            // unsupported source. Same destination as the async error path —
            // `fallback` else nothing — so a paywall never shows a dead
            // rectangle where a clip should be.
            showFallback()
        }
    }

    private fun startPlayer(mp: MediaPlayer) {
        if (!prepared || mp.isPlaying) return
        runCatching { mp.start() }
    }

    private fun applyPlaybackCommand(command: VideoPlaybackCommand) {
        when (command) {
            VideoPlaybackCommand.PLAY -> {
                shouldBePlaying = true
                player?.let { startPlayer(it) }
            }

            VideoPlaybackCommand.PAUSE -> {
                shouldBePlaying = false
                // `pause()` is only legal from a started/paused state, which
                // `isPlaying` is the cheapest way to establish.
                player?.takeIf { prepared && it.isPlaying }?.let { mp -> runCatching { mp.pause() } }
            }

            // Deliberately a no-op: a non-autoplay clip the reader has not
            // started (or has deliberately paused) must not be resumed by
            // visibility alone — see [videoPlaybackCommand].
            VideoPlaybackCommand.LEAVE_ALONE -> Unit
        }
    }

    private fun attachControllerIfRequested(mp: MediaPlayer) {
        if (!showsControls || mediaController != null) return
        val controller = MediaController(context)
        controller.setMediaPlayer(MediaPlayerControlAdapter(mp) { prepared })
        controller.setAnchorView(this)
        controller.isEnabled = true
        mediaController = controller
    }

    private fun retirePoster() {
        posterView?.let { view ->
            removeView(view)
            posterView = null
        }
    }

    /**
     * The failure path, shared by the synchronous throw and the asynchronous
     * error callback: hand over to `fallback` if the node has one, else draw
     * nothing. Exactly the contract every other node type uses when it cannot
     * draw — not a new failure mode.
     */
    private fun showFallback() {
        if (failed) return
        failed = true
        releasePlayer()
        removeAllViews()
        posterView = null
        buildFallback()?.let { view ->
            addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        }
        requestLayout()
    }

    /** Idempotent, and called from BOTH the surface-destroyed callback and
     *  [onDetachedFromWindow] because either can come first. */
    private fun releasePlayer() {
        prepared = false
        player?.let { mp ->
            // `reset()` before `release()` so a player mid-prepare stops
            // calling back into a view that is on its way out.
            runCatching { mp.reset() }
            runCatching { mp.release() }
        }
        player = null
        playerSurface?.release()
        playerSurface = null
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        // Deliberately no direct start(): the detector takes its first sample
        // synchronously and publishes through the callback above, so
        // attaching off-screen or backgrounded correctly starts nothing.
        visibilityDetector.start()
    }

    override fun onDetachedFromWindow() {
        visibilityDetector.stop()
        // The controller owns a WindowManager window anchored to this view;
        // leaving it showing leaks that window for the life of the activity.
        // The anchor itself needs no clearing — it IS this view, which is on
        // its way out, and `setAnchorView(null)` rebuilds the controller's
        // child views as a side effect on some API levels for no gain here.
        mediaController?.hide()
        mediaController = null
        // Dropping the listener first stops a late surface callback from
        // re-opening a player on a view nothing points at any more.
        textureView.surfaceTextureListener = null
        releasePlayer()
        super.onDetachedFromWindow()
    }
}

/**
 * Bridges the framework's [MediaController] onto a bare [MediaPlayer].
 * `VideoView` has an equivalent adapter internally; this SDK does not use
 * `VideoView` (it is `SurfaceView`-backed — see [VideoNodeView]), so the
 * adapter is spelled out here.
 *
 * [isPrepared] is read through a lambda rather than copied, because
 * `MediaController` polls these methods on its own schedule and a stale copy
 * would let it call into a player that has since been reset.
 */
private class MediaPlayerControlAdapter(
    private val player: MediaPlayer,
    private val isPrepared: () -> Boolean,
) : MediaController.MediaPlayerControl {
    override fun start() {
        if (isPrepared()) runCatching { player.start() }
    }

    override fun pause() {
        if (isPrepared()) runCatching { player.pause() }
    }

    override fun getDuration(): Int =
        if (isPrepared()) runCatching { player.duration }.getOrDefault(MEDIA_POSITION_UNKNOWN_MS) else MEDIA_POSITION_UNKNOWN_MS

    override fun getCurrentPosition(): Int =
        if (isPrepared()) {
            runCatching { player.currentPosition }.getOrDefault(MEDIA_POSITION_UNKNOWN_MS)
        } else {
            MEDIA_POSITION_UNKNOWN_MS
        }

    override fun seekTo(pos: Int) {
        if (isPrepared()) runCatching { player.seekTo(pos) }
    }

    override fun isPlaying(): Boolean = isPrepared() && runCatching { player.isPlaying }.getOrDefault(false)

    /** No progressive-download progress is tracked for a paywall clip, and
     *  `MediaController` reads this only to paint the secondary bar. */
    override fun getBufferPercentage(): Int = NO_BUFFER_PROGRESS_PERCENT

    override fun canPause(): Boolean = true

    override fun canSeekBackward(): Boolean = true

    override fun canSeekForward(): Boolean = true

    override fun getAudioSessionId(): Int =
        runCatching { player.audioSessionId }.getOrDefault(NO_AUDIO_SESSION_ID)
}

/** `MediaController`'s own "I don't know" for a duration/position, in ms. */
private const val MEDIA_POSITION_UNKNOWN_MS = 0

/** Nothing buffered-ahead is reported; see [MediaPlayerControlAdapter]. */
private const val NO_BUFFER_PROGRESS_PERCENT = 0

/** `AudioManager.AUDIO_SESSION_ID_GENERATE`'s "none" counterpart — 0 is the
 *  framework's own value for "no session". */
private const val NO_AUDIO_SESSION_ID = 0

/**
 * The `lottie` node's own top-level view: a container holding whatever the
 * host's registered [LottieRenderer] handed back.
 *
 * This SDK ships no Lottie runtime, so it cannot pause the host's animation
 * itself. What it CAN do is keep [LottieRenderRequest.playing] honest, and
 * that field rides the same [NodeVisibilityDetector] verdict `countdown`,
 * `carousel` and `video` consume — so a host player that honours it pauses
 * off screen for free.
 *
 * The request is RE-ISSUED (and the returned view swapped in) only when the
 * verdict actually FLIPS, which mirrors both siblings: web re-renders the
 * host component with the new prop, SwiftUI re-evaluates the body. The
 * detector de-duplicates, so this cannot fire per scrolled frame — which
 * matters here more than anywhere else, since a host that builds a fresh
 * animation view per call restarts the animation each time.
 */
private class LottieNodeView(
    context: Context,
    private val node: BuilderNode.Lottie,
    private val dark: Boolean,
    initialContent: View,
) : FrameLayout(context) {

    private var lastPlaying: Boolean = NODE_PLAYING_BEFORE_FIRST_SAMPLE

    private val visibilityDetector = NodeVisibilityDetector(this) { active -> reissue(active) }

    init {
        addView(initialContent, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    }

    private fun reissue(playing: Boolean) {
        if (playing == lastPlaying) return
        // A host that declines on a later call keeps whatever it last drew:
        // the fallback decision belongs to `buildLottie`, made once, and
        // swapping content for nothing mid-scroll would be a worse outcome
        // than a still animation.
        val content = lottieViewOrNull(context, lottieRenderRequest(node, playing, dark)) ?: return
        lastPlaying = playing
        removeAllViews()
        addView(content, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        visibilityDetector.start()
    }

    override fun onDetachedFromWindow() {
        visibilityDetector.stop()
        super.onDetachedFromWindow()
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
private val imageCache = BitmapLruCache<Bitmap>(sizeOf = { bitmap -> bitmap.allocationByteCount.toLong() })

/** Byte-array offset every [BitmapFactory.decodeByteArray] call here starts
 *  from: the whole downloaded body is the image. */
private const val IMAGE_BYTES_OFFSET = 0

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
 *
 * On a MISS the decode is DEFERRED until [imageView] has a measured WIDTH.
 * `buildImage` calls this one statement after constructing the `ImageView`,
 * so on a first render the view has never been through a layout pass and its
 * width is 0 — which [sampleSizeForWidth] (correctly, by design) answers
 * with [IMAGE_SAMPLE_SIZE_FULL]. Decoding at that moment therefore meant
 * downsampling NEVER happened: every image was decoded at full size, no
 * matter how small the slot it was going into. Waiting for one layout pass
 * is what makes the downsampling real. This uses the same
 * `ViewTreeObserver.OnGlobalLayoutListener` pattern as
 * `RovenuePaywallView`'s sticky-footer clearance, which has the identical
 * "needs a measured size, does not have one yet" shape.
 *
 * WIDTH ONLY — this is the whole correctness story, see
 * [sampleSizeForWidth]'s doc. Waiting on the HEIGHT too deadlocked every
 * image without an authored `height`: `buildImage` lays an `image` out
 * `MATCH_PARENT` wide by `WRAP_CONTENT` tall with `adjustViewBounds`, and a
 * `WRAP_CONTENT` `ImageView` with no drawable yet measures 0 tall forever —
 * the wait's precondition was the very thing the decode it was waiting for
 * would have produced. Width arrives from the parent's layout with no
 * drawable involved, so width is the only dimension this may wait on.
 *
 * Reading the size on the main thread before launching also fixes a
 * `View`-field read from `Dispatchers.IO`.
 *
 * Accepted trade-off: the cache key stays the URL alone, so the first slot
 * to be measured fixes the decoded size for every later slot showing the
 * same URL. Keying by URL + target size would be more precise but would
 * cost the synchronous cache-hit path above (a freshly rebuilt view has no
 * size yet, so it could not look itself up until after layout), and a
 * paywall shows a given image in a given slot.
 *
 * [decode] exists as a parameter ONLY so a JVM test can substitute a
 * recorder and assert the deferred work is actually REACHED. The test this
 * fix replaces asserted only that a listener gets registered, which stayed
 * green while production never completed the wait; production always passes
 * the default.
 */
internal fun loadImageInto(
    imageView: ImageView,
    url: String,
    scope: CoroutineScope,
    decode: ImageDecodeRequest = ImageDecodeRequest(::fetchAndDecodeInto),
) {
    val cached = imageCache.get(url)
    if (cached != null) {
        imageView.setImageBitmap(cached)
        return
    }
    if (imageView.width > UNMEASURED_VIEW_DIMENSION_PX) {
        decode(imageView, url, scope, imageView.width)
        return
    }
    awaitMeasuredWidthThenDecode(imageView, url, scope, decode)
}

/**
 * The deferred half of [loadImageInto]: waits for one layout pass to give
 * [imageView] a width, then decodes.
 *
 * Every exit unregisters. `RovenuePaywallView` rebuilds its whole view tree
 * on every state change (a package tap is a rebuild), and an ATTACHED view's
 * `getViewTreeObserver()` is the WINDOW's observer, shared by the entire
 * hierarchy and outliving any single `ImageView` — so a listener left
 * registered both leaks the discarded view and re-runs on every future
 * layout pass, once more per tap, for the life of the window. The three ways
 * out are therefore all handled: the width arrives (decode), the view leaves
 * the window (nothing left to decode into), or the scope is cancelled
 * (`RovenuePaywallView` cancelled it on detach; the decode could not
 * complete anyway).
 */
private fun awaitMeasuredWidthThenDecode(
    imageView: ImageView,
    url: String,
    scope: CoroutineScope,
    decode: ImageDecodeRequest,
) {
    var layoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null
    var attachListener: View.OnAttachStateChangeListener? = null

    // Idempotent: each exit path calls it, and nulling the fields means a
    // second call (detach racing a successful decode) is a no-op.
    fun unregister() {
        layoutListener?.let { listener ->
            imageView.viewTreeObserver.takeIf { it.isAlive }?.removeOnGlobalLayoutListener(listener)
        }
        attachListener?.let { listener -> imageView.removeOnAttachStateChangeListener(listener) }
        layoutListener = null
        attachListener = null
    }

    layoutListener = object : ViewTreeObserver.OnGlobalLayoutListener {
        override fun onGlobalLayout() {
            if (!scope.isActive) {
                unregister()
                return
            }
            val targetWidth = imageView.width
            // Still unmeasured (e.g. GONE, or a parent not laid out yet):
            // stay registered and try again on the next layout pass. This
            // is the ONE path that deliberately does not unregister — and
            // it is bounded by the detach listener below.
            if (targetWidth <= UNMEASURED_VIEW_DIMENSION_PX) return
            unregister()
            // Re-check: another view may have fetched the same URL during
            // the wait.
            val nowCached = imageCache.get(url)
            if (nowCached != null) {
                imageView.setImageBitmap(nowCached)
                return
            }
            decode(imageView, url, scope, targetWidth)
        }
    }
    attachListener = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(view: View) = Unit
        override fun onViewDetachedFromWindow(view: View) = unregister()
    }

    imageView.addOnAttachStateChangeListener(attachListener)
    imageView.viewTreeObserver.addOnGlobalLayoutListener(layoutListener)
}

/**
 * The deferred decode [loadImageInto] performs once its target has a
 * measured width. A named type rather than a bare lambda so the argument
 * order (and the fact that there is exactly ONE target dimension) is stated
 * once; [fetchAndDecodeInto] is the only production implementation.
 */
internal fun interface ImageDecodeRequest {
    operator fun invoke(imageView: ImageView, url: String, scope: CoroutineScope, targetWidth: Int)
}

/** Downloads [url] and decodes it downsampled to [targetWidth], caches it,
 *  and applies it to [imageView] on the main thread. [targetWidth] is an
 *  already-measured pixel size read on the main thread by [loadImageInto] —
 *  never a `View` field read from here. */
internal fun fetchAndDecodeInto(
    imageView: ImageView,
    url: String,
    scope: CoroutineScope,
    targetWidth: Int,
) {
    scope.launch(Dispatchers.IO) {
        val bitmap = runCatching {
            val connection = URL(url).openConnection() as HttpURLConnection
            connection.connectTimeout = IMAGE_LOAD_CONNECT_TIMEOUT_MS
            connection.readTimeout = IMAGE_LOAD_READ_TIMEOUT_MS
            connection.doInput = true
            connection.connect()
            val bytes = connection.inputStream.use { it.readBytes() }
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, IMAGE_BYTES_OFFSET, bytes.size, bounds)
            val options = BitmapFactory.Options().apply {
                inSampleSize = sampleSizeForWidth(
                    sourceWidth = bounds.outWidth,
                    targetWidth = targetWidth,
                )
            }
            BitmapFactory.decodeByteArray(bytes, IMAGE_BYTES_OFFSET, bytes.size, options)
        }.getOrNull()
        if (bitmap != null) {
            imageCache.put(url, bitmap)
            withContext(Dispatchers.Main) {
                if (isActive) imageView.setImageBitmap(bitmap)
            }
        }
    }
}
