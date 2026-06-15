import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  setAttributes,
  setEmail,
  setDisplayName,
  setPhoneNumber,
  setPushToken,
  flushAttributes,
} from "./attributes";
import { _setNativeForTesting } from "../core/native";
import { makeMockNative } from "../__tests__/_mockNative";
import { NotConfiguredError } from "../errors";

describe("attributes api", () => {
  beforeEach(() => {
    _setNativeForTesting(null);
  });

  it("forwards setAttributes / reserved setters / flushAttributes to native", async () => {
    const calls: any[] = [];
    const mock = makeMockNative();
    mock.setAttributes = vi.fn(async (a: Record<string, string | null>) => {
      calls.push(["setAttributes", a]);
    });
    mock.setEmail = vi.fn(async (e: string | null) => {
      calls.push(["setEmail", e]);
    });
    mock.flushAttributes = vi.fn(async () => {
      calls.push(["flushAttributes"]);
      return 3;
    });
    _setNativeForTesting(mock);

    await setAttributes({ $email: "a@b.com", country: null });
    await setEmail("a@b.com");
    expect(await flushAttributes()).toBe(3);
    expect(calls).toEqual([
      ["setAttributes", { $email: "a@b.com", country: null }],
      ["setEmail", "a@b.com"],
      ["flushAttributes"],
    ]);
  });

  it("forwards the remaining reserved setters to native", async () => {
    const mock = makeMockNative();
    _setNativeForTesting(mock);

    await setDisplayName("Ada");
    await setPhoneNumber("+15551234567");
    await setPushToken("tok_123");

    expect(mock.setDisplayName).toHaveBeenCalledWith("Ada");
    expect(mock.setPhoneNumber).toHaveBeenCalledWith("+15551234567");
    expect(mock.setPushToken).toHaveBeenCalledWith("tok_123");
  });

  it("passes null through reserved setters (delete marker)", async () => {
    const mock = makeMockNative();
    _setNativeForTesting(mock);
    await setEmail(null);
    expect(mock.setEmail).toHaveBeenCalledWith(null);
  });

  it("maps native error codes via mapNativeError", async () => {
    const mock = makeMockNative();
    mock.setAttributes = vi.fn(async () => {
      const e: any = new Error("not configured");
      e.code = "NotConfigured";
      throw e;
    });
    _setNativeForTesting(mock);
    await expect(setAttributes({ x: "y" })).rejects.toBeInstanceOf(NotConfiguredError);
  });
});
