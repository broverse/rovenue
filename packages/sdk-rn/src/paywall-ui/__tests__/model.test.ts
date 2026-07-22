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
      expect(decodeBuilderConfig(c.config)).not.toBeNull();
    });
  }

  it("unknown node retains its strictly-parsed fallback subtree", () => {
    const config = decodeBuilderConfig(fixture.acceptLenient[0]!.config)!;
    expect(containsUnknown(config.root)).toBe(true);
    const unknown = firstUnknown(config.root);
    expect(unknown?.fallback?.type).toBe("text");
  });

  it("unknown node type without a fallback decodes to `unknown` with no fallback", () => {
    const entry = fixture.acceptLenient.find((c) => c.name.startsWith("unknown node type without fallback"))!;
    const config = decodeBuilderConfig(entry.config)!;
    expect(containsUnknown(config.root)).toBe(true);
    const unknown = firstUnknown(config.root);
    expect(unknown?.fallback).toBeUndefined();
  });

  it("an override with an unknown when.kind is RETAINED in the array but never matches (D2 acceptLenient case)", () => {
    // Pins render-fixtures.json's acceptLenient case: the strict schema
    // rejects the whole config (an unknown when.kind isn't a valid
    // OverrideCondition), but this lenient decoder decodes leniently,
    // skipping ONLY this override entry's activation (never its
    // presence) — the entry stays in the array, never a config failure,
    // and the node itself is NOT an `unknown` node (it's still `text`).
    const entry = fixture.acceptLenient.find((c) => c.name.startsWith("override with unknown when.kind"))!;
    const config = decodeBuilderConfig(entry.config)!;
    expect(containsUnknown(config.root)).toBe(false);
    const title = config.root.children[0]!;
    expect(title.type).toBe("text");
    if (title.type !== "text") throw new Error("expected root.children[0] to be text");
    expect(title.overrides).toHaveLength(2);
    expect(title.overrides?.[0]).toEqual({ when: { kind: "introEligible" }, props: { align: "center" } });
    expect(title.overrides?.[1]).toEqual({ when: { kind: "unknown" } });
  });

  for (const c of fixture.reject) {
    it(`rejects (${c.reason}): ${c.name}`, () => {
      expect(decodeBuilderConfig(c.config)).toBeNull();
    });
  }

  it("decodes packageList.cellTemplate as a recursive subtree carrying its own overrides", () => {
    const entry = fixture.accept.find((c) => c.name.startsWith("packageList with cellTemplate"))!;
    const config = decodeBuilderConfig(entry.config)!;
    const pl = config.root.children[0]!;
    expect(pl.type).toBe("packageList");
    if (pl.type !== "packageList") throw new Error("expected packageList");
    const template = pl.cellTemplate;
    expect(template).toBeDefined();
    expect(template?.type).toBe("stack");
    if (template?.type !== "stack") throw new Error("expected cellTemplate to be a stack node");
    expect(template.overrides).toEqual([
      { when: { kind: "selected" }, props: { background: { light: "#EEF2FF" } } },
    ]);
    expect(template.children).toHaveLength(3);
    const badge = template.children[1]!;
    expect(badge.type).toBe("text");
    if (badge.type !== "text") throw new Error("expected badge to be text");
    expect(badge.overrides).toEqual([
      { when: { kind: "selected" }, props: { color: { light: "#4338CA" } } },
    ]);
  });

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
