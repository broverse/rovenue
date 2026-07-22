package dev.rovenue.sdk.paywallui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import java.io.File

/**
 * Asserts the Kotlin decoder against the SHARED cross-platform contract
 * file (packages/shared/src/paywall/render-fixtures.json) — the same file
 * the TS schema tests and the Swift decoder tests consume. See the
 * fixture's `_comment` for the strict-schema vs lenient-decoder asymmetry.
 */
class BuilderConfigModelTest {
    private val fixture: JsonObject by lazy {
        val candidates = listOf(
            File("../shared/src/paywall/render-fixtures.json"),
            File("../../packages/shared/src/paywall/render-fixtures.json"),
        )
        val file = candidates.firstOrNull { it.exists() }
            ?: error(
                "render-fixtures.json not found (cwd=${File(".").absolutePath}); " +
                    "expected at ../shared/src/paywall/ relative to packages/sdk-kotlin",
            )
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun section(name: String): JsonArray = fixture[name]!!.jsonArray

    private fun configJson(entry: JsonObject): String = entry["config"]!!.toString()

    private fun name(entry: JsonObject): String = entry["name"]!!.jsonPrimitive.content

    @Test
    fun `every accept fixture decodes`() {
        for (el in section("accept")) {
            val entry = el.jsonObject
            assertNotNull(decodeBuilderConfig(configJson(entry)), "accept should decode: ${name(entry)}")
        }
    }

    @Test
    fun `every acceptLenient fixture decodes`() {
        // Not every acceptLenient entry contains an Unknown NODE — the
        // "override with unknown when.kind" entry is lenient about an
        // override CONDITION kind instead (see the dedicated test below),
        // so this only asserts the shared "decodes, never null" contract;
        // node-retention is asserted per-entry.
        for (el in section("acceptLenient")) {
            val entry = el.jsonObject
            assertNotNull(decodeBuilderConfig(configJson(entry)), "acceptLenient should decode: ${name(entry)}")
        }
    }

    @Test
    fun `unknown node type entries retain an Unknown node`() {
        for (el in section("acceptLenient")) {
            val entry = el.jsonObject
            if (name(entry).startsWith("override with unknown when.kind")) continue
            val config = decodeBuilderConfig(configJson(entry))
            assertNotNull(config, "acceptLenient should decode: ${name(entry)}")
            assertTrue(
                containsUnknown(config.root),
                "expected an Unknown node in: ${name(entry)}",
            )
        }
    }

    @Test
    fun `unknown node retains its fallback subtree`() {
        val entry = section("acceptLenient").first().jsonObject
        val config = decodeBuilderConfig(configJson(entry))!!
        val unknown = firstUnknown(config.root)
        assertNotNull(unknown, "unknown node present")
        assertNotNull(unknown.fallback, "fallback retained on the unknown node")
        assertTrue(unknown.fallback is BuilderNode.Text)
    }

    @Test
    fun `every reject fixture yields null`() {
        for (el in section("reject")) {
            val entry = el.jsonObject
            assertNull(decodeBuilderConfig(configJson(entry)), "reject should be null: ${name(entry)}")
        }
    }

    @Test
    fun `invalid json yields null`() {
        assertNull(decodeBuilderConfig("not-json{"))
        assertNull(decodeBuilderConfig("[]"))
    }

    @Test
    fun `canonical accept config maps fields faithfully`() {
        val entry = section("accept").first().jsonObject
        val config = decodeBuilderConfig(configJson(entry))!!
        assertEquals(2, config.formatVersion)
        assertEquals("en", config.defaultLocale)
        assertEquals("Go Pro", config.localizations["en"]!!["title_1"])
        assertEquals(Axis.V, config.root.axis)
        assertTrue(config.root.children.any { it is BuilderNode.PackageList })
        assertTrue(config.root.children.any { it is BuilderNode.PurchaseButton })
    }

    @Test
    fun `variables vectors match`() {
        for (el in section("variables")) {
            val v = el.jsonObject
            val text = v["text"]!!.jsonPrimitive.content
            val expected = v["expected"]!!.jsonPrimitive.content
            val pkg = (v["pkg"] as? JsonObject)?.let {
                PackageView(
                    packageName = it["packageName"]!!.jsonPrimitive.content,
                    price = it["price"]!!.jsonPrimitive.content,
                    pricePerPeriod = it["pricePerPeriod"]!!.jsonPrimitive.content,
                    period = it["period"]!!.jsonPrimitive.content,
                    pricePerDay = it["pricePerDay"]?.jsonPrimitive?.content,
                    pricePerWeek = it["pricePerWeek"]?.jsonPrimitive?.content,
                    pricePerMonth = it["pricePerMonth"]?.jsonPrimitive?.content,
                    pricePerYear = it["pricePerYear"]?.jsonPrimitive?.content,
                    introPrice = it["introPrice"]?.jsonPrimitive?.content,
                    introPeriod = it["introPeriod"]?.jsonPrimitive?.content,
                    relativeDiscount = it["relativeDiscount"]?.jsonPrimitive?.content,
                )
            }
            assertEquals(expected, resolveVariables(text, pkg), "text=$text")
        }
    }

    // ---- Phase D2: overrides / cellTemplate -------------------------------

    private fun entryNamed(sectionName: String, name: String): JsonObject =
        section(sectionName).map { it.jsonObject }.first { name(it) == name }

    private fun entryWithNamePrefix(sectionName: String, prefix: String): JsonObject =
        section(sectionName).map { it.jsonObject }.first { name(it).startsWith(prefix) }

    @Test
    fun `override with unknown when-kind is retained but never matching`() {
        // Pins render-fixtures.json's acceptLenient case: the strict schema
        // rejects the whole config, but platform decoders decode leniently,
        // skipping ONLY this override entry's activation (never its
        // presence) per the unknown-condition-kind rule.
        val entry = entryWithNamePrefix("acceptLenient", "override with unknown when.kind")
        val config = decodeBuilderConfig(configJson(entry))!!
        val root = config.root
        val title = root.children[0] as BuilderNode.Text
        val overrides = title.overrides!!
        assertEquals(2, overrides.size, "the unknown-kind entry is RETAINED, not dropped")
        assertEquals(OverrideConditionKind.INTRO_ELIGIBLE, overrides[0].whenKind)
        assertEquals(HAlign.CENTER, overrides[0].props?.align)
        assertEquals(OverrideConditionKind.UNKNOWN, overrides[1].whenKind, "\"sizeClass\" is not a known condition kind")
        assertNull(overrides[1].props, "props are not decoded/validated for an unknown when.kind")

        // Never matches, regardless of the active condition set.
        val result = applyOverrides(title, OverrideActiveConditions(introEligible = true, selected = true))
        assertEquals(HAlign.CENTER, result.align, "only the KNOWN introEligible override is ever active")
    }

    @Test
    fun `structural key inside known-kind override props fails whole config decode`() {
        // Pins render-fixtures.json's reject case: `type` inside a
        // `when.kind: "introEligible"` override's `props` must fail the
        // WHOLE config decode (not just be dropped/ignored), since
        // introEligible IS a known kind.
        val entry = entryNamed("reject", "structural key 'type' inside override props on a known when.kind")
        assertNull(decodeBuilderConfig(configJson(entry)))
    }

    @Test
    fun `packageList cellTemplate decodes recursively`() {
        val entry = entryNamed(
            "accept",
            "packageList with cellTemplate (visual nodes only, selected-condition badge)",
        )
        val config = decodeBuilderConfig(configJson(entry))!!
        val list = config.root.children[0] as BuilderNode.PackageList
        val cellRoot = list.cellTemplate as BuilderNode.Stack
        assertEquals("cell_root", cellRoot.id)
        assertEquals(3, cellRoot.children.size)
        val cellRootOverrides = cellRoot.overrides!!
        assertEquals(OverrideConditionKind.SELECTED, cellRootOverrides.first().whenKind)
        assertEquals(ThemePair("#EEF2FF", null), cellRootOverrides.first().props?.background)
        val badge = cellRoot.children[1] as BuilderNode.Text
        assertEquals(ThemePair("#4338CA", null), badge.overrides?.first()?.props?.color)
    }

    @Test
    fun `overrides across node types decode with typed props`() {
        val entry = entryNamed(
            "accept",
            "overrides: introEligible + selected across node types, incl. a text key-swap",
        )
        val config = decodeBuilderConfig(configJson(entry))!!
        val root = config.root
        assertEquals(4.0, root.overrides?.first()?.props?.spacing)

        val title = root.children[1] as BuilderNode.Text
        assertEquals("title_key_intro", title.overrides?.first()?.props?.key)

        val cta = root.children[2] as BuilderNode.Button
        assertEquals("cta_key_selected", cta.overrides?.first()?.props?.labelKey)
        assertEquals(ButtonVisualStyle.SECONDARY, cta.overrides?.first()?.props?.style)
    }

    @Test
    fun `resolveText vectors match against accept0`() {
        val config = decodeBuilderConfig(configJson(section("accept").first().jsonObject))!!
        for (el in section("resolveText")) {
            val v = el.jsonObject
            val locale = v["locale"]!!.jsonPrimitive.content
            val key = v["key"]!!.jsonPrimitive.content
            val expectedEl = v["expected"]!!
            val expected =
                if (expectedEl is JsonPrimitive && expectedEl.isString) expectedEl.content else null
            assertEquals(expected, resolveText(config, locale, key), "$locale/$key")
        }
    }

    private fun containsUnknown(node: BuilderNode): Boolean = when (node) {
        is BuilderNode.Unknown -> true
        is BuilderNode.Stack -> node.children.any(::containsUnknown)
        else -> false
    }

    private fun firstUnknown(node: BuilderNode): BuilderNode.Unknown? = when (node) {
        is BuilderNode.Unknown -> node
        is BuilderNode.Stack -> node.children.firstNotNullOfOrNull(::firstUnknown)
        else -> null
    }
}
