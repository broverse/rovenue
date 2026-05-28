import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _setNativeForTesting } from "../core/native";
import { stopEventBridge } from "../core/eventBridge";
import { store } from "../store/reactiveStore";
import { configure } from "../api/configure";
import { makeMockNative, MockNative } from "./_mockNative";

/**
 * Verifies that the JS `configure()` forwards an optional appVersion
 * fourth-positional argument to the native module. The native modules
 * (iOS + Android) then auto-fill the value from the host bundle /
 * packageManager when this argument is undefined.
 */
describe("configure forwards appVersion to native", () => {
  let native: MockNative;

  beforeEach(() => {
    native = makeMockNative();
    _setNativeForTesting(native);
    store.clear();
  });
  afterEach(() => {
    stopEventBridge();
    _setNativeForTesting(null);
    store.clear();
  });

  it("passes undefined appVersion when JS omits it (native auto-reads)", () => {
    configure({ apiKey: "pk_test", baseUrl: "https://api.example.com" });
    expect(native.configure).toHaveBeenCalledWith(
      "pk_test",
      "https://api.example.com",
      false,
      undefined,
    );
  });

  it("forwards the explicit appVersion override", () => {
    configure({
      apiKey: "pk_test",
      baseUrl: "https://api.example.com",
      appVersion: "2.7.0",
    });
    expect(native.configure).toHaveBeenCalledWith(
      "pk_test",
      "https://api.example.com",
      false,
      "2.7.0",
    );
  });
});
