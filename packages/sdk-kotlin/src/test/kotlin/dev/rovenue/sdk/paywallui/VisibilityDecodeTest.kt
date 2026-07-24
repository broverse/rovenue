package dev.rovenue.sdk.paywallui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The evaluator vectors build [Visibility] objects by hand and the
 * render-fixtures `accept` cases only assert a non-null decode, so the
 * DECODER's lenient retention of `visibility` — every node type, unknown
 * platform strings dropped, all-dropped/empty folded to null — was
 * untested through the real JSON path. A decoder that dropped the field on
 * one node type or kept an unknown platform would pass every other test.
 */
class VisibilityDecodeTest {
    private fun rootWith(child: String): String =
        """{"formatVersion":2,"defaultLocale":"en","localizations":{"en":{"k":"x"}},
           "root":{"type":"stack","id":"root","axis":"v","children":[$child]}}"""

    private fun firstChild(json: String): BuilderNode {
        val model = decodeBuilderConfig(json)
        assertNotNull(model, "decode returned null for: $json")
        return model.root.children.first()
    }

    @Test
    fun keepsValidPlatformAndBounds() {
        val node = firstChild(rootWith(
            """{"type":"text","id":"t","key":"k","role":"body",
               "visibility":{"platform":["ios"],"minAppVersion":"1.0","maxAppVersion":"2.0"}}"""))
        assertEquals(listOf("ios"), node.visibility?.platform)
        assertEquals("1.0", node.visibility?.minAppVersion)
        assertEquals("2.0", node.visibility?.maxAppVersion)
    }

    @Test
    fun dropsUnknownPlatformStringLeniently() {
        val node = firstChild(rootWith(
            """{"type":"text","id":"t","key":"k","role":"body","visibility":{"platform":["ios","tvos"]}}"""))
        assertEquals(listOf("ios"), node.visibility?.platform)
    }

    @Test
    fun collapsesAllDroppedOrEmptyPlatformListToNull() {
        val allDropped = firstChild(rootWith(
            """{"type":"text","id":"t","key":"k","role":"body","visibility":{"platform":["tvos"]}}"""))
        assertNull(allDropped.visibility?.platform)
        val empty = firstChild(rootWith(
            """{"type":"text","id":"t","key":"k","role":"body","visibility":{"platform":[]}}"""))
        assertNull(empty.visibility?.platform)
    }

    @Test
    fun retainsVisibilityOnEverySevenNodeTypes() {
        val nodes = mapOf(
            "stack" to """{"type":"stack","id":"n","axis":"v","children":[]""",
            "text" to """{"type":"text","id":"n","key":"k","role":"body"""",
            "image" to """{"type":"image","id":"n","url":{"light":"u"}""",
            "button" to """{"type":"button","id":"n","labelKey":"k","style":"primary","action":{"kind":"restore"}""",
            "packageList" to """{"type":"packageList","id":"n","packageIds":[],"cellLayout":"row"""",
            "purchaseButton" to """{"type":"purchaseButton","id":"n","labelKey":"k"""",
            "spacer" to """{"type":"spacer","id":"n","size":4""",
        )
        for ((type, prefix) in nodes) {
            val node = firstChild(rootWith("""$prefix,"visibility":{"platform":["ios"]}}"""))
            assertEquals(listOf("ios"), node.visibility?.platform, "visibility dropped on $type")
        }
    }

    @Test
    fun noVisibilityDecodesToNull() {
        val node = firstChild(rootWith("""{"type":"text","id":"t","key":"k","role":"body"}"""))
        assertNull(node.visibility)
    }

    /**
     * The contract's forward-compat case: an unknown node `type` carrying
     * `visibility`. Dropping it would render the fallback on a platform the
     * author excluded. Driven off the shared fixture so all three native
     * decoders are held to the same entry.
     */
    @Test
    fun retainsVisibilityOnAnUnknownNodeType() {
        val fixture = java.io.File("../shared/src/paywall/render-fixtures.json")
            .takeIf { it.exists() }
            ?: java.io.File("../../packages/shared/src/paywall/render-fixtures.json")
        val root = kotlinx.serialization.json.Json.parseToJsonElement(fixture.readText())
        val entry = root.jsonObject["acceptLenient"]!!.jsonArray.first {
            it.jsonObject["name"]!!.jsonPrimitive.content.startsWith("unknown node type carrying visibility")
        }
        val model = decodeBuilderConfig(entry.jsonObject["config"]!!.toString())
        assertNotNull(model)
        val unknown = (model.root as BuilderNode.Stack).children.first()
        assertTrue(unknown is BuilderNode.Unknown, "expected the node to decode as Unknown")
        assertEquals(listOf("ios"), unknown.visibility?.platform)
    }
}
