package dev.rovenue.sdk.paywallui

import dev.rovenue.sdk.R
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

// =============================================================
// Builder-config model — Kotlin mirror of the Phase-B component
// tree (packages/shared/src/paywall/schema.ts) and of the Swift
// decoder (packages/sdk-swift .../PaywallUI/BuilderConfigModel.swift).
//
// Decoding contract (pinned by packages/shared/src/paywall/
// render-fixtures.json, see its `_comment`):
//  - an unrecognized node `type` decodes LENIENTLY to [UnknownNode]
//    retaining `id` + `fallback` (renderers draw the fallback or
//    nothing) — never an error;
//  - any structural defect in a KNOWN type (bad enum value, missing
//    `id`, malformed `fallback` subtree, formatVersion != 2,
//    non-object localization table, non-stack root) fails the WHOLE
//    decode — `decodeBuilderConfig` returns null.
// =============================================================

data class ThemePair(val light: String, val dark: String? = null)

/** A drawn border, always resolved together — a width without a color (or
 *  vice versa) renders nothing meaningful, so both fields are required
 *  inside the optional `border` prop. Drawn INSIDE the node's own corner
 *  radius on every platform (web `border` + `borderRadius`; SwiftUI
 *  `overlay(RoundedRectangle().strokeBorder)`; Android `GradientDrawable`
 *  stroke). Mirrors packages/shared/src/paywall/schema.ts's `NodeBorder`. */
data class NodeBorder(val width: Double, val color: ThemePair)

sealed class NodeSize {
    object Fit : NodeSize()
    object Fill : NodeSize()
    data class Value(val value: Double) : NodeSize()
}

data class Padding(val t: Double?, val r: Double?, val b: Double?, val l: Double?)

data class SizeSpec(val width: NodeSize?, val height: NodeSize?)

enum class Axis { V, H, Z }
enum class HAlign { START, CENTER, END }
enum class TextRole { TITLE, SUBTITLE, BODY, CAPTION }
enum class ButtonVisualStyle { PRIMARY, SECONDARY, PLAIN }
enum class CellLayout { ROW, COLUMN }

/** `countdown.onExpiry` — [FREEZE] holds the display at zero rather than
 *  vanishing (the default; hiding it collapses whatever space it occupied,
 *  a layout jump), [HIDE] removes the node once its deadline passes. Kotlin
 *  mirror of schema.ts's `CountdownNode.onExpiry` union / the Swift
 *  decoder's `CountdownOnExpiry`. */
enum class CountdownOnExpiry { FREEZE, HIDE }

sealed class ButtonAction {
    object Close : ButtonAction()
    object Restore : ButtonAction()
    data class Url(val url: String) : ButtonAction()
}

// =============================================================
// Node-level visibility (see Visibility.kt for the evaluator:
// `isNodeVisible` + `compareVersions`). Kotlin mirror of the shared
// `NodeVisibility` type (packages/shared/src/paywall/visibility.ts) and
// the RN model's `NodeVisibility` (packages/sdk-rn/src/paywall-ui/
// model.ts). Carried by every KNOWN node type below — NOT by
// [BuilderNode.Unknown], which never has one to parse (see
// `parseVisibility`'s decode contract) — and deliberately NOT
// overridable (absent from OVERRIDABLE_PROP_KEYS on every type).
// =============================================================

/** Platforms this node renders on. `null`/absent OR EMPTY means all of
 *  them. Bounds are inclusive. */
data class Visibility(
    val platform: List<String>? = null,
    val minAppVersion: String? = null,
    val maxAppVersion: String? = null,
)

// =============================================================
// Overrides (Phase D2) — Kotlin mirror of the Swift
// BuilderConfigModel.swift's "Overrides" section and the shared
// cross-platform contract in packages/shared/src/paywall/schema.ts
// (`OverrideCondition`/`NodeOverride`/`OVERRIDABLE_PROP_KEYS`). Every
// node payload gains an optional `overrides: List<NodeOverride<...>>`;
// conditions are evaluated at render time (see PaywallOverrides.kt's
// `activeOverrideConditions` + `applyOverrides`).
//
// Decode leniency, matching render-fixtures.json's `_comment`: an
// unknown `when.kind` string decodes to [OverrideConditionKind.UNKNOWN]
// — retained but never matching, NOT a config failure (acceptLenient-
// pinned). A structural/unknown key inside `props` of a KNOWN kind
// (introEligible/selected) fails the WHOLE config decode (reject-
// pinned) — enforced by `validateOverridePropKeys` inside each
// `parseXOverrideProps` function below.
// =============================================================

/** The `when.kind` of a single override entry. [UNKNOWN] covers any string
 *  outside the two known literals — decoding never throws for this field
 *  alone; see `parseOverrideList`. */
enum class OverrideConditionKind { INTRO_ELIGIBLE, SELECTED, UNKNOWN }

/**
 * A single node-type's whitelist of override-able prop keys — the node's
 * own OPTIONAL VISUAL fields only. This is the Kotlin mirror of
 * packages/shared/src/paywall/schema.ts's `OVERRIDABLE_PROP_KEYS`, the
 * single source of truth; keep the two tables in sync by hand.
 */
private object OverridablePropKeys {
    val stack: Set<String> = setOf("spacing", "align", "background", "cornerRadius", "border")
    val text: Set<String> = setOf("key", "color", "align", "background", "cornerRadius")
    val image: Set<String> = setOf("cornerRadius", "border")
    val button: Set<String> = setOf("labelKey", "style", "background", "labelColor", "border", "cornerRadius")
    val packageList: Set<String> = emptySet()
    val purchaseButton: Set<String> = setOf(
        "labelKey", "trialLabelKey", "background", "labelColor", "border", "cornerRadius",
    )
    val spacer: Set<String> = emptySet()
    val divider: Set<String> = setOf("color", "thickness")
    val icon: Set<String> = setOf("name", "color")
    val featureList: Set<String> = setOf("iconColor")
    val timeline: Set<String> = setOf("connectorColor")
    val socialProof: Set<String> = setOf("rating", "starColor")
    val stickyFooter: Set<String> = setOf("background")
    val countdown: Set<String> = setOf("color")
    val carousel: Set<String> = setOf("indicatorColor")
    val video: Set<String> = setOf("url", "posterUrl")
    val lottie: Set<String> = setOf("url")
    val footerLinks: Set<String> = setOf("color", "separator", "align")
}

