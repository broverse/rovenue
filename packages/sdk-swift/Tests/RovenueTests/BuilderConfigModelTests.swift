//  BuilderConfigModelTests.swift — exercises `decodeBuilderConfig` and the
//  pure text/variable helpers against the frozen cross-platform contract
//  fixture, packages/shared/src/paywall/render-fixtures.json. See that
//  file's `_comment` for the accept/acceptLenient/reject contract.

import XCTest
@testable import Rovenue

final class BuilderConfigModelTests: XCTestCase {
    private var fixtures: [String: Any]!

    override func setUp() {
        super.setUp()
        fixtures = RenderFixtures.load()
    }

    // MARK: - accept

    func testEveryAcceptFixtureDecodes() throws {
        let entries = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        XCTAssertFalse(entries.isEmpty)
        for entry in entries {
            let name = entry["name"] as? String ?? "<unnamed>"
            let config = try XCTUnwrap(entry["config"], "missing config in fixture \"\(name)\"")
            let json = RenderFixtures.jsonString(for: config)
            let decoded = decodeBuilderConfig(json)
            XCTAssertNotNil(decoded, "expected accept fixture \"\(name)\" to decode")
            guard case .stack = decoded?.root else {
                XCTFail("accept fixture \"\(name)\" decoded but root was not .stack")
                continue
            }
        }
    }

