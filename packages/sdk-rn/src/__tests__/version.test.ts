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

  // Rovenue.podspec no longer carries a literal `s.version = '...'` — it
  // reads `s.version = CONFIG['version']` from release.config.json (see
  // packages/sdk-swift/Rovenue.podspec and Task 1's xcframework release
  // work). Matching the podspec text by regex therefore matches the
  // release config, so we read that file directly: it's the genuine
  // source the podspec's version comes from, not a proxy for it.
  it("SDK_VERSION matches the sdk-swift release config version", () => {
    const releaseConfig = JSON.parse(
      readFileSync(
        join(__dirname, "../../../sdk-swift/release.config.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(SDK_VERSION).toBe(releaseConfig.version);
  });

  // Dart pubspecs are hand-maintained strings just like the Kotlin/Swift
  // manifests above, with no compile-time link to the Rust core. The example
  // app's pubspec is excluded on purpose: it's an application, never
  // published, so it isn't part of the SDK version lockstep.
  const FLUTTER_PUBSPEC_PATHS = [
    "../../../sdk-flutter/rovenue_flutter_platform_interface/pubspec.yaml",
    "../../../sdk-flutter/rovenue_flutter/pubspec.yaml",
    "../../../sdk-flutter/rovenue_flutter_ios/pubspec.yaml",
    "../../../sdk-flutter/rovenue_flutter_android/pubspec.yaml",
  ] as const;

  it.each(FLUTTER_PUBSPEC_PATHS)(
    "SDK_VERSION matches %s",
    (relativePath) => {
      const pubspec = readFileSync(join(__dirname, relativePath), "utf8");
      const m = pubspec.match(/^version:\s*([^\s]+)/m);
      expect(m, `could not find version: in ${relativePath}`).not.toBeNull();
      // A pubspec version may carry a Dart build suffix (e.g. "0.16.0+1").
      // Parity only governs the semver core shared with the Rust crate; the
      // build suffix is a Dart-side concern (pub.dev release counter), so it
      // is stripped before comparing.
      const semverCore = m![1].split("+")[0];
      expect(semverCore, `${relativePath} drifted from SDK_VERSION (${SDK_VERSION})`).toBe(
        SDK_VERSION,
      );
    },
  );
});
