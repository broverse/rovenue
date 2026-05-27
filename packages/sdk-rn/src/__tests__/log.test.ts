import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setNativeForTesting } from "../core/native";
import { setLogHandler } from "../api/log";
import { makeMockNative, MockNative } from "./_mockNative";

describe("setLogHandler", () => {
  let native: MockNative;

  beforeEach(() => {
    native = makeMockNative();
    _setNativeForTesting(native);
  });
  afterEach(() => {
    setLogHandler(null);
    _setNativeForTesting(null);
  });

  it("subscribes to onLog and forwards entries", () => {
    const handler = vi.fn();
    setLogHandler(handler);
    native.__emitLog({ level: "info", message: "configure", data: undefined });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ level: "info", message: "configure", data: undefined });
  });

  it("setLogHandler(null) unsubscribes", () => {
    const handler = vi.fn();
    setLogHandler(handler);
    native.__emitLog({ level: "info", message: "first", data: undefined });
    setLogHandler(null);
    native.__emitLog({ level: "info", message: "second", data: undefined });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
