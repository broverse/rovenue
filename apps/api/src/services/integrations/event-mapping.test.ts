import { describe, expect, it } from "vitest";
import { applyEventMapping, DEFAULT_EVENT_MAPPING } from "./event-mapping";
import type { RovenueEventKey } from "@rovenue/shared";

const ALL_EVENTS: RovenueEventKey[] = [
  "revenue.INITIAL",
  "revenue.TRIAL_CONVERSION",
  "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE",
  "revenue.REFUND",
  "revenue.CANCELLATION",
  "subscription.trial.started",
  "subscriber.identified",
];

describe("applyEventMapping", () => {
  it("returns default event name when no override", () => {
    const result = applyEventMapping({
      providerId: "META_CAPI",
      eventKey: "revenue.INITIAL",
      enabledEvents: ALL_EVENTS,
      override: {},
    });
    expect(result).toEqual({ kind: "use", providerEvent: "Subscribe" });
  });

  it("override eventName wins over default", () => {
    const result = applyEventMapping({
      providerId: "META_CAPI",
      eventKey: "revenue.INITIAL",
      enabledEvents: ALL_EVENTS,
      override: { "revenue.INITIAL": { eventName: "CustomPurchase" } },
    });
    expect(result).toEqual({ kind: "use", providerEvent: "CustomPurchase" });
  });

  it("skip:true in override short-circuits to no_mapping", () => {
    const result = applyEventMapping({
      providerId: "META_CAPI",
      eventKey: "revenue.RENEWAL",
      enabledEvents: ALL_EVENTS,
      override: { "revenue.RENEWAL": { skip: true } },
    });
    expect(result).toEqual({ kind: "skip", reason: "no_mapping" });
  });

  it("event not in enabledEvents returns filtered_by_event_scope", () => {
    const result = applyEventMapping({
      providerId: "META_CAPI",
      eventKey: "revenue.REFUND",
      enabledEvents: ["revenue.INITIAL", "revenue.RENEWAL"],
      override: {},
    });
    expect(result).toEqual({ kind: "skip", reason: "filtered_by_event_scope" });
  });

  it("no_mapping when default is undefined and override has no eventName", () => {
    const result = applyEventMapping({
      providerId: "META_CAPI",
      eventKey: "revenue.REFUND",
      enabledEvents: ALL_EVENTS,
      override: {},
    });
    // revenue.REFUND has no default mapping in META_CAPI
    expect(result).toEqual({ kind: "skip", reason: "no_mapping" });
  });

  it("tolerates malformed override values (non-object)", () => {
    const result = applyEventMapping({
      providerId: "TIKTOK_EVENTS",
      eventKey: "revenue.INITIAL",
      enabledEvents: ALL_EVENTS,
      // @ts-expect-error intentional bad override for runtime tolerance test
      override: { "revenue.INITIAL": "not-an-object" },
    });
    // Falls back to default mapping
    expect(result).toEqual({ kind: "use", providerEvent: "Subscribe" });
  });
});
