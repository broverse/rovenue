import { describe, expect, it } from "vitest";
import { integrationDeliveryStatus } from "./enums";

describe("integration enums", () => {
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
