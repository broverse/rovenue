//  VisibilityDecodeTests.swift — the DECODER's retention of `visibility`,
//  as opposed to the evaluator's behaviour.
//
//  The `visibility` vectors decode a bare `Visibility` blob and the `accept`
//  fixtures only assert a non-nil config, so nothing drove the real
//  `decodeBuilderConfig` over the seven node payloads. Swift's type system
//  catches an unassigned `let visibility` in one of the seven hand-written
//  `init(from:)`s, but a typo'd `CodingKeys` raw value compiles fine and
//  silently never decodes — that is the class this pins, and it is the one
//  the RN and Kotlin siblings already cover.

import XCTest
@testable import Rovenue

final class VisibilityDecodeTests: XCTestCase {
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

    func test_keepsValidPlatformAndBounds() throws {
        let node = try firstChild("""
        {"type":"text","id":"t","key":"k","role":"body",
         "visibility":{"platform":["ios"],"minAppVersion":"1.0","maxAppVersion":"2.0"}}
        """)
        XCTAssertEqual(node.visibility?.platform, ["ios"])
        XCTAssertEqual(node.visibility?.minAppVersion, "1.0")
        XCTAssertEqual(node.visibility?.maxAppVersion, "2.0")
    }

    func test_dropsUnknownPlatformStringLeniently() throws {
        let node = try firstChild("""
        {"type":"text","id":"t","key":"k","role":"body","visibility":{"platform":["ios","tvos"]}}
        """)
        XCTAssertEqual(node.visibility?.platform, ["ios"])
    }

    func test_collapsesAllDroppedPlatformListToNil() throws {
        let node = try firstChild("""
        {"type":"text","id":"t","key":"k","role":"body","visibility":{"platform":["tvos"]}}
        """)
        XCTAssertNil(node.visibility?.platform)
    }

    func test_retainsVisibilityOnEverySevenNodeTypes() throws {
        let shapes: [(String, String)] = [
            ("stack", #"{"type":"stack","id":"n","axis":"v","children":[]"#),
            ("text", #"{"type":"text","id":"n","key":"k","role":"body""#),
            ("image", #"{"type":"image","id":"n","url":{"light":"u"}"#),
            ("button", #"{"type":"button","id":"n","labelKey":"k","style":"primary","action":{"kind":"restore"}"#),
            ("packageList", #"{"type":"packageList","id":"n","packageIds":[],"cellLayout":"row""#),
            ("purchaseButton", #"{"type":"purchaseButton","id":"n","labelKey":"k""#),
            ("spacer", #"{"type":"spacer","id":"n","size":4"#),
        ]
        for (type, prefix) in shapes {
            let node = try firstChild(prefix + #","visibility":{"platform":["ios"]}}"#)
            XCTAssertEqual(node.visibility?.platform, ["ios"], "visibility dropped on \(type)")
        }
    }

    func test_noVisibilityDecodesToNil() throws {
        let node = try firstChild(#"{"type":"text","id":"t","key":"k","role":"body"}"#)
        XCTAssertNil(node.visibility)
    }

    /// The contract's forward-compat case: an unknown node `type` carrying
    /// `visibility`. Dropping it would render the fallback on a platform the
    /// author excluded. Driven off the shared fixture so all three native
    /// decoders are held to the same entry.
    func test_retainsVisibilityOnAnUnknownNodeType() throws {
        let fixtures = RenderFixtures.load()
        let entries = try XCTUnwrap(fixtures["acceptLenient"] as? [[String: Any]])
        let entry = try XCTUnwrap(entries.first {
            ($0["name"] as? String)?.hasPrefix("unknown node type carrying visibility") == true
        })
        let data = try JSONSerialization.data(withJSONObject: try XCTUnwrap(entry["config"]))
        let model = try XCTUnwrap(decodeBuilderConfig(String(decoding: data, as: UTF8.self)))
        guard case .stack(let root) = model.root else {
            XCTFail("root did not decode as a stack"); return
        }
        let node = try XCTUnwrap(root.children.first)
        guard case .unknown = node else {
            XCTFail("expected the node to decode as .unknown"); return
        }
        XCTAssertEqual(node.visibility?.platform, ["ios"])
    }
}
