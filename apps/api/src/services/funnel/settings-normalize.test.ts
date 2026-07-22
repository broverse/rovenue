import { describe, expect, it } from "vitest";
import { normalizeFunnelSettings } from "./settings-normalize";

describe("normalizeFunnelSettings", () => {
  it("translates the dashboard's camelCase keys to the API's snake_case", () => {
    expect(
      normalizeFunnelSettings({
        devMode: true,
        universalLinkDomain: "go.acme.com",
        deepLinkScheme: "acme",
        iosUrl: "https://apps.apple.com/app/id1",
        androidUrl: "https://play.google.com/store/apps/details?id=x",
      }),
    ).toEqual({
      dev_mode: true,
      universal_link_domain: "go.acme.com",
      deep_link_scheme: "acme",
      app_store_url: "https://apps.apple.com/app/id1",
      play_store_url: "https://play.google.com/store/apps/details?id=x",
    });
  });

  it("passes already-snake_case settings through unchanged", () => {
    const already = { dev_mode: false, deep_link_scheme: "acme" };
    expect(normalizeFunnelSettings(already)).toEqual(already);
  });

  it("prefers an explicit snake_case key over its camelCase twin", () => {
    expect(
      normalizeFunnelSettings({ dev_mode: false, devMode: true }),
    ).toEqual({ dev_mode: false });
  });

  it("keeps unrecognised keys so nothing is silently dropped", () => {
    expect(normalizeFunnelSettings({ somethingNew: 1 })).toEqual({
      somethingNew: 1,
    });
  });

  it("returns {} for a non-object", () => {
    expect(normalizeFunnelSettings(null)).toEqual({});
    expect(normalizeFunnelSettings("nope")).toEqual({});
  });
});
