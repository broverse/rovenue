import { describe, expect, test } from "vitest";
import {
  EXPERIMENT_TYPE,
  experimentSchema,
  type Experiment,
  type FlagValue,
  type PaywallConfig,
  variantSchema,
} from "./experiments";

// =============================================================
// EXPERIMENT_TYPE
// =============================================================

describe("EXPERIMENT_TYPE", () => {
  test("enumerates FLAG, PRODUCT_GROUP, PAYWALL, ELEMENT", () => {
    expect(EXPERIMENT_TYPE.FLAG).toBe("FLAG");
    expect(EXPERIMENT_TYPE.PRODUCT_GROUP).toBe("PRODUCT_GROUP");
    expect(EXPERIMENT_TYPE.PAYWALL).toBe("PAYWALL");
    expect(EXPERIMENT_TYPE.ELEMENT).toBe("ELEMENT");
  });
});

// =============================================================
// variantSchema
// =============================================================

describe("variantSchema", () => {
  test("parses a basic variant with boolean value", () => {
    const input = {
      id: "control",
      name: "Off",
      value: false,
      weight: 0.5,
    };

    expect(variantSchema.parse(input)).toEqual(input);
  });

  test("value is opaque — any JSON-shaped payload passes", () => {
    const complex = {
      id: "variant_a",
      name: "Yaz Kampanyası",
      value: {
        title: "Pro'yu Dene",
        nested: { deeply: { value: 42 } },
        list: [1, "two", true, null],
      },
      weight: 0.5,
    };

    expect(variantSchema.parse(complex)).toEqual(complex);
  });

  test("rejects missing id", () => {
    expect(() =>
      variantSchema.parse({ name: "X", value: 1, weight: 1 }),
    ).toThrow();
  });

  test("rejects weight out of [0, 1]", () => {
    expect(() =>
      variantSchema.parse({ id: "a", name: "A", value: 1, weight: 1.5 }),
    ).toThrow();
    expect(() =>
      variantSchema.parse({ id: "a", name: "A", value: 1, weight: -0.1 }),
    ).toThrow();
  });
});

// =============================================================
// experimentSchema — happy paths for all 4 types
// =============================================================

describe("experimentSchema", () => {
  test("parses a FLAG experiment", () => {
    const input = {
      type: "FLAG",
      key: "new-paywall-enabled",
      variants: [
        { id: "control", name: "Off", value: false, weight: 0.5 },
        { id: "variant_a", name: "On", value: true, weight: 0.5 },
      ],
    };

    const parsed = experimentSchema.parse(input);
    expect(parsed.type).toBe("FLAG");
    expect(parsed.variants).toHaveLength(2);
  });

  test("parses a PRODUCT_GROUP experiment", () => {
    const input = {
      type: "PRODUCT_GROUP",
      key: "pricing-test",
      variants: [
        { id: "control", name: "Default", value: "default", weight: 0.5 },
        {
          id: "variant_a",
          name: "Weekly Promoted",
          value: "weekly_first",
          weight: 0.5,
        },
      ],
    };

    const parsed = experimentSchema.parse(input);
    expect(parsed.type).toBe("PRODUCT_GROUP");
    expect(parsed.variants[0]!.value).toBe("default");
  });

  test("parses a PAYWALL experiment with typed config value", () => {
    const input = {
      type: "PAYWALL",
      key: "paywall-summer",
      variants: [
        {
          id: "control",
          name: "Mevcut",
          value: {
            title: "Premium'a Geç",
            subtitle: "Sınırsız erişim",
            ctaText: "Başla",
            ctaColor: "#4F46E5",
            layout: "vertical",
            showBadge: true,
            badgeText: "Popüler",
            backgroundImage: null,
            showTestimonial: false,
          },
          weight: 0.5,
        },
        {
          id: "variant_a",
          name: "Yaz Kampanyası",
          value: {
            title: "Pro'yu Dene",
            subtitle: "7 gün ücretsiz",
            ctaText: "Ücretsiz Başla",
            ctaColor: "#059669",
            layout: "horizontal",
            showBadge: false,
            backgroundImage: "https://cdn.example.com/summer.jpg",
            showTestimonial: true,
          },
          weight: 0.5,
        },
      ],
    };

    const parsed = experimentSchema.parse(input);
    expect(parsed.type).toBe("PAYWALL");

    // The engine is type-agnostic, but consumers can cast the opaque
    // value to the PaywallConfig interface at the boundary.
    const variantValue = parsed.variants[0]!.value as PaywallConfig;
    expect(variantValue.ctaColor).toBe("#4F46E5");
    expect(variantValue.layout).toBe("vertical");
  });

  test("parses an ELEMENT experiment with 3 variants summing to 1", () => {
    const input = {
      type: "ELEMENT",
      key: "cta-text-test",
      variants: [
        {
          id: "control",
          name: "Satın Al",
          value: { ctaText: "Satın Al" },
          weight: 0.34,
        },
        {
          id: "variant_a",
          name: "Hemen Başla",
          value: { ctaText: "Hemen Başla" },
          weight: 0.33,
        },
        {
          id: "variant_b",
          name: "Ücretsiz Dene",
          value: { ctaText: "Ücretsiz Dene" },
          weight: 0.33,
        },
      ],
    };

    const parsed = experimentSchema.parse(input);
    expect(parsed.variants).toHaveLength(3);
  });
});

