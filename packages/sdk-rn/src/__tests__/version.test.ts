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

  it("SDK_VERSION matches the published package.json version", () => {
    // getVersion() returns SDK_VERSION at runtime; if it drifts from the npm
    // package version, telemetry/support version tagging lies. (Drifted twice.)
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "../../package.json"), "utf8"),
    ) as { version: string };
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("core-rs Cargo.toml inherits from workspace package", () => {
    const cargoToml = readFileSync(
      join(__dirname, "../../../core-rs/Cargo.toml"),
      "utf8",
    );
    expect(cargoToml).toContain("version.workspace = true");
  });

  // Kotlin + Swift versions are hand-maintained strings with no compile-time
  // link to the Rust core, so they silently drifted to 0.7.0 / 0.6.0 while the
  // core moved to 0.15.0. Assert them here so a future bump fails CI until all
  // four façades are aligned — the parity test is the only thing that catches
  // this (sdk.yml runs it in the rn job).
  it("SDK_VERSION matches the sdk-kotlin build.gradle.kts version", () => {
    const gradle = readFileSync(
      join(__dirname, "../../../sdk-kotlin/build.gradle.kts"),
      "utf8",
    );
    const m = gradle.match(/^version\s*=\s*"([^"]+)"/m);
    expect(m, "could not find version in sdk-kotlin/build.gradle.kts").not.toBeNull();
    expect(SDK_VERSION).toBe(m![1]);
  });

  it("SDK_VERSION matches the sdk-swift podspec version", () => {
    const podspec = readFileSync(
      join(__dirname, "../../../sdk-swift/Rovenue.podspec"),
      "utf8",
    );
    const m = podspec.match(/s\.version\s*=\s*'([^']+)'/);
    expect(m, "could not find s.version in sdk-swift/Rovenue.podspec").not.toBeNull();
    expect(SDK_VERSION).toBe(m![1]);
  });
});
