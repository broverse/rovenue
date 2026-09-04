import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { rovenuePodLine, withRovenueIos } from "../withRovenueIos";
import {
  MIN_PODFILE,
  PODFILE_WITHOUT_TARGET,
  makeFakeConfig,
  makePodfileScratch,
  readPodfile,
  readPodfileOrNull,
  runIosDangerousMod,
} from "./_fixturePodfile";

// The real published version, read the same way `version.test.ts` reads it
// — used only to assert the *integration*-level behaviour (the mod really
// does resolve and inject the package's own version). The unit tests for
// `rovenuePodLine` below use literal version strings and never touch the
// filesystem.
const OWN_PACKAGE_VERSION = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
  ) as { version: string }
).version;

describe("withRovenueIos", () => {
  let scratch: string | null = null;
  afterEach(() => {
    if (scratch) {
      fs.rmSync(scratch, { recursive: true, force: true });
      scratch = null;
    }
  });

  it("default (no opts) injects an exact-version pod line", async () => {
    scratch = makePodfileScratch(MIN_PODFILE);
    const cfg = withRovenueIos(makeFakeConfig() as any, undefined);
    await runIosDangerousMod(cfg, scratch);
    const patched = readPodfile(scratch);
    expect(patched).toContain(`pod 'Rovenue', '${OWN_PACKAGE_VERSION}'`);
    // The MIN_PODFILE template itself contains `:path =>` on the
    // React Native pod line — so the negative assertion must scope to
    // the Rovenue pod line specifically.
    expect(patched).not.toContain("pod 'Rovenue', :path =>");
  });

  it("rovenueSwiftPath opt injects path-based pod line, with no version pin alongside it", async () => {
    scratch = makePodfileScratch(MIN_PODFILE);
    const cfg = withRovenueIos(makeFakeConfig() as any, {
      rovenueSwiftPath: "../../../packages/sdk-swift",
    });
    await runIosDangerousMod(cfg, scratch);
    const patched = readPodfile(scratch);
    const rovenueLines = patched
      .split("\n")
      .filter((line) => line.includes("pod 'Rovenue'"));
    expect(rovenueLines).toEqual([
      "  pod 'Rovenue', :path => '../../../packages/sdk-swift'",
    ]);
  });

  it("is idempotent — running twice does not add a duplicate pod line", async () => {
    scratch = makePodfileScratch(MIN_PODFILE);
    const cfg = withRovenueIos(makeFakeConfig() as any, undefined);
    await runIosDangerousMod(cfg, scratch);
    const cfg2 = withRovenueIos(makeFakeConfig() as any, undefined);
    await runIosDangerousMod(cfg2, scratch);
    const patched = readPodfile(scratch);
    const matches = patched.match(/pod 'Rovenue'/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("returns unchanged when no Podfile exists (no crash)", async () => {
    scratch = makePodfileScratch(MIN_PODFILE);
    // Delete the Podfile after scratch dir creation
    fs.unlinkSync(`${scratch}/ios/Podfile`);
    const cfg = withRovenueIos(makeFakeConfig() as any, undefined);
    await runIosDangerousMod(cfg, scratch);
    expect(readPodfileOrNull(scratch)).toBeNull();
  });

  it("leaves Podfile unchanged when no `target ... do` block matches", async () => {
    scratch = makePodfileScratch(PODFILE_WITHOUT_TARGET);
    const cfg = withRovenueIos(makeFakeConfig() as any, undefined);
    await runIosDangerousMod(cfg, scratch);
    const patched = readPodfile(scratch);
    expect(patched).toBe(PODFILE_WITHOUT_TARGET);
  });
});

describe("rovenuePodLine", () => {
  it("pins the exact given version when no local path is given", () => {
    expect(rovenuePodLine(undefined, "1.2.3")).toBe(
      "  pod 'Rovenue', '1.2.3'",
    );
  });

  it("uses a local path reference for monorepo consumers, ignoring the version", () => {
    expect(rovenuePodLine("../../packages/sdk-swift", "1.2.3")).toBe(
      "  pod 'Rovenue', :path => '../../packages/sdk-swift'",
    );
  });
});
