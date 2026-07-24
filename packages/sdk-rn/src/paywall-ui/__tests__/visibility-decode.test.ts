import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBuilderConfig, type BuilderNode } from "../model";

const FIXTURES = JSON.parse(
  readFileSync(join(__dirname, "../../../../shared/src/paywall/render-fixtures.json"), "utf8"),
) as { acceptLenient: Array<{ name: string; config: unknown }> };

// The evaluator vectors run isNodeVisible directly and the render-fixtures
// `accept` cases only assert a non-null decode — so the DECODER's lenient
// retention of `visibility` was untested until here. A wrong decoder that
// dropped the field, kept an unknown platform, or missed a node type would
// pass every other test.

function root(child: Record<string, unknown>): unknown {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: { k: "x" } },
    root: { type: "stack", id: "root", axis: "v", children: [child] },
  };
}
function firstChild(m: ReturnType<typeof decodeBuilderConfig>): BuilderNode {
  const stack = m!.root as Extract<BuilderNode, { type: "stack" }>;
  return stack.children[0]!;
}

describe("decoder retains node visibility, leniently", () => {
  it("keeps a valid platform + version bounds", () => {
    const node = firstChild(
      decodeBuilderConfig(root({ type: "text", id: "t", key: "k", role: "body", visibility: { platform: ["ios"], minAppVersion: "1.0", maxAppVersion: "2.0" } })),
    );
    expect(node.visibility).toEqual({ platform: ["ios"], minAppVersion: "1.0", maxAppVersion: "2.0" });
  });

  it("drops an unrecognised platform string instead of failing the decode", () => {
    const node = firstChild(
      decodeBuilderConfig(root({ type: "text", id: "t", key: "k", role: "body", visibility: { platform: ["ios", "tvos"] } })),
    );
    expect(node.visibility?.platform).toEqual(["ios"]);
  });

  it("collapses an all-dropped or empty platform list to undefined", () => {
    const allDropped = firstChild(
      decodeBuilderConfig(root({ type: "text", id: "t", key: "k", role: "body", visibility: { platform: ["tvos"] } })),
    );
    expect(allDropped.visibility?.platform).toBeUndefined();
    const empty = firstChild(
      decodeBuilderConfig(root({ type: "text", id: "t", key: "k", role: "body", visibility: { platform: [] } })),
    );
    expect(empty.visibility?.platform).toBeUndefined();
  });

  it("retains visibility on every one of the seven node types", () => {
    const nodes: Record<string, Record<string, unknown>> = {
      stack: { type: "stack", id: "n", axis: "v", children: [] },
      text: { type: "text", id: "n", key: "k", role: "body" },
      image: { type: "image", id: "n", url: { light: "u" } },
      button: { type: "button", id: "n", labelKey: "k", style: "primary", action: { kind: "restore" } },
      packageList: { type: "packageList", id: "n", packageIds: [], cellLayout: "row" },
      purchaseButton: { type: "purchaseButton", id: "n", labelKey: "k" },
      spacer: { type: "spacer", id: "n", size: 4 },
    };
    for (const [type, shape] of Object.entries(nodes)) {
      const node = firstChild(decodeBuilderConfig(root({ ...shape, visibility: { platform: ["ios"] } })));
      expect(node.visibility, `visibility dropped on ${type}`).toEqual({ platform: ["ios"] });
    }
  });

  it("decodes a node with no visibility to undefined, not an empty object", () => {
    const node = firstChild(
      decodeBuilderConfig(root({ type: "text", id: "t", key: "k", role: "body" })),
    );
    expect(node.visibility).toBeUndefined();
  });

  it("retains visibility on an UNKNOWN node type — the contract's forward-compat case", () => {
    // Driven off the shared fixture so all three native decoders are held
    // to the same entry. Dropping visibility here would render the
    // fallback on a platform the author excluded.
    const entry = FIXTURES.acceptLenient.find((c) => c.name.startsWith("unknown node type carrying visibility"))!;
    const model = decodeBuilderConfig(entry.config)!;
    const stack = model.root as Extract<BuilderNode, { type: "stack" }>;
    const unknown = stack.children[0]!;
    expect(unknown.type).toBe("unknown");
    expect(unknown.visibility).toEqual({ platform: ["ios"] });
  });
});
