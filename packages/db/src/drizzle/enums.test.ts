import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_STATUSES } from "@rovenue/shared/subscription-status";
import { integrationDeliveryStatus, purchaseStatus } from "./enums";
import { PurchaseStatus } from "../index";

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

it("purchaseStatus pgEnum matches the shared tuple", () => {
  expect(purchaseStatus.enumValues).toEqual([...SUBSCRIPTION_STATUSES]);
});

it("the PurchaseStatus const object matches the shared tuple", () => {
  expect(Object.keys(PurchaseStatus).sort()).toEqual(
    [...SUBSCRIPTION_STATUSES].sort(),
  );
});
