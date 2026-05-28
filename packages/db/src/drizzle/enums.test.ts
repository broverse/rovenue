import { describe, expect, it } from "vitest";
import { integrationProvider, integrationDeliveryStatus } from "./enums";

describe("integration enums", () => {
  it("exposes IntegrationProvider variants", () => {
    expect(integrationProvider.enumValues).toEqual([
      "META_CAPI",
      "TIKTOK_EVENTS",
    ]);
  });

  it("exposes IntegrationDeliveryStatus variants", () => {
    expect(integrationDeliveryStatus.enumValues).toEqual([
      "pending",
      "succeeded",
      "failed",
      "skipped",
      "dead_letter",
    ]);
  });
});
