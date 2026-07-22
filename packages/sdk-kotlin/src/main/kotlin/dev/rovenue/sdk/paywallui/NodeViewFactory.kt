package dev.rovenue.sdk.paywallui

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
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
import dev.rovenue.sdk.Offering
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
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
    return packageView(pkg.product, pkg.product.displayName)
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

private fun dp(context: Context, value: Double): Int =
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
) {
    /** Localized + variable-resolved label. [cellPackage] scopes variables
     *  to a package cell; elsewhere the selected package wins. */
    fun label(key: String, cellPackage: PackageView?): String {
        val text = resolveText(config, locale, key) ?: ""
        val pkg = relevantPackageView(cellPackage, selectedPackageId, offering)
        return resolveVariables(text, pkg)
    }
}

/** Builds the android.view.View tree for a [BuilderNode] subtree. */
internal object NodeViewFactory {

    fun build(context: Context, node: BuilderNode, ctx: PaywallRenderContext, cellPackage: PackageView?): View? =
        when (node) {
            is BuilderNode.Stack -> buildStack(context, node, ctx, cellPackage)
            is BuilderNode.Text -> buildText(context, node, ctx, cellPackage)
            is BuilderNode.Image -> buildImage(context, node, ctx, cellPackage)
            is BuilderNode.Button -> buildButton(context, node, ctx, cellPackage)
            is BuilderNode.PackageList -> buildPackageList(context, node, ctx)
            is BuilderNode.PurchaseButton -> buildPurchaseButton(context, node, ctx)
            is BuilderNode.Spacer -> View(context)
            is BuilderNode.Unknown -> node.fallback?.let { build(context, it, ctx, cellPackage) }
        }

    private fun buildStack(
        context: Context,
        node: BuilderNode.Stack,
        ctx: PaywallRenderContext,
        cellPackage: PackageView?,
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
            val childView = build(context, child, ctx, cellPackage) ?: return@forEachIndexed
            val dimen = childLayoutFor(node.axis, child)
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
        cellPackage: PackageView?,
    ): TextView {
        val style = textStyleFor(node.role)
        return TextView(context).apply {
            text = ctx.label(node.key, cellPackage)
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
        cellPackage: PackageView?,
    ): ImageView {
        val iv = ImageView(context).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            adjustViewBounds = true
            contentDescription = node.alt?.let { ctx.label(it, cellPackage) }
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
        cellPackage: PackageView?,
    ): View? {
        if (!actionButtonVisible(node.action, hasRestoreHandler = ctx.onRestore != null)) return null
        return Button(context).apply {
            text = ctx.label(node.labelKey, cellPackage)
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
            val cell = buildPackageCell(context, pkg, ctx)
            val margin = dp(context, 4.0)
            val lp = LinearLayout.LayoutParams(
                if (row) 0 else LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                if (row) weight = 1f
                setMargins(margin, margin, margin, margin)
            }
            container.addView(cell, lp)
        }
        return container
    }

    private fun buildPackageCell(
        context: Context,
        pkg: dev.rovenue.sdk.Package,
        ctx: PaywallRenderContext,
    ): View {
        val view = packageView(pkg.product, pkg.product.displayName)
        val selected = ctx.selectedPackageId == pkg.identifier
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
            // The `isSelected`-state flag is this renderer's aria-equivalent
            // (mirrors Swift's `.accessibilityAddTraits(.isSelected)`).
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
        return Button(context).apply {
            text = ctx.label(node.labelKey, null)
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
}

/**
 * Minimal, dependency-free image loader (HttpURLConnection + BitmapFactory
 * — explicitly NO Coil per the Phase-C spec's non-goals). Runs on
 * [scope]'s dispatcher; lifecycle-safe because [scope] is cancelled by
 * [RovenuePaywallView] on detach, which cancels this coroutine before it
 * ever touches the (possibly-recycled) [imageView].
 */
internal fun loadImageInto(imageView: ImageView, url: String, scope: CoroutineScope) {
    scope.launch(Dispatchers.IO) {
        val bitmap = runCatching {
            val connection = URL(url).openConnection() as HttpURLConnection
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.doInput = true
            connection.connect()
            connection.inputStream.use { BitmapFactory.decodeStream(it) }
        }.getOrNull()
        if (bitmap != null) {
            withContext(Dispatchers.Main) {
                if (isActive) imageView.setImageBitmap(bitmap)
            }
        }
    }
}
