import { describe, expect, it } from "vitest";
import { PROVIDERS, getProvider } from "./registry";
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
      // @ts-expect-error intentional unknown provider id
      getProvider("UNKNOWN_PROVIDER" as ProviderId),
    ).toThrow("unknown provider: UNKNOWN_PROVIDER");
  });
});
