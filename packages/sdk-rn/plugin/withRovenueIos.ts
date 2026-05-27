// withRovenueIos — Expo config plugin mod that injects the Rovenue pod
// into the consumer's Podfile.
//
// Default (no opts):     pod 'Rovenue', '~> 0.1'    — pulls from CocoaPods Trunk
// rovenueSwiftPath set:  pod 'Rovenue', :path => '...'   — monorepo `:path =>` link
//
// Monorepo consumers (e.g. examples/sample-rn-expo) MUST pass
// `rovenueSwiftPath` because the Rovenue pod has not been pushed to
// Trunk yet (M7.1 only prepares the infra). External consumers pass
// nothing and pick up the default once the first Trunk push lands.

import { ConfigPlugin, withDangerousMod } from "@expo/config-plugins";
import * as fs from "node:fs";
import * as path from "node:path";

type Options = { rovenueSwiftPath?: string } | undefined;

export const withRovenueIos: ConfigPlugin<Options> = (config, opts) => {
  return withDangerousMod(config, ["ios", async (cfg) => {
    const podfile = path.join(cfg.modRequest.platformProjectRoot, "Podfile");
    if (!fs.existsSync(podfile)) return cfg;

    const contents = fs.readFileSync(podfile, "utf8");
    if (contents.includes("pod 'Rovenue'")) return cfg;

    const podLine = opts?.rovenueSwiftPath
      ? `  pod 'Rovenue', :path => '${opts.rovenueSwiftPath}'`
      : `  pod 'Rovenue', '~> 0.1'`;

    const patched = contents.replace(
      /(target\s+['"][^'"]+['"]\s+do)/,
      `$1\n${podLine}`,
    );
    fs.writeFileSync(podfile, patched);
    return cfg;
  }]);
};
