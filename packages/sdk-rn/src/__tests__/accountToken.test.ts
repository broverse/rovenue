import { describe, expect, it, beforeEach, vi } from "vitest";
import { getAppAccountToken } from "../api/accountToken";
import { _setNativeForTesting } from "../core/native";
import { makeMockNative } from "./_mockNative";

describe("accountToken", () => {
  beforeEach(() => {
    _setNativeForTesting(null);
  });

  it("returns the token from the native module", async () => {
    const mock = makeMockNative();
    mock.getAppAccountToken = vi.fn(async () => "550e8400-e29b-41d4-a716-446655440000");
    _setNativeForTesting(mock);
    const token = await getAppAccountToken();
    expect(token).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(mock.getAppAccountToken).toHaveBeenCalledTimes(1);
  });

  it("propagates native errors via mapNativeError", async () => {
    const mock = makeMockNative();
    mock.getAppAccountToken = vi.fn(async () => {
      const e: any = new Error("not configured");
      e.code = "NotConfigured";
      throw e;
    });
    _setNativeForTesting(mock);
    await expect(getAppAccountToken()).rejects.toMatchObject({ name: "NotConfiguredError" });
  });
});