// =============================================================
// experimentSchema — rejections
// =============================================================

describe("experimentSchema rejections", () => {
  test("rejects an unknown type", () => {
    expect(() =>
      experimentSchema.parse({
        type: "BOGUS",
        key: "x",
        variants: [
          { id: "a", name: "A", value: 1, weight: 0.5 },
          { id: "b", name: "B", value: 2, weight: 0.5 },
        ],
      }),
    ).toThrow();
  });

  test("rejects fewer than 2 variants", () => {
    expect(() =>
      experimentSchema.parse({
        type: "FLAG",
        key: "x",
        variants: [{ id: "a", name: "A", value: 1, weight: 1 }],
      }),
    ).toThrow(/at least 2/i);
  });

  test("rejects variant weights that don't sum to 1", () => {
    expect(() =>
      experimentSchema.parse({
        type: "FLAG",
        key: "broken",
        variants: [
          { id: "a", name: "A", value: 1, weight: 0.3 },
          { id: "b", name: "B", value: 2, weight: 0.3 },
        ],
      }),
    ).toThrow(/sum to 1/i);
  });

  test("accepts weights within floating-point tolerance of 1", () => {
    // 0.1 + 0.2 = 0.30000000000000004
    expect(() =>
      experimentSchema.parse({
        type: "FLAG",
        key: "fp",
        variants: [
          { id: "a", name: "A", value: 1, weight: 0.1 },
          { id: "b", name: "B", value: 2, weight: 0.2 },
          { id: "c", name: "C", value: 3, weight: 0.7 },
        ],
      }),
    ).not.toThrow();
  });

  test("rejects duplicate variant ids", () => {
    expect(() =>
      experimentSchema.parse({
        type: "FLAG",
        key: "dup",
        variants: [
          { id: "a", name: "A", value: 1, weight: 0.5 },
          { id: "a", name: "A2", value: 2, weight: 0.5 },
        ],
      }),
    ).toThrow(/duplicate/i);
  });

  test("rejects an empty key", () => {
    expect(() =>
      experimentSchema.parse({
        type: "FLAG",
        key: "",
        variants: [
          { id: "a", name: "A", value: 1, weight: 0.5 },
          { id: "b", name: "B", value: 2, weight: 0.5 },
        ],
      }),
    ).toThrow();
  });
});

// =============================================================
// Type-level smoke check (compiles iff exports line up)
// =============================================================

describe("exported types compile", () => {
  test("Experiment type matches schema", () => {
    const value: Experiment = {
      type: "FLAG",
      key: "x",
      variants: [
        { id: "a", name: "A", value: true, weight: 0.5 },
        { id: "b", name: "B", value: false, weight: 0.5 },
      ],
    };
    expect(experimentSchema.parse(value)).toEqual(value);
  });

  test("FlagValue type accepts boolean | string | number | null", () => {
    const values: FlagValue[] = [true, "on", 42, null];
    expect(values).toHaveLength(4);
  });
});
