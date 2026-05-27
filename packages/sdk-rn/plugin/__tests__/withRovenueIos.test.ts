import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { withRovenueIos } from "../withRovenueIos";
import {
  MIN_PODFILE,
  PODFILE_WITHOUT_TARGET,
  makeFakeConfig,
  makePodfileScratch,
  readPodfile,
  readPodfileOrNull,
  runIosDangerousMod,
} from "./_fixturePodfile";

describe("withRovenueIos", () => {
  let scratch: string | null = null;
  afterEach(() => {
    if (scratch) {
      fs.rmSync(scratch, { recursive: true, force: true });
      scratch = null;
    }
  });

  it("default (no opts) injects Trunk pod line with version constraint", async () => {
    scratch = makePodfileScratch(MIN_PODFILE);
    const cfg = withRovenueIos(makeFakeConfig() as any, undefined);
    await runIosDangerousMod(cfg, scratch);
    const patched = readPodfile(scratch);
    expect(patched).toContain("pod 'Rovenue', '~> 0.1'");
    // The MIN_PODFILE template itself contains `:path =>` on the
    // React Native pod line — so the negative assertion must scope to
    // the Rovenue pod line specifically.
    expect(patched).not.toContain("pod 'Rovenue', :path =>");
  });

  it("rovenueSwiftPath opt injects path-based pod line", async () => {
    scratch = makePodfileScratch(MIN_PODFILE);
    const cfg = withRovenueIos(makeFakeConfig() as any, {
      rovenueSwiftPath: "../../../packages/sdk-swift",
    });
    await runIosDangerousMod(cfg, scratch);
    const patched = readPodfile(scratch);
    expect(patched).toContain(
      "pod 'Rovenue', :path => '../../../packages/sdk-swift'",
    );
    expect(patched).not.toContain("'~> 0.1'");
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
