import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodeBuilderConfig, type BuilderConfigModel, type BuilderNode } from "../model";
import { resolveText, resolveVariables, type PackageView } from "../helpers";

// Asserts the RN decoder against the SHARED cross-platform contract file —
// the same render-fixtures.json the TS schema, Swift, and Kotlin tests
// consume. See the fixture's `_comment` for the strict-schema vs
// lenient-decoder asymmetry.

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../shared/src/paywall/render-fixtures.json",
);

interface Fixture {
  accept: Array<{ name: string; config: unknown }>;
  acceptLenient: Array<{ name: string; config: unknown }>;
  reject: Array<{ name: string; reason: string; config: unknown }>;
  variables: Array<{ text: string; pkg: PackageView | null; expected: string }>;
  resolveText: Array<{ locale: string; key: string; expected: string | null }>;
}

const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

function containsUnknown(node: BuilderNode): boolean {
  if (node.type === "unknown") return true;
  if (node.type === "stack") return node.children.some(containsUnknown);
  return false;
}

function firstUnknown(node: BuilderNode): Extract<BuilderNode, { type: "unknown" }> | null {
  if (node.type === "unknown") return node;
  if (node.type === "stack") {
    for (const child of node.children) {
      const found = firstUnknown(child);
      if (found) return found;
    }
  }
  return null;
}

describe("RN builder-config decoder vs render-fixtures", () => {
  for (const c of fixture.accept) {
    it(`accepts: ${c.name}`, () => {
      expect(decodeBuilderConfig(c.config)).not.toBeNull();
    });
  }

  for (const c of fixture.acceptLenient) {
    it(`leniently accepts: ${c.name}`, () => {
      const config = decodeBuilderConfig(c.config);
      expect(config).not.toBeNull();
      expect(containsUnknown(config!.root)).toBe(true);
    });
  }

  it("unknown node retains its strictly-parsed fallback subtree", () => {
    const config = decodeBuilderConfig(fixture.acceptLenient[0]!.config)!;
    const unknown = firstUnknown(config.root);
    expect(unknown?.fallback?.type).toBe("text");
  });

  for (const c of fixture.reject) {
    it(`rejects (${c.reason}): ${c.name}`, () => {
      expect(decodeBuilderConfig(c.config)).toBeNull();
    });
  }

  it("rejects non-object inputs", () => {
    expect(decodeBuilderConfig(null)).toBeNull();
    expect(decodeBuilderConfig([])).toBeNull();
    expect(decodeBuilderConfig("{}")).toBeNull();
  });

  describe("variables vectors", () => {
    fixture.variables.forEach((v, i) => {
      it(`vector ${i}`, () => {
        expect(resolveVariables(v.text, v.pkg)).toBe(v.expected);
      });
    });
  });

  describe("resolveText vectors (against accept[0])", () => {
    const config = decodeBuilderConfig(fixture.accept[0]!.config) as BuilderConfigModel;
    for (const v of fixture.resolveText) {
      it(`${v.locale}/${v.key}`, () => {
        expect(resolveText(config, v.locale, v.key)).toBe(v.expected);
      });
    }
  });
});
