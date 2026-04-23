import { describe, expect, test } from "vitest";
import { matchesAudience, validateAudienceRules } from "./targeting";

// =============================================================
// Empty rules — "All Users"
// =============================================================

describe("matchesAudience — empty rules", () => {
  test("matches every subscriber when rules is an empty object", () => {
    expect(matchesAudience({ country: "TR" }, {})).toBe(true);
    expect(matchesAudience({}, {})).toBe(true);
  });

  test("matches when rules is null/undefined (All Users fallback)", () => {
    expect(
      matchesAudience({ country: "TR" }, null as unknown as Record<string, unknown>),
    ).toBe(true);
    expect(
      matchesAudience({ country: "TR" }, undefined as unknown as Record<string, unknown>),
    ).toBe(true);
  });
});

// =============================================================
// $in / $nin
// =============================================================

describe("matchesAudience — $in / $nin", () => {
  test("$in accepts values present in the list", () => {
    const rules = { country: { $in: ["TR", "AZ"] } };
    expect(matchesAudience({ country: "TR" }, rules)).toBe(true);
    expect(matchesAudience({ country: "AZ" }, rules)).toBe(true);
    expect(matchesAudience({ country: "DE" }, rules)).toBe(false);
  });

  test("$nin rejects values in the list", () => {
    const rules = { country: { $nin: ["US"] } };
    expect(matchesAudience({ country: "TR" }, rules)).toBe(true);
    expect(matchesAudience({ country: "US" }, rules)).toBe(false);
  });
});

// =============================================================
// Equality + combined filters
// =============================================================

describe("matchesAudience — platform + version", () => {
  test("AND across multiple top-level keys", () => {
    const rules = {
      platform: "ios",
      appVersion: { $gte: "2.0" },
    };
    expect(
      matchesAudience({ platform: "ios", appVersion: "2.1" }, rules),
    ).toBe(true);
    expect(
      matchesAudience({ platform: "android", appVersion: "2.1" }, rules),
    ).toBe(false);
    expect(
      matchesAudience({ platform: "ios", appVersion: "1.9" }, rules),
    ).toBe(false);
  });

  test("$gte on numeric totalRevenue", () => {
    const rules = { totalRevenue: { $gte: 50 } };
    expect(matchesAudience({ totalRevenue: 50 }, rules)).toBe(true);
    expect(matchesAudience({ totalRevenue: 100 }, rules)).toBe(true);
    expect(matchesAudience({ totalRevenue: 49.99 }, rules)).toBe(false);
  });
});

// =============================================================
// Nested custom attributes (dot notation)
// =============================================================

describe("matchesAudience — nested attributes", () => {
  test("dot-notation dives into nested objects", () => {
    const attributes = {
      country: "TR",
      attributes: {
        totalRevenue: 150,
        plan: "enterprise",
      },
    };
    const rules = {
      "attributes.totalRevenue": { $gte: 100 },
      "attributes.plan": "enterprise",
    };
    expect(matchesAudience(attributes, rules)).toBe(true);
  });

  test("fails when nested attribute is missing", () => {
    const rules = { "attributes.customField": "x" };
    expect(matchesAudience({ attributes: {} }, rules)).toBe(false);
  });
});

// =============================================================
// $and / $or / $not composition
// =============================================================

describe("matchesAudience — logical operators", () => {
  test("$or accepts when any branch matches", () => {
    const rules = {
      $or: [{ country: "TR" }, { country: "DE" }],
    };
    expect(matchesAudience({ country: "TR" }, rules)).toBe(true);
    expect(matchesAudience({ country: "DE" }, rules)).toBe(true);
    expect(matchesAudience({ country: "US" }, rules)).toBe(false);
  });

  test("$and requires every branch", () => {
    const rules = {
      $and: [{ platform: "ios" }, { appVersion: { $gte: "2.0" } }],
    };
    expect(
      matchesAudience({ platform: "ios", appVersion: "2.5" }, rules),
    ).toBe(true);
    expect(
      matchesAudience({ platform: "ios", appVersion: "1.0" }, rules),
    ).toBe(false);
  });
});

// =============================================================
// $exists
// =============================================================

describe("matchesAudience — $exists", () => {
  test("true when the field is present", () => {
    const rules = { email: { $exists: true } };
    expect(matchesAudience({ email: "a@b.c" }, rules)).toBe(true);
    expect(matchesAudience({}, rules)).toBe(false);
  });
});

// =============================================================
// validateAudienceRules — operator allowlist
// =============================================================

describe("validateAudienceRules — rejects dangerous operators", () => {
  test("rejects $regex (ReDoS risk)", () => {
    expect(() => validateAudienceRules({ email: { $regex: "^a+b" } })).toThrow(
      /\$regex is not allowed/,
    );
  });

  test("rejects $where (arbitrary JS)", () => {
    expect(() =>
      validateAudienceRules({ $where: "this.country === 'TR'" }),
    ).toThrow(/\$where is not allowed/);
  });

  test("rejects $expr (aggregation expressions)", () => {
    expect(() =>
      validateAudienceRules({ $expr: { $eq: ["$a", "$b"] } }),
    ).toThrow(/\$expr is not allowed/);
  });

  test("rejects $function", () => {
    expect(() =>
      validateAudienceRules({
        $function: { body: "function(){}", args: [], lang: "js" },
      }),
    ).toThrow(/\$function is not allowed/);
  });

  test("accepts the standard operator set", () => {
    expect(() =>
      validateAudienceRules({
        $and: [
          { country: { $in: ["TR", "AZ"] } },
          { totalRevenue: { $gte: 50 } },
          { email: { $exists: true } },
        ],
      }),
    ).not.toThrow();
  });
});
