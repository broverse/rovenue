import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _setNativeForTesting } from "../core/native";
import { stopEventBridge } from "../core/eventBridge";
import { store } from "../store/reactiveStore";
import { configure, getConfiguredAppVersion } from "../api/configure";
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
      "warn",
      undefined,
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
      "warn",
      "2.7.0",
      undefined,
    );
  });

  it("getConfiguredAppVersion() reflects the value passed to configure()", () => {
    configure({ apiKey: "pk_test", baseUrl: "https://api.example.com", appVersion: "2.7.0" });
    expect(getConfiguredAppVersion()).toBe("2.7.0");
  });

  // The documented default: callers omit appVersion and let the bridge
  // read the bundle / packageManager value. Without reading it back,
  // version-based node visibility would be inert for exactly the config
  // the docs tell people to use.
  it("getConfiguredAppVersion() reports the version native auto-read when JS omits it", () => {
    native.__state.autoReadAppVersion = "3.1.0";
    configure({ apiKey: "pk_test", baseUrl: "https://api.example.com" });
    expect(getConfiguredAppVersion()).toBe("3.1.0");
  });

  it("getConfiguredAppVersion() is undefined when neither JS nor native has a version", () => {
    configure({ apiKey: "pk_test", baseUrl: "https://api.example.com" });
    expect(getConfiguredAppVersion()).toBeUndefined();
  });

  // An RN dev can reload the JS bundle against a native binary built
  // before `getAppVersion` existed. Falling back to what JS passed keeps
  // configure() from throwing "not a function" on the happy path.
  it("falls back to the JS-supplied version against a native binary without getAppVersion", () => {
    const legacy = makeMockNative();
    delete (legacy as Partial<MockNative>).getAppVersion;
    _setNativeForTesting(legacy);
    configure({ apiKey: "pk_test", baseUrl: "https://api.example.com", appVersion: "2.7.0" });
    expect(getConfiguredAppVersion()).toBe("2.7.0");
  });
});