/** A single conditional prop swap: `{ when: { kind }, props }`. [T] is the
 *  node type's own override-props class (e.g. [StackOverrideProps]). */
data class NodeOverride<T>(val whenKind: OverrideConditionKind, val props: T?)

data class StackOverrideProps(
    val spacing: Double? = null,
    val align: HAlign? = null,
    val background: ThemePair? = null,
    val cornerRadius: Double? = null,
    val border: NodeBorder? = null,
)

data class TextOverrideProps(
    val key: String? = null,
    val color: ThemePair? = null,
    val align: HAlign? = null,
    val background: ThemePair? = null,
    val cornerRadius: Double? = null,
)

data class ImageOverrideProps(val cornerRadius: Double? = null, val border: NodeBorder? = null)

data class ButtonOverrideProps(
    val labelKey: String? = null,
    val style: ButtonVisualStyle? = null,
    val background: ThemePair? = null,
    val labelColor: ThemePair? = null,
    val border: NodeBorder? = null,
    val cornerRadius: Double? = null,
)

/** Empty whitelist (`OVERRIDABLE_PROP_KEYS.packageList == []`) — no fields
 *  to merge; an `overrides` array on this type can only ever carry
 *  `props: {}`, so applying it is always a no-op. */
object PackageListOverrideProps

data class PurchaseButtonOverrideProps(
    val labelKey: String? = null,
    val trialLabelKey: String? = null,
    val background: ThemePair? = null,
    val labelColor: ThemePair? = null,
    val border: NodeBorder? = null,
    val cornerRadius: Double? = null,
)

/** Empty whitelist (`OVERRIDABLE_PROP_KEYS.spacer == []`) — same as
 *  [PackageListOverrideProps], always a no-op. */
object SpacerOverrideProps

data class DividerOverrideProps(val color: ThemePair? = null, val thickness: Double? = null)

data class IconOverrideProps(val name: String? = null, val color: ThemePair? = null)

data class FeatureListOverrideProps(val iconColor: ThemePair? = null)

data class TimelineOverrideProps(val connectorColor: ThemePair? = null)

data class SocialProofOverrideProps(val rating: Double? = null, val starColor: ThemePair? = null)

data class StickyFooterOverrideProps(val background: ThemePair? = null)

data class CountdownOverrideProps(val color: ThemePair? = null)

data class CarouselOverrideProps(val indicatorColor: ThemePair? = null)

/** `video`'s two overridable props — the SOURCES, not the playback flags:
 *  swapping which clip an intro-eligible reader sees is an authoring
 *  decision, whereas swapping `autoplay`/`muted` mid-render would fight the
 *  playback rule the node is already obeying. Mirrors
 *  `OVERRIDABLE_PROP_KEYS.video` in schema.ts. */
data class VideoOverrideProps(val url: ThemePair? = null, val posterUrl: ThemePair? = null)

/** `lottie`'s single overridable prop — same reasoning as
 *  [VideoOverrideProps]: the animation source, not `loop`/`autoplay`/`speed`. */
data class LottieOverrideProps(val url: ThemePair? = null)

/** `footerLinks`' three overridable props. Mirrors `OVERRIDABLE_PROP_KEYS.
 *  footerLinks` in schema.ts / Swift's `FooterLinksOverrideProps`. */
data class FooterLinksOverrideProps(
    val color: ThemePair? = null,
    val separator: String? = null,
    val align: String? = null,
)

// =============================================================
// Feature-list / timeline row shapes (Wave B) — Kotlin mirror of the shared
// `FeatureRow`/`TimelineRow` types (packages/shared/src/paywall/schema.ts)
// and the Swift decoder's `FeatureRowProps`/`TimelineRowProps`. Not nodes
// themselves, so — like the Swift structs — they carry none of
// `visibility`/`overrides`/`fallback`.
// =============================================================

data class FeatureRow(val labelKey: String, val icon: String? = null, val included: Boolean? = null)

data class TimelineRow(val labelKey: String, val captionKey: String? = null, val icon: String? = null)

/** One tappable link in a `footerLinks` row. `action` is the SAME
 *  `ButtonAction` union a `button` node carries — a footer link and a
 *  button do the same three things (close/url/restore), and a second
 *  action union would be a second thing to keep in sync across three
 *  renderers. Mirrors schema.ts's `FooterLink` / Swift's `FooterLinkModel`. */
data class FooterLink(val labelKey: String, val action: ButtonAction)

sealed class BuilderNode {
    abstract val id: String
    abstract val visibility: Visibility?
    abstract val fallback: BuilderNode?

