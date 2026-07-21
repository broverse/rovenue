import { describe, expect, it } from "vitest";
import { roleHasCapability } from "./capabilities";

describe("roleHasCapability", () => {
  it("OWNER can do everything", () => {
    expect(roleHasCapability("OWNER", "project:delete")).toBe(true);
    expect(roleHasCapability("OWNER", "members:manage")).toBe(true);
    expect(roleHasCapability("OWNER", "credits:write")).toBe(true);
  });

  it("ADMIN can manage members but not delete project", () => {
    expect(roleHasCapability("ADMIN", "members:manage")).toBe(true);
    expect(roleHasCapability("ADMIN", "project:delete")).toBe(false);
    expect(roleHasCapability("ADMIN", "project:transfer")).toBe(false);
  });

  it("DEVELOPER can write to product/sdk/webhook routes", () => {
    expect(roleHasCapability("DEVELOPER", "products:write")).toBe(true);
    expect(roleHasCapability("DEVELOPER", "sdk:write")).toBe(true);
    expect(roleHasCapability("DEVELOPER", "webhooks:write")).toBe(true);
    expect(roleHasCapability("DEVELOPER", "members:manage")).toBe(false);
  });

  it("GROWTH can write to experiments + audiences but not credits", () => {
    expect(roleHasCapability("GROWTH", "experiments:write")).toBe(true);
    expect(roleHasCapability("GROWTH", "audiences:write")).toBe(true);
    expect(roleHasCapability("GROWTH", "credits:write")).toBe(false);
    expect(roleHasCapability("GROWTH", "products:write")).toBe(false);
  });

  it("CUSTOMER_SUPPORT can edit subscriber attributes but not perform money/GDPR ops", () => {
    expect(roleHasCapability("CUSTOMER_SUPPORT", "subscribers:write")).toBe(true);
    // Money-equivalent and irreversible/PII-exfil operations are gated above
    // CUSTOMER_SUPPORT: minting currency, GDPR anonymize/export.
    expect(roleHasCapability("CUSTOMER_SUPPORT", "credits:write")).toBe(false);
    expect(roleHasCapability("CUSTOMER_SUPPORT", "subscribers:gdpr")).toBe(false);
    expect(roleHasCapability("CUSTOMER_SUPPORT", "experiments:write")).toBe(false);
  });

  it("credit grants are ADMIN+, currency-definition management includes DEVELOPER", () => {
    expect(roleHasCapability("ADMIN", "credits:write")).toBe(true);
    expect(roleHasCapability("DEVELOPER", "credits:write")).toBe(false);
    expect(roleHasCapability("DEVELOPER", "virtual-currency:manage")).toBe(true);
    expect(roleHasCapability("CUSTOMER_SUPPORT", "virtual-currency:manage")).toBe(false);
  });

  it("GDPR anonymize/export is ADMIN-and-above only", () => {
    expect(roleHasCapability("OWNER", "subscribers:gdpr")).toBe(true);
    expect(roleHasCapability("ADMIN", "subscribers:gdpr")).toBe(true);
    expect(roleHasCapability("DEVELOPER", "subscribers:gdpr")).toBe(false);
  });

  it("every role can read", () => {
    for (const role of ["OWNER", "ADMIN", "DEVELOPER", "GROWTH", "CUSTOMER_SUPPORT"] as const) {
      expect(roleHasCapability(role, "project:read")).toBe(true);
    }
  });
});
