import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { builderConfigSchema } from "./schema";
import { resolveText } from "./validate";
import { resolveVariables, type PackageView } from "./variables";
import type { BuilderConfig } from "./schema";

// =============================================================
// render-fixtures.json — the cross-platform contract file.
//
// Swift (Codable) and Kotlin (kotlinx-serialization) builder-config
// decoders assert against the SAME file (Phase C). This suite guards
// the fixture against rot on the TS side:
//   - every `accept` config passes the strict authoring schema,
//   - every `acceptLenient` config FAILS the strict schema (they
//     contain unknown node types platform decoders must tolerate by
//     falling back — the asymmetry is deliberate, see _comment),
//   - every `reject` config fails the schema,
//   - variable / resolveText vectors match the real implementations.
// =============================================================

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "render-fixtures.json",
);

interface Fixture {
  _comment: string;
  accept: Array<{ name: string; config: unknown }>;
  acceptLenient: Array<{ name: string; config: unknown }>;
  reject: Array<{ name: string; reason: string; config: unknown }>;
  variables: Array<{
    text: string;
    pkg: PackageView | null;
    expected: string;
  }>;
  resolveText: Array<{
    locale: string;
    key: string;
    expected: string | null;
  }>;
}

const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("render-fixtures contract", () => {
  it("has the required coverage counts", () => {
    expect(fixture.accept.length).toBeGreaterThanOrEqual(6);
    expect(fixture.acceptLenient.length).toBeGreaterThanOrEqual(1);
    expect(fixture.reject.length).toBeGreaterThanOrEqual(5);
    expect(fixture.variables.length).toBeGreaterThanOrEqual(8);
    expect(fixture.resolveText.length).toBeGreaterThanOrEqual(4);
    expect(fixture._comment).toContain("lenient");
  });

  describe("accept", () => {
    for (const c of fixture.accept) {
      it(`schema accepts: ${c.name}`, () => {
        const r = builderConfigSchema.safeParse(c.config);
        expect(r.success, JSON.stringify((r as { error?: unknown }).error)).toBe(true);
      });
    }
  });

  describe("acceptLenient (strict schema must REJECT these)", () => {
    for (const c of fixture.acceptLenient) {
      it(`strict schema rejects: ${c.name}`, () => {
        expect(builderConfigSchema.safeParse(c.config).success).toBe(false);
      });
    }
  });

  describe("reject", () => {
    for (const c of fixture.reject) {
      it(`schema rejects: ${c.name} (${c.reason})`, () => {
        expect(builderConfigSchema.safeParse(c.config).success).toBe(false);
      });
    }
  });

  describe("variables vectors", () => {
    fixture.variables.forEach((v, i) => {
      it(`vector ${i}: ${JSON.stringify(v.text).slice(0, 40)}`, () => {
        expect(resolveVariables(v.text, v.pkg)).toBe(v.expected);
      });
    });
  });

  describe("resolveText vectors (against accept[0])", () => {
    const config = fixture.accept[0]!.config as BuilderConfig;
    for (const v of fixture.resolveText) {
      it(`${v.locale}/${v.key} → ${JSON.stringify(v.expected)}`, () => {
        expect(resolveText(config, v.locale, v.key)).toBe(v.expected);
      });
    }
  });
});
