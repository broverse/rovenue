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
}
