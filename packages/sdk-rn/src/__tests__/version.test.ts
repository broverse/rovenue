import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SDK_VERSION } from "../version";

describe("Rovenue RN version parity", () => {
  it("exposes a non-empty SDK_VERSION", () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("SDK_VERSION matches the workspace Cargo.toml version", () => {
    const rootCargo = readFileSync(
      join(__dirname, "../../../../Cargo.toml"),
      "utf8",
    );
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
});
