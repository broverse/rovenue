import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configure, getVersion, SDK_VERSION } from "../index";

describe("Rovenue RN stub", () => {
  it("exposes a non-empty SDK_VERSION", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("SDK_VERSION matches the workspace Cargo.toml version", () => {
    const rootCargo = readFileSync(
      join(__dirname, "../../../../Cargo.toml"),
      "utf8",
    );
    // [workspace.package] version = "x.y.z"
    const m = rootCargo.match(/\[workspace\.package\][\s\S]*?version\s*=\s*"([^"]+)"/);
    expect(m, "could not find workspace.package version in root Cargo.toml").not.toBeNull();
    expect(SDK_VERSION).toBe(m![1]);
  });

  it("core-rs Cargo.toml inherits from workspace package", () => {
    const cargoToml = readFileSync(
      join(__dirname, "../../../core-rs/Cargo.toml"),
      "utf8",
    );
    expect(cargoToml).toContain("version.workspace = true");
  });

  it("getVersion() returns SDK_VERSION", () => {
    expect(getVersion()).toBe(SDK_VERSION);
  });

  it("configure() with empty key throws", () => {
    expect(() =>
      configure({ apiKey: "", baseUrl: "https://api.rovenue.dev" }),
    ).toThrow(/api key/i);
  });

  it("configure() with valid input returns a handle reporting SDK_VERSION", () => {
    const handle = configure({
      apiKey: "pk_test",
      baseUrl: "https://api.rovenue.dev",
    });
    expect(handle.getVersion()).toBe(SDK_VERSION);
  });
});