    func testCanonicalEveryNodeFixtureFieldsAndTree() throws {
        let entries = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first { ($0["name"] as? String) == "canonical every-node multi-locale" })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))

        XCTAssertEqual(decoded.formatVersion, 2)
        XCTAssertEqual(decoded.defaultLocale, "en")
        XCTAssertEqual(decoded.localizations["en"]?["title_1"], "Go Pro")
        XCTAssertEqual(decoded.localizations["tr"]?["title_1"], "Pro'ya geç")
        XCTAssertEqual(decoded.background?.light, "#FFFFFF")
        XCTAssertEqual(decoded.background?.dark, "#0B0B0F")

        guard case .stack(let root) = decoded.root else {
            return XCTFail("root must be .stack")
        }
        XCTAssertEqual(root.id, "root")
        XCTAssertEqual(root.axis, .v)
        XCTAssertEqual(root.children.count, 7)

        guard case .image(let image) = root.children[0] else { return XCTFail("children[0] must be .image") }
        XCTAssertEqual(image.url.light, "https://cdn.example.com/hero.png")
        XCTAssertEqual(image.height, 180)

        guard case .text(let title) = root.children[1] else { return XCTFail("children[1] must be .text") }
        XCTAssertEqual(title.key, "title_1")
        XCTAssertEqual(title.role, .title)

        guard case .spacer(let spacer) = root.children[3] else { return XCTFail("children[3] must be .spacer") }
        XCTAssertEqual(spacer.size, 8)

        guard case .packageList(let list) = root.children[4] else { return XCTFail("children[4] must be .packageList") }
        XCTAssertEqual(list.packageIds, [])
        XCTAssertEqual(list.cellLayout, .column)

        guard case .purchaseButton(let purchase) = root.children[5] else {
            return XCTFail("children[5] must be .purchaseButton")
        }
        XCTAssertEqual(purchase.labelKey, "cta_1")

        guard case .stack(let row) = root.children[6] else { return XCTFail("children[6] must be .stack") }
        XCTAssertEqual(row.axis, .h)
        guard case .button(let closeButton) = row.children[0] else { return XCTFail("row.children[0] must be .button") }
        XCTAssertEqual(closeButton.style, .plain)
        XCTAssertEqual(closeButton.action, .close)
        guard case .button(let restoreButton) = row.children[1] else { return XCTFail("row.children[1] must be .button") }
        XCTAssertEqual(restoreButton.action, .restore)
    }

    func testUrlButtonActionDecodesItsURL() throws {
        let entries = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first { ($0["name"] as? String) == "url and restore buttons, spacer flexible" })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root, case .button(let terms) = root.children[0] else {
            return XCTFail("expected root.children[0] to be .button")
        }
        XCTAssertEqual(terms.action, .url("https://example.com/terms"))
    }

    func testPackageListDefaultSelected() throws {
        let entries = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first { ($0["name"] as? String) == "explicit packageIds with defaultSelected" })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root, case .packageList(let list) = root.children[0] else {
            return XCTFail("expected root.children[0] to be .packageList")
        }
        XCTAssertEqual(list.packageIds, ["$rov_monthly", "$rov_annual"])
        XCTAssertEqual(list.defaultSelected, "$rov_annual")
        XCTAssertEqual(list.cellLayout, .row)
    }

    func testPackageListCellTemplateDecodesRecursively() throws {
        let entries = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first {
            ($0["name"] as? String) == "packageList with cellTemplate (visual nodes only, selected-condition badge)"
        })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root, case .packageList(let list) = root.children[0] else {
            return XCTFail("expected root.children[0] to be .packageList")
        }
        guard case .stack(let cellRoot) = list.cellTemplate?.node else {
            return XCTFail("expected cellTemplate to decode as .stack")
        }
        XCTAssertEqual(cellRoot.id, "cell_root")
        XCTAssertEqual(cellRoot.children.count, 3)
        let cellRootOverrides = try XCTUnwrap(cellRoot.overrides)
        XCTAssertEqual(cellRootOverrides.first?.when, .selected)
        XCTAssertEqual(cellRootOverrides.first?.props?.background, ThemePair(light: "#EEF2FF", dark: nil))
        guard case .text(let badge) = cellRoot.children[1] else { return XCTFail("expected children[1] to be .text") }
        XCTAssertEqual(badge.overrides?.first?.props?.color, ThemePair(light: "#4338CA", dark: nil))
    }

    func testOverridesAcrossNodeTypesDecodeWithTypedProps() throws {
        let entries = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first {
            ($0["name"] as? String) == "overrides: introEligible + selected across node types, incl. a text key-swap"
        })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root else { return XCTFail("root must be .stack") }
        XCTAssertEqual(root.overrides?.first?.props?.spacing, 4)

        guard case .text(let title) = root.children[1] else { return XCTFail("children[1] must be .text") }
        XCTAssertEqual(title.overrides?.first?.props?.key, "title_key_intro")

        guard case .button(let cta) = root.children[2] else { return XCTFail("children[2] must be .button") }
        XCTAssertEqual(cta.overrides?.first?.props?.labelKey, "cta_key_selected")
        XCTAssertEqual(cta.overrides?.first?.props?.style, .secondary)
    }

    func testThemePairWithoutDark() throws {
        let entries = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first { ($0["name"] as? String) == "theme pair without dark" })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        XCTAssertEqual(decoded.background?.light, "#FafaFA")
        XCTAssertNil(decoded.background?.dark)
    }

    func testValidFallbackSubtreeDecodes() throws {
        let entries = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first { ($0["name"] as? String) == "node carrying a valid fallback" })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root, case .text(let t1) = root.children[0] else {
            return XCTFail("expected root.children[0] to be .text")
        }
        XCTAssertEqual(t1.key, "a")
        guard case .text(let fallbackProps) = t1.fallback?.node else {
            return XCTFail("expected t1.fallback to be a .text node")
        }
        XCTAssertEqual(fallbackProps.key, "b")
    }

    // MARK: - acceptLenient

    func testUnknownNodeTypeWithFallbackDecodesLeniently() throws {
        let entries = try XCTUnwrap(fixtures["acceptLenient"] as? [[String: Any]])
        let entry = try XCTUnwrap(
            entries.first { ($0["name"] as? String) == "unknown node type with valid fallback (platform decoders keep id+fallback; strict schema rejects)" })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)), "lenient fixture must decode")
        guard case .stack(let root) = decoded.root else { return XCTFail("root must be .stack") }
        guard case .unknown(let id, _, let fallback) = root.children[0] else {
            return XCTFail("expected root.children[0] to decode as .unknown")
        }
        XCTAssertEqual(id, "cd_1")
        guard case .text(let fallbackText) = fallback?.node else {
            return XCTFail("expected .unknown's fallback to decode as .text")
        }
        XCTAssertEqual(fallbackText.id, "cd_fb")
        XCTAssertEqual(fallbackText.key, "t")
    }

    func testUnknownNodeTypeWithoutFallbackDecodesLeniently() throws {
        let entries = try XCTUnwrap(fixtures["acceptLenient"] as? [[String: Any]])
        let entry = try XCTUnwrap(
            entries.first { ($0["name"] as? String) == "unknown node type without fallback (platforms render nothing)" })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)), "lenient fixture must decode")
        guard case .stack(let root) = decoded.root else { return XCTFail("root must be .stack") }
        guard case .unknown(let id, _, let fallback) = root.children[0] else {
            return XCTFail("expected root.children[0] to decode as .unknown")
        }
        // The fixture's placeholder node was renamed in wave D2: it used the
        // literal type string "video" as its "unknown type" stand-in, which
        // stopped being unknown the moment `video` became a real schema
        // member. Its id moved with it, vid_1 -> unk_1. A placeholder must be
        // a name that can never become real, or the next wave arms it.
        XCTAssertEqual(id, "unk_1")
        XCTAssertNil(fallback)
    }

    func testOverrideWithUnknownWhenKindIsRetainedButNeverMatching() throws {
        // Pins render-fixtures.json's acceptLenient case: the strict schema
        // rejects the whole config, but platform decoders decode leniently,
        // skipping ONLY this override entry's activation (never its
        // presence) per the unknown-condition-kind rule.
        let entries = try XCTUnwrap(fixtures["acceptLenient"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first {
            ($0["name"] as? String)?.hasPrefix("override with unknown when.kind") == true
        })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root, case .text(let title) = root.children[0] else {
            return XCTFail("expected root.children[0] to be .text")
        }
        let overrides = try XCTUnwrap(title.overrides)
        XCTAssertEqual(overrides.count, 2, "the unknown-kind entry is RETAINED, not dropped")
        XCTAssertEqual(overrides[0].when, .introEligible)
        XCTAssertEqual(overrides[0].props?.align, .center)
        XCTAssertEqual(overrides[1].when, .unknown, "\"sizeClass\" is not a known condition kind")
        XCTAssertNil(overrides[1].props, "props are not decoded/validated for an unknown when.kind")

        // Never matches, regardless of the active condition set.
        let result = applyOverrides(title, active: OverrideActiveConditions(introEligible: true, selected: true))
        XCTAssertEqual(result.align, .center, "only the KNOWN introEligible override is ever active")
    }

    func testStructuralKeyInsideKnownKindOverridePropsFailsWholeConfigDecode() throws {
        // Pins render-fixtures.json's reject case: `type` inside a
        // `when.kind: "introEligible"` override's `props` must fail the
        // WHOLE config decode (not just be dropped/ignored), since
        // introEligible IS a known kind.
        let entries = try XCTUnwrap(fixtures["reject"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first {
            ($0["name"] as? String) == "structural key 'type' inside override props on a known when.kind"
        })
        let config = try XCTUnwrap(entry["config"])
        XCTAssertNil(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
    }

    func testEveryAcceptLenientFixtureDecodes() throws {
        let entries = try XCTUnwrap(fixtures["acceptLenient"] as? [[String: Any]])
        XCTAssertFalse(entries.isEmpty)
        for entry in entries {
            let name = entry["name"] as? String ?? "<unnamed>"
            let config = try XCTUnwrap(entry["config"], "missing config in fixture \"\(name)\"")
            let decoded = decodeBuilderConfig(RenderFixtures.jsonString(for: config))
            XCTAssertNotNil(decoded, "expected acceptLenient fixture \"\(name)\" to decode")
        }
    }

    // MARK: - reject

    func testEveryRejectFixtureDecodesToNil() throws {
        let entries = try XCTUnwrap(fixtures["reject"] as? [[String: Any]])
        XCTAssertFalse(entries.isEmpty)
        for entry in entries {
            let name = entry["name"] as? String ?? "<unnamed>"
            let config = try XCTUnwrap(entry["config"], "missing config in fixture \"\(name)\"")
            let decoded = decodeBuilderConfig(RenderFixtures.jsonString(for: config))
            XCTAssertNil(decoded, "expected reject fixture \"\(name)\" (\(entry["reason"] as? String ?? "")) to decode to nil")
        }
    }

    func testMalformedJSONDecodesToNil() {
        XCTAssertNil(decodeBuilderConfig("not json at all"))
        XCTAssertNil(decodeBuilderConfig(""))
    }

    // MARK: - variables (resolveVariables)

    func testVariableResolutionVectors() throws {
        let entries = try XCTUnwrap(fixtures["variables"] as? [[String: Any]])
        XCTAssertFalse(entries.isEmpty)
        for entry in entries {
            let text = try XCTUnwrap(entry["text"] as? String)
            let expected = try XCTUnwrap(entry["expected"] as? String)
            let pkg = packageView(fromFixture: entry["pkg"])
            XCTAssertEqual(resolveVariables(text, pkg: pkg), expected, "text=\"\(text)\" pkg=\(String(describing: pkg))")
        }
    }

    // MARK: - resolveText

    func testResolveTextVectors() throws {
        let accept = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let canonicalEntry = try XCTUnwrap(accept.first { ($0["name"] as? String) == "canonical every-node multi-locale" })
        let config = try XCTUnwrap(canonicalEntry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))

        let vectors = try XCTUnwrap(fixtures["resolveText"] as? [[String: Any]])
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            let locale = try XCTUnwrap(vector["locale"] as? String)
            let key = try XCTUnwrap(vector["key"] as? String)
            let expected = vector["expected"] as? String // nil means the JSON `null`
            XCTAssertEqual(resolveText(decoded, locale: locale, key: key), expected, "locale=\(locale) key=\(key)")
        }
    }

    // MARK: - visibility (cross-platform render-fixtures.json vector table)

    /// Runs every `visibility` vector in render-fixtures.json through the
    /// Swift `isNodeVisible` — the same 13 cases the RN and Kotlin ports
    /// run, including every FAILS OPEN one (empty platform list, unknown
    /// platform, unknown app version, a non-numeric version component).
    /// The evaluator's own unit tests live in VisibilityTests.swift; this
    /// is the cross-platform contract conformance proof.
    func testVisibilityVectorsAgreeWithSharedFixture() throws {
        let entries = try XCTUnwrap(fixtures["visibility"] as? [[String: Any]])
        XCTAssertFalse(entries.isEmpty)
        for entry in entries {
            let name = try XCTUnwrap(entry["name"] as? String)
            let visibilityJSON = try XCTUnwrap(entry["visibility"])
            let visibilityData = try JSONSerialization.data(withJSONObject: visibilityJSON)
            let visibility = try JSONDecoder().decode(Visibility.self, from: visibilityData)
            let platform = entry["platform"] as? String // nil surfaces JSON `null`
            let appVersion = entry["appVersion"] as? String // nil surfaces JSON `null`
            let expected = try XCTUnwrap(entry["expected"] as? Bool)
            XCTAssertEqual(
                isNodeVisible(visibility, platform: platform, appVersion: appVersion), expected,
                "visibility vector \"\(name)\"")
        }
    }

    // MARK: - trialLabel (cross-platform render-fixtures.json vector table)

    /// Runs every `trialLabel` vector in render-fixtures.json through
    /// `ctaLabelKey` — the Swift port of variables.ts's `resolveCtaLabelKey`.
    /// `selectedHasIntroPeriod` is the fixture's boolean/null shorthand for a
    /// selection: `true` -> a selected package mid-trial (`introPeriod` set
    /// to a non-empty string), `false` -> a selected package with no trial
    /// (`introPeriod` nil), `null` -> no selection at all (`selectedView`
    /// nil). Mirrors render-fixtures.test.ts's `toSelected`.
    func testTrialLabelVectorsAgreeWithSharedFixture() throws {
        let trialLabel = try XCTUnwrap(fixtures["trialLabel"] as? [String: Any])
        let cases = try XCTUnwrap(trialLabel["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for entry in cases {
            let name = try XCTUnwrap(entry["name"] as? String)
            let labelKey = try XCTUnwrap(entry["labelKey"] as? String)
            let trialLabelKey = entry["trialLabelKey"] as? String
            let expectedKey = try XCTUnwrap(entry["expectedKey"] as? String)
            let selectedView: PackageView?
            if entry["selectedHasIntroPeriod"] is NSNull || entry["selectedHasIntroPeriod"] == nil {
                selectedView = nil
            } else {
                let hasIntroPeriod = try XCTUnwrap(entry["selectedHasIntroPeriod"] as? Bool)
                selectedView = PackageView(
                    packageName: "", price: "", pricePerPeriod: "", period: "",
                    introPeriod: hasIntroPeriod ? "1 week" : nil)
            }
            XCTAssertEqual(
                ctaLabelKey(labelKey: labelKey, trialLabelKey: trialLabelKey, selectedView: selectedView),
                expectedKey, "trialLabel vector \"\(name)\"")
        }
    }

    /// Empty-string `introPeriod` is explicitly NOT a trial — mirroring the
    /// TS truthiness check (`selected.introPeriod !== ""`). Not represented
    /// in the shared fixture (which only carries the boolean/null
    /// shorthand), so pinned directly here.
    func testEmptyIntroPeriodIsNotATrial() {
        let selectedView = PackageView(
            packageName: "", price: "", pricePerPeriod: "", period: "", introPeriod: "")
        XCTAssertEqual(
            ctaLabelKey(labelKey: "cta.buy", trialLabelKey: "cta.trial", selectedView: selectedView),
            "cta.buy")
    }

    /// Empty-string `trialLabelKey` is explicitly NOT a trial label, even
    /// with a live trial selection — mirroring the TS truthiness check
    /// (`node.trialLabelKey && hasIntroPeriod`), where an empty string is
    /// falsy. Not represented in the shared fixture, so pinned directly
    /// here, same as `testEmptyIntroPeriodIsNotATrial`.
    func testEmptyTrialLabelKeyIsNotATrialLabel() {
        let selectedView = PackageView(
            packageName: "", price: "", pricePerPeriod: "", period: "", introPeriod: "1 week")
        XCTAssertEqual(
            ctaLabelKey(labelKey: "cta.buy", trialLabelKey: "", selectedView: selectedView),
            "cta.buy")
    }

    /// Decode-retention: `trialLabelKey` present on the wire is retained on
    /// `PurchaseButtonProps`; absent decodes to `nil`.
    func testPurchaseButtonTrialLabelKeyDecodeRetention() throws {
        let accept = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let entry = try XCTUnwrap(accept.first {
            ($0["name"] as? String) == "purchaseButton with trialLabelKey (both keys present in default locale)"
        })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root, case .purchaseButton(let pb) = root.children[0] else {
            return XCTFail("expected root.children[0] to be .purchaseButton")
        }
        XCTAssertEqual(pb.labelKey, "cta.buy")
        XCTAssertEqual(pb.trialLabelKey, "cta.trial")

        // Absent case, using the canonical every-node fixture's purchaseButton
        // (pb_1), which carries no trialLabelKey.
        let canonicalEntry = try XCTUnwrap(accept.first { ($0["name"] as? String) == "canonical every-node multi-locale" })
        let canonicalConfig = try XCTUnwrap(canonicalEntry["config"])
        let canonicalDecoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: canonicalConfig)))
        guard case .stack(let canonicalRoot) = canonicalDecoded.root,
              case .purchaseButton(let absentPb) = canonicalRoot.children[5]
        else {
            return XCTFail("expected canonical root.children[5] to be .purchaseButton")
        }
        XCTAssertNil(absentPb.trialLabelKey)
    }

    /// Decode-retention for the OVERRIDE side: `trialLabelKey` inside a
    /// purchaseButton override's `props` decodes and is retained (mirrors
    /// schema.ts's `OVERRIDABLE_PROP_KEYS.purchaseButton` whitelisting it
    /// alongside `labelKey`) — this is the wire-format counterpart to
    /// `test_purchaseButtonProps_mergesTrialLabelKey` in
    /// PaywallOverridesTests.swift, which exercises the same field once
    /// already-decoded.
    func testPurchaseButtonOverrideTrialLabelKeyDecodeRetention() throws {
        let node = try firstChild(#"""
            {"type":"purchaseButton","id":"pb","labelKey":"buy","trialLabelKey":"trial",
             "overrides":[{"when":{"kind":"selected"},"props":{"labelKey":"buy_selected","trialLabelKey":"trial_selected"}}]}
            """#)
        guard case .purchaseButton(let props) = node else { return XCTFail("expected .purchaseButton") }
        let override = try XCTUnwrap(props.overrides?.first)
        XCTAssertEqual(override.props?.trialLabelKey, "trial_selected")
    }

    func testResolveTextWithNilLocaleFallsStraightToDefaultLocale() throws {
        let accept = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let canonicalEntry = try XCTUnwrap(accept.first { ($0["name"] as? String) == "canonical every-node multi-locale" })
        let config = try XCTUnwrap(canonicalEntry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        XCTAssertEqual(resolveText(decoded, locale: nil, key: "title_1"), "Go Pro")
    }

    // MARK: - featureList / timeline / socialProof (Wave B)
    //
    // These three now have dedicated render-fixtures.json accept entries —
    // they used to predate the shared fixture (hand-built via `firstChild`
    // below, the same gap Kotlin's BuilderConfigModelTest.kt had). `firstChild`
    // stays for cases genuinely outside the cross-platform contract (an empty
    // `rows` array, and the excluded/included mark-resolution unit checks
    // just below, which construct a bare `FeatureRowProps` directly).

    private func firstChild(_ childJSON: String) throws -> BuilderNode {
        let json = """
        {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{"k":"x"}},
         "root":{"type":"stack","id":"root","axis":"v","children":[\(childJSON)]}}
        """
        let model = try XCTUnwrap(decodeBuilderConfig(json))
        guard case .stack(let root) = model.root else {
            XCTFail("root did not decode as a stack"); throw XCTSkip("unreachable")
        }
        return try XCTUnwrap(root.children.first)
    }

    private func acceptEntry(named name: String) throws -> Any {
        let entries = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first { ($0["name"] as? String) == name }, "no accept fixture named \"\(name)\"")
        return try XCTUnwrap(entry["config"])
    }

    /// Selects an `accept` fixture entry BY NAME (never by index — a
    /// previous wave widened render-fixtures.json and silently broke two
    /// Kotlin tests that assumed a position), decodes it, and hands back its
    /// root's first (only) child. Built on `acceptEntry(named:)`.
    private func decodeNode(named name: String) throws -> BuilderNode {
        let config = try acceptEntry(named: name)
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root else {
            XCTFail("fixture \"\(name)\" root did not decode as .stack")
            throw XCTSkip("unreachable")
        }
        return try XCTUnwrap(root.children.first, "fixture \"\(name)\" root has no children")
    }

    func test_decodesFeatureListRows() throws {
        let config = try acceptEntry(named: "featureList: multi-row with a mix of included values")
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root, case .featureList(let p) = root.children[0] else {
            return XCTFail("expected root.children[0] to be .featureList")
        }
        XCTAssertEqual(p.rows.count, 3)
        XCTAssertEqual(p.rows[0].included, true)
        XCTAssertEqual(p.rows[1].included, false)
        XCTAssertNil(p.rows[2].included)
    }

    func test_decodesTimelineCaptions() throws {
        let config = try acceptEntry(named: "timeline: rows with and without captions")
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root, case .timeline(let p) = root.children[0] else {
            return XCTFail("expected root.children[0] to be .timeline")
        }
        XCTAssertEqual(p.rows[0].captionKey, "t1c")
        XCTAssertNil(p.rows[1].captionKey)
        XCTAssertEqual(p.rows[2].captionKey, "t3c")
    }

    func test_decodesSocialProofRating() throws {
        let withRatingConfig = try acceptEntry(named: "socialProof: with a fractional rating")
        let withRatingDecoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: withRatingConfig)))
        guard case .stack(let withRatingRoot) = withRatingDecoded.root, case .socialProof(let withP) = withRatingRoot.children[0] else {
            return XCTFail("expected root.children[0] to be .socialProof")
        }
        XCTAssertEqual(withP.rating, 4.5)

        let withoutRatingConfig = try acceptEntry(named: "socialProof: without a rating (no stars)")
        let withoutRatingDecoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: withoutRatingConfig)))
        guard case .stack(let withoutRatingRoot) = withoutRatingDecoded.root, case .socialProof(let withoutP) = withoutRatingRoot.children[0] else {
            return XCTFail("expected root.children[0] to be .socialProof")
        }
        XCTAssertNil(withoutP.rating)
    }

    func test_decodesEmptyRows() throws {
        let node = try firstChild(#"{"type":"featureList","id":"f1","rows":[]}"#)
        guard case .featureList(let p) = node else { XCTFail("not a featureList"); return }
        XCTAssertTrue(p.rows.isEmpty)
    }

    /// The excluded-mark test that must assert WHICH symbol resolves, not
    /// merely that a symbol rendered — both `check` and `x` are real,
    /// drawable SF Symbols, so a test asserting only non-nilness would still
    /// pass with the wrong branch forced. See mutation-check note in
    /// RovenuePaywallView.swift's `resolvedFeatureRowIconName`.
    func test_excludedFeatureRowResolvesToTheExcludedMarkNotTheDefault() throws {
        let node = try firstChild(#"{"type":"featureList","id":"f1","rows":[{"labelKey":"a","included":false}]}"#)
        guard case .featureList(let p) = node else { XCTFail("not a featureList"); return }
        let iconName = resolvedFeatureRowIconName(p.rows[0])
        XCTAssertEqual(sfSymbolName(for: iconName), "xmark", "an excluded row must resolve to the excluded mark, not the included default")
    }

    func test_includedFeatureRowResolvesToTheDefaultMark() throws {
        let node = try firstChild(#"{"type":"featureList","id":"f1","rows":[{"labelKey":"a"}]}"#)
        guard case .featureList(let p) = node else { XCTFail("not a featureList"); return }
        let iconName = resolvedFeatureRowIconName(p.rows[0])
        XCTAssertEqual(sfSymbolName(for: iconName), "checkmark")
    }

    // MARK: - stickyFooter / countdown (Wave C)

    func test_decodesStickyFooterChildren() throws {
        let node = try firstChild(#"{"type":"stickyFooter","id":"sf","children":[{"type":"spacer","id":"s1","size":8}]}"#)
        guard case .stickyFooter(let p) = node else { XCTFail("not a stickyFooter"); return }
        XCTAssertEqual(p.children.count, 1)
    }

    func test_decodesCountdownBothModes() throws {
        let abs = try firstChild(#"{"type":"countdown","id":"c1","endsAt":"2027-01-01T00:00:00Z"}"#)
        guard case .countdown(let a) = abs else { XCTFail("not a countdown"); return }
        XCTAssertEqual(a.endsAt, "2027-01-01T00:00:00Z")
        let dur = try firstChild(#"{"type":"countdown","id":"c2","durationSeconds":900}"#)
        guard case .countdown(let d) = dur else { XCTFail("not a countdown"); return }
        XCTAssertEqual(d.durationSeconds, 900)
    }

    // The formatter is where a countdown is actually testable — SwiftUI
    // views are not inspectable here, so it's extracted as a pure function.
    func test_formatsRemainingTime() {
        XCTAssertEqual(countdownText(remaining: 60), "01:00")
        XCTAssertEqual(countdownText(remaining: 3661), "01:01:01")
        XCTAssertEqual(countdownText(remaining: 0), "00:00")
        XCTAssertEqual(countdownText(remaining: -5), "00:00")
    }

    func test_decodesStickyFooterFixture() throws {
        let config = try acceptEntry(named: "stickyFooter: pinned footer with a nested purchaseButton")
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root, case .stickyFooter(let p) = root.children[0] else {
            return XCTFail("expected root.children[0] to be .stickyFooter")
        }
        XCTAssertEqual(p.background?.light, "#FFFFFF")
        guard case .purchaseButton(let pb) = p.children[0] else {
            return XCTFail("expected the footer's only child to be .purchaseButton")
        }
        XCTAssertEqual(pb.labelKey, "cta.buy")
    }

    func test_decodesCountdownFixture() throws {
        let config = try acceptEntry(named: "countdown: absolute deadline with a label and onExpiry")
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root, case .countdown(let p) = root.children[0] else {
            return XCTFail("expected root.children[0] to be .countdown")
        }
        XCTAssertEqual(p.endsAt, "2027-01-01T00:00:00.000Z")
        XCTAssertNil(p.durationSeconds)
        XCTAssertEqual(p.onExpiry, .freeze)
        XCTAssertEqual(p.labelKey, "cd.label")
        XCTAssertEqual(p.color?.light, "#111111")
    }

    // MARK: - carousel (wave D1)

    func test_decodesBareCarouselFromTheSharedFixture() throws {
        let node = try decodeNode(named: "carousel-bare")   // select by NAME, never by index
        guard case .carousel(let p) = node else { return XCTFail("expected carousel") }
        XCTAssertEqual(p.children.count, 2)
        XCTAssertNil(p.showsIndicator)
        XCTAssertNil(p.autoAdvanceSeconds)
        XCTAssertNil(p.loop)
        XCTAssertNil(p.indicatorColor)
    }

    func test_decodesFullCarouselFromTheSharedFixture() throws {
        let node = try decodeNode(named: "carousel-full")
        guard case .carousel(let p) = node else { return XCTFail("expected carousel") }
        XCTAssertEqual(p.children.count, 2)
        XCTAssertEqual(p.showsIndicator, false)
        XCTAssertEqual(p.autoAdvanceSeconds, 5)
        XCTAssertEqual(p.loop, true)
        XCTAssertEqual(p.indicatorColor?.light, "#111111")
        XCTAssertEqual(p.indicatorColor?.dark, "#EEEEEE")
    }

    /// `durationSeconds` must anchor to a PERSISTED first-show instant, not
    /// this render's own mount time — otherwise a countdown restarts on
    /// every open, which is not a deadline. A second call for the SAME
    /// paywall identifier must reuse the stored anchor rather than
    /// re-stamping it. Uses a dedicated `UserDefaults` suite, cleared before
    /// and after, so this test never depends on (or pollutes) any other
    /// test's persisted state.
    func test_countdownAnchorPersistsAcrossRenders() throws {
        let suiteName = "RovenueTests.countdownAnchor"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let first = countdownFirstShownAt(paywallIdentifier: "pw_1", defaults: defaults)
        let second = countdownFirstShownAt(paywallIdentifier: "pw_1", defaults: defaults)
        XCTAssertEqual(first, second, "a second render of the same paywall must reuse the stored anchor")

        // A DIFFERENT paywall identifier is keyed independently — reading it
        // back must not disturb (or return) "pw_1"'s already-stored anchor.
        _ = countdownFirstShownAt(paywallIdentifier: "pw_2", defaults: defaults)
        let firstAgain = countdownFirstShownAt(paywallIdentifier: "pw_1", defaults: defaults)
        XCTAssertEqual(firstAgain, first)
    }

    // MARK: - countdownDeadline (the endsAt/durationSeconds contract)

    /// A scratch `UserDefaults` suite, cleared before and after the calling
    /// test, so a persisted anchor never leaks between tests or into the
    /// machine's real defaults.
    private func scratchDefaults(_ suiteName: String) throws -> UserDefaults {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        addTeardownBlock { defaults.removePersistentDomain(forName: suiteName) }
        return defaults
    }

    /// render-fixtures.json carries a countdown with BOTH `endsAt` and
    /// `durationSeconds` as an `acceptLenient` entry, not a `reject` one: the
    /// exclusivity is a TypeScript-only authoring `refine`, so the config
    /// reaches the platform decoders intact and the contract is that
    /// `endsAt` WINS. Asserted through the real fixture, not a hand-built
    /// node, so the entry and this expectation cannot drift apart.
    func test_countdownDeadline_prefersEndsAtWhenBothAreSomehowPresent() throws {
        let entries = try XCTUnwrap(fixtures["acceptLenient"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first {
            ($0["name"] as? String)?.hasPrefix("countdown carrying BOTH endsAt and durationSeconds") == true
        })
        let config = try XCTUnwrap(entry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        guard case .stack(let root) = decoded.root, case .countdown(let props) = root.children[0] else {
            return XCTFail("expected root.children[0] to be .countdown")
        }
        XCTAssertEqual(props.endsAt, "2027-06-01T12:00:00.000Z")
        XCTAssertEqual(props.durationSeconds, 600)

        let defaults = try scratchDefaults("RovenueTests.countdownDeadline.both")
        let deadline = try XCTUnwrap(
            countdownDeadline(props: props, paywallIdentifier: "pw_1", defaults: defaults))
        let expected = try XCTUnwrap(ISO8601DateFormatter.rovenueTestFractional.date(from: "2027-06-01T12:00:00.000Z"))
        XCTAssertEqual(deadline, expected, "endsAt must win over durationSeconds")
        // The durationSeconds branch was never taken, so it never stamped an
        // anchor — the strongest available signal that `endsAt` short-circuited.
        XCTAssertNil(
            defaults.object(forKey: countdownFirstShownKeyPrefix + "pw_1"),
            "preferring endsAt must not touch the persisted first-shown anchor")
    }

    func test_countdownDeadline_anchorsDurationSecondsToThePersistedFirstShow() throws {
        let defaults = try scratchDefaults("RovenueTests.countdownDeadline.duration")
        let props = CountdownProps(id: "cd", durationSeconds: 900)
        let anchor = countdownFirstShownAt(paywallIdentifier: "pw_1", defaults: defaults)
        let deadline = try XCTUnwrap(
            countdownDeadline(props: props, paywallIdentifier: "pw_1", defaults: defaults))
        XCTAssertEqual(deadline.timeIntervalSince(anchor), 900, accuracy: 0.001)
    }

    /// An unparsable `endsAt` yields no deadline, which routes the node to
    /// `fallback` else nothing — never a garbage display, and never a silent
    /// fall-through to `durationSeconds` (the web renderer's
    /// `useCountdownDeadline` returns null in exactly the same shape).
    func test_countdownDeadline_isNilForAnUnparsableEndsAt() throws {
        let defaults = try scratchDefaults("RovenueTests.countdownDeadline.unparsable")
        XCTAssertNil(countdownDeadline(
            props: CountdownProps(id: "cd", endsAt: "not a date"),
            paywallIdentifier: "pw_1", defaults: defaults))
        XCTAssertNil(countdownDeadline(
            props: CountdownProps(id: "cd", endsAt: "not a date", durationSeconds: 900),
            paywallIdentifier: "pw_1", defaults: defaults),
            "an unparsable endsAt must not fall through to durationSeconds")
    }

    func test_countdownDeadline_isNilWhenTheNodeCarriesNeitherDeadline() throws {
        let defaults = try scratchDefaults("RovenueTests.countdownDeadline.none")
        XCTAssertNil(countdownDeadline(
            props: CountdownProps(id: "cd"), paywallIdentifier: "pw_1", defaults: defaults))
    }

    /// Both authored spellings parse: plain `Z`-suffixed UTC (what the
    /// builder writes) and a stray fractional-seconds value.
    // MARK: - video / lottie (Wave D2)
    //
    // Every entry is selected BY NAME through `decodeNode(named:)` — never by
    // index. A previous wave widened render-fixtures.json and silently broke
    // two Kotlin tests that assumed a position.

    func test_decodesBareVideoFromTheSharedFixture() throws {
        let node = try decodeNode(named: "video-bare")
        guard case .video(let p) = node else { return XCTFail("expected video") }
        XCTAssertNil(p.autoplay)
        XCTAssertNil(p.posterUrl)
    }

    /// The bare node's absences are the interesting half: `nil` is what makes
    /// the mirrored defaults apply, and an `aspectRatio` of `nil` specifically
    /// means NO ratio is applied at all rather than a substituted number.
    func test_bareVideoLeavesEveryOptionalAbsent() throws {
        let node = try decodeNode(named: "video-bare")
        guard case .video(let p) = node else { return XCTFail("expected video") }
        XCTAssertEqual(p.url.light, "https://x/a.mp4")
        XCTAssertNil(p.url.dark)
        XCTAssertNil(p.loop)
        XCTAssertNil(p.muted)
        XCTAssertNil(p.showsControls)
        XCTAssertNil(p.aspectRatio)
    }

    func test_decodesFullVideoFromTheSharedFixture() throws {
        let node = try decodeNode(named: "video-full")
        guard case .video(let p) = node else { return XCTFail("expected video") }
        XCTAssertEqual(p.url.dark, "https://x/a-dark.mp4")
        XCTAssertEqual(p.posterUrl?.light, "https://x/poster.png")
        XCTAssertEqual(p.posterUrl?.dark, "https://x/poster-dark.png")
        // Each of these is the NON-default value, so a decoder that dropped
        // the field and let the default stand would fail here.
        XCTAssertEqual(p.autoplay, false)
        XCTAssertEqual(p.loop, false)
        XCTAssertEqual(p.muted, false)
        XCTAssertEqual(p.showsControls, true)
        XCTAssertEqual(p.aspectRatio, 1.777)
    }

    func test_decodesBareLottieFromTheSharedFixture() throws {
        let node = try decodeNode(named: "lottie-bare")
        guard case .lottie(let p) = node else { return XCTFail("expected lottie") }
        XCTAssertEqual(p.url.light, "https://x/a.json")
        XCTAssertNil(p.loop)
        XCTAssertNil(p.autoplay)
        XCTAssertNil(p.speed)
    }

    func test_decodesFullLottieFromTheSharedFixture() throws {
        let node = try decodeNode(named: "lottie-full")
        guard case .lottie(let p) = node else { return XCTFail("expected lottie") }
        XCTAssertEqual(p.url.dark, "https://x/a-dark.json")
        XCTAssertEqual(p.loop, false)
        XCTAssertEqual(p.autoplay, false)
        XCTAssertEqual(p.speed, 2)
    }

    /// Both media types whitelist their SOURCE (schema.ts's
    /// `OVERRIDABLE_PROP_KEYS.video` / `.lottie`), so an active override swaps
    /// the clip rather than a colour — and a key outside that whitelist still
    /// fails the whole config decode, exactly as it does for every other type.
    func test_videoAndLottieOverridesSwapTheSource() throws {
        let video = try firstChild(#"""
        {"type":"video","id":"v1","url":{"light":"https://x/a.mp4"},
         "overrides":[{"when":{"kind":"introEligible"},
                       "props":{"url":{"light":"https://x/trial.mp4"},
                                "posterUrl":{"light":"https://x/trial.png"}}}]}
        """#)
        guard case .video(let vp) = video else { return XCTFail("expected video") }
        let eligible = OverrideActiveConditions(introEligible: true, selected: false)
        XCTAssertEqual(applyOverrides(vp, active: eligible).url.light, "https://x/trial.mp4")
        XCTAssertEqual(applyOverrides(vp, active: eligible).posterUrl?.light, "https://x/trial.png")
        // Inactive: the authored source is what survives.
        let ineligible = OverrideActiveConditions(introEligible: false, selected: false)
        XCTAssertEqual(applyOverrides(vp, active: ineligible).url.light, "https://x/a.mp4")
        XCTAssertNil(applyOverrides(vp, active: ineligible).posterUrl)

        let lottie = try firstChild(#"""
        {"type":"lottie","id":"l1","url":{"light":"https://x/a.json"},
         "overrides":[{"when":{"kind":"selected"},"props":{"url":{"light":"https://x/sel.json"}}}]}
        """#)
        guard case .lottie(let lp) = lottie else { return XCTFail("expected lottie") }
        let selected = OverrideActiveConditions(introEligible: false, selected: true)
        XCTAssertEqual(applyOverrides(lp, active: selected).url.light, "https://x/sel.json")
    }

    func test_aNonWhitelistedMediaOverridePropFailsTheWholeConfig() {
        let json = """
        {"formatVersion":2,"defaultLocale":"en","localizations":{"en":{}},
         "root":{"type":"stack","id":"root","axis":"v","children":[
           {"type":"lottie","id":"l1","url":{"light":"https://x/a.json"},
            "overrides":[{"when":{"kind":"selected"},"props":{"speed":3}}]}]}}
        """
        XCTAssertNil(
            decodeBuilderConfig(json),
            "`speed` is not in OVERRIDABLE_PROP_KEYS.lottie, so the whole config must fail")
    }

    func test_countdownDeadline_parsesBothIsoSpellings() throws {
        let defaults = try scratchDefaults("RovenueTests.countdownDeadline.iso")
        let plain = countdownDeadline(
            props: CountdownProps(id: "cd", endsAt: "2027-01-01T00:00:00Z"),
            paywallIdentifier: nil, defaults: defaults)
        let fractional = countdownDeadline(
            props: CountdownProps(id: "cd", endsAt: "2027-01-01T00:00:00.000Z"),
            paywallIdentifier: nil, defaults: defaults)
        XCTAssertNotNil(plain)
        XCTAssertEqual(plain, fractional)
    }
}

private extension ISO8601DateFormatter {
    /// Parses the fractional-seconds spelling render-fixtures.json uses for
    /// `endsAt`; the default `ISO8601DateFormatter` refuses it.
    static let rovenueTestFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

/// Builds a `PackageView?` from a fixture's `pkg` field, which is either a
/// JSON object or JSON `null` (surfaced by `JSONSerialization` as `NSNull`).
private func packageView(fromFixture value: Any?) -> PackageView? {
    guard let dict = value as? [String: Any] else { return nil }
    return PackageView(
        packageName: dict["packageName"] as? String ?? "",
        price: dict["price"] as? String ?? "",
        pricePerPeriod: dict["pricePerPeriod"] as? String ?? "",
        period: dict["period"] as? String ?? "",
        pricePerDay: dict["pricePerDay"] as? String,
        pricePerWeek: dict["pricePerWeek"] as? String,
        pricePerMonth: dict["pricePerMonth"] as? String,
        pricePerYear: dict["pricePerYear"] as? String,
        introPrice: dict["introPrice"] as? String,
        introPeriod: dict["introPeriod"] as? String,
        relativeDiscount: dict["relativeDiscount"] as? String)
}
