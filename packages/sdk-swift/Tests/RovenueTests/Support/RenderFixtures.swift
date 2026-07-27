//  RenderFixtures.swift — loads the cross-platform paywall contract fixture
//  (packages/shared/src/paywall/render-fixtures.json) for the builder-config
//  decoder + view-model-helper tests.
//
//  The fixture is NOT bundled into the library or test target — it's read
//  straight off disk, located relative to the calling test file's own path
//  (`#filePath`, captured at the call site by default-argument semantics)
//  walking up to the repo root: Tests/RovenueTests -> Tests -> sdk-swift ->
//  packages -> <repo root>.

import Foundation
import XCTest

enum RenderFixtures {
    /// Repo-root-relative path to the frozen cross-platform fixture.
    private static let relativePath = "packages/shared/src/paywall/render-fixtures.json"

    /// Repo-root-relative path to the icon registry — the contract behind
    /// `sfSymbolName(for:)`: every entry's `name` must map to an SF Symbol.
    private static let iconRegistryRelativePath = "packages/shared/src/paywall/icon-registry.json"

    /// Locates the repo root from a test file's `#filePath`
    /// (.../packages/sdk-swift/Tests/RovenueTests/<File>.swift): five
    /// `deleteLastPathComponent()` calls strip the filename, then
    /// RovenueTests, Tests, sdk-swift, and packages.
    static func repoRootURL(fromTestFile filePath: String) -> URL {
        var url = URL(fileURLWithPath: filePath)
        for _ in 0..<5 {
            url.deleteLastPathComponent()
        }
        return url
    }

    /// Loads and parses render-fixtures.json as a loose JSON object. Fails
    /// the calling test (with the resolved path in the message) rather than
    /// crashing the whole test run when the fixture is missing or malformed
    /// — the file lives outside this package's own source tree.
    static func load(file: StaticString = #filePath, line: UInt = #line) -> [String: Any] {
        let fixtureURL = repoRootURL(fromTestFile: "\(file)").appendingPathComponent(relativePath)
        guard let data = try? Data(contentsOf: fixtureURL) else {
            XCTFail(
                "render-fixtures.json not found at \(fixtureURL.path) — expected the frozen contract fixture at packages/shared/src/paywall/render-fixtures.json relative to the repo root",
                file: file, line: line)
            return [:]
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("render-fixtures.json at \(fixtureURL.path) did not parse as a JSON object", file: file, line: line)
            return [:]
        }
        return json
    }

    /// Loads every `name` from icon-registry.json's `icons` array — the
    /// registry is the contract: every name it lists must have a mapped SF
    /// Symbol (see `sfSymbolName(for:)`).
    static func iconRegistryNames(file: StaticString = #filePath, line: UInt = #line) -> [String] {
        let registryURL = repoRootURL(fromTestFile: "\(file)").appendingPathComponent(iconRegistryRelativePath)
        guard let data = try? Data(contentsOf: registryURL) else {
            XCTFail(
                "icon-registry.json not found at \(registryURL.path) — expected it at packages/shared/src/paywall/icon-registry.json relative to the repo root",
                file: file, line: line)
            return []
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let icons = json["icons"] as? [[String: Any]]
        else {
            XCTFail("icon-registry.json at \(registryURL.path) did not parse as expected", file: file, line: line)
            return []
        }
        return icons.compactMap { $0["name"] as? String }
    }

    /// Re-serializes a fixture entry's `config` value (already-parsed JSON)
    /// back to a compact JSON string, matching what `Paywall.builderConfigJson`
    /// carries over the wire.
    static func jsonString(for config: Any) -> String {
        guard JSONSerialization.isValidJSONObject(config),
              let data = try? JSONSerialization.data(withJSONObject: config),
              let string = String(data: data, encoding: .utf8)
        else {
            XCTFail("fixture config entry could not be re-serialized to JSON")
            return "{}"
        }
        return string
    }
}
