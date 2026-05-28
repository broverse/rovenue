import { describe, it, expect } from "vitest";
import type { AppConnectionRow } from "./dashboard";

describe("AppConnectionRow — integrations overlay fields", () => {
  it("accepts errorReason and credentialsHint", () => {
    const row: AppConnectionRow = {
      appId: "meta-capi",
      status: "error",
      lastActivityAt: null,
      lastSyncLabel: "5m ago",
      account: "Pixel 1234…5678",
      errorReason: "invalid_credentials",
      credentialsHint: "Pixel 1234…5678",
    };
    expect(row.errorReason).toBe("invalid_credentials");
    expect(row.credentialsHint).toBe("Pixel 1234…5678");
  });
});
