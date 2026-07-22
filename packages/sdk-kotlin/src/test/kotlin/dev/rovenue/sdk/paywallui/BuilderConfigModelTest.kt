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
    fun `every acceptLenient fixture decodes with unknown nodes retained`() {
        for (el in section("acceptLenient")) {
            val entry = el.jsonObject
            val config = decodeBuilderConfig(configJson(entry))
            assertNotNull(config, "acceptLenient should decode: ${name(entry)}")
            assertTrue(
                containsUnknown(config!!.root),
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
        assertNotNull(unknown!!.fallback, "fallback retained on the unknown node")
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
                )
            }
            assertEquals(expected, resolveVariables(text, pkg), "text=$text")
        }
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
