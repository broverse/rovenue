// =============================================================
// MCP catalog + placement/audience + asset write tools: DB-free unit
// coverage.
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
  buildAssetDeletePreview,
  buildAudienceCreatePreview,
  buildEntitlementCreatePreview,
  buildFunnelCreatePreview,
  buildFunnelUpdatePreview,
  buildOfferingCreatePreview,
  buildPaywallCreatePreview,
  buildPaywallUpdatePreview,
  buildPlacementCreatePreview,
  buildProductCreatePreview,
  buildVirtualCurrencyCreatePreview,
  canonicalizeIntentPayload,
  DeleteAssetMcpSchema,
  intentPayloadsEqual,
  UpdateFunnelMcpSchema,
  UpdatePaywallMcpSchema,
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

describe("placement and audience create previews", () => {
  it("names the placement identifier", () => {
    const preview = buildPlacementCreatePreview({
      identifier: "home_top",
      name: "Home Top",
    });
    expect(preview.title).toContain("home_top");
  });

  it("names the audience", () => {
    const preview = buildAudienceCreatePreview({ name: "Churned" });
    expect(preview.title).toContain("Churned");
  });
});

describe("virtual currency create preview", () => {
  it("names the currency code", () => {
    const preview = buildVirtualCurrencyCreatePreview({
      code: "GEMS",
      name: "Gems",
    });
    expect(preview.title).toContain("GEMS");
    expect(preview.fields).toContainEqual({ label: "Code", after: "GEMS" });
    expect(preview.fields).toContainEqual({ label: "Name", after: "Gems" });
  });
});

describe("asset delete preview", () => {
  it("names the asset id", () => {
    const preview = buildAssetDeletePreview({ id: "as_1" });
    expect(preview.title).toContain("as_1");
  });

  it("renders unforced when force is absent", () => {
    const preview = buildAssetDeletePreview({ id: "as_1" });
    expect(preview.fields).toContainEqual({
      label: "Force",
      after: "false",
    });
  });

  it('renders forced for the dashboard-accepted "true" string', () => {
    const preview = buildAssetDeletePreview({ id: "as_1", force: "true" });
    expect(preview.fields).toContainEqual({
      label: "Force",
      after: "true (skips the in-use check)",
    });
  });

  it("renders forced for a boolean true echo", () => {
    const preview = buildAssetDeletePreview({ id: "as_1", force: true });
    expect(preview.fields).toContainEqual({
      label: "Force",
      after: "true (skips the in-use check)",
    });
  });

  it('renders unforced for the "false" string', () => {
    const preview = buildAssetDeletePreview({ id: "as_1", force: "false" });
    expect(preview.fields).toContainEqual({
      label: "Force",
      after: "false",
    });
  });
});

describe("funnel create and update previews", () => {
  it("names the funnel", () => {
    const preview = buildFunnelCreatePreview({ name: "Onboarding" });
    expect(preview.title).toContain("Onboarding");
    expect(preview.fields).toContainEqual({
      label: "Slug",
      after: "(auto-generated)",
    });
  });

  it("names an explicit slug", () => {
    const preview = buildFunnelCreatePreview({
      name: "Onboarding",
      slug: "onboarding",
    });
    expect(preview.fields).toContainEqual({
      label: "Slug",
      after: "onboarding",
    });
  });

  it("names the funnel id and changed fields, never draft payloads", () => {
    const preview = buildFunnelUpdatePreview({
      funnelId: "fn_1",
      name: "Renamed",
      draft_pages_json: [{ id: "p1" }],
    });
    expect(preview.title).toContain("fn_1");
    expect(preview.fields).toContainEqual({
      label: "Changed fields",
      after: "name, draft_pages_json",
    });
    expect(JSON.stringify(preview)).not.toContain("p1");
  });
});

