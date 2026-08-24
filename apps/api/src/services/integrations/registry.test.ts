import { describe, expect, it } from "vitest";
import { PROVIDERS, getProvider, providerIds, fanoutTopics } from "./registry";
import { metaCapiProvider } from "./providers/meta-capi";
import { tiktokEventsProvider } from "./providers/tiktok-events";
import type { ProviderId } from "./types";

describe("PROVIDERS registry", () => {
  it("contains exactly META_CAPI and TIKTOK_EVENTS", () => {
    const keys = Object.keys(PROVIDERS).sort();
    expect(keys).toEqual(["META_CAPI", "TIKTOK_EVENTS"]);
  });

  it("getProvider returns the matching module", () => {
    expect(getProvider("META_CAPI")).toBe(metaCapiProvider);
    expect(getProvider("TIKTOK_EVENTS")).toBe(tiktokEventsProvider);
  });

  it("throws on unknown provider", () => {
    expect(() =>
      getProvider("UNKNOWN_PROVIDER" as ProviderId),
    ).toThrow("unknown provider: UNKNOWN_PROVIDER");
  });
});

// =============================================================
// Task 3 — declarative provider registry
// =============================================================

describe("providerIds()", () => {
  it("contains META_CAPI and TIKTOK_EVENTS", () => {
    const ids = providerIds();
    expect(ids).toContain("META_CAPI");
    expect(ids).toContain("TIKTOK_EVENTS");
  });

  it("returns a non-empty tuple usable by z.enum", () => {
    const ids = providerIds();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe("fanoutTopics()", () => {
  it("equals [\"rovenue.revenue\"] while only the two ad providers exist", () => {
    expect(fanoutTopics()).toEqual(["rovenue.revenue"]);
  });
});

describe("every provider's credentialsSchema", () => {
  it("rejects an empty credentials object", () => {
    for (const provider of Object.values(PROVIDERS)) {
      const result = provider.credentialsSchema.safeParse({});
      expect(result.success).toBe(false);
    }
  });
});