    data class Stack(
        override val id: String,
        val axis: Axis,
        val children: List<BuilderNode>,
        val spacing: Double? = null,
        val align: HAlign? = null,
        val padding: Padding? = null,
        val size: SizeSpec? = null,
        val background: ThemePair? = null,
        val cornerRadius: Double? = null,
        /** Drawn INSIDE [cornerRadius]. Absent = no border, today's output. */
        val border: NodeBorder? = null,
        val overrides: List<NodeOverride<StackOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Text(
        override val id: String,
        val key: String,
        val role: TextRole,
        val color: ThemePair? = null,
        val align: HAlign? = null,
        /** Badge/chip fill. Absent = no background, today's output. */
        val background: ThemePair? = null,
        val cornerRadius: Double? = null,
        val overrides: List<NodeOverride<TextOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Image(
        override val id: String,
        val url: ThemePair,
        val height: Double? = null,
        val cornerRadius: Double? = null,
        /** Drawn INSIDE [cornerRadius]. Absent = no border, today's output. */
        val border: NodeBorder? = null,
        val alt: String? = null,
        val overrides: List<NodeOverride<ImageOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Button(
        override val id: String,
        val labelKey: String,
        val style: ButtonVisualStyle,
        val action: ButtonAction,
        /** Custom style props (spec 2026-07-29): all override the `style`
         *  variant's own visual; absent = the variant's current look, today's
         *  output. See `resolveButtonVisual` in NodeViewFactory.kt for the
         *  merge rule. */
        val background: ThemePair? = null,
        val labelColor: ThemePair? = null,
        /** Drawn INSIDE [cornerRadius]. Absent = no border, today's output. */
        val border: NodeBorder? = null,
        val cornerRadius: Double? = null,
        val overrides: List<NodeOverride<ButtonOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class PackageList(
        override val id: String,
        val packageIds: List<String>,
        val defaultSelected: String? = null,
        val cellLayout: CellLayout,
        /** Optional subtree rendered once per effective package, with
         *  cell-scoped variables, replacing the built-in (name + price)
         *  cell. Absent -> current built-in cell (backward compatible).
         *  Recursive, exactly like [fallback]. */
        val cellTemplate: BuilderNode? = null,
        val overrides: List<NodeOverride<PackageListOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class PurchaseButton(
        override val id: String,
        val labelKey: String,
        /** Loc key rendered instead of [labelKey] when the selected
         *  package's resolved [PackageView.introPeriod] is a non-empty
         *  string — a trial/intro period is active (see `ctaLabelKey` in
         *  PaywallHelpers.kt, the Kotlin port of variables.ts's
         *  `resolveCtaLabelKey`). Absent = always [labelKey]. Mirrors
         *  schema.ts's `PurchaseButtonNode.trialLabelKey`. */
        val trialLabelKey: String? = null,
        /** Custom style props (spec 2026-07-29): all override the button's
         *  own base visual; absent = today's output. See
         *  `resolveButtonVisual` in NodeViewFactory.kt. */
        val background: ThemePair? = null,
        val labelColor: ThemePair? = null,
        /** Drawn INSIDE [cornerRadius]. Absent = no border, today's output. */
        val border: NodeBorder? = null,
        val cornerRadius: Double? = null,
        val overrides: List<NodeOverride<PurchaseButtonOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Spacer(
        override val id: String,
        val size: Double? = null,
        val overrides: List<NodeOverride<SpacerOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Divider(
        override val id: String,
        val color: ThemePair? = null,
        /** Defaults to DIVIDER_DEFAULT_THICKNESS_DP (NodeViewFactory.kt) if absent. */
        val thickness: Double? = null,
        /** Horizontal inset on both sides. Defaults to DIVIDER_DEFAULT_INSET_DP if absent. */
        val inset: Double? = null,
        val overrides: List<NodeOverride<DividerOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Icon(
        override val id: String,
        /** A name from icon-registry.json. Deliberately a free string: unknown
         *  names render nothing and fail open (see [drawableResFor]), so a
         *  newer paywall never breaks an older app. */
        val name: String,
        /** Defaults to ICON_DEFAULT_SIZE_DP (NodeViewFactory.kt) if absent. */
        val size: Double? = null,
        val color: ThemePair? = null,
        val overrides: List<NodeOverride<IconOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class FeatureList(
        override val id: String,
        val rows: List<FeatureRow>,
        /** Applied to each row's icon that does not carry its own. Absent
         *  means inherit (see NodeViewFactory.kt), NOT a default color. */
        val iconColor: ThemePair? = null,
        val overrides: List<NodeOverride<FeatureListOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Timeline(
        override val id: String,
        val rows: List<TimelineRow>,
        /** Absent = TIMELINE_CONNECTOR_DEFAULT_COLOR (NodeViewFactory.kt). */
        val connectorColor: ThemePair? = null,
        val overrides: List<NodeOverride<TimelineOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class SocialProof(
        override val id: String,
        /** 0..SOCIAL_PROOF_MAX_RATING. Absent renders no stars at all. */
        val rating: Double? = null,
        val labelKey: String,
        /** Absent = SOCIAL_PROOF_STAR_DEFAULT_COLOR (NodeViewFactory.kt). */
        val starColor: ThemePair? = null,
        val overrides: List<NodeOverride<SocialProofOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class StickyFooter(
        override val id: String,
        val children: List<BuilderNode>,
        /** Absent = STICKY_FOOTER_DEFAULT_BACKGROUND (NodeViewFactory.kt) —
         *  a pinned bar needs an opaque background or the content scrolls
         *  visibly beneath it, unlike an ordinary node's colour. */
        val background: ThemePair? = null,
        val overrides: List<NodeOverride<StickyFooterOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Countdown(
        override val id: String,
        /** ISO-8601 absolute deadline. Mutually exclusive with
         *  [durationSeconds]. */
        val endsAt: String? = null,
        /** Seconds from this paywall's first show to this user, persisted
         *  (see `countdownFirstShownAtMillis` in NodeViewFactory.kt) — a
         *  timer restarting on every open is not a deadline. Mutually
         *  exclusive with [endsAt]. */
        val durationSeconds: Double? = null,
        /** Absent = COUNTDOWN_DEFAULT_ON_EXPIRY (NodeViewFactory.kt). */
        val onExpiry: CountdownOnExpiry? = null,
        val labelKey: String? = null,
        /** Absent = inherit the ambient text colour, never a substituted
         *  value. */
        val color: ThemePair? = null,
        val overrides: List<NodeOverride<CountdownOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Carousel(
        override val id: String,
        /** Pages. Any node, not only images — the same freedom `stack`
         *  gives. */
        val children: List<BuilderNode>,
        /** Absent = CAROUSEL_DEFAULT_SHOWS_INDICATOR (NodeViewFactory.kt). */
        val showsIndicator: Boolean? = null,
        /** Seconds between automatic advances. Absent = no auto-advance at
         *  all, deliberately not a default interval: a paywall that starts
         *  moving on its own without the author asking is a surprise. */
        val autoAdvanceSeconds: Double? = null,
        /** Absent = CAROUSEL_DEFAULT_LOOP (NodeViewFactory.kt). */
        val loop: Boolean? = null,
        /** Absent = inherit the ambient text colour, never a substituted
         *  value. */
        val indicatorColor: ThemePair? = null,
        val overrides: List<NodeOverride<CarouselOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Video(
        override val id: String,
        /** The clip. Theme-picked exactly like an `image`'s. */
        val url: ThemePair,
        /** Shown until the player renders its first frame. Absent = nothing
         *  covers the player, so an autoplaying clip simply starts. */
        val posterUrl: ThemePair? = null,
        /** Absent = VIDEO_DEFAULT_AUTOPLAY (NodeViewFactory.kt). `false` is
         *  HONOURED: scrolling into view never starts a clip the author said
         *  should not start itself (see `videoPlaybackCommand`). */
        val autoplay: Boolean? = null,
        /** Absent = VIDEO_DEFAULT_LOOP (NodeViewFactory.kt). */
        val loop: Boolean? = null,
        /** Absent = VIDEO_DEFAULT_MUTED (NodeViewFactory.kt). */
        val muted: Boolean? = null,
        /** Absent = VIDEO_DEFAULT_SHOWS_CONTROLS (NodeViewFactory.kt). */
        val showsControls: Boolean? = null,
        /** Width / height. Absent = NO ratio is applied at all and the
         *  source's own dimensions govern once known — never a substituted
         *  number (see `videoEffectiveAspectRatio`). */
        val aspectRatio: Double? = null,
        val overrides: List<NodeOverride<VideoOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Lottie(
        override val id: String,
        /** The animation document. Theme-picked exactly like a `video`'s. */
        val url: ThemePair,
        /** Absent = LOTTIE_DEFAULT_LOOP (NodeViewFactory.kt). */
        val loop: Boolean? = null,
        /** Absent = LOTTIE_DEFAULT_AUTOPLAY (NodeViewFactory.kt). */
        val autoplay: Boolean? = null,
        /** Playback rate multiplier. Absent = LOTTIE_DEFAULT_SPEED
         *  (NodeViewFactory.kt). Values outside
         *  LOTTIE_MIN_SPEED..LOTTIE_MAX_SPEED are authoring-time ADVICE in
         *  the shared validator, not a clamp — whatever is authored is
         *  handed to the host's player unchanged. */
        val speed: Double? = null,
        val overrides: List<NodeOverride<LottieOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    /**
     * The row of small, low-emphasis legal/action links at the bottom of a
     * paywall: Restore Purchases · Terms · Privacy. `separator`/`align` are
     * kept OPTIONAL here on purpose — this is the WIRE shape, and the
     * default ([dev.rovenue.sdk.paywallui] `FOOTER_LINKS_DEFAULT_SEPARATOR`/
     * `FOOTER_LINKS_DEFAULT_ALIGN` in NodeViewFactory.kt) is applied by the
     * VIEW, not fabricated here — mirrors nodes.tsx's `renderFooterLinks`
     * (`node.separator ?? FOOTER_LINKS_DEFAULT_SEPARATOR`) and Swift's
     * `FooterLinksProps`: a renderer that forgets to apply the default is
     * visible in a decode test instead of being masked by a fabricated
     * decoder default.
     */
    data class FooterLinks(
        override val id: String,
        val links: List<FooterLink>,
        val separator: String? = null,
        val align: String? = null,
        /** Applies to every link's label AND the separators. Absent =
         *  inherit the ambient text colour. */
        val color: ThemePair? = null,
        val overrides: List<NodeOverride<FooterLinksOverrideProps>>? = null,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    /** An unrecognized node `type`. `visibility` IS retained: it is the
     *  author's "don't show this here", and an unknown type is exactly the
     *  forward-compat case where a platform restriction matters most —
     *  dropping it would render the fallback on a platform the author
     *  excluded, which the web renderer already refuses to do. */
    data class Unknown(
        override val id: String,
        override val visibility: Visibility? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()
}

data class BuilderConfigModel(
    val formatVersion: Int,
    val defaultLocale: String,
    val localizations: Map<String, Map<String, String>>,
    val background: ThemePair?,
    val root: BuilderNode.Stack,
)

private class BuilderDecodeException(message: String) : Exception(message)

private val json = Json { ignoreUnknownKeys = true }

/**
 * Decodes a builder-config JSON string. Returns null on ANY structural
 * defect — never throws. An unrecognized node `type` is NOT a structural
 * defect: it decodes leniently to [BuilderNode.Unknown].
 */
fun decodeBuilderConfig(raw: String): BuilderConfigModel? = try {
    val root = json.parseToJsonElement(raw).jsonObject
    parseConfig(root)
} catch (_: Exception) {
    null
}

// ----- config -----

private fun parseConfig(obj: JsonObject): BuilderConfigModel {
    val formatVersion = (obj["formatVersion"] as? JsonPrimitive)?.intOrNull
        ?: throw BuilderDecodeException("formatVersion missing")
    if (formatVersion != 2) throw BuilderDecodeException("formatVersion must be the literal 2")

    val defaultLocale = obj.requireString("defaultLocale")
    if (defaultLocale.isEmpty()) throw BuilderDecodeException("defaultLocale must be non-empty")

    val locsObj = obj["localizations"] as? JsonObject
        ?: throw BuilderDecodeException("localizations must be an object")
    val localizations = locsObj.mapValues { (locale, table) ->
        val tableObj = table as? JsonObject
            ?: throw BuilderDecodeException("localizations[$locale] must be an object")
        tableObj.mapValues { (key, v) ->
            val prim = v as? JsonPrimitive
            if (prim == null || !prim.isString) {
                throw BuilderDecodeException("localizations[$locale][$key] must be a string")
            }
            prim.content
        }
    }

    val background = obj["background"]?.letObject(::parseThemePair)

    val rootNode = parseNode(
        obj["root"] as? JsonObject ?: throw BuilderDecodeException("root must be an object"),
    )
    if (rootNode !is BuilderNode.Stack) throw BuilderDecodeException("root must be a stack node")

    return BuilderConfigModel(formatVersion, defaultLocale, localizations, background, rootNode)
}

// ----- nodes -----

private fun parseNode(obj: JsonObject): BuilderNode {
    val type = obj.requireString("type")
    val id = obj.requireString("id")
    val fallback = obj["fallback"]?.letObject(::parseNode)
    val visibility = parseVisibility(obj)

    return when (type) {
        "stack" -> BuilderNode.Stack(
            id = id,
            axis = obj.requireEnum("axis", mapOf("v" to Axis.V, "h" to Axis.H, "z" to Axis.Z)),
            children = (obj["children"] as? JsonArray
                ?: throw BuilderDecodeException("stack.children must be an array"))
                .map { parseNode(it as? JsonObject ?: throw BuilderDecodeException("child must be an object")) },
            spacing = obj.optionalDouble("spacing"),
            align = obj.optionalAlign(),
            padding = obj["padding"]?.letObject { p ->
                Padding(p.optionalDouble("t"), p.optionalDouble("r"), p.optionalDouble("b"), p.optionalDouble("l"))
            },
            size = obj["size"]?.letObject { s ->
                SizeSpec(s["width"]?.let(::parseNodeSize), s["height"]?.let(::parseNodeSize))
            },
            background = obj["background"]?.letObject(::parseThemePair),
            cornerRadius = obj.optionalDouble("cornerRadius"),
            border = obj["border"]?.letObject(::parseNodeBorder),
            overrides = obj.parseOverrideList(::parseStackOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "text" -> BuilderNode.Text(
            id = id,
            key = obj.requireString("key"),
            role = obj.requireEnum(
                "role",
                mapOf(
                    "title" to TextRole.TITLE, "subtitle" to TextRole.SUBTITLE,
                    "body" to TextRole.BODY, "caption" to TextRole.CAPTION,
                ),
            ),
            color = obj["color"]?.letObject(::parseThemePair),
            align = obj.optionalAlign(),
            background = obj["background"]?.letObject(::parseThemePair),
            cornerRadius = obj.optionalDouble("cornerRadius"),
            overrides = obj.parseOverrideList(::parseTextOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "image" -> BuilderNode.Image(
            id = id,
            url = obj["url"]?.letObject(::parseThemePair)
                ?: throw BuilderDecodeException("image.url required"),
            height = obj.optionalDouble("height"),
            cornerRadius = obj.optionalDouble("cornerRadius"),
            border = obj["border"]?.letObject(::parseNodeBorder),
            alt = obj.optionalString("alt"),
            overrides = obj.parseOverrideList(::parseImageOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "button" -> BuilderNode.Button(
            id = id,
            labelKey = obj.requireString("labelKey"),
            style = obj.requireEnum(
                "style",
                mapOf(
                    "primary" to ButtonVisualStyle.PRIMARY,
                    "secondary" to ButtonVisualStyle.SECONDARY,
                    "plain" to ButtonVisualStyle.PLAIN,
                ),
            ),
            action = parseAction(
                obj["action"] as? JsonObject ?: throw BuilderDecodeException("button.action required"),
            ),
            background = obj["background"]?.letObject(::parseThemePair),
            labelColor = obj["labelColor"]?.letObject(::parseThemePair),
            border = obj["border"]?.letObject(::parseNodeBorder),
            cornerRadius = obj.optionalDouble("cornerRadius"),
            overrides = obj.parseOverrideList(::parseButtonOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "packageList" -> BuilderNode.PackageList(
            id = id,
            packageIds = (obj["packageIds"] as? JsonArray
                ?: throw BuilderDecodeException("packageList.packageIds must be an array"))
                .map {
                    val prim = it as? JsonPrimitive
                    if (prim == null || !prim.isString) throw BuilderDecodeException("packageIds entries must be strings")
                    prim.content
                },
            defaultSelected = obj.optionalString("defaultSelected"),
            cellLayout = obj.requireEnum(
                "cellLayout",
                mapOf("row" to CellLayout.ROW, "column" to CellLayout.COLUMN),
            ),
            cellTemplate = obj["cellTemplate"]?.letObject(::parseNode),
            overrides = obj.parseOverrideList(::parsePackageListOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "purchaseButton" -> BuilderNode.PurchaseButton(
            id = id,
            labelKey = obj.requireString("labelKey"),
            trialLabelKey = obj.optionalString("trialLabelKey"),
            background = obj["background"]?.letObject(::parseThemePair),
            labelColor = obj["labelColor"]?.letObject(::parseThemePair),
            border = obj["border"]?.letObject(::parseNodeBorder),
            cornerRadius = obj.optionalDouble("cornerRadius"),
            overrides = obj.parseOverrideList(::parsePurchaseButtonOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "spacer" -> BuilderNode.Spacer(
            id = id,
            size = obj.optionalDouble("size"),
            overrides = obj.parseOverrideList(::parseSpacerOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "divider" -> BuilderNode.Divider(
            id = id,
            color = obj["color"]?.letObject(::parseThemePair),
            thickness = obj.optionalDouble("thickness"),
            inset = obj.optionalDouble("inset"),
            overrides = obj.parseOverrideList(::parseDividerOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "icon" -> BuilderNode.Icon(
            id = id,
            name = obj.requireString("name"),
            size = obj.optionalDouble("size"),
            color = obj["color"]?.letObject(::parseThemePair),
            overrides = obj.parseOverrideList(::parseIconOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "featureList" -> BuilderNode.FeatureList(
            id = id,
            rows = (obj["rows"] as? JsonArray ?: throw BuilderDecodeException("featureList.rows must be an array"))
                .map { parseFeatureRow(it as? JsonObject ?: throw BuilderDecodeException("featureList row must be an object")) },
            iconColor = obj["iconColor"]?.letObject(::parseThemePair),
            overrides = obj.parseOverrideList(::parseFeatureListOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "timeline" -> BuilderNode.Timeline(
            id = id,
            rows = (obj["rows"] as? JsonArray ?: throw BuilderDecodeException("timeline.rows must be an array"))
                .map { parseTimelineRow(it as? JsonObject ?: throw BuilderDecodeException("timeline row must be an object")) },
            connectorColor = obj["connectorColor"]?.letObject(::parseThemePair),
            overrides = obj.parseOverrideList(::parseTimelineOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "socialProof" -> BuilderNode.SocialProof(
            id = id,
            rating = obj.optionalDouble("rating"),
            labelKey = obj.requireString("labelKey"),
            starColor = obj["starColor"]?.letObject(::parseThemePair),
            overrides = obj.parseOverrideList(::parseSocialProofOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "stickyFooter" -> BuilderNode.StickyFooter(
            id = id,
            children = (obj["children"] as? JsonArray
                ?: throw BuilderDecodeException("stickyFooter.children must be an array"))
                .map { parseNode(it as? JsonObject ?: throw BuilderDecodeException("child must be an object")) },
            background = obj["background"]?.letObject(::parseThemePair),
            overrides = obj.parseOverrideList(::parseStickyFooterOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "countdown" -> BuilderNode.Countdown(
            id = id,
            endsAt = obj.optionalString("endsAt"),
            durationSeconds = obj.optionalDouble("durationSeconds"),
            onExpiry = obj["onExpiry"]?.let { el ->
                val prim = el as? JsonPrimitive ?: throw BuilderDecodeException("onExpiry must be a string")
                when (prim.content) {
                    "freeze" -> CountdownOnExpiry.FREEZE
                    "hide" -> CountdownOnExpiry.HIDE
                    else -> throw BuilderDecodeException("onExpiry has invalid value \"${prim.content}\"")
                }
            },
            labelKey = obj.optionalString("labelKey"),
            color = obj["color"]?.letObject(::parseThemePair),
            overrides = obj.parseOverrideList(::parseCountdownOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "carousel" -> BuilderNode.Carousel(
            id = id,
            children = (obj["children"] as? JsonArray
                ?: throw BuilderDecodeException("carousel.children must be an array"))
                .map { parseNode(it as? JsonObject ?: throw BuilderDecodeException("child must be an object")) },
            showsIndicator = obj.optionalBoolean("showsIndicator"),
            autoAdvanceSeconds = obj.optionalDouble("autoAdvanceSeconds"),
            loop = obj.optionalBoolean("loop"),
            indicatorColor = obj["indicatorColor"]?.letObject(::parseThemePair),
            overrides = obj.parseOverrideList(::parseCarouselOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "video" -> BuilderNode.Video(
            id = id,
            url = obj["url"]?.letObject(::parseThemePair)
                ?: throw BuilderDecodeException("video.url required"),
            posterUrl = obj["posterUrl"]?.letObject(::parseThemePair),
            autoplay = obj.optionalBoolean("autoplay"),
            loop = obj.optionalBoolean("loop"),
            muted = obj.optionalBoolean("muted"),
            showsControls = obj.optionalBoolean("showsControls"),
            aspectRatio = obj.optionalDouble("aspectRatio"),
            overrides = obj.parseOverrideList(::parseVideoOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "lottie" -> BuilderNode.Lottie(
            id = id,
            url = obj["url"]?.letObject(::parseThemePair)
                ?: throw BuilderDecodeException("lottie.url required"),
            loop = obj.optionalBoolean("loop"),
            autoplay = obj.optionalBoolean("autoplay"),
            speed = obj.optionalDouble("speed"),
            overrides = obj.parseOverrideList(::parseLottieOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        "footerLinks" -> BuilderNode.FooterLinks(
            id = id,
            links = (obj["links"] as? JsonArray
                ?: throw BuilderDecodeException("footerLinks.links must be an array"))
                .map { parseFooterLink(it as? JsonObject ?: throw BuilderDecodeException("footerLinks link must be an object")) },
            // Kept as raw strings, not validated against the enum here —
            // see [BuilderNode.FooterLinks]'s own doc: an unrecognized VALUE
            // (not a structural type mismatch) is a render-time leniency
            // concern (footerSeparatorGlyph/footerLinksGravity), same as
            // Swift's FooterLinksProps.
            separator = obj.optionalString("separator"),
            align = obj.optionalString("align"),
            color = obj["color"]?.letObject(::parseThemePair),
            overrides = obj.parseOverrideList(::parseFooterLinksOverrideProps),
            visibility = visibility,
            fallback = fallback,
        )
        // Lenient branch: unknown types keep id + fallback and never fail
        // the decode. The fallback subtree itself is still parsed strictly.
        else -> BuilderNode.Unknown(id = id, visibility = visibility, fallback = fallback)
    }
}

// ----- visibility -----

/** Platforms recognized by node-level `visibility` — Kotlin mirror of
 *  shared's `VisibilityPlatform` union / the RN decoder's
 *  `VISIBILITY_PLATFORMS`. */
private val VISIBILITY_PLATFORMS: Set<String> = setOf("ios", "android", "web")

/**
 * `visibility.platform` decodes LENIENTLY: any entry outside the known
 * set is dropped rather than failing the whole config, and an
 * empty-after-filtering array is treated the same as absent (`null`) —
 * both mean "no constraint" to [isNodeVisible].
 */
private fun parseVisibilityPlatformList(el: kotlinx.serialization.json.JsonElement?): List<String>? {
    val arr = el as? JsonArray ?: return null
    val kept = arr.mapNotNull { entry -> (entry as? JsonPrimitive)?.takeIf { it.isString }?.content }
        .filter { it in VISIBILITY_PLATFORMS }
    return kept.ifEmpty { null }
}

/**
 * Lenient `visibility` parse: a missing/non-object `visibility`, or one
 * whose every field is unusable, decodes to `null` rather than failing —
 * this is the one field on a known node type that does NOT fail the
 * whole config decode on a structural defect (mirrors the RN decoder's
 * `parseVisibility` exactly; see this file's `Visibility` doc for why).
 */
private fun parseVisibility(obj: JsonObject): Visibility? {
    val v = obj["visibility"] as? JsonObject ?: return null
    val platform = parseVisibilityPlatformList(v["platform"])
    val minAppVersion = (v["minAppVersion"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val maxAppVersion = (v["maxAppVersion"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (platform == null && minAppVersion == null && maxAppVersion == null) return null
    return Visibility(platform = platform, minAppVersion = minAppVersion, maxAppVersion = maxAppVersion)
}

// ----- overrides -----

/** Throws when [props] carries any key outside [allowed] — the defensive
 *  check that makes a structural key (e.g. `"type"`) inside a KNOWN
 *  when.kind's `props` fail the whole config decode, per
 *  render-fixtures.json's reject-pinned case. */
private fun validateOverridePropKeys(props: JsonObject, allowed: Set<String>) {
    for (key in props.keys) {
        if (key !in allowed) {
            throw BuilderDecodeException("\"$key\" is not an overridable prop for this node type.")
        }
    }
}

private fun parseStackOverrideProps(props: JsonObject): StackOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.stack)
    return StackOverrideProps(
        spacing = props.optionalDouble("spacing"),
        align = props.optionalAlign(),
        background = props["background"]?.letObject(::parseThemePair),
        cornerRadius = props.optionalDouble("cornerRadius"),
        border = props["border"]?.letObject(::parseNodeBorder),
    )
}

private fun parseTextOverrideProps(props: JsonObject): TextOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.text)
    return TextOverrideProps(
        key = props.optionalString("key"),
        color = props["color"]?.letObject(::parseThemePair),
        align = props.optionalAlign(),
        background = props["background"]?.letObject(::parseThemePair),
        cornerRadius = props.optionalDouble("cornerRadius"),
    )
}

private fun parseImageOverrideProps(props: JsonObject): ImageOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.image)
    return ImageOverrideProps(
        cornerRadius = props.optionalDouble("cornerRadius"),
        border = props["border"]?.letObject(::parseNodeBorder),
    )
}

private fun parseButtonOverrideProps(props: JsonObject): ButtonOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.button)
    return ButtonOverrideProps(
        labelKey = props.optionalString("labelKey"),
        style = props["style"]?.let {
            val prim = it as? JsonPrimitive ?: throw BuilderDecodeException("style must be a string")
            when (prim.content) {
                "primary" -> ButtonVisualStyle.PRIMARY
                "secondary" -> ButtonVisualStyle.SECONDARY
                "plain" -> ButtonVisualStyle.PLAIN
                else -> throw BuilderDecodeException("style has invalid value \"${prim.content}\"")
            }
        },
        background = props["background"]?.letObject(::parseThemePair),
        labelColor = props["labelColor"]?.letObject(::parseThemePair),
        border = props["border"]?.letObject(::parseNodeBorder),
        cornerRadius = props.optionalDouble("cornerRadius"),
    )
}

private fun parsePackageListOverrideProps(props: JsonObject): PackageListOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.packageList)
    return PackageListOverrideProps
}

private fun parsePurchaseButtonOverrideProps(props: JsonObject): PurchaseButtonOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.purchaseButton)
    return PurchaseButtonOverrideProps(
        labelKey = props.optionalString("labelKey"),
        trialLabelKey = props.optionalString("trialLabelKey"),
        background = props["background"]?.letObject(::parseThemePair),
        labelColor = props["labelColor"]?.letObject(::parseThemePair),
        border = props["border"]?.letObject(::parseNodeBorder),
        cornerRadius = props.optionalDouble("cornerRadius"),
    )
}

private fun parseSpacerOverrideProps(props: JsonObject): SpacerOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.spacer)
    return SpacerOverrideProps
}

private fun parseDividerOverrideProps(props: JsonObject): DividerOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.divider)
    return DividerOverrideProps(
        color = props["color"]?.letObject(::parseThemePair),
        thickness = props.optionalDouble("thickness"),
    )
}

private fun parseIconOverrideProps(props: JsonObject): IconOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.icon)
    return IconOverrideProps(
        name = props.optionalString("name"),
        color = props["color"]?.letObject(::parseThemePair),
    )
}

private fun parseFeatureListOverrideProps(props: JsonObject): FeatureListOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.featureList)
    return FeatureListOverrideProps(iconColor = props["iconColor"]?.letObject(::parseThemePair))
}

private fun parseTimelineOverrideProps(props: JsonObject): TimelineOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.timeline)
    return TimelineOverrideProps(connectorColor = props["connectorColor"]?.letObject(::parseThemePair))
}

private fun parseSocialProofOverrideProps(props: JsonObject): SocialProofOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.socialProof)
    return SocialProofOverrideProps(
        rating = props.optionalDouble("rating"),
        starColor = props["starColor"]?.letObject(::parseThemePair),
    )
}

private fun parseStickyFooterOverrideProps(props: JsonObject): StickyFooterOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.stickyFooter)
    return StickyFooterOverrideProps(background = props["background"]?.letObject(::parseThemePair))
}

private fun parseCountdownOverrideProps(props: JsonObject): CountdownOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.countdown)
    return CountdownOverrideProps(color = props["color"]?.letObject(::parseThemePair))
}

private fun parseCarouselOverrideProps(props: JsonObject): CarouselOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.carousel)
    return CarouselOverrideProps(indicatorColor = props["indicatorColor"]?.letObject(::parseThemePair))
}

private fun parseVideoOverrideProps(props: JsonObject): VideoOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.video)
    return VideoOverrideProps(
        url = props["url"]?.letObject(::parseThemePair),
        posterUrl = props["posterUrl"]?.letObject(::parseThemePair),
    )
}

private fun parseLottieOverrideProps(props: JsonObject): LottieOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.lottie)
    return LottieOverrideProps(url = props["url"]?.letObject(::parseThemePair))
}

private fun parseFooterLinksOverrideProps(props: JsonObject): FooterLinksOverrideProps {
    validateOverridePropKeys(props, OverridablePropKeys.footerLinks)
    return FooterLinksOverrideProps(
        color = props["color"]?.letObject(::parseThemePair),
        separator = props.optionalString("separator"),
        align = props.optionalString("align"),
    )
}

// ----- feature-list / timeline rows -----

private fun parseFeatureRow(obj: JsonObject): FeatureRow = FeatureRow(
    labelKey = obj.requireString("labelKey"),
    icon = obj.optionalString("icon"),
    included = obj.optionalBoolean("included"),
)

private fun parseTimelineRow(obj: JsonObject): TimelineRow = TimelineRow(
    labelKey = obj.requireString("labelKey"),
    captionKey = obj.optionalString("captionKey"),
    icon = obj.optionalString("icon"),
)

private fun parseFooterLink(obj: JsonObject): FooterLink = FooterLink(
    labelKey = obj.requireString("labelKey"),
    action = parseAction(
        obj["action"] as? JsonObject ?: throw BuilderDecodeException("footerLinks link.action required"),
    ),
)

// ----- icon registry -----

/**
 * Registry name -> vendored Material drawable RESOURCE ID, referenced
 * STATICALLY (`R.drawable.rovenue_ic_*`) rather than resolved at render time
 * via a name string + `Resources.getIdentifier`. `getIdentifier` is a pure
 * runtime lookup — nothing in the compiled bytecode statically mentions
 * `R.drawable.rovenue_ic_*` — so a consuming app's release build with
 * `shrinkResources true` sees all twelve drawables as unreferenced and can
 * strip them, after which every icon silently fails open (only visible in a
 * release build; no test in this repo catches it). Referencing the R
 * constants directly here keeps them reachable. This also sidesteps a
 * second latent bug in the old `getIdentifier(name, "drawable",
 * context.packageName)` call: `context.packageName` returns the
 * *applicationId*, which an `applicationIdSuffix` build variant shifts away
 * from the resource-table package, breaking the by-name lookup even before
 * shrinking enters the picture.
 *
 * Unknown names return null and render nothing, so a newer paywall never
 * breaks an older app.
 *
 * `"star_border"` is the one entry NOT in packages/shared/src/paywall/
 * icon-registry.json — it's not an author-facing icon name (a paywall
 * config can never reference it via an `icon` node or a `featureList`/
 * `timeline` row), only NodeViewFactory.kt's `buildSocialProof` resolves it
 * internally, to draw an unfilled star as a distinct outline glyph rather
 * than the filled star at reduced alpha. Vendored through the same
 * fetch-path convention as the other twelve (see res/drawable/README.md).
 */
internal fun drawableResFor(name: String): Int? = when (name) {
    "check" -> R.drawable.rovenue_ic_check
    "x" -> R.drawable.rovenue_ic_x
    "star" -> R.drawable.rovenue_ic_star
    "star_border" -> R.drawable.rovenue_ic_star_border
    "lock" -> R.drawable.rovenue_ic_lock
    "shield" -> R.drawable.rovenue_ic_shield
    "sparkle" -> R.drawable.rovenue_ic_sparkle
    "bolt" -> R.drawable.rovenue_ic_bolt
    "gift" -> R.drawable.rovenue_ic_gift
    "clock" -> R.drawable.rovenue_ic_clock
    "infinity" -> R.drawable.rovenue_ic_infinity
    "cloud" -> R.drawable.rovenue_ic_cloud
    "arrow-right" -> R.drawable.rovenue_ic_arrow_right
    else -> null
}

/**
 * Decodes a node's `overrides` array, if present. An unknown `when.kind`
 * decodes to [OverrideConditionKind.UNKNOWN] with `props` left `null` —
 * this entry is retained in the array but can never become active (see
 * `applyOverrides` in PaywallOverrides.kt), and its `props` value is
 * deliberately NOT parsed/validated (lenient — matches the acceptLenient
 * fixture, which pairs an unknown kind with otherwise-valid props). A
 * KNOWN kind's `props` IS parsed via [parseProps], which throws on any
 * non-whitelisted key — that failure propagates up and fails the WHOLE
 * config decode, per the reject fixture.
 */
private fun <T> JsonObject.parseOverrideList(parseProps: (JsonObject) -> T): List<NodeOverride<T>>? {
    val raw = this["overrides"] ?: return null
    val arr = raw as? JsonArray ?: throw BuilderDecodeException("overrides must be an array")
    return arr.map { el ->
        val entry = el as? JsonObject ?: throw BuilderDecodeException("override entry must be an object")
        val whenObj = entry["when"] as? JsonObject ?: throw BuilderDecodeException("override.when must be an object")
        when (whenObj.requireString("kind")) {
            "introEligible" -> NodeOverride(OverrideConditionKind.INTRO_ELIGIBLE, parseProps(entry.requirePropsObject()))
            "selected" -> NodeOverride(OverrideConditionKind.SELECTED, parseProps(entry.requirePropsObject()))
            else -> NodeOverride(OverrideConditionKind.UNKNOWN, null)
        }
    }
}

private fun JsonObject.requirePropsObject(): JsonObject =
    this["props"] as? JsonObject ?: throw BuilderDecodeException("override.props must be an object")

private fun parseAction(obj: JsonObject): ButtonAction = when (val kind = obj.requireString("kind")) {
    "close" -> ButtonAction.Close
    "restore" -> ButtonAction.Restore
    "url" -> ButtonAction.Url(obj.requireString("url"))
    else -> throw BuilderDecodeException("unknown button action kind \"$kind\"")
}

private fun parseThemePair(obj: JsonObject): ThemePair =
    ThemePair(light = obj.requireString("light"), dark = obj.optionalString("dark"))

/** Both `width` and `color` are required — a border missing either fails
 *  the whole config decode, same "structural defect on a KNOWN type"
 *  contract every other malformed field on a known node type already has
 *  (mirrors Swift's `NodeBorder`, whose two fields are non-optional). */
private fun parseNodeBorder(obj: JsonObject): NodeBorder = NodeBorder(
    width = obj.optionalDouble("width") ?: throw BuilderDecodeException("border.width required"),
    color = obj["color"]?.letObject(::parseThemePair) ?: throw BuilderDecodeException("border.color required"),
)

private fun parseNodeSize(el: kotlinx.serialization.json.JsonElement): NodeSize {
    val prim = el as? JsonPrimitive ?: throw BuilderDecodeException("NodeSize must be a string or number")
    if (prim.isString) {
        return when (prim.content) {
            "fit" -> NodeSize.Fit
            "fill" -> NodeSize.Fill
            else -> throw BuilderDecodeException("NodeSize string must be \"fit\" or \"fill\"")
        }
    }
    return NodeSize.Value(
        prim.doubleOrNull ?: throw BuilderDecodeException("NodeSize must be \"fit\", \"fill\", or a number"),
    )
}

// ----- JsonObject helpers -----

private fun JsonObject.requireString(key: String): String {
    val prim = this[key] as? JsonPrimitive
    if (prim == null || !prim.isString) throw BuilderDecodeException("$key must be a string")
    return prim.content
}

private fun JsonObject.optionalString(key: String): String? {
    val el = this[key] ?: return null
    val prim = el as? JsonPrimitive ?: throw BuilderDecodeException("$key must be a string")
    if (!prim.isString) {
        if (prim.content == "null") return null
        throw BuilderDecodeException("$key must be a string")
    }
    return prim.content
}

private fun JsonObject.optionalDouble(key: String): Double? {
    val el = this[key] ?: return null
    val prim = el as? JsonPrimitive ?: throw BuilderDecodeException("$key must be a number")
    if (prim.content == "null") return null
    return prim.doubleOrNull ?: throw BuilderDecodeException("$key must be a number")
}

private fun JsonObject.optionalBoolean(key: String): Boolean? {
    val el = this[key] ?: return null
    val prim = el as? JsonPrimitive ?: throw BuilderDecodeException("$key must be a boolean")
    if (prim.content == "null") return null
    return prim.booleanOrNull ?: throw BuilderDecodeException("$key must be a boolean")
}

private fun <T> JsonObject.requireEnum(key: String, mapping: Map<String, T>): T {
    val raw = requireString(key)
    return mapping[raw] ?: throw BuilderDecodeException("$key has invalid value \"$raw\"")
}

private fun JsonObject.optionalAlign(): HAlign? {
    val el = this["align"] ?: return null
    val prim = el as? JsonPrimitive ?: throw BuilderDecodeException("align must be a string")
    return when (prim.content) {
        "start" -> HAlign.START
        "center" -> HAlign.CENTER
        "end" -> HAlign.END
        else -> throw BuilderDecodeException("align has invalid value \"${prim.content}\"")
    }
}

private fun <T> kotlinx.serialization.json.JsonElement.letObject(block: (JsonObject) -> T): T {
    val obj = this as? JsonObject ?: throw BuilderDecodeException("expected an object")
    return block(obj)
}
