import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_API_BASE_URL, resolveRuntimeConfig } from "./runtime-config";

describe("resolveRuntimeConfig", () => {
  it("prefers the runtime value over the build-time one", () => {
    const r = resolveRuntimeConfig(
      { apiUrl: "https://api.example.com" },
      { VITE_API_URL: "http://localhost:3000" },
    );
    expect(r.apiUrl).toBe("https://api.example.com");
  });

  it("falls back to the build-time value when runtime is absent", () => {
    const r = resolveRuntimeConfig(undefined, { VITE_API_URL: "https://built.example.com" });
    expect(r.apiUrl).toBe("https://built.example.com");
  });

  it("falls back to the default when neither is set", () => {
    const r = resolveRuntimeConfig(undefined, {});
    expect(r.apiUrl).toBe(DEFAULT_API_BASE_URL);
  });

  // The container emits `{$VAR:}` for unset variables, which arrives as "".
  // host-mode.ts distinguishes unset from empty, so "" must not shadow the
  // build-time value and must not be handed on as a set value.
  it("treats an empty runtime string as absent", () => {
    const r = resolveRuntimeConfig(
      { apiUrl: "", hostMode: "", allowRegistration: "", dashboardHost: "" },
      { VITE_API_URL: "https://built.example.com", VITE_HOST_MODE: "cloud" },
    );
    expect(r.apiUrl).toBe("https://built.example.com");
    expect(r.hostMode).toBe("cloud");
    expect(r.allowRegistration).toBeUndefined();
    expect(r.dashboardHost).toBeUndefined();
  });

  it("leaves optional values undefined when nothing supplies them", () => {
    const r = resolveRuntimeConfig(undefined, {});
    expect(r.hostMode).toBeUndefined();
    expect(r.allowRegistration).toBeUndefined();
    expect(r.dashboardHost).toBeUndefined();
  });

  it("carries every runtime key through", () => {
    const r = resolveRuntimeConfig(
      {
        apiUrl: "https://a.example.com",
        hostMode: "cloud",
        allowRegistration: "true",
        dashboardHost: "app.example.com",
      },
      {},
    );
    expect(r).toEqual({
      apiUrl: "https://a.example.com",
      hostMode: "cloud",
      allowRegistration: "true",
      dashboardHost: "app.example.com",
    });
  });
});

// The suite above only covers the pure resolveRuntimeConfig function. It
// never exercises the module-scope read of window.__ROVENUE_CONFIG__ or the
// four exported accessors — so renaming that global, or making apiBaseUrl()
// return the default, would still pass the whole suite. That is exactly the
// published-image bug this module exists to prevent, so this suite drives
// the module the way the real app does: set the global, THEN import.
describe("runtime-config module wiring", () => {
  afterEach(() => {
    delete window.__ROVENUE_CONFIG__;
  });

  it("resolves apiBaseUrl/hostModeValue/allowRegistrationValue/dashboardHostValue from window.__ROVENUE_CONFIG__", async () => {
    window.__ROVENUE_CONFIG__ = {
      apiUrl: "https://runtime.example.com",
      hostMode: "cloud",
      allowRegistration: "true",
      dashboardHost: "runtime.example.com",
    };

    // The module resolves its config once, at module-evaluation time (see
    // the top-level `const resolved = ...` in runtime-config.ts), so the
    // global must be set BEFORE the module is (re-)imported.
    vi.resetModules();
    const mod = await import("./runtime-config");

    expect(mod.apiBaseUrl()).toBe("https://runtime.example.com");
    expect(mod.hostModeValue()).toBe("cloud");
    expect(mod.allowRegistrationValue()).toBe("true");
    expect(mod.dashboardHostValue()).toBe("runtime.example.com");
  });
});
