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
        guard case .unknown(let id, let fallback) = root.children[0] else {
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
        guard case .unknown(let id, let fallback) = root.children[0] else {
            return XCTFail("expected root.children[0] to decode as .unknown")
        }
        XCTAssertEqual(id, "vid_1")
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

    func testResolveTextWithNilLocaleFallsStraightToDefaultLocale() throws {
        let accept = try XCTUnwrap(fixtures["accept"] as? [[String: Any]])
        let canonicalEntry = try XCTUnwrap(accept.first { ($0["name"] as? String) == "canonical every-node multi-locale" })
        let config = try XCTUnwrap(canonicalEntry["config"])
        let decoded = try XCTUnwrap(decodeBuilderConfig(RenderFixtures.jsonString(for: config)))
        XCTAssertEqual(resolveText(decoded, locale: nil, key: "title_1"), "Go Pro")
    }
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
