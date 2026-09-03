package dev.rovenue.sdk.paywallui

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
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

    // ---- divider / icon nodes ---------------------------------------------
    // Both types now have dedicated render-fixtures.json accept entries (they
    // used to predate the fixture, same gap featureList/timeline/socialProof
    // had — see the node-type union coverage test in render-fixtures.test.ts).
    // `rootWith`/`firstChild` stay for the one case that genuinely isn't part
    // of the cross-platform contract: an UNKNOWN icon name still decoding.

    private fun rootWith(child: String): String =
        """{"formatVersion":2,"defaultLocale":"en","localizations":{"en":{"k":"x"}},
           "root":{"type":"stack","id":"root","axis":"v","children":[$child]}}"""

    private fun firstChild(json: String): BuilderNode {
        val model = decodeBuilderConfig(json)
        assertNotNull(model, "decode returned null for: $json")
        return model.root.children.first()
    }

    @Test
    fun decodesDivider() {
        val entry = entryNamed("accept", "divider: explicit color/thickness/inset, and a bare default-styled hairline")
        val config = decodeBuilderConfig(configJson(entry))!!
        val custom = config.root.children[0] as BuilderNode.Divider
        assertEquals(4.0, custom.thickness)
        assertEquals(8.0, custom.inset)
        assertEquals("#FF0000", custom.color?.light)
        val default = config.root.children[1] as BuilderNode.Divider
        assertNull(default.thickness)
        assertNull(default.color)
    }

    @Test
    fun decodesIconSizeAndColor() {
        val entry = entryNamed("accept", "icon: explicit size/color, and a bare default-size uncolored icon")
        val config = decodeBuilderConfig(configJson(entry))!!
        val custom = config.root.children[0] as BuilderNode.Icon
        assertEquals("star", custom.name)
        assertEquals(32.0, custom.size)
        assertEquals("#F59E0B", custom.color?.light)
        val default = config.root.children[1] as BuilderNode.Icon
        assertEquals("check", default.name)
        assertNull(default.size)
        assertNull(default.color)
    }

    @Test
    fun decodesIconWithAnUnknownNameWithoutThrowing() {
        // Not part of the cross-platform fixture contract: `icon.name` is a
        // free string by design (see BuilderConfigModel.kt's Icon doc), so a
        // fabricated/future name must still decode -- resolution/fail-open
        // happens later, at render time (`drawableResFor`).
        val unknown = firstChild(rootWith("""{"type":"icon","id":"i2","name":"not-real"}"""))
        assertEquals("not-real", (unknown as BuilderNode.Icon).name)
    }

    // ---- carousel node --------------------------------------------------

    /** The named `accept` fixture's root's first child, decoded. Select fixture
     *  entries BY NAME, never by index -- a previous wave widened this file and
     *  silently broke two Kotlin tests in this module that assumed a position. */
    private fun decodeFixtureNode(entryName: String): BuilderNode {
        val entry = entryNamed("accept", entryName)
        val config = decodeBuilderConfig(configJson(entry))!!
        return config.root.children.first()
    }

    private fun fixtureDefaults(): JsonObject = fixture["defaults"]!!.jsonObject

    @Test
    fun `decodes the bare carousel from the shared fixture`() {
        val node = decodeFixtureNode("carousel-bare")
        assertTrue(node is BuilderNode.Carousel)
        assertEquals(2, (node as BuilderNode.Carousel).children.size)
        assertNull(node.showsIndicator)
        assertNull(node.autoAdvanceSeconds)
        assertNull(node.loop)
        assertNull(node.indicatorColor)
    }

    @Test
    fun `decodes the full carousel from the shared fixture`() {
        val node = decodeFixtureNode("carousel-full") as BuilderNode.Carousel
        assertEquals(2, node.children.size)
        assertEquals(false, node.showsIndicator)
        assertEquals(5.0, node.autoAdvanceSeconds)
        assertEquals(true, node.loop)
        assertEquals("#111111", node.indicatorColor?.light)
        assertEquals("#EEEEEE", node.indicatorColor?.dark)
    }

    // ---- video / lottie nodes (wave D2) -----------------------------------
    // Selected BY NAME through `decodeFixtureNode`, never by index — see its
    // doc for the position-assumption breakage that rule exists to prevent.

    @Test
    fun `decodes the bare video from the shared fixture`() {
        val node = decodeFixtureNode("video-bare")
        assertTrue(node is BuilderNode.Video)
        // Every optional stays NULL rather than being pre-resolved at decode
        // time: which default a bare field takes is the RENDERER's decision
        // (VIDEO_DEFAULT_*), and baking it in here would make the absent and
        // the explicitly-authored cases indistinguishable downstream.
        assertNull((node as BuilderNode.Video).autoplay)
        assertEquals("https://x/a.mp4", node.url.light)
        assertNull(node.url.dark)
        assertNull(node.posterUrl)
        assertNull(node.loop)
        assertNull(node.muted)
        assertNull(node.showsControls)
        assertNull(node.aspectRatio)
    }

    @Test
    fun `decodes the full video from the shared fixture`() {
        val node = decodeFixtureNode("video-full") as BuilderNode.Video
        assertEquals("https://x/a.mp4", node.url.light)
        assertEquals("https://x/a-dark.mp4", node.url.dark)
        assertEquals("https://x/poster.png", node.posterUrl?.light)
        assertEquals("https://x/poster-dark.png", node.posterUrl?.dark)
        assertEquals(false, node.autoplay)
        assertEquals(false, node.loop)
        assertEquals(false, node.muted)
        assertEquals(true, node.showsControls)
        assertEquals(1.777, node.aspectRatio)
    }

    @Test
    fun `decodes the bare lottie from the shared fixture`() {
        val node = decodeFixtureNode("lottie-bare")
        assertTrue(node is BuilderNode.Lottie)
        assertEquals("https://x/a.json", (node as BuilderNode.Lottie).url.light)
        assertNull(node.url.dark)
        assertNull(node.loop)
        assertNull(node.autoplay)
        assertNull(node.speed)
    }

    @Test
    fun `decodes the full lottie from the shared fixture`() {
        val node = decodeFixtureNode("lottie-full") as BuilderNode.Lottie
        assertEquals("https://x/a.json", node.url.light)
        assertEquals("https://x/a-dark.json", node.url.dark)
        assertEquals(false, node.loop)
        assertEquals(false, node.autoplay)
        assertEquals(2.0, node.speed)
    }

    @Test
    fun everyRegistryIconHasADrawable() {
        val registry = java.io.File("../shared/src/paywall/icon-registry.json")
            .takeIf { it.exists() } ?: java.io.File("../../packages/shared/src/paywall/icon-registry.json")
        val names = kotlinx.serialization.json.Json
            .parseToJsonElement(registry.readText()).jsonObject["icons"]!!.jsonArray
            .map { it.jsonObject["name"]!!.jsonPrimitive.content }
        for (n in names) {
            // `assertNotNull(drawableResFor(n))` alone would pass for any name
            // present in the `when` branch whether or not the backing XML
            // actually exists on disk — a JVM unit test never sees a real `R`
            // that could fail to resolve a stale resource name. Assert the
            // vendored file is really there too (the files are right there on
            // disk to check).
            assertNotNull(drawableResFor(n), "no drawable resource mapped for $n")
            val drawableFile = java.io.File("src/main/res/drawable/rovenue_ic_${n.replace('-', '_')}.xml")
                .takeIf { it.exists() }
                ?: java.io.File("packages/sdk-kotlin/src/main/res/drawable/rovenue_ic_${n.replace('-', '_')}.xml")
            assertTrue(drawableFile.exists(), "no vendored drawable file for $n at ${drawableFile.path}")
        }
    }

    // `star_border` is deliberately NOT in icon-registry.json (see
    // BuilderConfigModel.kt's drawableResFor doc) — it's not an author-facing
    // icon name, only buildSocialProof's internal unfilled-star mark. Same
    // disk-existence check as the loop above, just outside the registry.
    @Test
    fun starBorderDrawableIsVendoredForTheUnfilledSocialProofStar() {
        assertNotNull(drawableResFor("star_border"))
        val drawableFile = java.io.File("src/main/res/drawable/rovenue_ic_star_border.xml")
            .takeIf { it.exists() }
            ?: java.io.File("packages/sdk-kotlin/src/main/res/drawable/rovenue_ic_star_border.xml")
        assertTrue(drawableFile.exists(), "no vendored drawable file for star_border at ${drawableFile.path}")
    }

    // ---- featureList / timeline / socialProof nodes -----------------------
    // Driven off render-fixtures.json now — these three used to predate the
    // shared fixture (same gap divider/icon had above).

    @Test
    fun decodesFeatureListRows() {
        val entry = entryNamed("accept", "featureList: multi-row with a mix of included values")
        val config = decodeBuilderConfig(configJson(entry))!!
        val p = config.root.children[0] as BuilderNode.FeatureList
        assertEquals(3, p.rows.size)
        assertEquals(true, p.rows[0].included)
        assertEquals(false, p.rows[1].included)
        assertNull(p.rows[2].included)
    }

    @Test
    fun decodesTimelineCaptions() {
        val entry = entryNamed("accept", "timeline: rows with and without captions")
        val config = decodeBuilderConfig(configJson(entry))!!
        val p = config.root.children[0] as BuilderNode.Timeline
        assertEquals("t1c", p.rows[0].captionKey)
        assertNull(p.rows[1].captionKey)
        assertEquals("t3c", p.rows[2].captionKey)
    }

    @Test
    fun decodesSocialProofRating() {
        val withRating = entryNamed("accept", "socialProof: with a fractional rating")
        val configWithRating = decodeBuilderConfig(configJson(withRating))!!
        val withP = configWithRating.root.children[0] as BuilderNode.SocialProof
        assertEquals(4.5, withP.rating)

        val withoutRating = entryNamed("accept", "socialProof: without a rating (no stars)")
        val configWithoutRating = decodeBuilderConfig(configJson(withoutRating))!!
        val withoutP = configWithoutRating.root.children[0] as BuilderNode.SocialProof
        assertNull(withoutP.rating)
    }

    @Test
    fun decodesStickyFooterChildren() {
        val node = firstChild(rootWith("""{"type":"stickyFooter","id":"sf","children":[{"type":"spacer","id":"s1","size":8}]}"""))
        assertTrue(node is BuilderNode.StickyFooter)
        assertEquals(1, (node as BuilderNode.StickyFooter).children.size)
    }

    @Test
    fun decodesCountdownBothModes() {
        val abs = firstChild(rootWith("""{"type":"countdown","id":"c1","endsAt":"2027-01-01T00:00:00Z"}"""))
        assertEquals("2027-01-01T00:00:00Z", (abs as BuilderNode.Countdown).endsAt)
        val dur = firstChild(rootWith("""{"type":"countdown","id":"c2","durationSeconds":900}"""))
        assertEquals(900.0, (dur as BuilderNode.Countdown).durationSeconds)
    }

    @Test
    fun `stickyFooter fixture decode matches the shared cross-platform contract`() {
        val entry = entryNamed("accept", "stickyFooter: pinned footer with a nested purchaseButton")
        val config = decodeBuilderConfig(configJson(entry))!!
        val footer = config.root.children[0] as BuilderNode.StickyFooter
        assertEquals("#FFFFFF", footer.background?.light)
        assertEquals("#111827", footer.background?.dark)
        assertEquals(1, footer.children.size)
        assertTrue(footer.children[0] is BuilderNode.PurchaseButton)
    }

    @Test
    fun `countdown fixture decode matches the shared cross-platform contract`() {
        val entry = entryNamed("accept", "countdown: absolute deadline with a label and onExpiry")
        val config = decodeBuilderConfig(configJson(entry))!!
        val countdown = config.root.children[0] as BuilderNode.Countdown
        assertEquals("2027-01-01T00:00:00.000Z", countdown.endsAt)
        assertNull(countdown.durationSeconds)
        assertEquals(CountdownOnExpiry.FREEZE, countdown.onExpiry)
        assertEquals("cd.label", countdown.labelKey)
        assertEquals("#111111", countdown.color?.light)
        assertEquals("#EEEEEE", countdown.color?.dark)
    }

    @Test
    fun `stickyFooter override background decode retention`() {
        val node = firstChild(
            rootWith(
                """{"type":"stickyFooter","id":"sf","children":[],
                   "overrides":[{"when":{"kind":"selected"},"props":{"background":{"light":"#000000"}}}]}""",
            ),
        )
        val footer = node as BuilderNode.StickyFooter
        assertEquals("#000000", footer.overrides!!.first().props?.background?.light)
    }

    @Test
    fun `countdown override color decode retention`() {
        val node = firstChild(
            rootWith(
                """{"type":"countdown","id":"cd","endsAt":"2027-01-01T00:00:00Z",
                   "overrides":[{"when":{"kind":"introEligible"},"props":{"color":{"light":"#ABCDEF"}}}]}""",
            ),
        )
        val countdown = node as BuilderNode.Countdown
        assertEquals("#ABCDEF", countdown.overrides!!.first().props?.color?.light)
    }

    /**
     * The excluded-mark test that must assert WHICH icon resolves, not
     * merely that one resolved — `assertNotNull(drawableResFor(...))` alone
     * would pass even if the excluded branch were wrongly wired to the
     * included default, since both `check` and `x` are real, vendored
     * drawables. Mutation-checked (see task report): forcing the excluded
     * branch to `FEATURE_ROW_DEFAULT_ICON` fails this test naming
     * `rovenue_ic_check` where `rovenue_ic_x` was expected.
     */
    @Test
    fun excludedFeatureRowResolvesToTheExcludedMarkNotTheDefault() {
        val excluded = FeatureRow(labelKey = "a", included = false)
        val resolvedName = resolvedFeatureRowIconName(excluded)
        assertEquals(
            drawableResFor("x"),
            drawableResFor(resolvedName),
            "an excluded row must resolve to the excluded mark \"x\", not the included default " +
                "-- resolved icon name was \"$resolvedName\"",
        )
    }

    @Test
    fun `includedFeatureRow resolves to the default included mark`() {
        val included = FeatureRow(labelKey = "a", included = true)
        assertEquals(drawableResFor("check"), drawableResFor(resolvedFeatureRowIconName(included)))
        val absent = FeatureRow(labelKey = "a")
        assertEquals(drawableResFor("check"), drawableResFor(resolvedFeatureRowIconName(absent)))
    }

    @Test
    fun `featureRow's own icon wins over the included-excluded default`() {
        val row = FeatureRow(labelKey = "a", icon = "star", included = false)
        assertEquals("star", resolvedFeatureRowIconName(row))
    }

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
        // Selected by name prefix, not by exclusion: `acceptLenient` also
        // carries entries whose leniency has nothing to do with an unknown
        // NODE (an unknown override CONDITION kind; a countdown carrying
        // both deadline props — both have dedicated tests below), and
        // "everything except the one I remembered" silently mis-asserts as
        // soon as the shared fixture grows another kind of lenient entry.
        val entries = section("acceptLenient").map { it.jsonObject }
            .filter { name(it).startsWith("unknown node type") }
        assertTrue(entries.isNotEmpty(), "acceptLenient carries unknown-node-type entries")
        for (entry in entries) {
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
        val entry = entryWithNamePrefix("acceptLenient", "unknown node type with valid fallback")
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

    // ---- node visibility ---------------------------------------------------

    /**
     * Conformance proof: runs the Kotlin `isNodeVisible` against every
     * `{ visibility, platform, appVersion, expected }` case in the shared
     * `visibility` vector table — the same table the TS schema tests and
     * the RN/Swift decoders are checked against. The Kotlin evaluator
     * must agree with all 13.
     */
    @Test
    fun `visibility vectors match`() {
        for (el in section("visibility")) {
            val v = el.jsonObject
            val caseName = name(v)
            val visibilityObj = v["visibility"]!!.jsonObject
            val platformList = (visibilityObj["platform"] as? JsonArray)
                ?.map { it.jsonPrimitive.content }
            val visibility = Visibility(
                platform = platformList,
                minAppVersion = (visibilityObj["minAppVersion"] as? JsonPrimitive)?.content,
                maxAppVersion = (visibilityObj["maxAppVersion"] as? JsonPrimitive)?.content,
            )
            val platformEl = v["platform"]
            val platform = if (platformEl is JsonPrimitive && platformEl.isString) platformEl.content else null
            val appVersionEl = v["appVersion"]
            val appVersion = if (appVersionEl is JsonPrimitive && appVersionEl.isString) appVersionEl.content else null
            val expected = v["expected"]!!.jsonPrimitive.content.toBoolean()

            assertEquals(expected, isNodeVisible(visibility, platform, appVersion), caseName)
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

    // ---- cross-platform default constants ---------------------------------

    private fun themePairFrom(el: JsonObject): ThemePair =
        ThemePair(
            light = el["light"]!!.jsonPrimitive.content,
            dark = (el["dark"] as? JsonPrimitive)?.content,
        )

    /**
     * Compares NodeViewFactory.kt's hand-mirrored defaults against
     * render-fixtures.json's `defaults` object (generated straight off
     * schema.ts's exported constants — see that file's generation note) BY
     * VALUE. A sync test that only checks "both exist" can never fail when
     * schema.ts's value changes and a native forgets to follow — this
     * compares the actual values, so editing the shared side without
     * touching NodeViewFactory.kt fails THIS test (mutation-checked in the
     * task report: flipping FEATURE_ROW_DEFAULT_ICON in schema.ts without
     * updating Kotlin fails this assertion by value).
     */
    @Test
    fun `native defaults match the shared fixture by value`() {
        val defaults = fixtureDefaults()
        assertEquals(DIVIDER_DEFAULT_THICKNESS_DP, defaults["DIVIDER_DEFAULT_THICKNESS"]!!.jsonPrimitive.double)
        assertEquals(DIVIDER_DEFAULT_INSET_DP, defaults["DIVIDER_DEFAULT_INSET"]!!.jsonPrimitive.double)
        assertEquals(DIVIDER_DEFAULT_COLOR, themePairFrom(defaults["DIVIDER_DEFAULT_COLOR"]!!.jsonObject))
        assertEquals(FEATURE_ROW_DEFAULT_ICON, defaults["FEATURE_ROW_DEFAULT_ICON"]!!.jsonPrimitive.content)
        assertEquals(FEATURE_ROW_EXCLUDED_ICON, defaults["FEATURE_ROW_EXCLUDED_ICON"]!!.jsonPrimitive.content)
        assertEquals(FEATURE_ROW_DEFAULT_INCLUDED, defaults["FEATURE_ROW_DEFAULT_INCLUDED"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(TIMELINE_ROW_DEFAULT_ICON, defaults["TIMELINE_ROW_DEFAULT_ICON"]!!.jsonPrimitive.content)
        assertEquals(
            TIMELINE_CONNECTOR_DEFAULT_COLOR,
            themePairFrom(defaults["TIMELINE_CONNECTOR_DEFAULT_COLOR"]!!.jsonObject),
        )
        assertEquals(
            SOCIAL_PROOF_STAR_DEFAULT_COLOR,
            themePairFrom(defaults["SOCIAL_PROOF_STAR_DEFAULT_COLOR"]!!.jsonObject),
        )
        assertEquals(SOCIAL_PROOF_MAX_RATING, defaults["SOCIAL_PROOF_MAX_RATING"]!!.jsonPrimitive.int)
        // The four wave-C keys. The key PREFIX is the cross-platform one:
        // this SDK's SharedPreferences key, the Swift SDK's UserDefaults key
        // and the web's localStorage key are the same string, so a paywall's
        // countdown anchor lives in the same named slot everywhere.
        assertEquals(
            COUNTDOWN_DEFAULT_ON_EXPIRY,
            countdownOnExpiryFrom(defaults["COUNTDOWN_DEFAULT_ON_EXPIRY"]!!.jsonPrimitive.content),
        )
        assertEquals(COUNTDOWN_TICK_MS, defaults["COUNTDOWN_TICK_MS"]!!.jsonPrimitive.long)
        assertEquals(
            COUNTDOWN_FIRST_SHOWN_KEY_PREFIX,
            defaults["COUNTDOWN_FIRST_SHOWN_AT_KEY_PREFIX"]!!.jsonPrimitive.content,
        )
        assertEquals(
            STICKY_FOOTER_DEFAULT_BACKGROUND,
            themePairFrom(defaults["STICKY_FOOTER_DEFAULT_BACKGROUND"]!!.jsonObject),
        )
        assertEquals(
            STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT_DP,
            defaults["STICKY_FOOTER_CONTENT_CLEARANCE_DEFAULT"]!!.jsonPrimitive.double,
        )
        // The three wave-D1 keys.
        assertEquals(
            CAROUSEL_DEFAULT_SHOWS_INDICATOR,
            defaults["CAROUSEL_DEFAULT_SHOWS_INDICATOR"]!!.jsonPrimitive.content.toBoolean(),
        )
        assertEquals(CAROUSEL_DEFAULT_LOOP, defaults["CAROUSEL_DEFAULT_LOOP"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(
            CAROUSEL_MIN_AUTO_ADVANCE_SECONDS,
            defaults["CAROUSEL_MIN_AUTO_ADVANCE_SECONDS"]!!.jsonPrimitive.int,
        )
        // The nine wave-D2 keys. Same by-value discipline: these are the
        // renderer's hand-mirrored copies of schema.ts, and this comparison
        // is the only thing standing between a shared-side edit and Android
        // quietly playing a clip with sound the author muted.
        assertEquals(VIDEO_DEFAULT_AUTOPLAY, defaults["VIDEO_DEFAULT_AUTOPLAY"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(VIDEO_DEFAULT_LOOP, defaults["VIDEO_DEFAULT_LOOP"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(VIDEO_DEFAULT_MUTED, defaults["VIDEO_DEFAULT_MUTED"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(
            VIDEO_DEFAULT_SHOWS_CONTROLS,
            defaults["VIDEO_DEFAULT_SHOWS_CONTROLS"]!!.jsonPrimitive.content.toBoolean(),
        )
        assertEquals(LOTTIE_DEFAULT_LOOP, defaults["LOTTIE_DEFAULT_LOOP"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(LOTTIE_DEFAULT_AUTOPLAY, defaults["LOTTIE_DEFAULT_AUTOPLAY"]!!.jsonPrimitive.content.toBoolean())
        assertEquals(LOTTIE_DEFAULT_SPEED, defaults["LOTTIE_DEFAULT_SPEED"]!!.jsonPrimitive.double)
        assertEquals(LOTTIE_MIN_SPEED, defaults["LOTTIE_MIN_SPEED"]!!.jsonPrimitive.double)
        assertEquals(LOTTIE_MAX_SPEED, defaults["LOTTIE_MAX_SPEED"]!!.jsonPrimitive.double)
    }

    private fun countdownOnExpiryFrom(raw: String): CountdownOnExpiry = when (raw) {
        "freeze" -> CountdownOnExpiry.FREEZE
        "hide" -> CountdownOnExpiry.HIDE
        else -> error("unknown onExpiry in the shared fixture: $raw")
    }

    /**
     * render-fixtures.json carries `endsAt` + `durationSeconds` TOGETHER as
     * an `acceptLenient` entry, deliberately not a `reject`: their
     * exclusivity is a TypeScript-only authoring `refine`, so a config
     * carrying both reaches the platform decoders intact and the
     * cross-platform contract is "decode it, and prefer `endsAt`".
     *
     * The anchor supplier fails the test if it is called at all — preferring
     * `endsAt` is not only about the resulting instant, it is also what
     * keeps an `endsAt` countdown off persistent storage entirely.
     */
    @Test
    fun `countdown carrying both deadline props decodes and prefers endsAt`() {
        val entry = entryWithNamePrefix("acceptLenient", "countdown carrying BOTH endsAt and durationSeconds")
        val config = decodeBuilderConfig(configJson(entry))!!
        val countdown = config.root.children[0] as BuilderNode.Countdown
        assertNotNull(countdown.endsAt, "endsAt survives the decode")
        assertNotNull(countdown.durationSeconds, "durationSeconds survives the decode too — neither is dropped")

        val deadline = countdownDeadlineMillis(countdown) {
            error("the anchor must not be read when endsAt is present")
        }
        assertEquals(parseIsoInstantMillis(countdown.endsAt!!), deadline)
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

    // ---- trialLabel (cross-platform render-fixtures.json vector table) ----
    // Task 12 — port of the web (56871833) and Swift (8dafb855 + 460ba634)
    // trial-aware purchase-button label contract.

    /**
     * Runs every `trialLabel` vector in render-fixtures.json through
     * [ctaLabelKey] — the Kotlin port of variables.ts's `resolveCtaLabelKey`
     * and Swift's `ctaLabelKey`. `selectedHasIntroPeriod` is the fixture's
     * boolean/null shorthand for a selection: `true` -> a selected package
     * mid-trial (`introPeriod` a non-empty string), `false` -> a selected
     * package with no trial (`introPeriod` null), `null` -> no selection at
     * all (`selectedView` null). Mirrors the Swift test's
     * `testTrialLabelVectorsAgreeWithSharedFixture`.
     */
    @Test
    fun `trialLabel vectors match`() {
        val cases = fixture["trialLabel"]!!.jsonObject["cases"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (el in cases) {
            val v = el.jsonObject
            val caseName = name(v)
            val labelKey = v["labelKey"]!!.jsonPrimitive.content
            val trialLabelKey = (v["trialLabelKey"] as? JsonPrimitive)?.content
            val expectedKey = v["expectedKey"]!!.jsonPrimitive.content
            val hasIntroPeriod = (v["selectedHasIntroPeriod"] as? JsonPrimitive)?.booleanOrNull
            val selectedView = if (hasIntroPeriod == null) {
                null
            } else {
                PackageView(
                    packageName = "", price = "", pricePerPeriod = "", period = "",
                    introPeriod = if (hasIntroPeriod) "1 week" else null,
                )
            }
            assertEquals(expectedKey, ctaLabelKey(labelKey, trialLabelKey, selectedView), caseName)
        }
    }

    /**
     * Empty-string `introPeriod` is explicitly NOT a trial — mirroring the
     * TS truthiness check (`selected.introPeriod !== ""`). Not represented
     * in the shared fixture (which only carries the boolean/null shorthand),
     * so pinned directly here, same as the Swift test.
     */
    @Test
    fun `empty-string introPeriod is not a trial`() {
        val selectedView = PackageView(packageName = "", price = "", pricePerPeriod = "", period = "", introPeriod = "")
        assertEquals("cta.buy", ctaLabelKey("cta.buy", "cta.trial", selectedView))
    }

    /**
     * Empty-string `trialLabelKey` is explicitly NOT a trial label, even
     * with a live trial selection — mirroring the TS truthiness check
     * (`node.trialLabelKey && hasIntroPeriod`), where an empty string is
     * falsy. Not represented in the shared fixture, so pinned directly
     * here, same as `empty-string introPeriod is not a trial`.
     */
    @Test
    fun `empty-string trialLabelKey is not a trial label`() {
        val selectedView =
            PackageView(packageName = "", price = "", pricePerPeriod = "", period = "", introPeriod = "1 week")
        assertEquals("cta.buy", ctaLabelKey("cta.buy", "", selectedView))
    }

    /**
     * Decode-retention: `trialLabelKey` present on the wire is retained on
     * [BuilderNode.PurchaseButton]; absent decodes to `null`.
     */
    @Test
    fun `purchaseButton trialLabelKey decode retention`() {
        val entry = entryNamed("accept", "purchaseButton with trialLabelKey (both keys present in default locale)")
        val config = decodeBuilderConfig(configJson(entry))!!
        val pb = config.root.children[0] as BuilderNode.PurchaseButton
        assertEquals("cta.buy", pb.labelKey)
        assertEquals("cta.trial", pb.trialLabelKey)

        // Absent case, using the canonical every-node fixture's
        // purchaseButton (pb_1, index 5), which carries no trialLabelKey.
        val canonicalEntry = entryNamed("accept", "canonical every-node multi-locale")
        val canonicalConfig = decodeBuilderConfig(configJson(canonicalEntry))!!
        val absentPb = canonicalConfig.root.children[5] as BuilderNode.PurchaseButton
        assertNull(absentPb.trialLabelKey)
    }

    /**
     * Decode-retention for the OVERRIDE side: `trialLabelKey` inside a
     * purchaseButton override's `props` decodes and is retained (mirrors
     * schema.ts's `OVERRIDABLE_PROP_KEYS.purchaseButton` whitelisting it
     * alongside `labelKey`) — the wire-format counterpart to
     * `purchaseButton node merges trialLabelKey` in PaywallOverridesTest.kt,
     * which exercises the same field once already-decoded.
     */
    @Test
    fun `purchaseButton override trialLabelKey decode retention`() {
        val node = firstChild(
            rootWith(
                """{"type":"purchaseButton","id":"pb","labelKey":"buy","trialLabelKey":"trial",
                   "overrides":[{"when":{"kind":"selected"},"props":{"labelKey":"buy_selected","trialLabelKey":"trial_selected"}}]}""",
            ),
        )
        val pb = node as BuilderNode.PurchaseButton
        val override = pb.overrides!!.first()
        assertEquals("trial_selected", override.props?.trialLabelKey)
    }

    // ---- node style pass: border / background / labelColor / cornerRadius
    // (spec 2026-07-29) -----------------------------------------------------
    //
    // Not fixture-based (render-fixtures.json is edited only in the LAST
    // task of this wave, per the plan's Global Constraints) — hand-built via
    // `rootWith`/`firstChild`, same idiom the "unknown icon name" test above
    // uses. Every new prop is optional and LENIENT on absence, matching
    // every other optional prop this decoder already carries. Mirrors
    // packages/sdk-swift .../RovenueTests/BuilderConfigModelTests.swift's
    // "node style pass" section.

    @Test
    fun `stack decodes border`() {
        val node = firstChild(
            rootWith(
                """{"type":"stack","id":"s1","axis":"v","children":[],
                   "border":{"width":2,"color":{"light":"#111111","dark":"#EEEEEE"}}}""",
            ),
        ) as BuilderNode.Stack
        assertEquals(2.0, node.border?.width)
        assertEquals(ThemePair("#111111", "#EEEEEE"), node.border?.color)
    }

    @Test
    fun `stack without border decodes leniently`() {
        val node = firstChild(rootWith("""{"type":"stack","id":"s1","axis":"v","children":[]}""")) as BuilderNode.Stack
        assertNull(node.border)
    }

    @Test
    fun `text decodes background and cornerRadius`() {
        val node = firstChild(
            rootWith(
                """{"type":"text","id":"t1","key":"k","role":"body",
                   "background":{"light":"#EEF2FF"},"cornerRadius":6}""",
            ),
        ) as BuilderNode.Text
        assertEquals(ThemePair("#EEF2FF", null), node.background)
        assertEquals(6.0, node.cornerRadius)
    }

    @Test
    fun `text without badge props decodes leniently`() {
        val node = firstChild(rootWith("""{"type":"text","id":"t1","key":"k","role":"body"}""")) as BuilderNode.Text
        assertNull(node.background)
        assertNull(node.cornerRadius)
    }

    @Test
    fun `image decodes border`() {
        val node = firstChild(
            rootWith(
                """{"type":"image","id":"i1","url":{"light":"https://x/a.png"},
                   "border":{"width":1,"color":{"light":"#000000"}}}""",
            ),
        ) as BuilderNode.Image
        assertEquals(1.0, node.border?.width)
        assertEquals(ThemePair("#000000", null), node.border?.color)
    }

    @Test
    fun `image without border decodes leniently`() {
        val node =
            firstChild(rootWith("""{"type":"image","id":"i1","url":{"light":"https://x/a.png"}}""")) as BuilderNode.Image
        assertNull(node.border)
    }

    @Test
    fun `button decodes all four style props`() {
        val node = firstChild(
            rootWith(
                """{"type":"button","id":"b1","labelKey":"k","style":"primary","action":{"kind":"close"},
                   "background":{"light":"#111111"},"labelColor":{"light":"#FFFFFF"},
                   "border":{"width":1,"color":{"light":"#333333"}},"cornerRadius":10}""",
            ),
        ) as BuilderNode.Button
        assertEquals(ThemePair("#111111", null), node.background)
        assertEquals(ThemePair("#FFFFFF", null), node.labelColor)
        assertEquals(1.0, node.border?.width)
        assertEquals(ThemePair("#333333", null), node.border?.color)
        assertEquals(10.0, node.cornerRadius)
    }

    @Test
    fun `button without style props decodes leniently`() {
        val node = firstChild(
            rootWith("""{"type":"button","id":"b1","labelKey":"k","style":"primary","action":{"kind":"close"}}"""),
        ) as BuilderNode.Button
        assertNull(node.background)
        assertNull(node.labelColor)
        assertNull(node.border)
        assertNull(node.cornerRadius)
    }

    @Test
    fun `purchaseButton decodes all four style props`() {
        val node = firstChild(
            rootWith(
                """{"type":"purchaseButton","id":"pb1","labelKey":"k",
                   "background":{"light":"#111111"},"labelColor":{"light":"#FFFFFF"},
                   "border":{"width":2,"color":{"light":"#333333"}},"cornerRadius":14}""",
            ),
        ) as BuilderNode.PurchaseButton
        assertEquals(ThemePair("#111111", null), node.background)
        assertEquals(ThemePair("#FFFFFF", null), node.labelColor)
        assertEquals(2.0, node.border?.width)
        assertEquals(14.0, node.cornerRadius)
    }

    @Test
    fun `purchaseButton without style props decodes leniently`() {
        val node = firstChild(rootWith("""{"type":"purchaseButton","id":"pb1","labelKey":"k"}""")) as BuilderNode.PurchaseButton
        assertNull(node.background)
        assertNull(node.labelColor)
        assertNull(node.border)
        assertNull(node.cornerRadius)
    }

    /** A malformed `border` (missing `color`) fails the whole config decode
     *  — same "structural defect on a KNOWN type" contract every other
     *  malformed field on a known node type already has. */
    @Test
    fun `malformed border missing color fails the whole config`() {
        val json = """
            {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{}},
             "root":{"type":"stack","id":"root","axis":"v","children":[
               {"type":"stack","id":"s1","axis":"v","children":[],"border":{"width":2}}]}}
        """
        assertNull(decodeBuilderConfig(json), "a border missing its required color must fail the whole config")
    }

    /**
     * Override parity (the P6 lesson): each node type's new keys must flow
     * through the SAME `NodeOverride<...Props>` whitelist/decode path every
     * other overridable key already uses — an active override actually
     * carries the new prop.
     */
    @Test
    fun `overrides carry the new style keys across node types`() {
        val stack = firstChild(
            rootWith(
                """{"type":"stack","id":"s1","axis":"v","children":[],
                   "overrides":[{"when":{"kind":"selected"},
                                 "props":{"border":{"width":3,"color":{"light":"#FF0000"}}}}]}""",
            ),
        ) as BuilderNode.Stack
        assertEquals(3.0, stack.overrides?.first()?.props?.border?.width)

        val text = firstChild(
            rootWith(
                """{"type":"text","id":"t1","key":"k","role":"body",
                   "overrides":[{"when":{"kind":"introEligible"},
                                 "props":{"background":{"light":"#00FF00"},"cornerRadius":4}}]}""",
            ),
        ) as BuilderNode.Text
        assertEquals(ThemePair("#00FF00", null), text.overrides?.first()?.props?.background)
        assertEquals(4.0, text.overrides?.first()?.props?.cornerRadius)

        val image = firstChild(
            rootWith(
                """{"type":"image","id":"i1","url":{"light":"https://x/a.png"},
                   "overrides":[{"when":{"kind":"selected"},
                                 "props":{"border":{"width":1,"color":{"light":"#0000FF"}}}}]}""",
            ),
        ) as BuilderNode.Image
        assertEquals(ThemePair("#0000FF", null), image.overrides?.first()?.props?.border?.color)

        val button = firstChild(
            rootWith(
                """{"type":"button","id":"b1","labelKey":"k","style":"primary","action":{"kind":"close"},
                   "overrides":[{"when":{"kind":"introEligible"},
                                 "props":{"background":{"light":"#ABCDEF"},"labelColor":{"light":"#123456"},
                                          "border":{"width":2,"color":{"light":"#654321"}},"cornerRadius":5}}]}""",
            ),
        ) as BuilderNode.Button
        val buttonPatch = button.overrides!!.first().props!!
        assertEquals(ThemePair("#ABCDEF", null), buttonPatch.background)
        assertEquals(ThemePair("#123456", null), buttonPatch.labelColor)
        assertEquals(2.0, buttonPatch.border?.width)
        assertEquals(5.0, buttonPatch.cornerRadius)

        val purchaseButton = firstChild(
            rootWith(
                """{"type":"purchaseButton","id":"pb1","labelKey":"k",
                   "overrides":[{"when":{"kind":"selected"},
                                 "props":{"background":{"light":"#ABCDEF"},"labelColor":{"light":"#123456"},
                                          "border":{"width":2,"color":{"light":"#654321"}},"cornerRadius":9}}]}""",
            ),
        ) as BuilderNode.PurchaseButton
        val purchaseButtonPatch = purchaseButton.overrides!!.first().props!!
        assertEquals(ThemePair("#ABCDEF", null), purchaseButtonPatch.background)
        assertEquals(9.0, purchaseButtonPatch.cornerRadius)
    }

    /** The whitelist side of parity: a key that is NOT in
     *  `OVERRIDABLE_PROP_KEYS.text` (e.g. `border` — text has no border prop
     *  at all, per the matrix) still fails the whole config. */
    @Test
    fun `a non-whitelisted style override prop fails the whole config`() {
        val json = """
            {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{}},
             "root":{"type":"stack","id":"root","axis":"v","children":[
               {"type":"text","id":"t1","key":"k","role":"body",
                "overrides":[{"when":{"kind":"selected"},
                              "props":{"border":{"width":1,"color":{"light":"#000000"}}}}]}]}}
        """
        assertNull(
            decodeBuilderConfig(json),
            "`border` is not in OVERRIDABLE_PROP_KEYS.text, so the whole config must fail",
        )
    }

    // ---- footerLinks node (spec §3 wave, 2026-09-04) -----------------------

    /** Decodes a single bare node JSON object by wrapping it as the sole
     *  child of a minimal stack root. Thin alias over [firstChild]/
     *  [rootWith] so this section reads like its siblings' `decodeFixtureNode`
     *  helper. */
    private fun decodeNode(nodeJson: String): BuilderNode = firstChild(rootWith(nodeJson))

    @Test
    fun `decodes a footerLinks node`() {
        val json = """
            {"type":"footerLinks","id":"f","links":[
              {"labelKey":"f_restore","action":{"kind":"restore"}},
              {"labelKey":"f_terms","action":{"kind":"url","url":"https://x.dev/terms"}}
            ],"separator":"pipe","align":"start"}
        """.trimIndent()
        val node = decodeNode(json)
        assertTrue(node is BuilderNode.FooterLinks)
        node as BuilderNode.FooterLinks
        assertEquals("f", node.id)
        assertEquals(2, node.links.size)
        assertEquals("f_restore", node.links[0].labelKey)
        assertEquals(ButtonAction.Restore, node.links[0].action)
        assertEquals("f_terms", node.links[1].labelKey)
        assertEquals(ButtonAction.Url("https://x.dev/terms"), node.links[1].action)
        assertEquals("pipe", node.separator)
        assertEquals("start", node.align)
    }

    /** `separator`/`align` decode as whatever the wire says (leniently, no
     *  enum validation) -- an unrecognized value is a render-time leniency
     *  concern ([footerSeparatorGlyph]/`footerLinksGravity` in
     *  NodeViewFactory.kt), not a decode failure. Mirrors Swift's
     *  `FooterLinksProps`. */
    @Test
    fun `keeps an unrecognized footerLinks separator instead of failing the decode`() {
        val node = decodeNode(
            """{"type":"footerLinks","id":"f","links":[{"labelKey":"a","action":{"kind":"restore"}}],
               "separator":"slash"}""",
        ) as BuilderNode.FooterLinks
        assertEquals("slash", node.separator)
    }

    @Test
    fun `keeps footerLinks defaults absent in the decoder`() {
        val json = """{"type":"footerLinks","id":"f","links":[{"labelKey":"a","action":{"kind":"restore"}}]}"""
        val node = decodeNode(json) as BuilderNode.FooterLinks
        assertNull(node.separator)
        assertNull(node.align)
        assertNull(node.color)
    }

    // ---- footerLinks node, shared render-fixtures.json entries (Task 6) ---
    // Selected BY NAME through `decodeFixtureNode`, mirroring the same two
    // fixtures Swift's BuilderConfigModelTests decode ("footer-links-full",
    // "footer-links-bare") -- these pin the same fields against the
    // cross-platform contract file, not just the hand-written JSON literals
    // above.

    @Test
    fun `decodes footer-links-full from the shared fixture`() {
        val node = decodeFixtureNode("footer-links-full") as BuilderNode.FooterLinks
        assertEquals("fl_full", node.id)
        assertEquals(3, node.links.size)
        assertEquals("fl_restore", node.links[0].labelKey)
        assertEquals(ButtonAction.Restore, node.links[0].action)
        assertEquals(ButtonAction.Url("https://example.com/terms"), node.links[1].action)
        assertEquals(ButtonAction.Url("https://example.com/privacy"), node.links[2].action)
        assertEquals("pipe", node.separator)
        assertEquals("start", node.align)
        assertEquals(ThemePair("#666666", "#999999"), node.color)
    }

    @Test
    fun `decodes footer-links-bare from the shared fixture`() {
        val node = decodeFixtureNode("footer-links-bare") as BuilderNode.FooterLinks
        assertEquals("fl_bare", node.id)
        assertEquals(1, node.links.size)
        assertEquals("fl_restore", node.links[0].labelKey)
        assertEquals(ButtonAction.Restore, node.links[0].action)
        // Absent in the fixture -> absent from the decoder; the VIEW applies
        // FOOTER_LINKS_DEFAULT_SEPARATOR/_ALIGN, never the decoder.
        assertNull(node.separator)
        assertNull(node.align)
        assertNull(node.color)
    }

    @Test
    fun `decodes a footerLinks node's color and overrides`() {
        val node = decodeNode(
            """{"type":"footerLinks","id":"f","links":[{"labelKey":"a","action":{"kind":"close"}}],
               "color":{"light":"#111111","dark":"#EEEEEE"},
               "overrides":[{"when":{"kind":"selected"},
                             "props":{"color":{"light":"#222222"},"separator":"none","align":"end"}}]}""",
        ) as BuilderNode.FooterLinks
        assertEquals(ThemePair("#111111", "#EEEEEE"), node.color)
        val patch = node.overrides!!.first().props!!
        assertEquals(ThemePair("#222222", null), patch.color)
        assertEquals("none", patch.separator)
        assertEquals("end", patch.align)
    }

    /** The whitelist side of parity, same shape as the `text`/`border` case
     *  above: a key NOT in `OVERRIDABLE_PROP_KEYS.footerLinks` fails the
     *  whole config. */
    @Test
    fun `a non-whitelisted footerLinks override prop fails the whole config`() {
        val json = """
            {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{}},
             "root":{"type":"stack","id":"root","axis":"v","children":[
               {"type":"footerLinks","id":"f","links":[{"labelKey":"a","action":{"kind":"close"}}],
                "overrides":[{"when":{"kind":"selected"},"props":{"labelKey":"nope"}}]}]}}
        """
        assertNull(
            decodeBuilderConfig(json),
            "`labelKey` is not in OVERRIDABLE_PROP_KEYS.footerLinks, so the whole config must fail",
        )
    }
}
