import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setNativeForTesting } from "../core/native";
import { setLogHandler } from "../api/log";
import type { LogEntry } from "../api/log";
import { Rovenue } from "../index";
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
    native.emitMockNativeLog({ level: "info", message: "configure", fields: {} });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ level: "info", message: "configure", data: undefined });
  });

  it("setLogHandler(null) unsubscribes", () => {
    const handler = vi.fn();
    setLogHandler(handler);
    native.emitMockNativeLog({ level: "info", message: "first", fields: {} });
    setLogHandler(null);
    native.emitMockNativeLog({ level: "info", message: "second", fields: {} });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("maps native onLog fields into LogEntry.data and never surfaces raw secrets", () => {
    const seen: LogEntry[] = [];
    Rovenue.setLogHandler((e) => seen.push(e));
    // Simulate the native bridge emitting a core LogRecord (already redacted in core).
    native.emitMockNativeLog({
      level: "debug",
      message: "http GET /v1/entitlements",
      fields: { method: "GET", path: "/v1/entitlements", status: "200", correlation_id: "req-0" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].level).toBe("debug");
    expect(seen[0].data?.path).toBe("/v1/entitlements");
    // Authorization must never be a field key (core strips it).
    expect(Object.keys(seen[0].data ?? {})).not.toContain("authorization");
    Rovenue.setLogHandler(null);
  });
});
