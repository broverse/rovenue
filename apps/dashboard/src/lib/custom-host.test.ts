import { describe, expect, it } from "vitest";
import { isCanonicalDashboardHost } from "./custom-host";

describe("isCanonicalDashboardHost", () => {
  it("is true when the hostname matches the configured dashboard host", () => {
    expect(
      isCanonicalDashboardHost({ VITE_DASHBOARD_HOST: "app.rovenue.io" }, "app.rovenue.io"),
    ).toBe(true);
  });

  it("is false for a different hostname", () => {
    expect(
      isCanonicalDashboardHost({ VITE_DASHBOARD_HOST: "app.rovenue.io" }, "quiz.acme.com"),
    ).toBe(false);
  });

  it("is false when the variable is unset, so the lookup still runs", () => {
    // Unset must NOT mean "everything is canonical" — that would make
    // custom domains silently fail for any operator who never set the
    // variable. The lookup is the safe default; the variable only skips it.
    expect(isCanonicalDashboardHost({}, "app.rovenue.io")).toBe(false);
  });

  it("ignores case and a port suffix", () => {
    expect(
      isCanonicalDashboardHost({ VITE_DASHBOARD_HOST: "App.Rovenue.IO:5173" }, "app.rovenue.io"),
    ).toBe(true);
  });
});