describe("update funnel MCP schema (route parity)", () => {
  it("parses a name edit with the path id", () => {
    expect(
      UpdateFunnelMcpSchema.parse({ funnelId: "fn_1", name: "Renamed" }),
    ).toEqual({ funnelId: "fn_1", name: "Renamed" });
  });

  it("requires the funnel id", () => {
    expect(() => UpdateFunnelMcpSchema.parse({ name: "Renamed" })).toThrow();
    expect(() =>
      UpdateFunnelMcpSchema.parse({ funnelId: "", name: "Renamed" }),
    ).toThrow();
  });

  it("rejects an empty patch (dashboard parity)", () => {
    expect(() => UpdateFunnelMcpSchema.parse({ funnelId: "fn_1" })).toThrow();
  });

  it("rejects a default_locale outside locales (dashboard parity)", () => {
    expect(() =>
      UpdateFunnelMcpSchema.parse({
        funnelId: "fn_1",
        default_locale: "fr",
        locales: ["en"],
      }),
    ).toThrow();
  });

  it("rejects a non-kebab slug (dashboard parity)", () => {
    expect(() =>
      UpdateFunnelMcpSchema.parse({ funnelId: "fn_1", slug: "Not A Slug" }),
    ).toThrow();
  });
});

describe("paywall create and update previews", () => {
  it("names the paywall identifier", () => {
    const preview = buildPaywallCreatePreview({
      identifier: "pro-monthly",
      name: "Pro Monthly",
    });
    expect(preview.title).toContain("pro-monthly");
    expect(preview.fields).toContainEqual({
      label: "Name",
      after: "Pro Monthly",
    });
  });

  it("names the paywall id and changed fields, never config payloads", () => {
    const preview = buildPaywallUpdatePreview({
      paywallId: "pw_1",
      name: "Renamed",
      remoteConfig: { defaultLocale: "en", locales: { en: { k: "v" } } },
    });
    expect(preview.title).toContain("pw_1");
    expect(preview.fields).toContainEqual({
      label: "Changed fields",
      after: "name, remoteConfig",
    });
    expect(JSON.stringify(preview)).not.toContain("defaultLocale");
  });
});

describe("update paywall MCP schema (route parity)", () => {
  it("parses a name edit with the path id", () => {
    expect(
      UpdatePaywallMcpSchema.parse({ paywallId: "pw_1", name: "Renamed" }),
    ).toEqual({ paywallId: "pw_1", name: "Renamed" });
  });

  it("requires the paywall id", () => {
    expect(() => UpdatePaywallMcpSchema.parse({ name: "Renamed" })).toThrow();
    expect(() =>
      UpdatePaywallMcpSchema.parse({ paywallId: "", name: "Renamed" }),
    ).toThrow();
  });

  it("rejects an empty patch (dashboard parity)", () => {
    expect(() => UpdatePaywallMcpSchema.parse({ paywallId: "pw_1" })).toThrow();
  });

  it("rejects a builderConfig without draftRevision (dashboard parity)", () => {
    expect(() =>
      UpdatePaywallMcpSchema.parse({
        paywallId: "pw_1",
        builderConfig: null,
      }),
    ).toThrow();
  });

  it("rejects a defaultLocale outside locales (dashboard parity)", () => {
    expect(() =>
      UpdatePaywallMcpSchema.parse({
        paywallId: "pw_1",
        remoteConfig: { defaultLocale: "fr", locales: { en: {} } },
      }),
    ).toThrow();
  });
});

describe("delete asset MCP schema", () => {
  it("defaults an absent force to false (dashboard parity)", () => {
    expect(DeleteAssetMcpSchema.parse({ id: "as_1" })).toEqual({
      id: "as_1",
      force: false,
    });
  });

  it('parses force "true" to boolean true', () => {
    expect(DeleteAssetMcpSchema.parse({ id: "as_1", force: "true" })).toEqual({
      id: "as_1",
      force: true,
    });
  });

  it("requires the asset id", () => {
    expect(() =>
      DeleteAssetMcpSchema.parse({ force: "true" }),
    ).toThrow();
    expect(() => DeleteAssetMcpSchema.parse({ id: "" })).toThrow();
  });

  it("rejects unknown force values (dashboard parity — never coerce)", () => {
    expect(() =>
      DeleteAssetMcpSchema.parse({ id: "as_1", force: "yes" }),
    ).toThrow();
    // A JSON boolean is not what the dashboard DELETE accepts (its
    // query string carries "true"/"false"), so it is refused rather
    // than coerced — "false" must never become true.
    expect(() =>
      DeleteAssetMcpSchema.parse({ id: "as_1", force: true }),
    ).toThrow();
  });
});
