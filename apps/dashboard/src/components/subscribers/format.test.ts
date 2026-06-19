import { describe, expect, it } from "vitest";
import { deriveSubscriberStatus } from "./format";

describe("deriveSubscriberStatus", () => {
  it("is active when the subscriber holds an active entitlement", () => {
    expect(deriveSubscriberStatus(true, 0)).toBe("active");
    expect(deriveSubscriberStatus(true, 3)).toBe("active");
  });

  it("is churned when access is gone but a purchase happened before", () => {
    expect(deriveSubscriberStatus(false, 1)).toBe("churned");
    expect(deriveSubscriberStatus(false, 5)).toBe("churned");
  });

  it("is free when the subscriber has never purchased (e.g. SDK first-install)", () => {
    // Regression: never-subscribed users were incorrectly labelled "churned".
    expect(deriveSubscriberStatus(false, 0)).toBe("free");
  });
});
