import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OfferingDTO, PaywallDTO } from "../specs/RovenueModule.types";

const getPaywall = vi.fn(async (_placementId: string, _locale?: string): Promise<PaywallDTO | null> => null);
const track = vi.fn(async () => {});
vi.mock("../core/native", () => ({ getNative: () => ({ getPaywall, track }) }));

import {
  getPaywall as getPaywallApi,
  logPaywallShown,
  mapPaywallDTO,
  buildPaywallViewEnvelope,
  parseRemoteConfig,
} from "./paywalls";

const OFFERING_DTO: OfferingDTO = {
  identifier: "default",
  isDefault: true,
  packages: [],
};

function makePaywallDTO(overrides: Partial<PaywallDTO> = {}): PaywallDTO {
  return {
    placementIdentifier: "plc_1",
    placementRevision: 3,
    paywallIdentifier: "pw_1",
    paywallName: "Go Pro Paywall",
    configFormatVersion: 1,
    remoteConfigJson: JSON.stringify({ title: "Go Pro" }),
    remoteConfigLocale: "en",
    offering: OFFERING_DTO,
    presentedContext: {
      placementId: "plc_1",
      paywallId: "pw_1",
      variantId: "var_a",
      experimentKey: "exp_1",
      revision: 3,
    },
    ...overrides,
  };
}

describe("parseRemoteConfig", () => {
  it("returns null for a null input", () => {
    expect(parseRemoteConfig(null)).toBeNull();
  });

  it("returns null for malformed JSON, does not throw", () => {
    expect(parseRemoteConfig("{not valid json")).toBeNull();
  });

  it("returns null for a non-object top level", () => {
    expect(parseRemoteConfig("[1,2,3]")).toBeNull();
  });

  it("parses a valid object", () => {
    expect(parseRemoteConfig('{"title":"Go Pro","price":9.99}')).toEqual({
      title: "Go Pro",
      price: 9.99,
    });
  });
});

describe("mapPaywallDTO", () => {
  it("maps all scalar fields and decodes remoteConfig", () => {
    const paywall = mapPaywallDTO(makePaywallDTO());
    expect(paywall.placementIdentifier).toBe("plc_1");
    expect(paywall.placementRevision).toBe(3);
    expect(paywall.paywallIdentifier).toBe("pw_1");
    expect(paywall.paywallName).toBe("Go Pro Paywall");
    expect(paywall.configFormatVersion).toBe(1);
    expect(paywall.remoteConfigLocale).toBe("en");
    expect(paywall.remoteConfig).toEqual({ title: "Go Pro" });
  });

  it("maps presentedContext", () => {
    const paywall = mapPaywallDTO(makePaywallDTO());
    expect(paywall.presentedContext).toEqual({
      placementId: "plc_1",
      paywallId: "pw_1",
      variantId: "var_a",
      experimentKey: "exp_1",
      revision: 3,
    });
  });

  it("passes through a null presentedContext as null", () => {
    const paywall = mapPaywallDTO(makePaywallDTO({ presentedContext: null }));
    expect(paywall.presentedContext).toBeNull();
  });

  it("passes through a null offering as null", () => {
    const paywall = mapPaywallDTO(makePaywallDTO({ offering: null }));
    expect(paywall.offering).toBeNull();
  });

  it("yields a null remoteConfig when remoteConfigJson is null", () => {
    const paywall = mapPaywallDTO(makePaywallDTO({ remoteConfigJson: null }));
    expect(paywall.remoteConfig).toBeNull();
  });

  it("maps the offering via the shared offerings mapper", () => {
    const paywall = mapPaywallDTO(makePaywallDTO());
    expect(paywall.offering).toEqual({ identifier: "default", isDefault: true, packages: [] });
  });
});

describe("getPaywall", () => {
  beforeEach(() => getPaywall.mockClear());

  it("forwards placementId/locale to the native bridge and maps the DTO", async () => {
    getPaywall.mockResolvedValueOnce(makePaywallDTO());
    const paywall = await getPaywallApi("plc_1", "en");
    expect(getPaywall).toHaveBeenCalledWith("plc_1", "en");
    expect(paywall?.paywallIdentifier).toBe("pw_1");
  });

  it("null paywall passthrough: a resolved-to-nothing placement returns null, not an error", async () => {
    getPaywall.mockResolvedValueOnce(null);
    const paywall = await getPaywallApi("retired_placement");
    expect(paywall).toBeNull();
  });
});

describe("buildPaywallViewEnvelope", () => {
  it("builds the expected paywall_view envelope shape", () => {
    const paywall = mapPaywallDTO(makePaywallDTO());
    const env = buildPaywallViewEnvelope(paywall, "evt_stable_1", "2026-06-20T10:00:00Z");

    expect(env).toEqual({
      version: 1,
      eventId: "evt_stable_1",
      eventType: "paywall_view",
      occurredAt: "2026-06-20T10:00:00Z",
      paywallContext: {
        paywallId: "pw_1",
        placementId: "plc_1",
        placementRevision: 3,
        variantId: "var_a",
        experimentKey: "exp_1",
      },
    });
  });

  it("eventId is stable across repeated calls, not regenerated", () => {
    const paywall = mapPaywallDTO(makePaywallDTO());
    const first = buildPaywallViewEnvelope(paywall, "evt_fixed", "2026-06-20T10:00:00Z");
    const second = buildPaywallViewEnvelope(paywall, "evt_fixed", "2026-06-20T10:00:01Z");
    expect(first?.eventId).toBe(second?.eventId);
  });

  it("returns undefined when the paywall has no presentedContext", () => {
    const paywall = mapPaywallDTO(makePaywallDTO({ presentedContext: null }));
    expect(buildPaywallViewEnvelope(paywall, "evt_x", "2026-06-20T10:00:00Z")).toBeUndefined();
  });

  it("omits optional variantId/experimentKey when absent", () => {
    const paywall = mapPaywallDTO(
      makePaywallDTO({
        presentedContext: {
          placementId: "plc_1",
          paywallId: "pw_1",
          variantId: null,
          experimentKey: null,
          revision: 3,
        },
      }),
    );
    const env = buildPaywallViewEnvelope(paywall, "evt_x", "2026-06-20T10:00:00Z");
    expect(env?.paywallContext?.variantId).toBeUndefined();
    expect(env?.paywallContext?.experimentKey).toBeUndefined();
  });
});

describe("logPaywallShown", () => {
  beforeEach(() => track.mockClear());

  it("enqueues the paywall_view envelope via the native track() bridge — no new sender", async () => {
    const paywall = mapPaywallDTO(makePaywallDTO());
    logPaywallShown(paywall);
    // Fire-and-forget: flush the microtask queue so the async native call lands.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(track).toHaveBeenCalledTimes(1);
    const env = JSON.parse(track.mock.calls[0][0] as string);
    expect(env.eventType).toBe("paywall_view");
    expect(env.version).toBe(1);
    expect(typeof env.eventId).toBe("string");
    expect(env.paywallContext).toEqual({
      paywallId: "pw_1",
      placementId: "plc_1",
      placementRevision: 3,
      variantId: "var_a",
      experimentKey: "exp_1",
    });
    // No extra top-level keys — the server's eventEnvelopeSchema is `.strict()`.
    expect("subscriberId" in env).toBe(false);
    expect("productId" in env).toBe(false);
    expect("identityContext" in env).toBe(false);
  });

  it("is a no-op (never calls track) when the paywall has no presentedContext", async () => {
    const paywall = mapPaywallDTO(makePaywallDTO({ presentedContext: null }));
    logPaywallShown(paywall);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(track).not.toHaveBeenCalled();
  });
});
