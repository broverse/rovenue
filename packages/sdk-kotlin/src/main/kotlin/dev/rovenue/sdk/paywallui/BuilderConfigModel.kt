package dev.rovenue.sdk.paywallui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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

sealed class ButtonAction {
    object Close : ButtonAction()
    object Restore : ButtonAction()
    data class Url(val url: String) : ButtonAction()
}

sealed class BuilderNode {
    abstract val id: String
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
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Text(
        override val id: String,
        val key: String,
        val role: TextRole,
        val color: ThemePair? = null,
        val align: HAlign? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Image(
        override val id: String,
        val url: ThemePair,
        val height: Double? = null,
        val cornerRadius: Double? = null,
        val alt: String? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Button(
        override val id: String,
        val labelKey: String,
        val style: ButtonVisualStyle,
        val action: ButtonAction,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class PackageList(
        override val id: String,
        val packageIds: List<String>,
        val defaultSelected: String? = null,
        val cellLayout: CellLayout,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class PurchaseButton(
        override val id: String,
        val labelKey: String,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Spacer(
        override val id: String,
        val size: Double? = null,
        override val fallback: BuilderNode? = null,
    ) : BuilderNode()

    data class Unknown(
        override val id: String,
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
            fallback = fallback,
        )
        "image" -> BuilderNode.Image(
            id = id,
            url = obj["url"]?.letObject(::parseThemePair)
                ?: throw BuilderDecodeException("image.url required"),
            height = obj.optionalDouble("height"),
            cornerRadius = obj.optionalDouble("cornerRadius"),
            alt = obj.optionalString("alt"),
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
            fallback = fallback,
        )
        "purchaseButton" -> BuilderNode.PurchaseButton(
            id = id,
            labelKey = obj.requireString("labelKey"),
            fallback = fallback,
        )
        "spacer" -> BuilderNode.Spacer(id = id, size = obj.optionalDouble("size"), fallback = fallback)
        // Lenient branch: unknown types keep id + fallback and never fail
        // the decode. The fallback subtree itself is still parsed strictly.
        else -> BuilderNode.Unknown(id = id, fallback = fallback)
    }
}

private fun parseAction(obj: JsonObject): ButtonAction = when (val kind = obj.requireString("kind")) {
    "close" -> ButtonAction.Close
    "restore" -> ButtonAction.Restore
    "url" -> ButtonAction.Url(obj.requireString("url"))
    else -> throw BuilderDecodeException("unknown button action kind \"$kind\"")
}

private fun parseThemePair(obj: JsonObject): ThemePair =
    ThemePair(light = obj.requireString("light"), dark = obj.optionalString("dark"))

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
