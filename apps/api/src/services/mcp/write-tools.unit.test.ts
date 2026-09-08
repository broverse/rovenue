// =============================================================
// MCP catalog write tools: DB-free unit coverage.
//
// The propose/confirm flow itself is covered by
// write-tools.integration.test.ts (host-run, needs Postgres). This
// file pins the two pieces that need no database: the canonical
// payload binding (a swapped confirmation must fail closed, while
// key order or dropped undefineds must not split an honest echo)
// and the MCP-local preview builders.
// =============================================================

import { describe, expect, it } from "vitest";
import {
  buildEntitlementCreatePreview,
  buildOfferingCreatePreview,
  buildProductCreatePreview,
  canonicalizeIntentPayload,
  intentPayloadsEqual,
} from "./write-tools";

describe("intentPayloadsEqual", () => {
  it("ignores key order", () => {
    expect(
      intentPayloadsEqual(
        { identifier: "a", displayName: "A" },
        { displayName: "A", identifier: "a" },
      ),
    ).toBe(true);
  });

  it("treats a dropped undefined like a missing key (jsonb parity)", () => {
    expect(
      intentPayloadsEqual(
        { identifier: "a" },
        { identifier: "a", metadata: undefined },
      ),
    ).toBe(true);
  });

  it("fails closed on any changed value", () => {
    expect(
      intentPayloadsEqual(
        { identifier: "a", displayName: "A" },
        { identifier: "b", displayName: "A" },
      ),
    ).toBe(false);
  });

  it("fails closed on a dropped defined value", () => {
    expect(
      intentPayloadsEqual(
        { identifier: "a", displayName: "A" },
        { identifier: "a" },
      ),
    ).toBe(false);
  });

  it("canonicalizes nested objects and arrays", () => {
    expect(
      canonicalizeIntentPayload({
        packages: [{ order: 0, productId: "p1" }],
        identifier: "off",
      }),
    ).toEqual({
      identifier: "off",
      packages: [{ order: 0, productId: "p1" }],
    });
  });
});

describe("catalog create previews", () => {
  it("names the product identifier", () => {
    const preview = buildProductCreatePreview({
      identifier: "pro_1",
      type: "SUBSCRIPTION",
      displayName: "Pro",
    });
    expect(preview.title).toContain("pro_1");
  });

  it("names the offering identifier", () => {
    const preview = buildOfferingCreatePreview({ identifier: "default" });
    expect(preview.title).toContain("default");
  });

  it("names the entitlement identifier", () => {
    const preview = buildEntitlementCreatePreview({
      identifier: "premium",
      displayName: "Premium",
    });
    expect(preview.title).toContain("premium");
  });
});
