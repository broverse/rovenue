import { describe, expect, it } from "vitest";
import { SCOPE_TYPES } from "./transactions";

describe("SCOPE_TYPES", () => {
  it("counts a one-time purchase in the purchase scope", () => {
    expect(SCOPE_TYPES.purchase).toContain("NON_RENEWING_PURCHASE");
  });
});
