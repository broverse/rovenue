import { describe, expect, it } from "vitest";
import { PROVIDERS, getProvider, providerIds, fanoutTopics } from "./registry";
import { metaCapiProvider } from "./providers/meta-capi";
import { tiktokEventsProvider } from "./providers/tiktok-events";
import { customWebhookProvider } from "./providers/custom-webhook";
import { amplitudeProvider } from "./providers/amplitude";
import { mixpanelProvider } from "./providers/mixpanel";
import { appsflyerProvider } from "./providers/appsflyer";
import type { ProviderId } from "./types";

describe("PROVIDERS registry", () => {
  it("contains exactly META_CAPI, TIKTOK_EVENTS, CUSTOM_WEBHOOK, AMPLITUDE, MIXPANEL and APPSFLYER", () => {
    const keys = Object.keys(PROVIDERS).sort();
    expect(keys).toEqual([
      "AMPLITUDE",
      "APPSFLYER",
      "CUSTOM_WEBHOOK",
      "META_CAPI",
      "MIXPANEL",
      "TIKTOK_EVENTS",
    ]);
  });

  it("getProvider returns the matching module", () => {
    expect(getProvider("META_CAPI")).toBe(metaCapiProvider);
    expect(getProvider("TIKTOK_EVENTS")).toBe(tiktokEventsProvider);
    expect(getProvider("CUSTOM_WEBHOOK")).toBe(customWebhookProvider);
    expect(getProvider("AMPLITUDE")).toBe(amplitudeProvider);
    expect(getProvider("MIXPANEL")).toBe(mixpanelProvider);
    expect(getProvider("APPSFLYER")).toBe(appsflyerProvider);
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
  it("contains META_CAPI, TIKTOK_EVENTS, CUSTOM_WEBHOOK, AMPLITUDE, MIXPANEL and APPSFLYER", () => {
    const ids = providerIds();
    expect(ids).toContain("META_CAPI");
    expect(ids).toContain("TIKTOK_EVENTS");
    expect(ids).toContain("CUSTOM_WEBHOOK");
    expect(ids).toContain("AMPLITUDE");
    expect(ids).toContain("MIXPANEL");
    expect(ids).toContain("APPSFLYER");
  });

  it("returns a non-empty tuple usable by z.enum", () => {
    const ids = providerIds();
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBeGreaterThan(0);
  });
});

describe("fanoutTopics()", () => {
  it("is the deduped union of every provider's topics — now includes CUSTOM_WEBHOOK's 4 topics", () => {
    expect(new Set(fanoutTopics())).toEqual(
      new Set([
        "rovenue.revenue",
        "rovenue.subscription",
        "rovenue.paywall_events",
        "rovenue.credit",
      ]),
    );
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
