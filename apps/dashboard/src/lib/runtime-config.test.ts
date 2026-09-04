import { describe, expect, it } from "vitest";
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
