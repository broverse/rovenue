import { describe, expect, it } from "vitest";
import {
  ATTRIBUTE_LIMITS,
  normalizeStored,
  flattenAttributes,
  applyMutations,
  validateAttributeInput,
  attributesBodySchema,
} from "./helpers";

const NOW = "2026-06-15T10:00:00.000Z";

describe("normalizeStored", () => {
  it("passes through already-nested entries", () => {
    const nested = { $email: { value: "a@b.com", updatedAt: NOW, source: "sdk" as const } };
    expect(normalizeStored(nested)).toEqual(nested);
  });

  it("upgrades a legacy flat map to nested (source=legacy)", () => {
    const out = normalizeStored({ country: "US", age: 30 });
    expect(out.country.value).toBe("US");
    expect(out.country.source).toBe("legacy");
    // non-string legacy scalars are coerced to string
    expect(out.age.value).toBe("30");
  });

  it("returns {} for null / non-object", () => {
    expect(normalizeStored(null)).toEqual({});
    expect(normalizeStored("x")).toEqual({});
  });
});

describe("flattenAttributes", () => {
  it("projects nested storage to a flat {key: value} map", () => {
    const nested = {
      $email: { value: "a@b.com", updatedAt: NOW, source: "sdk" as const },
      country: { value: "US", updatedAt: NOW, source: "legacy" as const },
    };
    expect(flattenAttributes(nested)).toEqual({ $email: "a@b.com", country: "US" });
  });

  it("tolerates a legacy flat map directly", () => {
    expect(flattenAttributes({ country: "US" })).toEqual({ country: "US" });
  });
});

describe("applyMutations", () => {
  it("sets new keys with server now + source", () => {
    const out = applyMutations({}, { $email: "a@b.com" }, "sdk", NOW);
    expect(out.$email).toEqual({ value: "a@b.com", updatedAt: NOW, source: "sdk" });
  });

  it("deletes a key when value is null", () => {
    const cur = { country: { value: "US", updatedAt: NOW, source: "sdk" as const } };
    expect(applyMutations(cur, { country: null }, "sdk", NOW)).toEqual({});
  });

  it("overwrites existing key and re-stamps updatedAt", () => {
    const cur = { country: { value: "US", updatedAt: "2020-01-01T00:00:00.000Z", source: "sdk" as const } };
    const out = applyMutations(cur, { country: "TR" }, "server", NOW);
    expect(out.country).toEqual({ value: "TR", updatedAt: NOW, source: "server" });
  });
});

describe("validateAttributeInput", () => {
  it("accepts a valid mix of reserved + custom", () => {
    expect(validateAttributeInput({ $email: "a@b.com", favoriteTeam: "GS" }, {})).toEqual([]);
  });

  it("rejects unknown reserved key", () => {
    const errs = validateAttributeInput({ $nope: "x" }, {});
    expect(errs[0]).toMatchObject({ key: "$nope" });
  });

  it("rejects malformed custom key", () => {
    const errs = validateAttributeInput({ "bad key!": "x" }, {});
    expect(errs[0].key).toBe("bad key!");
  });

  it("rejects over-long custom value", () => {
    const errs = validateAttributeInput({ note: "x".repeat(501) }, {});
    expect(errs[0].reason).toMatch(/500/);
  });

  it("enforces the custom-key count limit (deletes & reserved exempt)", () => {
    const current: Record<string, { value: string; updatedAt: string; source: "sdk" }> = {};
    for (let i = 0; i < ATTRIBUTE_LIMITS.customMax; i++) {
      current[`k${i}`] = { value: "v", updatedAt: NOW, source: "sdk" };
    }
    // adding one more NEW custom key exceeds the cap
    expect(validateAttributeInput({ extra: "v" }, current).length).toBe(1);
    // overwriting an existing custom key is fine
    expect(validateAttributeInput({ k0: "v2" }, current)).toEqual([]);
    // deleting is always fine
    expect(validateAttributeInput({ extra: null }, current)).toEqual([]);
  });
});

describe("attributesBodySchema", () => {
  it("accepts strings and nulls", () => {
    const r = attributesBodySchema.safeParse({ attributes: { a: "x", b: null } });
    expect(r.success).toBe(true);
  });
  it("rejects non-string/non-null values", () => {
    const r = attributesBodySchema.safeParse({ attributes: { a: 5 } });
    expect(r.success).toBe(false);
  });
});
