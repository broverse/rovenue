// withRovenueIos — Expo config plugin mod that injects the Rovenue pod
// into the consumer's Podfile.
//
// Default (no opts):     pod 'Rovenue', '<exact version>'  — pulls from CocoaPods Trunk
// rovenueSwiftPath set:  pod 'Rovenue', :path => '...'      — monorepo `:path =>` link
//
// Monorepo consumers (e.g. examples/sample-rn-expo) MUST pass
// `rovenueSwiftPath` because the Rovenue pod has not been pushed to
// Trunk yet (M7.1 only prepares the infra). External consumers pass
// nothing and pick up the default once the first Trunk push lands.
//
// The version is pinned exactly rather than with a `~>` range: the bridge
// pod and the `Rovenue` façade it links against are released in lockstep,
// so a mismatch must fail at dependency resolution, not silently link
// against a newer/older façade.

import { ConfigPlugin, withDangerousMod } from "@expo/config-plugins";
import * as fs from "node:fs";
import * as path from "node:path";

type Options = { rovenueSwiftPath?: string } | undefined;

/**
 * The Podfile line injected into the consumer's target.
 *
 * External consumers get an exact version pin: the bridge pod and the
 * `Rovenue` façade are released together, and a bridge built against a
 * different façade version fails at link time rather than at resolve time.
 * Monorepo consumers pass a path and bypass Trunk entirely.
 */
export function rovenuePodLine(
  rovenueSwiftPath: string | undefined,
  version: string,
): string {
  return rovenueSwiftPath
    ? `  pod 'Rovenue', :path => '${rovenueSwiftPath}'`
    : `  pod 'Rovenue', '${version}'`;
}

/**
 * Locate and read this package's own `package.json`.
 *
 * `withRovenueIos.ts` is compiled by `tsconfig.plugin.json` (rootDir
 * `plugin/`, outDir `plugin/build/`) before consumers ever load it via
 * `app.plugin.js`, so the shipped module's `__dirname` is one directory
 * deeper (`plugin/build/`) than the TS source's (`plugin/`). Try the
 * source-relative path first, then the compiled-relative path, so this
 * resolves correctly both under `vitest` (which runs the TS source
 * directly) and in the published package (which runs the compiled JS).
 */
function readOwnPackageVersion(): string {
  const candidates = [
    path.join(__dirname, "..", "package.json"),
    path.join(__dirname, "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        version: string;
      };
      return pkg.version;
    }
  }
  throw new Error(
    `could not locate package.json from ${__dirname} to resolve the Rovenue pod version`,
  );
}

export const withRovenueIos: ConfigPlugin<Options> = (config, opts) => {
  return withDangerousMod(config, ["ios", async (cfg) => {
    const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
    if (!fs.existsSync(podfile)) return cfg;

    const contents = fs.readFileSync(podfile, "utf8");
    if (contents.includes("pod 'Rovenue'")) return cfg;

    const podLine = rovenuePodLine(opts?.rovenueSwiftPath, readOwnPackageVersion());

    const patched = contents.replace(
      /(target\s+['"][^'"]+['"]\s+do)/,
      `$1\n${podLine}`,
    );
    fs.writeFileSync(podfile, patched);
    return cfg;
  }]);
};
